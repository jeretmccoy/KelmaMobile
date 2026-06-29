// Kelma collection session: review, scheduling, and sync driven entirely by
// Anki's rslib. No study state is reimplemented here — every operation is a
// thin translation between JSON (for the platform layer) and rslib's public
// `Collection` API.
//
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::Mutex;

use anki::card::CardId;
use anki::collection::{Collection, CollectionBuilder};
use anki::prelude::AnkiError;
use anki::scheduler::answering::{CardAnswer, Rating};
use anki::scheduler::states::SchedulingStates;
use anki::sync::login::{sync_login, SyncAuth};
use anki::timestamp::TimestampMillis;
use anki::types::Usn;
use serde_json::{json, Value};

/// A long-lived handle owning one open collection. The platform layer keeps a
/// single session per profile and serializes calls; rslib itself guards the
/// SQLite connection, but we add a `Mutex` so the FFI surface is `Send`/`Sync`.
pub struct KelmaSession {
    inner: Mutex<SessionState>,
}

struct SessionState {
    /// `None` while a full sync swaps the collection out.
    col: Option<Collection>,
    collection_path: String,
    media_folder_path: String,
    media_db_path: String,
}

/// Build the reqwest client rslib expects for sync. It must be the same
/// `reqwest` version rslib links against (see Cargo.toml pinning note).
fn web_client() -> reqwest::Client {
    reqwest::Client::builder()
        .build()
        .expect("failed to build sync HTTP client")
}

/// Run a future to completion on a throwaway current-thread runtime. rslib's
/// sync code blocks the caller, matching how the desktop/AnkiDroid backends
/// invoke it from a worker thread.
fn block_on<F: std::future::Future>(fut: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime")
        .block_on(fut)
}

impl KelmaSession {
    /// Open or create a collection. `request` is `{collectionPath,
    /// mediaFolderPath, mediaDbPath}`.
    pub fn open(request: &Value) -> Result<Box<KelmaSession>, String> {
        let collection_path = str_field(request, "collectionPath")?;
        let media_folder_path = str_field(request, "mediaFolderPath")?;
        let media_db_path = str_field(request, "mediaDbPath")?;

        let col = build_collection(&collection_path, &media_folder_path, &media_db_path)?;

        Ok(Box::new(KelmaSession {
            inner: Mutex::new(SessionState {
                col: Some(col),
                collection_path,
                media_folder_path,
                media_db_path,
            }),
        }))
    }

    fn with_col<T>(
        &self,
        f: impl FnOnce(&mut Collection) -> Result<T, AnkiError>,
    ) -> Result<T, String> {
        let mut guard = self.inner.lock().map_err(|_| "session poisoned".to_string())?;
        let col = guard
            .col
            .as_mut()
            .ok_or_else(|| "collection is not open".to_string())?;
        f(col).map_err(|e| format!("{e:?}"))
    }

    /// Full deck tree with today's study counts, as nested JSON.
    pub fn deck_tree(&self) -> Result<Value, String> {
        let node = self.with_col(|col| col.deck_tree(Some(anki::timestamp::TimestampSecs::now())))?;
        Ok(deck_node_to_json(&node))
    }

    /// The next due card (rendered) plus remaining counts. Returns
    /// `{counts:{new,learning,review}, card: null | {...}}`.
    pub fn next_card(&self) -> Result<Value, String> {
        self.with_col(|col| {
            let queued = col.get_queued_cards(1, false)?;
            let counts = json!({
                "new": queued.new_count,
                "learning": queued.learning_count,
                "review": queued.review_count,
            });

            let Some(first) = queued.cards.first() else {
                return Ok(json!({ "counts": counts, "card": Value::Null }));
            };

            // `Card`'s fields are private; use its public accessors and the
            // collection's public deck lookup (not the private storage method).
            let card_id = first.card.id();
            let deck_id = first.card.deck_id();
            let rendered = col.render_existing_card(card_id, false, false)?;
            let deck_name = col
                .get_deck(deck_id)?
                .map(|d| d.name.human_name())
                .unwrap_or_default();


            Ok(json!({
                "counts": counts,
                "card": {
                    "cardId": card_id.0,
                    "deckName": deck_name,
                    "question": rendered.question().into_owned(),
                    "answer": rendered.answer().into_owned(),
                    "css": rendered.css,
                },
            }))
        })
    }

    /// Answer the current card. `request` is `{cardId, rating(0..3),
    /// millisecondsTaken}`. The scheduling states are recomputed by rslib so
    /// the platform layer never has to understand FSRS/SM2.
    pub fn answer_card(&self, request: &Value) -> Result<Value, String> {
        let card_id = CardId(i64_field(request, "cardId")?);
        let rating = rating_from_u64(u64_field(request, "rating")?)?;
        let ms = request
            .get("millisecondsTaken")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32;

        self.with_col(|col| {
            let states: SchedulingStates = col.get_scheduling_states(card_id)?;
            let new_state = match rating {
                Rating::Again => states.again,
                Rating::Hard => states.hard,
                Rating::Good => states.good,
                Rating::Easy => states.easy,
            };
            let mut answer = CardAnswer {
                card_id,
                current_state: states.current,
                new_state,
                rating,
                answered_at: TimestampMillis::now(),
                milliseconds_taken: ms,
                custom_data: None,
                from_queue: true,
            };
            col.answer_card(&mut answer)?;
            Ok(())
        })?;

        Ok(json!({ "answered": true }))
    }

    /// Exchange username/password for a sync host key against the given
    /// endpoint. `request` is `{username, password, endpoint}`.
    pub fn sync_login(&self, request: &Value) -> Result<Value, String> {
        let username = str_field(request, "username")?;
        let password = str_field(request, "password")?;
        let endpoint = str_field(request, "endpoint")?;

        let auth = block_on(sync_login(
            username,
            password,
            Some(endpoint.clone()),
            web_client(),
        ))
        .map_err(|e| format!("{e:?}"))?;

        Ok(json!({ "hkey": auth.hkey, "endpoint": endpoint }))
    }

    /// Run a normal (incremental) sync. `request` is `{hkey, endpoint}`.
    /// Returns the action required so the UI can prompt for a full sync when
    /// the server and client schemas diverge.
    pub fn sync_collection(&self, request: &Value) -> Result<Value, String> {
        let auth = sync_auth_from(request)?;

        let output = self.with_col(|col| block_on(col.normal_sync(auth, web_client())))?;

        use anki::sync::collection::normal::SyncActionRequired;
        let required = match output.required {
            SyncActionRequired::NoChanges => "noChanges",
            SyncActionRequired::NormalSyncRequired => "normalSyncRequired",
            SyncActionRequired::FullSyncRequired { .. } => "fullSyncRequired",
        };
        let (upload_ok, download_ok) = match output.required {
            SyncActionRequired::FullSyncRequired {
                upload_ok,
                download_ok,
            } => (upload_ok, download_ok),
            _ => (false, false),
        };

        Ok(json!({
            "required": required,
            "uploadOk": upload_ok,
            "downloadOk": download_ok,
            "serverMessage": output.server_message,
            "newEndpoint": output.new_endpoint,
        }))
    }

    /// Cheap, network-free check of whether local changes are pending.
    pub fn sync_status(&self) -> Result<Value, String> {
        use anki::sync::collection::status::online_sync_status_check;
        let _ = online_sync_status_check; // referenced for docs; offline path below
        let required = self.with_col(|col| col.sync_status_offline())?;
        Ok(json!({ "changes": format!("{required:?}") }))
    }

    /// Full upload or download. `request` is `{hkey, endpoint, upload(bool)}`.
    /// rslib consumes the collection during a full sync, so we take it out and
    /// reopen from the same path afterwards.
    pub fn full_sync(&self, request: &Value) -> Result<Value, String> {
        let auth = sync_auth_from(request)?;
        let upload = request
            .get("upload")
            .and_then(Value::as_bool)
            .ok_or_else(|| "missing 'upload' boolean".to_string())?;

        let mut guard = self.inner.lock().map_err(|_| "session poisoned".to_string())?;
        let col = guard
            .col
            .take()
            .ok_or_else(|| "collection is not open".to_string())?;

        let result = if upload {
            block_on(col.full_upload(auth, web_client()))
        } else {
            block_on(col.full_download(auth, web_client()))
        };
        result.map_err(|e| format!("{e:?}"))?;

        // The collection was consumed; reopen it so review can continue.
        let reopened = build_collection(
            &guard.collection_path,
            &guard.media_folder_path,
            &guard.media_db_path,
        )?;
        guard.col = Some(reopened);

        Ok(json!({ "completed": true, "upload": upload }))
    }
}

fn build_collection(
    collection_path: &str,
    media_folder_path: &str,
    media_db_path: &str,
) -> Result<Collection, String> {
    CollectionBuilder::new(collection_path)
        .set_media_paths(media_folder_path, media_db_path)
        .build()
        .map_err(|e| format!("{e:?}"))
}

fn sync_auth_from(request: &Value) -> Result<SyncAuth, String> {
    let hkey = str_field(request, "hkey")?;
    let endpoint = str_field(request, "endpoint")?;
    let endpoint = url::Url::parse(&endpoint).map_err(|e| format!("invalid endpoint: {e}"))?;
    Ok(SyncAuth {
        hkey,
        endpoint: Some(endpoint),
        io_timeout_secs: None,
    })
}

fn rating_from_u64(value: u64) -> Result<Rating, String> {
    match value {
        0 => Ok(Rating::Again),
        1 => Ok(Rating::Hard),
        2 => Ok(Rating::Good),
        3 => Ok(Rating::Easy),
        other => Err(format!("invalid rating {other}")),
    }
}

fn deck_node_to_json(node: &anki_proto::decks::DeckTreeNode) -> Value {
    json!({
        "deckId": node.deck_id,
        "name": node.name,
        "level": node.level,
        "collapsed": node.collapsed,
        "filtered": node.filtered,
        "newCount": node.new_count,
        "learnCount": node.learn_count,
        "reviewCount": node.review_count,
        "children": node.children.iter().map(deck_node_to_json).collect::<Vec<_>>(),
    })
}

fn str_field(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("missing string field '{key}'"))
}

fn i64_field(value: &Value, key: &str) -> Result<i64, String> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("missing integer field '{key}'"))
}

fn u64_field(value: &Value, key: &str) -> Result<u64, String> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("missing unsigned field '{key}'"))
}

// `Usn` is referenced so the platform layer can extend full-sync to honor a
// server-provided usn later without another API change.
#[allow(dead_code)]
fn _usn(value: i32) -> Usn {
    Usn(value)
}

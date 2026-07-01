// Kelma collection session: review, scheduling, and sync driven entirely by
// Anki's rslib. No study state is reimplemented here — every operation is a
// thin translation between JSON (for the platform layer) and rslib's public
// `Collection` API.
//
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::Mutex;

use anki::browser_table::Column;
use anki::card::CardId;
use anki::collection::{Collection, CollectionBuilder};
use anki::decks::{DeckId, DeckKind};
use anki::prelude::{AnkiError, OrNotFound};
use anki::scheduler::answering::{CardAnswer, Rating};
use anki::scheduler::states::SchedulingStates;
use anki::search::{parse_search, JoinSearches, SearchBuilder, SearchNode, SortMode, StateKind};
use anki::services::SearchService;
use anki::sync::login::{sync_login, SyncAuth};
use anki::timestamp::{TimestampMillis, TimestampSecs};
use anki::types::Usn;
use anki_proto::decks::DeckTreeNode;
use anki_proto::generic::StringList;
use rusqlite::params;
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

    /// Absolute path of the collection's media folder, so the platform layer
    /// can resolve `[sound:resource]` tags to on-disk files for playback.
    pub fn media_dir(&self) -> Result<Value, String> {
        let guard = self.inner.lock().map_err(|_| "session poisoned".to_string())?;
        Ok(json!({ "dir": guard.media_folder_path }))
    }

    /// Set the deck that subsequent review pulls cards from. rslib's notion of
    /// the "current deck" drives the queue builder, and descendants are pulled
    /// in automatically, mirroring how AnkiDroid starts a review from a tapped
    /// deck. `request` is `{deckId}`.
    pub fn set_current_deck(&self, request: &Value) -> Result<Value, String> {
        let deck_id = DeckId(i64_field(request, "deckId")?);
        self.with_col(|col| col.set_current_deck(deck_id))?;
        Ok(json!({ "selected": true, "deckId": deck_id.0 }))
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

            // Next-interval labels for the rating buttons, like normal Anki:
            // [again, hard, good, easy] (e.g. "<1m", "10m", "1d", "4d").
            let states = col.get_scheduling_states(card_id)?;
            let intervals = col.describe_next_states(&states)?;

            Ok(json!({
                "counts": counts,
                "card": {
                    "cardId": card_id.0,
                    "deckName": deck_name,
                    "question": rendered.question().into_owned(),
                    "answer": rendered.answer().into_owned(),
                    "css": rendered.css,
                    "intervals": intervals,
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

    /// Collection statistics for the Stats screen: today's study message plus a
    /// card-count breakdown (computed via searches, like AnkiDroid's card stats).
    pub fn stats(&self) -> Result<Value, String> {
        self.with_col(|col| {
            let studied = col.studied_today().unwrap_or_default();
            let count = |c: &mut anki::collection::Collection, query: &str| -> i64 {
                c.search_cards(query, anki::search::SortMode::NoOrder)
                    .map(|cards| cards.len() as i64)
                    .unwrap_or(0)
            };
            Ok(json!({
                "studiedToday": studied,
                "counts": {
                    "total": count(col, "deck:*"),
                    "new": count(col, "is:new"),
                    "learning": count(col, "is:learn"),
                    "young": count(col, "is:review -prop:ivl>=21"),
                    "mature": count(col, "prop:ivl>=21"),
                    "suspended": count(col, "is:suspended"),
                },
            }))
        })
    }

    /// Deck inspector: the per-deck overview AnkiDroid shows in its
    /// StudyOptionsFragment — the deck's name and description, today's due
    /// counts (new / learning / review, including subdecks, after limits), the
    /// total number of cards in the deck, and how many of those are still new.
    /// `request` is `{deckId}`.
    pub fn deck_overview(&self, request: &Value) -> Result<Value, String> {
        let deck_id = DeckId(i64_field(request, "deckId")?);
        self.with_col(|col| {
            let deck = col
                .get_deck(deck_id)?
                .or_not_found(deck_id)?;
            let name = deck.name.human_name();
            let filtered = matches!(deck.kind, DeckKind::Filtered(_));
            let description = match &deck.kind {
                DeckKind::Normal(normal) => normal.description.clone(),
                DeckKind::Filtered(_) => String::new(),
            };

            // Today's due counts come from the deck tree node (with children,
            // after per-deck limits), exactly like the DeckPicker numbers.
            let tree = col.deck_tree(Some(TimestampSecs::now()))?;
            let node = find_deck_node(&tree, deck_id);
            let (today_new, today_learn, today_review, total_cards) = match node {
                Some(n) => (
                    n.new_count,
                    n.learn_count,
                    n.review_count,
                    n.total_including_children,
                ),
                None => (0, 0, 0, 0),
            };

            // Total new cards across this deck and its subdecks.
            let new_search = SearchBuilder::from(SearchNode::from_deck_id(deck_id, true))
                .and(StateKind::New);
            let total_new = col.search_cards(new_search, SortMode::NoOrder)?.len() as i64;

            Ok(json!({
                "deckId": deck_id.0,
                "name": name,
                "description": description,
                "filtered": filtered,
                "todayNew": today_new,
                "todayLearn": today_learn,
                "todayReview": today_review,
                "totalNew": total_new,
                "totalCards": total_cards,
            }))
        })
    }

    /// Browse the cards in a deck (and its subdecks), the rslib equivalent of
    /// opening the Card Browser scoped to one deck. Cards are sorted by due
    /// date and paged, and each row carries the question preview and the same
    /// cells the desktop browser shows (due, interval, reps, lapses) plus a
    /// state color so the UI can flag suspended / buried / marked cards.
    /// `request` is `{deckId, query?, limit?, offset?}`.
    pub fn browse_deck(&self, request: &Value) -> Result<Value, String> {
        let deck_id = DeckId(i64_field(request, "deckId")?);
        let query = request.get("query").and_then(Value::as_str).unwrap_or("");
        let limit = request.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
        let offset = request.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;

        self.with_col(|col| {
            let mut search = SearchBuilder::from(SearchNode::from_deck_id(deck_id, true));
            if !query.is_empty() {
                // Parse the user's free-text query and AND it with the deck
                // filter, mirroring how the desktop browser narrows a saved
                // search.
                let nodes = parse_search(query)?;
                search = search.and(SearchBuilder::all(nodes));
            }

            // Sort by due so the list reads like the queue: newest-position
            // cards first, then learning, then review by due date.
            let ids = col.search_cards(
                search,
                SortMode::Builtin {
                    column: Column::Due,
                    reverse: false,
                },
            )?;
            let total = ids.len() as i64;
            let page: Vec<i64> = ids
                .into_iter()
                .skip(offset)
                .take(limit)
                .map(|c| c.0)
                .collect();

            // The Question / Due / Interval / Reps / Lapses cells, in this
            // fixed order, so the platform layer can index them by position.
            col.set_active_browser_columns(StringList {
                vals: vec![
                    "question".to_string(),
                    "cardDue".to_string(),
                    "cardIvl".to_string(),
                    "cardReps".to_string(),
                    "cardLapses".to_string(),
                ],
            })?;

            let mut cards = Vec::with_capacity(page.len());
            for id in page {
                let row = col.browser_row_for_id(id)?;
                let cells: Vec<String> = row.cells.iter().map(|c| c.text.clone()).collect();
                cards.push(json!({
                    "cardId": id,
                    "question": cells.get(0).cloned().unwrap_or_default(),
                    "due": cells.get(1).cloned().unwrap_or_default(),
                    "interval": cells.get(2).cloned().unwrap_or_default(),
                    "reps": cells.get(3).cloned().unwrap_or_default(),
                    "lapses": cells.get(4).cloned().unwrap_or_default(),
                    "color": row.color as i32,
                }));
            }

            Ok(json!({
                "deckId": deck_id.0,
                "total": total,
                "offset": offset,
                "limit": limit,
                "cards": cards,
            }))
        })
    }

    /// Render a single card's front and back faithfully (the note type's own
    /// CSS, so cloze/blur/colours all work), the way the reviewer and the
    /// desktop "card info" view do. `request` is `{cardId}`.
    pub fn card_detail(&self, request: &Value) -> Result<Value, String> {
        let card_id = CardId(i64_field(request, "cardId")?);
        self.with_col(|col| {
            // partial_render=false so the question/answer come back as a single
            // fully-rendered HTML string each, exactly like the reviewer gets.
            let rendered = col.render_existing_card(card_id, false, false)?;
            Ok(json!({
                "cardId": card_id.0,
                "question": rendered.question().into_owned(),
                "answer": rendered.answer().into_owned(),
                "css": rendered.css,
            }))
        })
    }

    // --- Sync state -----------------------------------------------------------

    /// Per-deck pending-sync counts, mirroring the Kelma plugin's deck badges:
    /// `added` = cards created (id newer) since the last sync, `changed` =
    /// older cards whose mod is newer than the last sync. The last-sync stamp
    /// is rslib's own `col.ls`, and the collection-wide "has changes" comes
    /// from rslib's `sync_status_offline`, so this never desyncs from the real
    /// sync machinery. `decks` lists each deck's *own* cards (not rolled up
    /// into parents), matching the plugin's per-row badge semantics.
    pub fn pending_changes(&self) -> Result<Value, String> {
        self.with_col(|col| {
            // rslib's authoritative collection-wide signal.
            let has_changes = !matches!(
                col.sync_status_offline()?,
                anki_proto::sync::sync_status_response::Required::NoChanges
            );

            let db = col.storage.db();
            let last_ms: i64 = db
                .query_row("select ls from col", [], |row| row.get(0))
                .unwrap_or(0);
            let last_sec = last_ms / 1000;

            // added: cards created after the last sync (card id is creation ms)
            let mut added: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
            if last_ms > 0 {
                let mut stmt = db.prepare(
                    "select did, count(*) from cards where id > ? group by did",
                )?;
                let rows = stmt.query_map(params![last_ms], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
                })?;
                for r in rows {
                    if let Ok((did, cnt)) = r {
                        added.insert(did, cnt);
                    }
                }
            }

            // changed: older cards reviewed/edited after the last sync
            let mut changed: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
            if last_ms > 0 {
                let mut stmt = db.prepare(
                    "select did, count(*) from cards where mod > ? and id <= ? group by did",
                )?;
                let rows = stmt.query_map(params![last_sec, last_ms], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
                })?;
                for r in rows {
                    if let Ok((did, cnt)) = r {
                        changed.insert(did, cnt);
                    }
                }
            }

            // Emit one entry per deck id that has any pending cards (own cards
            // only — the plugin deliberately does not roll children into parents
            // so each row's badge reflects just that deck).
            let mut decks: Vec<Value> = Vec::new();
            let mut dids: std::collections::BTreeSet<i64> = added.keys().chain(changed.keys()).copied().collect();
            for did in dids {
                let a = added.get(&did).copied().unwrap_or(0);
                let c = changed.get(&did).copied().unwrap_or(0);
                if a == 0 && c == 0 {
                    continue;
                }
                decks.push(json!({ "deckId": did, "added": a, "changed": c }));
            }

            Ok(json!({
                "hasChanges": has_changes,
                "lastSyncMs": last_ms,
                "decks": decks,
            }))
        })
    }

    /// Persist the KelmaSync host key + endpoint in the collection's own
    /// `config` store (the same `config` table Anki uses), so the home Sync
    /// button can sync without re-entering credentials — even after the app
    /// restarts. Lives in the SQLite `config` table; never leaves the device
    /// except via a normal sync.
    pub fn get_sync_auth(&self) -> Result<Value, String> {
        self.with_col(|col| {
            let db = col.storage.db();
            let row: Option<Vec<u8>> = db
                .query_row(
                    "select val from config where key = 'kelmaSyncAuth'",
                    [],
                    |row| row.get(0),
                )
                .ok();
            Ok(match row {
                Some(bytes) => {
                    let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                    if parsed.is_null() {
                        Value::Null
                    } else {
                        parsed
                    }
                }
                None => Value::Null,
            })
        })
    }

    pub fn set_sync_auth(&self, request: &Value) -> Result<Value, String> {
        let hkey = str_field(request, "hkey")?;
        let endpoint = str_field(request, "endpoint")?;
        self.with_col(|col| {
            let db = col.storage.db();
            let val = serde_json::to_vec(&json!({ "hkey": hkey, "endpoint": endpoint }))?;
            db.execute(
                "insert or replace into config (key, usn, mtime_secs, val) \
                 values ('kelmaSyncAuth', -1, ?, ?)",
                params![TimestampSecs::now().0, val],
            )?;
            Ok(json!({ "stored": true }))
        })
    }

    pub fn clear_sync_auth(&self) -> Result<Value, String> {
        self.with_col(|col| {
            col.storage
                .db()
                .execute("delete from config where key = 'kelmaSyncAuth'", [])
                .ok();
            Ok(json!({ "cleared": true }))
        })
    }

    /// Diagnostic dump of the sync-relevant collection state: the `col` row
    /// timestamps/usn, plus raw counts of rows still marked pending (`usn=-1`).
    /// Used to localize upload/download bugs without a debugger attached.
    pub fn sync_debug(&self) -> Result<Value, String> {
        self.with_col(|col| {
            let db = col.storage.db();
            let (mod_, scm, ls, usn): (i64, i64, i64, i64) = db
                .query_row("select mod, scm, ls, usn from col", [], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?;
            let count = |sql: &str| -> i64 {
                db.query_row(sql, [], |row| row.get(0)).unwrap_or(0)
            };
            Ok(json!({
                "col": { "mod": mod_, "scm": scm, "ls": ls, "usn": usn },
                "pendingCards": count("select count(*) from cards where usn=-1"),
                "pendingNotes": count("select count(*) from notes where usn=-1"),
                "pendingRevlogs": count("select count(*) from revlog where usn=-1"),
                "pendingGraves": count("select count(*) from graves"),
                "totalCards": count("select count(*) from cards"),
                "totalRevlogs": count("select count(*) from revlog"),
            }))
        })
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

    /// Run Anki's separate media protocol after collection sync. Keeping this
    /// as its own bridge operation lets the React Native UI report the real
    /// collection and media phases independently.
    pub fn sync_media(&self, request: &Value) -> Result<Value, String> {
        let auth = sync_auth_from(request)?;
        let result = self.with_col(|col| {
            let manager = col.media()?;
            let progress = col.new_progress_handler();
            block_on(manager.sync_media(progress, auth, web_client(), None))
        });

        if let Err(error) = result {
            let guard = self.inner.lock().map_err(|_| "session poisoned".to_string())?;
            let (files, bytes) =
                media_folder_totals(&guard.media_folder_path).unwrap_or_default();
            return Err(format!(
                "Media sync stopped after {files} files ({bytes} bytes): {error}"
            ));
        }

        let guard = self.inner.lock().map_err(|_| "session poisoned".to_string())?;
        let (files, bytes) = media_folder_totals(&guard.media_folder_path)?;
        Ok(json!({ "files": files, "bytes": bytes }))
    }
}

fn media_folder_totals(path: &str) -> Result<(u64, u64), String> {
    let entries = std::fs::read_dir(path).map_err(|e| format!("reading media folder: {e}"))?;
    let mut files = 0;
    let mut bytes = 0;
    for entry in entries {
        let entry = entry.map_err(|e| format!("reading media entry: {e}"))?;
        let metadata = entry
            .metadata()
            .map_err(|e| format!("reading media metadata: {e}"))?;
        if metadata.is_file() {
            files += 1;
            bytes += metadata.len();
        }
    }
    Ok((files, bytes))
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

/// Locate a deck (by id) inside a `deck_tree()` result, recursing into
/// children. The tree's synthetic root carries deck id 0, so the deck of
/// interest is always one of its descendants.
fn find_deck_node<'a>(
    node: &'a DeckTreeNode,
    deck_id: DeckId,
) -> Option<&'a DeckTreeNode> {
    if node.deck_id == deck_id.0 {
        return Some(node);
    }
    for child in &node.children {
        if let Some(found) = find_deck_node(child, deck_id) {
            return Some(found);
        }
    }
    None
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

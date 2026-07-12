// Kelma collection session: review, scheduling, and sync driven entirely by
// Anki's rslib. No study state is reimplemented here — every operation is a
// thin translation between JSON (for the platform layer) and rslib's public
// `Collection` API.
//
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;

use anki::browser_table::Column;
use anki::card::CardId;
use anki::collection::{Collection, CollectionBuilder};
use anki::decks::{Deck, DeckId, DeckKind, NativeDeckName};
use anki::import_export::package::ExportAnkiPackageOptions;
use anki::notetype::NotetypeId;
use anki::prelude::{AnkiError, NoteId, OrInvalid, OrNotFound};
use anki::progress::{Progress, ProgressState};
use anki::scheduler::answering::{CardAnswer, Rating};
use anki::scheduler::states::SchedulingStates;
use anki::search::{parse_search, JoinSearches, SearchBuilder, SearchNode, SortMode, StateKind};
use anki::services::{
    CardsService, DecksService, NotesService, NotetypesService, SearchService, TagsService,
};
use anki::sync::login::SyncAuth;
use anki::timestamp::{TimestampMillis, TimestampSecs};
use anki::types::Usn;
use anki_proto::decks::DeckTreeNode;
use anki_proto::generic::StringList;
use rusqlite::params;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};

/// A long-lived handle owning one open collection. The platform layer keeps a
/// single session per profile and serializes calls; rslib itself guards the
/// SQLite connection, but we add a `Mutex` so the FFI surface is `Send`/`Sync`.
pub struct KelmaSession {
    inner: Mutex<SessionState>,
    /// Live progress cell of an in-flight background media sync (see
    /// `sync_media_start`). Read by `sync_media_poll` without the `inner` lock,
    /// so progress can be polled while the sync runs on its own thread.
    media_progress: Mutex<Option<Arc<Mutex<V2MediaProgress>>>>,
    /// Set by the media-sync worker thread when it finishes: `Ok(totals)` or
    /// `Err(message)`. `None` inside means still running.
    media_done: Mutex<Option<Arc<Mutex<Option<Result<Value, String>>>>>>,
    /// Live progress cell of an in-flight background full collection sync
    /// (`full_sync_start`) — carries `FullSyncProgress` byte counts.
    full_progress: Mutex<Option<Arc<Mutex<ProgressState>>>>,
    /// Result of the full-sync worker thread (the collection is consumed during
    /// a full sync, so `full_sync_poll` reopens it once this is set).
    full_done: Mutex<Option<Arc<Mutex<Option<Result<Value, String>>>>>>,
}

struct SessionState {
    /// `None` while a full sync swaps the collection out.
    col: Option<Collection>,
    collection_path: String,
    media_folder_path: String,
    media_db_path: String,
}

#[derive(Default)]
struct V2MediaProgress {
    checked: usize,
    downloaded_files: usize,
    uploaded_files: usize,
}

/// Build the reqwest client rslib expects for sync. It must be the same
/// `reqwest` version rslib links against (see Cargo.toml pinning note).
fn kelma_client_label() -> String {
    format!(
        "kelma-mobile:{}:anki{}",
        env!("CARGO_PKG_VERSION"),
        crate::ANKI_VERSION
    )
}

fn web_client() -> reqwest::Client {
    use std::net::{IpAddr, Ipv4Addr};
    use std::time::Duration;
    reqwest::Client::builder()
        // Force IPv4. iOS's URLSession (what Safari uses) does Happy Eyeballs —
        // it races IPv4 and IPv6 and uses whichever connects — but reqwest/hyper
        // connects to the first resolved address, usually the IPv6 one. On a
        // network whose IPv6 route to the sync host is a black hole (common on
        // some carriers / captive Wi-Fi), that connect just hangs until the TCP
        // timeout (~75s) with no IPv4 fallback, so sync "times out" even though
        // the same host loads instantly in Safari. Binding a local IPv4 address
        // makes every sync connection use the A record.
        .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
        // And cap connect time so a genuinely dead route fails fast and legibly
        // instead of a silent ~75s hang.
        .connect_timeout(Duration::from_secs(20))
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
    /// mediaFolderPath, mediaDbPath, timeZone?}`.
    pub fn open(request: &Value) -> Result<Box<KelmaSession>, String> {
        let collection_path = str_field(request, "collectionPath")?;
        let media_folder_path = str_field(request, "mediaFolderPath")?;
        let media_db_path = str_field(request, "mediaDbPath")?;

        // rslib's day-rollover math (what counts as "today", and the seed for
        // new/review queue shuffling) runs on `chrono::Local`, which reads
        // `TZ`/the OS timezone database — not reliably correct inside an
        // embedded mobile Rust runtime. Without this, the app can silently
        // compute a different "today" than Anki Desktop/AnkiMobile for the
        // same collection, producing a different due-card order. The
        // platform layer resolves the device's real IANA timezone and passes
        // it here; setting `TZ` before anything touches the scheduler makes
        // `chrono::Local` agree with it.
        if let Some(time_zone) = request.get("timeZone").and_then(Value::as_str) {
            if !time_zone.is_empty() {
                // SAFETY: called once, synchronously, before the collection
                // (and any other thread that might read the environment) exists.
                unsafe {
                    std::env::set_var("TZ", time_zone);
                }
            }
        }

        let col = build_collection(&collection_path, &media_folder_path, &media_db_path)?;

        Ok(Box::new(KelmaSession {
            inner: Mutex::new(SessionState {
                col: Some(col),
                collection_path,
                media_folder_path,
                media_db_path,
            }),
            media_progress: Mutex::new(None),
            media_done: Mutex::new(None),
            full_progress: Mutex::new(None),
            full_done: Mutex::new(None),
        }))
    }

    fn with_col<T>(
        &self,
        f: impl FnOnce(&mut Collection) -> Result<T, AnkiError>,
    ) -> Result<T, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "session poisoned".to_string())?;
        let col = guard
            .col
            .as_mut()
            .ok_or_else(|| "collection is not open".to_string())?;
        f(col).map_err(|e| format!("{e:?}"))
    }

    /// Variant for sync helpers that need to preserve actionable protocol
    /// errors (for example deletion/conflict confirmation markers) instead of
    /// wrapping them in AnkiError.
    fn with_col_result<T>(
        &self,
        f: impl FnOnce(&mut Collection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "session poisoned".to_string())?;
        let col = guard
            .col
            .as_mut()
            .ok_or_else(|| "collection is not open".to_string())?;
        f(col)
    }

    /// Full deck tree with today's study counts, as nested JSON.
    pub fn deck_tree(&self) -> Result<Value, String> {
        let node =
            self.with_col(|col| col.deck_tree(Some(anki::timestamp::TimestampSecs::now())))?;
        Ok(deck_node_to_json(&node))
    }

    /// Absolute path of the collection's media folder, so the platform layer
    /// can resolve `[sound:resource]` tags to on-disk files for playback.
    pub fn media_dir(&self) -> Result<Value, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "session poisoned".to_string())?;
        Ok(json!({ "dir": guard.media_folder_path }))
    }

    /// Write the reviewer's rendered card HTML to a scratch file next to (a
    /// sibling of) the media folder, so the platform layer can load it via
    /// `source.uri` instead of `source.html`. On iOS, `loadHTMLString:baseURL:`
    /// (used for `source.html`) never grants the WKWebView's sandboxed
    /// WebContent process read access to local `file://` subresources — only
    /// `loadFileURL:allowingReadAccessToURL:` (the `source.uri` path) does,
    /// which is why card images were never loading. `request` is `{html}`.
    /// Returns `{uri, allowedRoot}` (both `file://` URLs); `allowedRoot` covers
    /// both this scratch file and the media folder, since WebKit requires the
    /// granted root to be an ancestor of the file actually being loaded.
    pub fn write_card_html(&self, request: &Value) -> Result<Value, String> {
        let html = str_field(request, "html")?;
        let guard = self
            .inner
            .lock()
            .map_err(|_| "session poisoned".to_string())?;
        let media_path = std::path::Path::new(&guard.media_folder_path);
        let profile_dir = media_path
            .parent()
            .ok_or_else(|| "media folder has no parent directory".to_string())?;

        // A fresh filename per render: WKWebView can otherwise keep serving a
        // cached copy of a `file://` URL it already loaded even after the
        // underlying file changes on disk.
        let scratch_path =
            profile_dir.join(format!("kelma_card_{}.html", TimestampMillis::now().0));
        std::fs::write(&scratch_path, html.as_bytes())
            .map_err(|e| format!("writing scratch card html: {e}"))?;

        // Best-effort cleanup of previous scratch renders.
        if let Ok(entries) = std::fs::read_dir(profile_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("kelma_card_") && entry.path() != scratch_path {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }

        Ok(json!({
            "uri": format!("file://{}", scratch_path.to_string_lossy()),
            "allowedRoot": format!("file://{}/", profile_dir.to_string_lossy()),
        }))
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

    /// Whether there's a change to undo (an answered card, or a suspend/bury/
    /// flag/delete from the card menu) and roughly what it was, so the
    /// reviewer can show/hide its "Undo" control the way the desktop client's
    /// Ctrl+Z tooltip does. `operation` is the `Debug` name of rslib's
    /// internal `Op` (e.g. `"AnswerCard"`), not a localized string.
    pub fn undo_status(&self) -> Result<Value, String> {
        self.with_col(|col| {
            let status = col.undo_status();
            Ok(json!({
                "canUndo": status.undo.is_some(),
                "operation": status.undo.map(|op| format!("{op:?}")),
            }))
        })
    }

    /// Undo the last change, exactly like Ctrl+Z on the desktop client — this
    /// reuses rslib's single global undo stack, so undoing after answering a
    /// card re-queues it (the reviewer reloads `nextCard` afterwards to show
    /// it again), while undoing after a suspend/bury/flag/delete reverts that
    /// instead. Returns `{undone: false}` rather than an error when the stack
    /// is empty, since callers may call this opportunistically.
    pub fn undo(&self) -> Result<Value, String> {
        self.with_col(|col| {
            if col.can_undo().is_none() {
                return Ok(json!({ "undone": false, "operation": Value::Null }));
            }
            let output = col.undo()?;
            Ok(json!({
                "undone": true,
                "operation": format!("{:?}", output.output.undone_op),
            }))
        })
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

    /// Full per-deck statistics, scoped to a deck (and its subdecks) via the
    /// same rslib graph engine AnkiDroid/desktop use. `request` is
    /// `{deckId, days}` where `days` bounds the revlog window (0 = all time).
    /// Returns every graph in `GraphsResponse` serialized to JSON.
    pub fn deck_stats(&self, request: &Value) -> Result<Value, String> {
        use anki::services::StatsService;
        use anki_proto::stats::GraphsRequest;

        let deck_id = DeckId(i64_field(request, "deckId")?);
        let days = request.get("days").and_then(Value::as_u64).unwrap_or(365) as u32;

        self.with_col(|col| {
            let deck = col.get_deck(deck_id)?.or_not_found(deck_id)?;
            let name = deck.name.human_name();
            // `deck:"Name"` matches the deck and all of its subdecks, exactly how
            // AnkiDroid scopes per-deck statistics.
            let search = format!("deck:\"{}\"", name.replace('"', "\\\""));
            let g = col.graphs(GraphsRequest { search, days })?;
            Ok(graphs_to_json(&name, days, &g))
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
            let deck = col.get_deck(deck_id)?.or_not_found(deck_id)?;
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
            let new_search =
                SearchBuilder::from(SearchNode::from_deck_id(deck_id, true)).and(StateKind::New);
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

            // Surface the card's scheduling + flag state and the note's mark
            // state so the card detail screen can show the right options
            // (Suspend vs Unsuspend, Mark vs Unmark, current flag/deck).
            let card = col.get_card(anki_proto::cards::CardId { cid: card_id.0 })?;
            let note_id = card.note_id;
            let note = col.get_note(anki_proto::notes::NoteId { nid: note_id })?;
            let marked = note.tags.iter().any(|t| t == "marked");

            Ok(json!({
                "cardId": card_id.0,
                "question": rendered.question().into_owned(),
                "answer": rendered.answer().into_owned(),
                "css": rendered.css,
                "noteId": note_id,
                "deckId": card.deck_id,
                "queue": card.queue,
                "flags": card.flags,
                "marked": marked,
            }))
        })
    }

    // --- Card actions (browser-style: suspend / bury / flag / deck / delete /
    //     mark) ---------------------------------------------------------------
    // All driven by rslib's own transactional ops so undo, USN stamping, and
    // sync bookkeeping are identical to the desktop/AnkiDroid browser.

    /// Suspend a single card. `request` is `{cardId}`.
    pub fn suspend_card(&self, request: &Value) -> Result<Value, String> {
        let card_id = CardId(i64_field(request, "cardId")?);
        self.with_col(|col| {
            let out = col.bury_or_suspend_cards(
                &[card_id],
                anki_proto::scheduler::bury_or_suspend_cards_request::Mode::Suspend,
            )?;
            Ok(json!({ "count": out.output }))
        })
    }

    /// Unsuspend (or unbury) a single card. `request` is `{cardId}`.
    pub fn unsuspend_card(&self, request: &Value) -> Result<Value, String> {
        let card_id = CardId(i64_field(request, "cardId")?);
        self.with_col(|col| {
            col.unbury_or_unsuspend_cards(&[card_id])?;
            Ok(json!({ "restored": true }))
        })
    }

    /// User-bury a single card (hide it from reviews until manually unburied or
    /// the next day rollover). `request` is `{cardId}`.
    pub fn bury_card(&self, request: &Value) -> Result<Value, String> {
        let card_id = CardId(i64_field(request, "cardId")?);
        self.with_col(|col| {
            let out = col.bury_or_suspend_cards(
                &[card_id],
                anki_proto::scheduler::bury_or_suspend_cards_request::Mode::BuryUser,
            )?;
            Ok(json!({ "count": out.output }))
        })
    }

    /// Set the flag (0-7) on a single card. `request` is `{cardId, flag}`.
    pub fn set_card_flag(&self, request: &Value) -> Result<Value, String> {
        let card_id = CardId(i64_field(request, "cardId")?);
        let flag = u64_field(request, "flag")? as u32;
        self.with_col(|col| {
            col.set_card_flag(&[card_id], flag)?;
            Ok(json!({ "flag": flag }))
        })
    }

    /// Move a single card to another deck. `request` is `{cardId, deckId}`.
    pub fn set_card_deck(&self, request: &Value) -> Result<Value, String> {
        let card_id = CardId(i64_field(request, "cardId")?);
        let deck_id = DeckId(i64_field(request, "deckId")?);
        self.with_col(|col| {
            col.set_deck(&[card_id], deck_id)?;
            Ok(json!({ "deckId": deck_id.0 }))
        })
    }

    /// Delete a card (and its note if no other cards reference it). `request`
    /// is `{cardId}`.
    pub fn delete_card(&self, request: &Value) -> Result<Value, String> {
        let card_id = i64_field(request, "cardId")?;
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "session poisoned".to_string())?;
        let collection_path = guard.collection_path.clone();
        let col = guard
            .col
            .as_mut()
            .ok_or_else(|| "collection is not open".to_string())?;
        let row: Option<(String, i64, i64, i64)> = col
            .storage
            .db()
            .query_row(
                "SELECT n.guid, c.ord, c.nid, c.usn FROM cards c JOIN notes n ON n.id=c.nid WHERE c.id=?",
                [card_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(|e| format!("inspect card before deletion: {e}"))?;
        let Some((guid, ord, nid, usn)) = row else {
            return Ok(json!({ "count": 0 }));
        };
        let cards_on_note: i64 = col
            .storage
            .db()
            .query_row("SELECT count(*) FROM cards WHERE nid=?", [nid], |r| {
                r.get(0)
            })
            .unwrap_or(1);
        let mut state = load_v2_sync_state(&collection_path);
        let canonical_id = state.cards.iter().find_map(|(canonical, logical)| {
            (logical.0 == guid && logical.1 == ord)
                .then(|| canonical.parse::<i64>().ok())
                .flatten()
        });
        if usn != -1 && canonical_id.is_none() {
            return Err(
                "Sync once before deleting this server card, so its canonical identity is known."
                    .to_string(),
            );
        }

        // Persist the outgoing tombstone before changing SQLite. If the app is
        // killed between these writes, the next sync still converges safely.
        if let Some(canonical_id) = canonical_id {
            state.pending_cards.insert(canonical_id);
            if cards_on_note == 1 && state.notes.contains(&guid) {
                state.pending_notes.insert(guid.clone());
            }
            save_existing_v2_sync_state(&collection_path, &state)?;
        }
        let out = col
            .remove_cards(anki_proto::cards::RemoveCardsRequest {
                card_ids: vec![card_id],
            })
            .map_err(|e| format!("delete card: {e:?}"))?;
        Ok(json!({ "count": out.count }))
    }

    /// Toggle the "marked" tag on the card's note. `request` is `{cardId}`.
    /// Returns `{marked: bool}` for the new state.
    pub fn toggle_card_mark(&self, request: &Value) -> Result<Value, String> {
        let card_id = i64_field(request, "cardId")?;
        self.with_col(|col| {
            let card = col.get_card(anki_proto::cards::CardId { cid: card_id })?;
            let note_id = card.note_id;
            let note = col.get_note(anki_proto::notes::NoteId { nid: note_id })?;
            let marked = note.tags.iter().any(|t| t == "marked");
            if marked {
                let _ = col.remove_note_tags(anki_proto::tags::NoteIdsAndTagsRequest {
                    note_ids: vec![note_id],
                    tags: "marked".to_owned(),
                })?;
            } else {
                let _ = col.add_note_tags(anki_proto::tags::NoteIdsAndTagsRequest {
                    note_ids: vec![note_id],
                    tags: "marked".to_owned(),
                })?;
            }
            Ok(json!({ "marked": !marked }))
        })
    }

    // --- Note editing --------------------------------------------------------

    /// Fetch a card's note for editing: the note id, notetype id/name, the
    /// field names (from the notetype) paired with the note's current field
    /// values, and the tags. `request` is `{cardId}`.
    pub fn get_note_edit(&self, request: &Value) -> Result<Value, String> {
        let card_id = i64_field(request, "cardId")?;
        self.with_col(|col| {
            let card = col.get_card(anki_proto::cards::CardId { cid: card_id })?;
            let note_id = card.note_id;
            let note = col.get_note(anki_proto::notes::NoteId { nid: note_id })?;
            let nt = col
                .get_notetype(NotetypeId(note.notetype_id))?
                .or_invalid("note type")?;
            let field_names: Vec<String> = nt.fields.iter().map(|f| f.name.clone()).collect();
            let values: Vec<String> = note.fields.clone();
            // Pad/truncate to the notetype's field count so the editor always
            // has one value per field even if the note is stale.
            let fields = field_names
                .iter()
                .enumerate()
                .map(|(i, name)| {
                    json!({
                        "name": name,
                        "value": values.get(i).cloned().unwrap_or_default(),
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({
                "noteId": note_id,
                "notetypeId": nt.id.0,
                "notetypeName": nt.name,
                "fields": fields,
                "tags": note.tags,
            }))
        })
    }

    /// Save an edited note. `request` is `{noteId, notetypeId, fields: [str],
    /// tags: [str]}`. Builds a proto `Note` and calls rslib's `update_notes`,
    /// which re-renders templates, regenerates cards, normalizes text, and
    /// stamps USN/mod exactly like the desktop editor.
    pub fn update_note(&self, request: &Value) -> Result<Value, String> {
        let note_id = i64_field(request, "noteId")?;
        let notetype_id = i64_field(request, "notetypeId")?;
        let fields = request
            .get("fields")
            .and_then(Value::as_array)
            .ok_or_else(|| "missing 'fields' array".to_string())?
            .iter()
            .map(|v| v.as_str().unwrap_or("").to_owned())
            .collect::<Vec<_>>();
        let tags = request
            .get("tags")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .map(|v| v.as_str().unwrap_or("").to_owned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        self.with_col(|col| {
            let current = col.get_note(anki_proto::notes::NoteId { nid: note_id })?;
            let _ = col.update_notes(anki_proto::notes::UpdateNotesRequest {
                notes: vec![anki_proto::notes::Note {
                    id: note_id,
                    guid: current.guid,
                    notetype_id,
                    mtime_secs: 0,
                    usn: 0,
                    tags,
                    fields,
                }],
                skip_undo_entry: false,
            })?;
            Ok(json!({ "saved": true }))
        })
    }

    // --- Add / notetypes ------------------------------------------------------

    /// List every notetype in the collection, with field names (in order) and a
    /// use count, so the Add screen can offer a notetype picker and lay out one
    /// field editor per notetype field — exactly like AnkiDroid's Add screen.
    pub fn notetypes(&self) -> Result<Value, String> {
        self.with_col(|col| {
            let nts = col.get_all_notetypes()?;
            let list: Vec<Value> = nts
                .iter()
                .map(|nt| {
                    json!({
                        "id": nt.id.0,
                        "name": nt.name,
                        "fields": nt.fields.iter().map(|f| f.name.clone()).collect::<Vec<_>>(),
                        "useCount": 0,
                    })
                })
                .collect();
            Ok(json!({ "notetypes": list }))
        })
    }

    /// Create a new note (and its generated cards) in the given deck, the
    /// rslib equivalent of AnkiDroid's Add. Builds a blank note from the
    /// notetype, fills the fields in order, sets the tags, and calls
    /// `Collection::add_note`, which re-renders templates, generates cards,
    /// normalizes text, and stamps USN/mod exactly like the desktop editor.
    /// `request` is `{notetypeId, deckId, fields: [str], tags: [str]}`. Returns
    /// `{noteId}`.
    pub fn add_note(&self, request: &Value) -> Result<Value, String> {
        let notetype_id = NotetypeId(i64_field(request, "notetypeId")?);
        let deck_id = DeckId(i64_field(request, "deckId")?);
        let fields = request
            .get("fields")
            .and_then(Value::as_array)
            .ok_or_else(|| "missing 'fields' array".to_string())?
            .iter()
            .map(|v| v.as_str().unwrap_or("").to_owned())
            .collect::<Vec<_>>();
        let tags = request
            .get("tags")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .map(|v| v.as_str().unwrap_or("").to_owned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        self.with_col(|col| {
            let nt = col.get_notetype(notetype_id)?.or_invalid("note type")?;
            let mut note = nt.new_note();
            for (idx, value) in fields.iter().enumerate() {
                // `set_field` errors on out-of-range indices; pad defensively
                // so a mismatched field count can't abort the whole add.
                if idx < note.fields().len() {
                    note.set_field(idx, value.clone())?;
                }
            }
            note.tags = tags;
            let out = col.add_note(&mut note, deck_id)?;
            Ok(json!({ "noteId": note.id.0, "cards": out.output }))
        })
    }

    /// Check a note's fields before adding — the same check Anki's Add screen
    /// runs via `Collection::note_fields_check`. Returns `{state}` where state
    /// is: 0=normal, 1=empty first field, 2=duplicate first field, 3=missing
    /// cloze, 4=notetype not cloze, 5=field not cloze. The UI uses this to
    /// warn the user before creating a duplicate note (the cause of the 1-card
    /// sync divergence when the same content exists on the server with a
    /// different GUID). `request` is `{notetypeId, fields: [str]}`.
    pub fn check_note_fields(&self, request: &Value) -> Result<Value, String> {
        let notetype_id = NotetypeId(i64_field(request, "notetypeId")?);
        let fields = request
            .get("fields")
            .and_then(Value::as_array)
            .ok_or_else(|| "missing 'fields' array".to_string())?
            .iter()
            .map(|v| v.as_str().unwrap_or("").to_owned())
            .collect::<Vec<_>>();
        self.with_col(|col| {
            let nt = col.get_notetype(notetype_id)?.or_invalid("note type")?;
            let mut note = nt.new_note();
            for (idx, value) in fields.iter().enumerate() {
                if idx < note.fields().len() {
                    note.set_field(idx, value.clone())?;
                }
            }
            let state = col.note_fields_check(&note)?;
            Ok(json!({ "state": state as i32 }))
        })
    }

    // --- Export --------------------------------------------------------------

    /// Export a deck (and its subdecks) to an `.apkg` package, like AnkiDroid's
    /// Export. Writes the file into the OS temp dir and returns its absolute
    /// path plus the note count, so the platform layer can hand it to a share
    /// sheet. `request` is `{deckId, deckName, withScheduling, withMedia,
    /// withDeckConfigs}`.
    pub fn export_deck(&self, request: &Value) -> Result<Value, String> {
        let deck_id = DeckId(i64_field(request, "deckId")?);
        let deck_name = request
            .get("deckName")
            .and_then(Value::as_str)
            .unwrap_or("export");
        let with_scheduling = request
            .get("withScheduling")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let with_media = request
            .get("withMedia")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let with_deck_configs = request
            .get("withDeckConfigs")
            .and_then(Value::as_bool)
            .unwrap_or(true);

        self.with_col(|col| {
            let options = ExportAnkiPackageOptions {
                with_scheduling,
                with_deck_configs,
                with_media,
                legacy: false,
            };
            let search = SearchNode::from_deck_id(deck_id, true);
            let path = export_path_for(deck_name);
            let notes = col.export_apkg(&path, options, search, None)?;
            Ok(json!({ "path": path, "notes": notes }))
        })
    }

    /// Import an `.apkg` package into the collection, like AnkiDroid's Import.
    /// `request` is `{packagePath, mergeNotetypes?, withScheduling?,
    /// withDeckConfigs?}`. rslib's `import_apkg` handles the full zip extract,
    /// note/notetype merge, deck creation, media restore, and USN stamping
    /// exactly like the desktop importer. Returns a one-line summary of what
    /// landed: added / updated / duplicates / conflicts / foundNotes.
    pub fn import_apkg(&self, request: &Value) -> Result<Value, String> {
        let package_path = str_field(request, "packagePath")?;
        let merge_notetypes = request
            .get("mergeNotetypes")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let with_scheduling = request
            .get("withScheduling")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let with_deck_configs = request
            .get("withDeckConfigs")
            .and_then(Value::as_bool)
            .unwrap_or(true);

        self.with_col(|col| {
            let options = anki_proto::import_export::ImportAnkiPackageOptions {
                merge_notetypes,
                with_scheduling,
                with_deck_configs,
                ..Default::default()
            };
            let out = col.import_apkg(&package_path, options)?;
            let log = out.output;
            Ok(json!({
                "added": log.new.len(),
                "updated": log.updated.len(),
                "duplicates": log.duplicate.len(),
                "conflicts": log.conflicting.len(),
                "foundNotes": log.found_notes,
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

            // Only count cards pending UPLOAD — i.e. locally modified since the
            // last sync, which Anki marks with `usn = -1`. Cards DOWNLOADED from
            // the server arrive with the server's usn (>= 0), so they're excluded
            // here (they're already in KelmaSync). The earlier heuristic keyed off
            // creation/mod time vs. the last-sync stamp, which wrongly flagged
            // freshly downloaded cards (created on another device after this
            // device's previous sync) as pending.

            // added: locally-created cards not yet uploaded (card id is creation ms)
            let mut added: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
            {
                let mut stmt = db.prepare(
                    "select did, count(*) from cards where usn = -1 and id > ? group by did",
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

            // changed: pre-existing cards edited/reviewed locally, not yet uploaded
            let mut changed: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
            {
                let mut stmt = db.prepare(
                    "select did, count(*) from cards where usn = -1 and id <= ? group by did",
                )?;
                let rows = stmt.query_map(params![last_ms], |row| {
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
            let dids: std::collections::BTreeSet<i64> =
                added.keys().chain(changed.keys()).copied().collect();
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
            let (mod_, scm, ls, usn): (i64, i64, i64, i64) =
                db.query_row("select mod, scm, ls, usn from col", [], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?;
            let count = |sql: &str| -> i64 { db.query_row(sql, [], |row| row.get(0)).unwrap_or(0) };
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

    /// Local collection manifest — the same shape as the server's `/sync/inspect`
    /// response, computed from the local collection. Used by the compare view to
    /// diff local vs server before syncing. See the KelmaSync REDESIGN doc.
    pub fn local_manifest(&self) -> Result<Value, String> {
        use sha2::{Digest, Sha256};
        use std::collections::HashMap;

        // Clone the media.db path so we can query it outside `with_col` (which
        // borrows the collection). The media.db is a separate SQLite file.
        let media_db_path = {
            let guard = self
                .inner
                .lock()
                .map_err(|_| "session poisoned".to_string())?;
            guard.media_db_path.clone()
        };

        // Collection queries run inside `with_col` so rusqlite::Error converts
        // to AnkiError (rslib implements From<rusqlite::Error>) and then to
        // String — same pattern as `sync_debug`.
        let mut manifest = self.with_col(|col| {
            let db = col.storage.db();

            // Collection-level meta.
            let (mod_, scm, usn, ver): (i64, i64, i64, i64) = db
                .query_row("SELECT mod, scm, usn, ver FROM col", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })
                .unwrap_or((0, 0, 0, 0));

            let mut deck_names: HashMap<i64, String> = HashMap::new();
            // Schema 15+ stores decks in a normalized table. Fall back to the
            // legacy col.decks JSON for old collections.
            if let Ok(mut stmt) = db.prepare("SELECT id, name FROM decks") {
                let rows =
                    stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
                for row in rows {
                    let (id, name) = row?;
                    deck_names.insert(id, name);
                }
            } else {
                let decks_json: String = db
                    .query_row("SELECT decks FROM col", [], |r| r.get(0))
                    .unwrap_or_default();
                let deck_map: HashMap<String, Value> =
                    serde_json::from_str(&decks_json).unwrap_or_default();
                for (_key, val) in &deck_map {
                    if let (Some(id), Some(name)) = (
                        val.get("id").and_then(|v| v.as_i64()),
                        val.get("name").and_then(|v| v.as_str()),
                    ) {
                        deck_names.insert(id, name.to_string());
                    }
                }
            }

            // Per-deck card counts.
            let mut card_counts: HashMap<i64, i64> = HashMap::new();
            {
                let mut stmt = db.prepare("SELECT did, COUNT(*) FROM cards GROUP BY did")?;
                let rows =
                    stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?;
                for row in rows {
                    let (did, cnt) = row?;
                    card_counts.insert(did, cnt);
                }
            }

            // DISTINCT collapses multiple card templates for one note in a
            // deck, while retaining notes whose cards span multiple decks.
            let mut deck_hashes: HashMap<i64, Sha256> = HashMap::new();
            let mut deck_note_counts: HashMap<i64, i64> = HashMap::new();
            let mut deck_mods: HashMap<i64, i64> = HashMap::new();
            // Per-note deck membership + card counts, keyed by nid so
            // duplicate/empty GUID notes don't collapse into one entry.
            let mut note_decks: HashMap<i64, Vec<i64>> = HashMap::new();
            let mut note_cards: HashMap<i64, HashMap<i64, i64>> = HashMap::new();
            {
                let mut stmt = db.prepare(
                    "SELECT DISTINCT c.did, n.guid, n.mod, n.id, n.flds \
                     FROM cards c JOIN notes n ON c.nid = n.id \
                     ORDER BY c.did, n.guid, n.id",
                )?;
                let rows = stmt.query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                })?;
                for row in rows {
                    let (did, guid, nmod, nid, flds) = row?;
                    note_decks.entry(nid).or_default().push(did);
                    *deck_note_counts.entry(did).or_default() += 1;
                    deck_mods
                        .entry(did)
                        .and_modify(|current| *current = (*current).max(nmod))
                        .or_insert(nmod);
                    let hasher = deck_hashes.entry(did).or_default();
                    hasher.update(guid.as_bytes());
                    hasher.update(b"\x1f");
                    hasher.update(nmod.to_le_bytes());
                    hasher.update(b"\x1f");
                    hasher.update(flds.as_bytes());
                    hasher.update(b"\x1e");
                }
            }
            {
                let mut stmt = db.prepare(
                    "SELECT n.id, c.did, COUNT(*) \
                     FROM cards c JOIN notes n ON c.nid = n.id \
                     GROUP BY n.id, c.did",
                )?;
                let rows = stmt.query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })?;
                for row in rows {
                    let (nid, did, cnt) = row?;
                    note_cards.entry(nid).or_default().insert(did, cnt);
                }
            }

            // Build the deck list, sorted by name.
            let mut decks: Vec<Value> = deck_names
                .iter()
                .map(|(id, name)| {
                    let cards = card_counts.get(id).copied().unwrap_or(0);
                    let notes = deck_note_counts.get(id).copied().unwrap_or(0);
                    let max_mod = deck_mods.get(id).copied().unwrap_or(0);
                    let hash = deck_hashes
                        .get(id)
                        .map(|h| {
                            let h = h.clone();
                            let result = h.finalize();
                            let mut hex = String::with_capacity(result.len() * 2);
                            for b in result {
                                hex.push_str(&format!("{b:02x}"));
                            }
                            format!("sha256:{hex}")
                        })
                        .unwrap_or_else(|| {
                            let result = Sha256::digest([]);
                            let mut hex = String::with_capacity(result.len() * 2);
                            for b in result {
                                hex.push_str(&format!("{b:02x}"));
                            }
                            format!("sha256:{hex}")
                        });
                    json!({
                        "id": id,
                        "name": name,
                        "cards": cards,
                        "notes": notes,
                        "mod": max_mod,
                        "hash": hash,
                    })
                })
                .collect();
            decks.sort_by(|a, b| {
                a["name"]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
            });

            // Full notes list (the drill-in diff data).
            let mut notes: Vec<Value> = Vec::new();
            {
                let mut stmt =
                    db.prepare("SELECT id, guid, mid, mod, flds FROM notes ORDER BY guid")?;
                let rows = stmt.query_map([], |r| {
                    let nid: i64 = r.get(0)?;
                    let guid: String = r.get(1)?;
                    let flds: String = r.get(4)?;
                    let decks = note_decks.remove(&nid).unwrap_or_default();
                    let card_map = note_cards.remove(&nid).unwrap_or_default();
                    let cards_per_deck: Vec<i64> = decks
                        .iter()
                        .map(|did| card_map.get(did).copied().unwrap_or(0))
                        .collect();
                    let field_hash = Sha256::digest(flds.as_bytes());
                    let mut field_hex = String::with_capacity(field_hash.len() * 2);
                    for b in field_hash {
                        field_hex.push_str(&format!("{b:02x}"));
                    }
                    Ok(json!({
                        "guid": guid,
                        "nid": nid,
                        "mid": r.get::<_, i64>(2)?,
                        "mod": r.get::<_, i64>(3)?,
                        "decks": decks,
                        "cards_per_deck": cards_per_deck,
                        "hash": format!("sha256:{field_hex}"),
                        "preview": note_preview(&flds),
                    }))
                })?;
                for row in rows {
                    notes.push(row?);
                }
            }

            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);

            Ok(json!({
                "ts": ts,
                "mod": mod_,
                "scm": scm,
                "usn": usn,
                "schema": ver,
                "decks": decks,
                "notes": notes,
            }))
        })?;

        // Media.db summary (may not exist on a fresh install).
        manifest["media"] = media_manifest_from_path(&media_db_path);

        Ok(manifest)
    }

    /// Fetch the server's manifest via `GET /sync/inspect`. `request` is
    /// `{hkey, endpoint}` (same shape as `syncCollection`). Returns the server's
    /// read-only collection state for the compare view.
    pub fn server_manifest(&self, request: &Value) -> Result<Value, String> {
        let auth = sync_auth_from(request)?;
        let endpoint = auth
            .endpoint
            .as_ref()
            .map(|u| u.as_str().trim_end_matches('/'))
            .unwrap_or("");
        if endpoint.is_empty() {
            return Err("missing endpoint".into());
        }
        // Optional `since=<usn>`: return only notes changed past that usn.
        let url = match request.get("since").and_then(Value::as_i64) {
            Some(s) => format!("{endpoint}/sync/inspect?since={s}"),
            None => format!("{endpoint}/sync/inspect"),
        };
        let header = json!({
            "v": 11,
            "k": auth.hkey,
            "c": kelma_client_label(),
            "s": "",
        })
        .to_string();

        let resp = block_on(async {
            web_client()
                .get(&url)
                .header("anki-sync", &header)
                .send()
                .await
                .map_err(|e| format!("{e:?}"))?
                .error_for_status()
                .map_err(|e| format!("{e:?}"))?
                .json::<Value>()
                .await
                .map_err(|e| format!("{e:?}"))
        })?;
        Ok(resp)
    }

    /// Full field/card content for one *local* note, by nid (preferred) or
    /// guid. Mirrors the server's `NoteDetail` shape for the compare drill-in.
    /// `request` is `{nid?, guid?}`.
    pub fn local_note_detail(&self, request: &Value) -> Result<Value, String> {
        let nid = request.get("nid").and_then(Value::as_i64).unwrap_or(0);
        let guid = request.get("guid").and_then(Value::as_str).unwrap_or("");
        self.with_col(|col| {
            let db = col.storage.db();
            let row: Option<(i64, String, i64, i64, String, String)> = if nid != 0 {
                db.query_row(
                    "SELECT id, guid, mid, mod, flds, tags FROM notes WHERE id = ?",
                    [nid],
                    |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                        ))
                    },
                )
                .optional()?
            } else {
                db.query_row(
                    "SELECT id, guid, mid, mod, flds, tags FROM notes WHERE guid = ?",
                    [guid],
                    |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                        ))
                    },
                )
                .optional()?
            };
            let Some((nid_, guid_, mid, mod_, flds, tags)) = row else {
                return Ok(Value::Null);
            };
            let mut cards: Vec<Value> = Vec::new();
            {
                let mut stmt =
                    db.prepare("SELECT ord, did FROM cards WHERE nid = ? ORDER BY ord")?;
                let rows = stmt.query_map([nid_], |r| {
                    Ok(json!({ "ord": r.get::<_, i64>(0)?, "did": r.get::<_, i64>(1)? }))
                })?;
                for row in rows {
                    cards.push(row?);
                }
            }
            Ok(json!({
                "guid": guid_, "nid": nid_, "mid": mid, "mod": mod_,
                "flds": flds, "tags": tags, "cards": cards,
            }))
        })
    }

    /// Fetch one note's full content from the server via
    /// `GET /sync/inspect/note`. `request` is `{hkey, endpoint, nid?, guid?}`.
    pub fn server_note_detail(&self, request: &Value) -> Result<Value, String> {
        let auth = sync_auth_from(request)?;
        let endpoint = auth
            .endpoint
            .as_ref()
            .map(|u| u.as_str().trim_end_matches('/'))
            .unwrap_or("");
        if endpoint.is_empty() {
            return Err("missing endpoint".into());
        }
        let nid = request.get("nid").and_then(Value::as_i64).unwrap_or(0);
        let guid = request.get("guid").and_then(Value::as_str).unwrap_or("");
        let mut url = format!("{endpoint}/sync/inspect/note?guid={}", urlencode(guid));
        if nid != 0 {
            url.push_str(&format!("&nid={nid}"));
        }
        let header = inspect_header(&auth.hkey);
        let resp = block_on(async {
            let r = web_client()
                .get(&url)
                .header("anki-sync", &header)
                .send()
                .await
                .map_err(|e| format!("{e:?}"))?;
            if r.status().as_u16() == 404 {
                return Ok(Value::Null);
            }
            r.error_for_status()
                .map_err(|e| format!("{e:?}"))?
                .json::<Value>()
                .await
                .map_err(|e| format!("{e:?}"))
        })?;
        Ok(resp)
    }

    /// Write a local note to the server ("force local → server") via
    /// `PUT /sync/notes/:guid`. `request` is `{hkey, endpoint, note}` where
    /// `note` is a local_note_detail shape.
    pub fn write_server_note(&self, request: &Value) -> Result<Value, String> {
        let auth = sync_auth_from(request)?;
        let endpoint = auth
            .endpoint
            .as_ref()
            .map(|u| u.as_str().trim_end_matches('/'))
            .unwrap_or("");
        if endpoint.is_empty() {
            return Err("missing endpoint".into());
        }
        let note = request.get("note").ok_or("missing 'note'")?;
        let guid = note.get("guid").and_then(Value::as_str).unwrap_or("");
        if guid.is_empty() {
            return Err("cannot push a note with an empty GUID".into());
        }
        let body = json!({
            "guid": guid,
            "mid": note.get("mid").and_then(Value::as_i64).unwrap_or(0),
            "mod": note.get("mod").and_then(Value::as_i64).unwrap_or(0),
            "flds": note.get("flds").and_then(Value::as_str).unwrap_or(""),
            "tags": note.get("tags").and_then(Value::as_str).unwrap_or(""),
            "cards": note.get("cards").cloned().unwrap_or(json!([])),
        });
        let url = format!("{endpoint}/sync/notes/{}", urlencode(guid));
        let header = inspect_header(&auth.hkey);
        let resp = block_on(async {
            web_client()
                .put(&url)
                .header("anki-sync", &header)
                .header("content-type", "application/json")
                .body(body.to_string())
                .send()
                .await
                .map_err(|e| format!("{e:?}"))?
                .error_for_status()
                .map_err(|e| format!("{e:?}"))?
                .json::<Value>()
                .await
                .map_err(|e| format!("{e:?}"))
        })?;
        Ok(resp)
    }

    /// Update a local note to match a server note ("accept server"). `request`
    /// is `{nid, server}` where `server` is a NoteDetail shape. Uses rslib's
    /// `update_notes`, which regenerates cards. Returns `{saved:true}`.
    pub fn accept_server_note(&self, request: &Value) -> Result<Value, String> {
        let nid = i64_field(request, "nid")?;
        let server = request.get("server").ok_or("missing 'server'")?;
        let flds = server
            .get("flds")
            .and_then(Value::as_str)
            .unwrap_or("")
            .split('\u{1f}')
            .map(|s| s.to_owned())
            .collect::<Vec<_>>();
        let tags = server
            .get("tags")
            .and_then(Value::as_str)
            .unwrap_or("")
            .split_whitespace()
            .map(|s| s.to_owned())
            .collect::<Vec<_>>();
        let mid = server.get("mid").and_then(Value::as_i64).unwrap_or(0);
        self.with_col(|col| {
            let current = col.get_note(anki_proto::notes::NoteId { nid })?;
            let _ = col.update_notes(anki_proto::notes::UpdateNotesRequest {
                notes: vec![anki_proto::notes::Note {
                    id: nid,
                    guid: current.guid,
                    notetype_id: mid,
                    mtime_secs: 0,
                    usn: 0,
                    tags,
                    fields: flds,
                }],
                skip_undo_entry: false,
            })?;
            Ok(json!({ "saved": true }))
        })
    }

    /// Assign a unique GUID to a local note that lacks one (fixes empty-GUID
    /// duplicate ambiguity). `request` is `{nid}`. Returns `{guid}`.
    pub fn generate_note_guid(&self, request: &Value) -> Result<Value, String> {
        let nid = i64_field(request, "nid")?;
        self.with_col(|col| {
            let new_guid = gen_guid();
            col.storage
                .db()
                .execute("UPDATE notes SET guid = ? WHERE id = ?", (&new_guid, nid))?;
            Ok(json!({ "guid": new_guid }))
        })
    }

    /// Exchange username/password for a KelmaSync v2 bearer token. The JS
    /// contract still calls the field `hkey` for compatibility with the old
    /// Anki-wire UI, but it now stores the v2 token.
    pub fn sync_login(&self, request: &Value) -> Result<Value, String> {
        let username = str_field(request, "username")?;
        let password = str_field(request, "password")?;
        let endpoint = str_field(request, "endpoint")?;
        let resp = v2_json(
            "POST",
            &endpoint,
            "/v2/auth/login",
            None,
            Some(json!({
                "username": username,
                "password": password,
                "client_label": kelma_client_label(),
            })),
        )?;
        let token = resp
            .get("token")
            .and_then(Value::as_str)
            .ok_or_else(|| "v2 login response missing token".to_string())?
            .to_string();
        Ok(json!({ "hkey": token, "endpoint": endpoint }))
    }

    /// Run a complete KelmaSync v2 content sync:
    /// - compares and pulls new/updated decks, notetypes, notes, and cards;
    /// - applies cards by logical identity `(note_guid, ord)` with crt-aware due;
    /// - uploads mobile-authored metadata, notes, reviews, and deletions;
    /// - applies scoped tombstones and requires explicit choices for ties or
    ///   deletion-vs-local-edit conflicts.
    pub fn sync_collection(&self, request: &Value) -> Result<Value, String> {
        let token = str_field(request, "hkey")?;
        let endpoint = str_field(request, "endpoint")?;
        let allow_deletions = request
            .get("allowDeletions")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let conflict_policy = request
            .get("conflictPolicy")
            .and_then(Value::as_str)
            .unwrap_or("");
        let outcome =
            self.v2_sync_collection(&endpoint, &token, allow_deletions, conflict_policy)?;
        Ok(json!({
            "required": if outcome.changed { "normalSyncRequired" } else { "noChanges" },
            "uploadOk": false,
            "downloadOk": false,
            "serverMessage": outcome.message,
            "newEndpoint": Value::Null,
        }))
    }

    fn v2_sync_collection(
        &self,
        endpoint: &str,
        token: &str,
        allow_deletions: bool,
        conflict_policy: &str,
    ) -> Result<V2SyncOutcome, String> {
        let (collection_path, media_folder_path) = {
            let guard = self
                .inner
                .lock()
                .map_err(|_| "session poisoned".to_string())?;
            (
                guard.collection_path.clone(),
                guard.media_folder_path.clone(),
            )
        };
        let mut previous_state = load_v2_sync_state(&collection_path);
        let pushed_deletions =
            push_v2_pending_deletes(endpoint, token, &collection_path, &mut previous_state)?;
        let manifest = v2_json("GET", endpoint, "/v2/sync/manifest", Some(token), None)?;
        let deleted = self.with_col_result(|col| {
            apply_v2_tombstones(
                col,
                &manifest,
                &previous_state,
                &media_folder_path,
                allow_deletions,
            )
        })?;

        // Build local canonical note/card hashes in two SQL scans. Existing
        // resources are compared too: mobile must pull server edits, not only
        // resources missing from a fresh collection.
        let (local_notes, local_cards, local_notetypes, local_decks) =
            self.with_col_result(|col| {
                let notes = {
                    let db = col.storage.db();
                    let mut notes = HashMap::new();
                    let mut stmt = db
                        .prepare("SELECT guid, mod, usn, flds, tags FROM notes WHERE guid <> ''")
                        .map_err(|e| format!("prepare local notes: {e}"))?;
                    let rows = stmt
                        .query_map([], |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, i64>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, String>(4)?,
                            ))
                        })
                        .map_err(|e| format!("query local notes: {e}"))?;
                    for (guid, modified, usn, fields, tags) in rows.filter_map(Result::ok) {
                        let fields = fields
                            .split('\u{1f}')
                            .map(str::to_string)
                            .collect::<Vec<_>>();
                        let tags = tags
                            .split_whitespace()
                            .map(str::to_string)
                            .collect::<Vec<_>>();
                        notes.insert(
                            guid,
                            LocalV2Note {
                                checksum: v2_note_checksum(&fields, &tags),
                                modified: rfc3339_from_secs(modified),
                                usn,
                            },
                        );
                    }
                    notes
                };

                let cards = {
                    let db = col.storage.db();
                    let mut cards = HashMap::new();
                    let mut stmt = db
                        .prepare(
                            "SELECT n.guid, c.ord, d.name, c.mod, c.usn FROM cards c \
                         JOIN notes n ON n.id=c.nid JOIN decks d ON d.id=c.did \
                         WHERE n.guid <> ''",
                        )
                        .map_err(|e| format!("prepare local cards: {e}"))?;
                    let rows = stmt
                        .query_map([], |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, i64>(3)?,
                                row.get::<_, i64>(4)?,
                            ))
                        })
                        .map_err(|e| format!("query local cards: {e}"))?;
                    for (guid, ord, deck, modified, usn) in rows.filter_map(Result::ok) {
                        cards.insert(
                            format!("{guid}:{ord}"),
                            LocalV2Card {
                                checksum: v2_card_checksum(&guid, &deck, ord),
                                modified: rfc3339_from_secs(modified),
                                usn,
                            },
                        );
                    }
                    cards
                };
                let notetypes = local_v2_notetype_checksums(col)?;
                let decks = local_v2_deck_checksums(col)?;
                Ok((notes, cards, notetypes, decks))
            })?;

        let server_notes = manifest
            .get("notes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let server_note_checksums = server_notes
            .iter()
            .filter_map(|note| {
                Some((
                    note.get("guid")?.as_str()?.to_string(),
                    note.get("checksum")?.as_str()?.to_string(),
                ))
            })
            .collect::<HashMap<_, _>>();
        let server_note_guids = server_notes
            .iter()
            .filter_map(|note| note.get("guid").and_then(Value::as_str))
            .filter(|guid| {
                let server_checksum = server_note_checksums
                    .get(*guid)
                    .map(String::as_str)
                    .unwrap_or("");
                local_notes
                    .get(*guid)
                    .map(|local| local.checksum.as_str() != server_checksum)
                    .unwrap_or(true)
            })
            .map(str::to_string)
            .collect::<Vec<_>>();

        let mut content_conflicts = Vec::new();
        let mut server_card_ids = Vec::new();
        for card in manifest
            .get("cards")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let guid = card.get("note_guid").and_then(Value::as_str).unwrap_or("");
            let ord = card.get("ord").and_then(Value::as_i64).unwrap_or(0);
            let key = format!("{guid}:{ord}");
            let Some(local) = local_cards.get(&key) else {
                if let Some(card_id) = card.get("card_id").and_then(Value::as_i64) {
                    server_card_ids.push(card_id);
                }
                continue;
            };
            let server_checksum = card.get("checksum").and_then(Value::as_str).unwrap_or("");
            let server_modified = card
                .get("client_modified_at")
                .and_then(Value::as_str)
                .unwrap_or("");
            let structural_difference = server_checksum != local.checksum;
            let server_is_newer = rfc3339_to_secs(server_modified).unwrap_or(0)
                > rfc3339_to_secs(&local.modified).unwrap_or(0);
            let local_is_newer = rfc3339_to_secs(&local.modified).unwrap_or(0)
                > rfc3339_to_secs(server_modified).unwrap_or(0);
            let pull = if structural_difference && local.usn == -1 {
                if server_is_newer || conflict_policy == "server" {
                    true
                } else if local_is_newer || conflict_policy == "local" {
                    false
                } else {
                    content_conflicts.push(format!("card {key}"));
                    false
                }
            } else {
                structural_difference || server_is_newer
            };
            if pull {
                if let Some(card_id) = card.get("card_id").and_then(Value::as_i64) {
                    server_card_ids.push(card_id);
                }
            }
        }
        if !content_conflicts.is_empty() && conflict_policy.is_empty() {
            return Err(format!(
                "KELMA_CONTENT_CONFIRM:{}",
                content_conflicts.join(", ")
            ));
        }

        let server_notetype_ids = manifest
            .get("notetypes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|n| {
                let id = n.get("notetype_id").and_then(Value::as_i64).unwrap_or(0);
                let checksum = n.get("checksum").and_then(Value::as_str).unwrap_or("");
                local_notetypes
                    .get(&id)
                    .map(|local| local != checksum)
                    .unwrap_or(true)
            })
            .filter_map(|n| n.get("notetype_id").and_then(Value::as_i64))
            .collect::<Vec<_>>();
        let server_deck_names = manifest
            .get("decks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|d| {
                let name = d.get("name").and_then(Value::as_str).unwrap_or("");
                let checksum = d.get("checksum").and_then(Value::as_str).unwrap_or("");
                local_decks
                    .get(name)
                    .map(|local| local != checksum)
                    .unwrap_or(true)
            })
            .filter_map(|d| d.get("name").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();

        let mut pulled_notes = Vec::<Value>::new();
        for chunk in server_note_guids.chunks(3000) {
            let resp = v2_json(
                "POST",
                endpoint,
                "/v2/batch/pull",
                Some(token),
                Some(json!({
                    "notes": chunk, "cards": [], "notetypes": [], "decks": []
                })),
            )?;
            pulled_notes.extend(
                resp.get("notes")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            );
        }
        let mut pulled_cards = Vec::<Value>::new();
        for chunk in server_card_ids.chunks(3000) {
            let resp = v2_json(
                "POST",
                endpoint,
                "/v2/batch/pull",
                Some(token),
                Some(json!({
                    "notes": [], "cards": chunk, "notetypes": [], "decks": []
                })),
            )?;
            pulled_cards.extend(
                resp.get("cards")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            );
        }
        let mut pulled_notetypes = Vec::<Value>::new();
        for chunk in server_notetype_ids.chunks(200) {
            let resp = v2_json(
                "POST",
                endpoint,
                "/v2/batch/pull",
                Some(token),
                Some(json!({
                    "notes": [], "cards": [], "notetypes": chunk, "decks": []
                })),
            )?;
            pulled_notetypes.extend(
                resp.get("notetypes")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            );
        }
        let mut pulled_decks = Vec::<Value>::new();
        for chunk in server_deck_names.chunks(200) {
            let resp = v2_json(
                "POST",
                endpoint,
                "/v2/batch/pull",
                Some(token),
                Some(json!({
                    "notes": [], "cards": [], "notetypes": [], "decks": chunk
                })),
            )?;
            pulled_decks.extend(
                resp.get("decks")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            );
        }

        let mut note_apply_guids = HashSet::new();
        let mut note_conflicts = Vec::new();
        for note in &pulled_notes {
            let guid = note.get("guid").and_then(Value::as_str).unwrap_or("");
            if guid.is_empty() {
                continue;
            }
            let Some(local) = local_notes.get(guid) else {
                note_apply_guids.insert(guid.to_string());
                continue;
            };
            if local.usn != -1 {
                note_apply_guids.insert(guid.to_string());
                continue;
            }
            let server_modified = note
                .get("client_modified_at")
                .or_else(|| note.get("modified_at"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if rfc3339_to_secs(server_modified).unwrap_or(0)
                > rfc3339_to_secs(&local.modified).unwrap_or(0)
                || conflict_policy == "server"
            {
                note_apply_guids.insert(guid.to_string());
            } else if rfc3339_to_secs(&local.modified).unwrap_or(0)
                > rfc3339_to_secs(server_modified).unwrap_or(0)
                || conflict_policy == "local"
            {
                // Keep the pending local version; it is pushed below using the
                // manifest checksum as its optimistic-concurrency base.
            } else {
                note_conflicts.push(format!("note {guid}"));
            }
        }
        if !note_conflicts.is_empty() && conflict_policy.is_empty() {
            return Err(format!(
                "KELMA_CONTENT_CONFIRM:{}",
                note_conflicts.join(", ")
            ));
        }

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "session poisoned".to_string())?;
        let col = guard
            .col
            .as_mut()
            .ok_or_else(|| "collection is not open".to_string())?;
        // The local collection's creation day. Anki review `due` values are days
        // since this crt, so scheduling written by a collection with a
        // different crt must be shifted to this collection's day scale.
        let local_crt: i64 = col
            .storage
            .db()
            .query_row("SELECT crt FROM col", [], |r| r.get(0))
            .unwrap_or(0);
        let local_crt_day = local_crt / 86400;
        let mut created_decks = 0usize;
        let mut applied_decks = 0usize;
        for deck in &pulled_decks {
            if apply_v2_deck(col, deck)? {
                created_decks += 1;
            }
            applied_decks += 1;
        }

        let mut applied_notetypes = 0usize;
        for nt in &pulled_notetypes {
            let ntid = nt.get("notetype_id").and_then(Value::as_i64).unwrap_or(0);
            if ntid == 0 {
                continue;
            }
            let name = nt.get("name").and_then(Value::as_str).unwrap_or("Notetype");
            prepare_v2_notetype_slot(
                col,
                ntid,
                name,
                previous_state.notetypes.contains(&ntid),
                conflict_policy == "server",
            )?;
            let mut definition = nt.get("definition").cloned().unwrap_or_else(|| json!({}));
            if let Some(obj) = definition.as_object_mut() {
                obj.insert("id".to_string(), json!(ntid));
                if let Some(name) = nt.get("name").and_then(Value::as_str) {
                    obj.insert("name".to_string(), json!(name));
                }
                let modified = nt
                    .get("client_modified_at")
                    .or_else(|| nt.get("modified_at"))
                    .and_then(Value::as_str)
                    .and_then(rfc3339_to_secs)
                    .unwrap_or(0);
                obj.insert("mod".to_string(), json!(modified));
                obj.insert("usn".to_string(), json!(0));
            }
            let json_bytes =
                serde_json::to_vec(&definition).map_err(|e| format!("notetype json: {e}"))?;
            let _ = col
                .add_or_update_notetype(anki_proto::notetypes::AddOrUpdateNotetypeRequest {
                    json: json_bytes,
                    skip_checks: true,
                    preserve_usn_and_mtime: true,
                })
                .map_err(|e| format!("apply notetype {ntid}: {e:?}"))?;
            applied_notetypes += 1;
        }

        // Server card records carry the deck name for each note. Pick the first
        // card deck as the note's add target; card placement is corrected below.
        let mut note_deck: HashMap<String, String> = HashMap::new();
        for card in &pulled_cards {
            if let (Some(guid), Some(deck)) = (
                card.get("note_guid").and_then(Value::as_str),
                card.get("deck_name").and_then(Value::as_str),
            ) {
                note_deck
                    .entry(guid.to_string())
                    .or_insert_with(|| deck.to_string());
            }
        }

        let mut added_notes = 0usize;
        let mut updated_notes = 0usize;
        for note in &pulled_notes {
            let guid = note.get("guid").and_then(Value::as_str).unwrap_or("");
            if guid.is_empty() || !note_apply_guids.contains(guid) {
                continue;
            }
            let existing: Option<i64> = col
                .storage
                .db()
                .query_row("SELECT id FROM notes WHERE guid = ?", [guid], |r| r.get(0))
                .optional()
                .map_err(|e| format!("check note {guid}: {e}"))?;
            let ntid = note.get("notetype_id").and_then(Value::as_i64).unwrap_or(0);
            let fields = note
                .get("fields")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|v| v.as_str().unwrap_or("").to_string())
                .collect::<Vec<_>>();
            let tags = note
                .get("tags")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<_>>();
            let modified = note
                .get("client_modified_at")
                .or_else(|| note.get("modified_at"))
                .and_then(Value::as_str)
                .and_then(rfc3339_to_secs)
                .unwrap_or(0);

            if let Some(nid) = existing {
                let _ = col
                    .update_notes(anki_proto::notes::UpdateNotesRequest {
                        notes: vec![anki_proto::notes::Note {
                            id: nid,
                            guid: guid.to_string(),
                            notetype_id: ntid,
                            mtime_secs: modified.clamp(0, u32::MAX as i64) as u32,
                            usn: 0,
                            tags,
                            fields,
                        }],
                        skip_undo_entry: true,
                    })
                    .map_err(|e| format!("update note {guid}: {e:?}"))?;
                col.storage
                    .db()
                    .execute("UPDATE notes SET mod=?, usn=0 WHERE id=?", (modified, nid))
                    .map_err(|e| format!("stamp note {guid}: {e}"))?;
                updated_notes += 1;
                continue;
            }

            let nt = col
                .get_notetype(NotetypeId(ntid))
                .map_err(|e| format!("get notetype {ntid}: {e:?}"))?
                .ok_or_else(|| format!("server note {guid} references missing notetype {ntid}"))?;
            let deck_name = note_deck.get(guid).map(String::as_str).unwrap_or("Default");
            ensure_deck(col, deck_name)?;
            let did = deck_id_by_name(col, deck_name)?.unwrap_or(DeckId(1));
            let mut local = nt.new_note();
            for (idx, field) in fields.iter().enumerate() {
                if idx < local.fields().len() {
                    local
                        .set_field(idx, field.clone())
                        .map_err(|e| format!("set note field {guid}: {e:?}"))?;
                }
            }
            local.tags = tags;
            col.add_note(&mut local, did)
                .map_err(|e| format!("add note {guid}: {e:?}"))?;
            col.storage
                .db()
                .execute(
                    "UPDATE notes SET guid = ?, mod = ?, usn = 0 WHERE id = ?",
                    (&guid, modified, local.id.0),
                )
                .map_err(|e| format!("stamp guid {guid}: {e}"))?;
            added_notes += 1;
        }

        // Resolve every logical card identity in one scan instead of one SQL
        // query per pulled card.
        let local_card_ids: HashMap<String, i64> = {
            let db = col.storage.db();
            let mut stmt = db.prepare(
                "SELECT n.guid, c.ord, c.id FROM cards c JOIN notes n ON n.id=c.nid WHERE n.guid <> ''",
            ).map_err(|e| format!("prepare local card identities: {e}"))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .map_err(|e| format!("query local card identities: {e}"))?;
            rows.filter_map(Result::ok)
                .map(|(guid, ord, card_id)| (format!("{guid}:{ord}"), card_id))
                .collect()
        };

        let mut applied_cards = 0usize;
        for card in &pulled_cards {
            let guid = card.get("note_guid").and_then(Value::as_str).unwrap_or("");
            let ord = card.get("ord").and_then(Value::as_i64).unwrap_or(0);
            if guid.is_empty() {
                continue;
            }
            let Some(cid) = local_card_ids.get(&format!("{guid}:{ord}")).copied() else {
                continue;
            };
            let deck_name = card
                .get("deck_name")
                .and_then(Value::as_str)
                .unwrap_or("Default");
            ensure_deck(col, deck_name)?;
            let did = deck_id_by_name(col, deck_name)?.unwrap_or(DeckId(1));
            let sched = card.get("scheduling").and_then(Value::as_object);
            let s_i64 = |key: &str| -> i64 {
                sched
                    .and_then(|m| m.get(key))
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
            };
            let s_str = |key: &str| -> String {
                sched
                    .and_then(|m| m.get(key))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            let queue = s_i64("queue");
            // Shift day-based due values from the writer's collection day scale
            // to ours. Review (2) and day-learning (3) store `due` in days since
            // the writing collection's crt; other queues are date/position
            // values that are already collection-independent.
            let writer_crt_day = card
                .get("scheduling")
                .and_then(|s| s.get("_crt"))
                .and_then(Value::as_i64)
                .map(|c| c / 86400)
                .unwrap_or(local_crt_day);
            let day_shift = writer_crt_day - local_crt_day;
            let due = if queue == 2 || queue == 3 {
                s_i64("due") + day_shift
            } else {
                s_i64("due")
            };
            let odue = if s_i64("odid") != 0 && (queue == 2 || queue == 3) {
                s_i64("odue") + day_shift
            } else {
                s_i64("odue")
            };
            let modified = card
                .get("client_modified_at")
                .or_else(|| card.get("modified_at"))
                .and_then(Value::as_str)
                .and_then(rfc3339_to_secs)
                .unwrap_or(0);
            col.storage.db().execute(
                "UPDATE cards SET did=?, type=?, queue=?, due=?, ivl=?, factor=?, reps=?, lapses=?, left=?, odue=?, odid=?, flags=?, data=?, mod=?, usn=0 WHERE id=?",
                rusqlite::params![
                    did.0, s_i64("type"), queue, due, s_i64("ivl"),
                    s_i64("factor"), s_i64("reps"), s_i64("lapses"), s_i64("left"),
                    odue, s_i64("odid"), s_i64("flags"), s_str("data"), modified, cid
                ],
            )
            .map_err(|e| format!("apply card {guid}:{ord}: {e}"))?;
            applied_cards += 1;
        }

        // --- Upload local changes (usn = -1 marks rows changed since last sync,
        // e.g. a card answered during review, or a note edited on device). ---

        // Pending notes -> push as v2 note records.
        let pending_notes: Vec<(String, i64, i64, String, String)> = {
            let db = col.storage.db();
            let mut stmt = db
                .prepare(
                    "SELECT guid, mid, mod, flds, tags FROM notes WHERE usn = -1 AND guid <> ''",
                )
                .map_err(|e| format!("query pending notes: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                })
                .map_err(|e| format!("map pending notes: {e}"))?;
            rows.filter_map(Result::ok).collect()
        };
        let mut note_payloads = Vec::<Value>::new();
        let mut already_synced_note_guids = Vec::<String>::new();
        for (guid, mid, nmod, flds, tags) in &pending_notes {
            let fields = flds.split('\u{1f}').map(str::to_string).collect::<Vec<_>>();
            let tags = tags
                .split_whitespace()
                .map(str::to_string)
                .collect::<Vec<_>>();
            let checksum = v2_note_checksum(&fields, &tags);
            let server_checksum = server_note_checksums.get(guid).map(String::as_str);
            if server_checksum == Some(checksum.as_str()) {
                already_synced_note_guids.push(guid.clone());
                continue;
            }
            note_payloads.push(json!({
                "guid": guid,
                "notetype_id": mid,
                "fields": fields,
                "tags": tags,
                "client_modified_at": rfc3339_from_secs(*nmod),
                "base_checksum": server_checksum.unwrap_or(""),
            }));
        }

        // Pending cards -> push scheduling by logical (note_guid, ord) identity,
        // tagging each with our crt so other collections can convert `due`.
        let pending_cards: Vec<(
            i64,
            String,
            i64,
            String,
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
            String,
        )> = {
            let db = col.storage.db();
            let mut stmt = db
                .prepare(
                    "SELECT c.id, n.guid, c.ord, d.name, c.mod, c.type, c.queue, c.due, c.ivl, c.factor, \
                            c.reps, c.lapses, c.left, c.odue, c.odid, c.flags, c.data \
                     FROM cards c JOIN notes n ON n.id = c.nid JOIN decks d ON d.id = c.did \
                     WHERE c.usn = -1 AND n.guid <> ''",
                )
                .map_err(|e| format!("query pending cards: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, i64>(5)?,
                        r.get::<_, i64>(6)?,
                        r.get::<_, i64>(7)?,
                        r.get::<_, i64>(8)?,
                        r.get::<_, i64>(9)?,
                        r.get::<_, i64>(10)?,
                        r.get::<_, i64>(11)?,
                        r.get::<_, i64>(12)?,
                        r.get::<_, i64>(13)?,
                        r.get::<_, i64>(14)?,
                        r.get::<_, i64>(15)?,
                        r.get::<_, String>(16)?,
                    ))
                })
                .map_err(|e| format!("map pending cards: {e}"))?;
            rows.filter_map(Result::ok).collect()
        };
        let mut card_payloads = Vec::<Value>::new();
        for c in &pending_cards {
            let (
                cid,
                guid,
                ord,
                deck,
                cmod,
                ctype,
                queue,
                due,
                ivl,
                factor,
                reps,
                lapses,
                left,
                odue,
                odid,
                flags,
                data,
            ) = c;
            card_payloads.push(json!({
                "card_id": cid,
                "note_guid": guid,
                "deck_name": deck,
                "ord": ord,
                "scheduling": {
                    "type": ctype, "queue": queue, "due": due, "ivl": ivl, "factor": factor,
                    "reps": reps, "lapses": lapses, "left": left, "odue": odue, "odid": odid,
                    "flags": flags, "data": data, "_crt": local_crt,
                },
                "client_modified_at": rfc3339_from_secs(*cmod),
            }));
        }

        // Mobile-created notes/cards may reference metadata that does not exist
        // on the server yet. Publish that metadata first so FK validation can
        // never reject the content batch.
        let server_notetype_set = manifest
            .get("notetypes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|v| v.get("notetype_id").and_then(Value::as_i64))
            .collect::<HashSet<_>>();
        let server_deck_set = manifest
            .get("decks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|v| v.get("name").and_then(Value::as_str).map(str::to_string))
            .collect::<HashSet<_>>();
        let missing_notetypes = note_payloads
            .iter()
            .filter_map(|n| n.get("notetype_id").and_then(Value::as_i64))
            .filter(|id| !server_notetype_set.contains(id))
            .collect::<HashSet<_>>();
        let missing_decks = card_payloads
            .iter()
            .filter_map(|c| {
                c.get("deck_name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .filter(|name| !server_deck_set.contains(name))
            .collect::<HashSet<_>>();
        let mut notetype_payloads = Vec::new();
        for ntid in missing_notetypes {
            notetype_payloads.push(v2_notetype_payload(col, ntid)?);
        }
        let mut deck_payloads = Vec::new();
        for name in missing_decks {
            deck_payloads.push(v2_deck_payload(col, &name)?);
        }

        let mut pushed_notetypes = 0usize;
        for chunk in notetype_payloads.chunks(200) {
            let resp = v2_json(
                "POST",
                endpoint,
                "/v2/batch/push",
                Some(token),
                Some(json!({
                    "notes": [], "cards": [], "notetypes": chunk, "decks": []
                })),
            )?;
            ensure_v2_batch_without_conflicts(&resp, "notetypes", chunk.len())?;
            pushed_notetypes += chunk.len();
        }
        let mut pushed_decks = 0usize;
        for chunk in deck_payloads.chunks(200) {
            let resp = v2_json(
                "POST",
                endpoint,
                "/v2/batch/push",
                Some(token),
                Some(json!({
                    "notes": [], "cards": [], "notetypes": [], "decks": chunk
                })),
            )?;
            ensure_v2_batch_without_conflicts(&resp, "decks", chunk.len())?;
            pushed_decks += chunk.len();
        }

        let db = col.storage.db();
        for guid in &already_synced_note_guids {
            db.execute("UPDATE notes SET usn=0 WHERE guid=? AND usn=-1", [guid])
                .map_err(|e| format!("clear matching note {guid}: {e}"))?;
        }

        let mut pushed_notes = 0usize;
        let mut accepted_note_guids = Vec::<String>::new();
        for chunk in note_payloads.chunks(3000) {
            let resp = v2_json(
                "POST",
                endpoint,
                "/v2/batch/push",
                Some(token),
                Some(json!({
                    "notes": chunk, "cards": [], "notetypes": [], "decks": []
                })),
            )?;
            let conflicts = resp
                .get("conflicts")
                .and_then(|v| v.get("notes"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if !conflicts.is_empty() {
                let ids = conflicts
                    .iter()
                    .filter_map(|v| v.get("guid").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(format!("KELMA_CONTENT_CONFIRM:note {ids}"));
            }
            let accepted = resp
                .get("accepted")
                .and_then(|a| a.get("notes"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            if accepted != chunk.len() {
                return Err(format!(
                    "server accepted {accepted}/{} notes; keeping them pending",
                    chunk.len()
                ));
            }
            pushed_notes += accepted;
            accepted_note_guids.extend(
                chunk
                    .iter()
                    .filter_map(|v| v.get("guid").and_then(Value::as_str).map(str::to_string)),
            );
        }
        for guid in &accepted_note_guids {
            db.execute("UPDATE notes SET usn=0 WHERE guid=? AND usn=-1", [guid])
                .map_err(|e| format!("clear uploaded note {guid}: {e}"))?;
        }

        let mut pushed_cards = 0usize;
        let mut accepted_cards = Vec::<(String, i64)>::new();
        for chunk in card_payloads.chunks(3000) {
            let resp = v2_json(
                "POST",
                endpoint,
                "/v2/batch/push",
                Some(token),
                Some(json!({
                    "notes": [], "cards": chunk, "notetypes": [], "decks": []
                })),
            )?;
            let accepted = resp
                .get("accepted")
                .and_then(|a| a.get("cards"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            pushed_cards += accepted;
            // Cards are newest-wins. If all were accepted, we know exactly
            // which local rows converged. If a concurrent newer server card
            // caused a skip, leave the whole chunk pending for the next pull.
            if accepted == chunk.len() {
                accepted_cards.extend(chunk.iter().filter_map(|v| {
                    Some((
                        v.get("note_guid")?.as_str()?.to_string(),
                        v.get("ord")?.as_i64()?,
                    ))
                }));
            }
        }
        for (guid, ord) in &accepted_cards {
            db.execute(
                "UPDATE cards SET usn=0 WHERE usn=-1 AND ord=? AND nid IN (SELECT id FROM notes WHERE guid=?)",
                (ord, guid),
            )
            .map_err(|e| format!("clear uploaded card {guid}:{ord}: {e}"))?;
        }

        // Capture canonical card IDs after pushes so future card tombstones can
        // be resolved to this collection's logical (guid, ord) identity.
        let final_manifest = if pushed_notes + pushed_cards + pushed_notetypes + pushed_decks > 0 {
            v2_json("GET", endpoint, "/v2/sync/manifest", Some(token), None)?
        } else {
            manifest.clone()
        };
        drop(guard);
        save_v2_sync_state(&collection_path, &final_manifest, &previous_state)?;

        Ok(V2SyncOutcome {
            changed: deleted > 0
                || pushed_deletions > 0
                || added_notes > 0
                || updated_notes > 0
                || applied_cards > 0
                || applied_notetypes > 0
                || applied_decks > 0
                || pushed_notes > 0
                || pushed_cards > 0
                || pushed_notetypes > 0
                || pushed_decks > 0,
            message: format!(
                "v2 sync: pushed {pushed_deletions} local deletion(s), applied {deleted} server deletion(s); pulled {applied_decks} deck(s) ({created_decks} new), {applied_notetypes} notetype(s), {added_notes} new + {updated_notes} updated note(s), {applied_cards} card(s); pushed {pushed_decks} deck(s), {pushed_notetypes} notetype(s), {pushed_notes} note(s), {pushed_cards} card(s)"
            ),
        })
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

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "session poisoned".to_string())?;
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

    /// Sync referenced media through KelmaSync v2 with the same 50-request
    /// concurrency used by the desktop clients.
    pub fn sync_media(&self, request: &Value) -> Result<Value, String> {
        let token = str_field(request, "hkey")?;
        let endpoint = str_field(request, "endpoint")?;
        let (collection_path, media_folder, refs) = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| "session poisoned".to_string())?;
            let collection_path = guard.collection_path.clone();
            let media_folder = guard.media_folder_path.clone();
            let col = guard
                .col
                .as_mut()
                .ok_or_else(|| "collection is not open".to_string())?;
            let refs = referenced_v2_media(col)?;
            (collection_path, media_folder, refs)
        };
        let downloaded = v2_sync_media_downloads(
            &endpoint,
            &token,
            &collection_path,
            &media_folder,
            refs,
            None,
        )?;
        let (files, bytes) = media_folder_totals(&media_folder)?;
        Ok(json!({ "files": files, "bytes": bytes, "downloaded": downloaded }))
    }

    /// Start a 50-request v2 media sync on a background thread. The UI
    /// polls `sync_media_poll`, so review/UI work remains responsive.
    pub fn sync_media_start(&self, request: &Value) -> Result<Value, String> {
        let token = str_field(request, "hkey")?;
        let endpoint = str_field(request, "endpoint")?;
        let (collection_path, media_folder, refs) = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| "session poisoned".to_string())?;
            let collection_path = guard.collection_path.clone();
            let media_folder = guard.media_folder_path.clone();
            let col = guard
                .col
                .as_mut()
                .ok_or_else(|| "collection is not open".to_string())?;
            let refs = referenced_v2_media(col)?;
            (collection_path, media_folder, refs)
        };

        if self
            .media_progress
            .lock()
            .map_err(|_| "session poisoned".to_string())?
            .is_some()
        {
            return Err("a media sync is already running".to_string());
        }

        let progress = Arc::new(Mutex::new(V2MediaProgress::default()));
        let done: Arc<Mutex<Option<Result<Value, String>>>> = Arc::new(Mutex::new(None));
        *self
            .media_progress
            .lock()
            .map_err(|_| "session poisoned".to_string())? = Some(progress.clone());
        *self
            .media_done
            .lock()
            .map_err(|_| "session poisoned".to_string())? = Some(done.clone());

        thread::spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                v2_sync_media_downloads(
                    &endpoint,
                    &token,
                    &collection_path,
                    &media_folder,
                    refs,
                    Some(progress),
                )
            }));
            let result = match outcome {
                Ok(Ok(_)) => {
                    let (files, bytes) = media_folder_totals(&media_folder).unwrap_or((0, 0));
                    Ok(json!({ "files": files, "bytes": bytes }))
                }
                Ok(Err(error)) => Err(error),
                Err(_) => Err("media sync worker panicked".to_string()),
            };
            if let Ok(mut slot) = done.lock() {
                *slot = Some(result);
            }
        });

        Ok(json!({ "started": true }))
    }

    /// Poll an in-flight media sync. Returns `{done, checked, downloadedFiles,
    /// downloadedDeletions, uploadedFiles, uploadedDeletions}` while running, and
    /// once finished adds `{ok, files, bytes}` or `{ok:false, error}`.
    pub fn sync_media_poll(&self) -> Result<Value, String> {
        let (checked, dl_files, dl_del, up_files, up_del) = {
            let cell = self
                .media_progress
                .lock()
                .map_err(|_| "session poisoned".to_string())?;
            let counters = match cell.as_ref().and_then(|arc| arc.lock().ok()) {
                Some(p) => (p.checked, p.downloaded_files, 0, p.uploaded_files, 0),
                None => (0, 0, 0, 0, 0),
            };
            counters
        };

        let finished = {
            let slot = self
                .media_done
                .lock()
                .map_err(|_| "session poisoned".to_string())?;
            match slot.as_ref() {
                Some(done_arc) => done_arc
                    .lock()
                    .map_err(|_| "session poisoned".to_string())?
                    .clone(),
                None => return Err("no media sync is running".to_string()),
            }
        };

        if let Some(result) = finished {
            *self
                .media_progress
                .lock()
                .map_err(|_| "session poisoned".to_string())? = None;
            *self
                .media_done
                .lock()
                .map_err(|_| "session poisoned".to_string())? = None;
            return match result {
                Ok(totals) => Ok(json!({
                    "done": true, "ok": true,
                    "files": totals.get("files").cloned().unwrap_or_else(|| json!(0)),
                    "bytes": totals.get("bytes").cloned().unwrap_or_else(|| json!(0)),
                    "checked": checked, "downloadedFiles": dl_files,
                    "downloadedDeletions": dl_del, "uploadedFiles": up_files,
                    "uploadedDeletions": up_del,
                })),
                Err(error) => Ok(json!({
                    "done": true, "ok": false, "error": error,
                    "checked": checked, "downloadedFiles": dl_files,
                    "downloadedDeletions": dl_del, "uploadedFiles": up_files,
                    "uploadedDeletions": up_del,
                })),
            };
        }

        Ok(json!({
            "done": false,
            "checked": checked, "downloadedFiles": dl_files,
            "downloadedDeletions": dl_del, "uploadedFiles": up_files,
            "uploadedDeletions": up_del,
        }))
    }

    /// Start a full collection sync (`upload=false` → download, replacing local)
    /// on a background thread and return immediately. `full_sync_poll` reports
    /// byte progress and, once finished, reopens the collection.
    pub fn full_sync_start(&self, request: &Value) -> Result<Value, String> {
        let auth = sync_auth_from(request)?;
        let upload = request
            .get("upload")
            .and_then(Value::as_bool)
            .ok_or_else(|| "missing 'upload' boolean".to_string())?;

        if self
            .full_progress
            .lock()
            .map_err(|_| "session poisoned".to_string())?
            .is_some()
        {
            return Err("a full sync is already running".to_string());
        }

        // Take the collection out (full sync consumes it) and grab its progress
        // cell before moving it to the worker.
        let (col, progress_cell) = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| "session poisoned".to_string())?;
            let col = guard
                .col
                .take()
                .ok_or_else(|| "collection is not open".to_string())?;
            let progress_cell = col.shared_progress();
            (col, progress_cell)
        };

        let done: Arc<Mutex<Option<Result<Value, String>>>> = Arc::new(Mutex::new(None));
        *self
            .full_progress
            .lock()
            .map_err(|_| "session poisoned".to_string())? = Some(progress_cell);
        *self
            .full_done
            .lock()
            .map_err(|_| "session poisoned".to_string())? = Some(done.clone());

        thread::spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if upload {
                    block_on(col.full_upload(auth, web_client()))
                } else {
                    block_on(col.full_download(auth, web_client()))
                }
            }));
            let result = match outcome {
                Ok(Ok(())) => Ok(json!({ "completed": true, "upload": upload })),
                Ok(Err(error)) => Err(format!("{error:?}")),
                Err(_) => Err("full sync worker panicked".to_string()),
            };
            if let Ok(mut slot) = done.lock() {
                *slot = Some(result);
            }
        });

        Ok(json!({ "started": true }))
    }

    /// Poll an in-flight full sync. Returns `{done, transferredBytes,
    /// totalBytes}`; once finished, reopens the (consumed) collection and adds
    /// `{ok}` or `{ok:false, error}`.
    pub fn full_sync_poll(&self) -> Result<Value, String> {
        let (transferred, total) = {
            let cell = self
                .full_progress
                .lock()
                .map_err(|_| "session poisoned".to_string())?;
            match cell
                .as_ref()
                .and_then(|arc| arc.lock().ok().and_then(|s| s.last_progress))
            {
                Some(Progress::FullSync(p)) => (p.transferred_bytes, p.total_bytes),
                _ => (0, 0),
            }
        };

        let finished = {
            let slot = self
                .full_done
                .lock()
                .map_err(|_| "session poisoned".to_string())?;
            match slot.as_ref() {
                Some(done_arc) => done_arc
                    .lock()
                    .map_err(|_| "session poisoned".to_string())?
                    .clone(),
                None => return Err("no full sync is running".to_string()),
            }
        };

        if let Some(result) = finished {
            // The collection was consumed (and replaced on disk); reopen it so
            // review can resume, whether the sync succeeded or failed.
            {
                let mut guard = self
                    .inner
                    .lock()
                    .map_err(|_| "session poisoned".to_string())?;
                if guard.col.is_none() {
                    let reopened = build_collection(
                        &guard.collection_path,
                        &guard.media_folder_path,
                        &guard.media_db_path,
                    )?;
                    guard.col = Some(reopened);
                }
            }
            *self
                .full_progress
                .lock()
                .map_err(|_| "session poisoned".to_string())? = None;
            *self
                .full_done
                .lock()
                .map_err(|_| "session poisoned".to_string())? = None;
            return match result {
                Ok(_) => Ok(json!({
                    "done": true, "ok": true,
                    "transferredBytes": transferred, "totalBytes": total,
                })),
                Err(error) => Ok(json!({
                    "done": true, "ok": false, "error": error,
                    "transferredBytes": transferred, "totalBytes": total,
                })),
            };
        }

        Ok(json!({
            "done": false,
            "transferredBytes": transferred, "totalBytes": total,
        }))
    }

    /// Wipe this device's local media: delete every file in the media folder and
    /// the media DB (so media-sync state resets to empty), then reopen. After
    /// this, a media sync has nothing local to push and downloads the server's
    /// media instead — the media half of a "reset & download from server".
    pub fn reset_media(&self) -> Result<Value, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "session poisoned".to_string())?;

        // Close the collection first so no handle keeps media.db open.
        guard.col.take();

        let media_dir = std::path::Path::new(&guard.media_folder_path).to_path_buf();
        if media_dir.exists() {
            for entry in
                std::fs::read_dir(&media_dir).map_err(|e| format!("read media dir: {e}"))?
            {
                let entry = entry.map_err(|e| format!("read media entry: {e}"))?;
                if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        } else {
            std::fs::create_dir_all(&media_dir).map_err(|e| format!("create media dir: {e}"))?;
        }

        // Drop the media DB (+ WAL/SHM) so sync state starts clean.
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{}", guard.media_db_path, suffix));
        }

        let reopened = build_collection(
            &guard.collection_path,
            &guard.media_folder_path,
            &guard.media_db_path,
        )?;
        guard.col = Some(reopened);
        Ok(json!({ "reset": true }))
    }
}

/// Build a unique, filesystem-safe `.apkg` path in the OS temp dir for an
/// export. Slugs the deck name (falling back to "export") and stamps the
/// current time so repeated exports of the same deck don't collide.
fn export_path_for(deck_name: &str) -> String {
    let slug: String = deck_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let slug = if slug.is_empty() {
        "export".to_owned()
    } else {
        slug
    };
    let stamp = TimestampMillis::now().0;
    let mut path = std::env::temp_dir();
    path.push(format!("{slug}-{stamp}.apkg"));
    path.to_string_lossy().into_owned()
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

struct V2SyncOutcome {
    changed: bool,
    message: String,
}

struct LocalV2Note {
    checksum: String,
    modified: String,
    usn: i64,
}

struct LocalV2Card {
    checksum: String,
    modified: String,
    usn: i64,
}

#[derive(Default)]
struct V2SyncState {
    initialized: bool,
    notes: HashSet<String>,
    cards: HashMap<String, (String, i64)>,
    notetypes: HashSet<i64>,
    decks: HashSet<String>,
    media: HashSet<String>,
    pending_notes: HashSet<String>,
    pending_cards: HashSet<i64>,
    downloaded_media: HashMap<String, String>,
}

enum V2LocalDeletion {
    Note { guid: String, nid: i64 },
    Card { guid: String, ord: i64, cid: i64 },
    Deck { name: String, did: i64 },
    Notetype(i64),
    Media(String),
}

fn v2_state_path(collection_path: &str) -> String {
    format!("{collection_path}.kelma-v2-state.json")
}

fn load_v2_sync_state(collection_path: &str) -> V2SyncState {
    let Ok(bytes) = std::fs::read(v2_state_path(collection_path)) else {
        return V2SyncState::default();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return V2SyncState::default();
    };
    let mut state = V2SyncState {
        initialized: value.get("version").and_then(Value::as_i64).unwrap_or(0) >= 1,
        ..V2SyncState::default()
    };
    state.notes = json_string_set(value.get("notes"));
    state.notetypes = value
        .get("notetypes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_i64)
        .collect();
    state.decks = json_string_set(value.get("decks"));
    state.media = json_string_set(value.get("media"));
    state.pending_notes = json_string_set(value.get("pendingNotes"));
    state.pending_cards = value
        .get("pendingCards")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_i64)
        .collect();
    state.downloaded_media = value
        .get("downloadedMedia")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(name, modified)| Some((name.clone(), modified.as_str()?.to_string())))
        .collect();
    if let Some(cards) = value.get("cards").and_then(Value::as_object) {
        for (canonical_id, logical) in cards {
            let guid = logical.get("guid").and_then(Value::as_str).unwrap_or("");
            let ord = logical.get("ord").and_then(Value::as_i64).unwrap_or(0);
            if !guid.is_empty() {
                state
                    .cards
                    .insert(canonical_id.clone(), (guid.to_string(), ord));
            }
        }
    }
    state
}

fn json_string_set(value: Option<&Value>) -> HashSet<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn save_v2_sync_state(
    collection_path: &str,
    manifest: &Value,
    pending: &V2SyncState,
) -> Result<(), String> {
    let notes = manifest
        .get("notes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.get("guid").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let notetypes = manifest
        .get("notetypes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.get("notetype_id").and_then(Value::as_i64))
        .collect::<Vec<_>>();
    let decks = manifest
        .get("decks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let media = manifest
        .get("media")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.get("filename").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let mut cards = serde_json::Map::new();
    for card in manifest
        .get("cards")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(card_id) = card.get("card_id").and_then(Value::as_i64) else {
            continue;
        };
        let guid = card.get("note_guid").and_then(Value::as_str).unwrap_or("");
        let ord = card.get("ord").and_then(Value::as_i64).unwrap_or(0);
        if !guid.is_empty() {
            cards.insert(card_id.to_string(), json!({ "guid": guid, "ord": ord }));
        }
    }
    let state = json!({
        "version": 1,
        "serverTime": manifest.get("server_time").cloned().unwrap_or(Value::Null),
        "notes": notes,
        "cards": cards,
        "notetypes": notetypes,
        "decks": decks,
        "media": media,
        "pendingNotes": pending.pending_notes,
        "pendingCards": pending.pending_cards,
        "downloadedMedia": pending.downloaded_media,
    });
    let path = v2_state_path(collection_path);
    let temporary = format!("{path}.tmp");
    let bytes = serde_json::to_vec(&state).map_err(|e| format!("encode v2 state: {e}"))?;
    let mut file =
        std::fs::File::create(&temporary).map_err(|e| format!("create v2 state: {e}"))?;
    use std::io::Write;
    file.write_all(&bytes)
        .map_err(|e| format!("write v2 state: {e}"))?;
    file.sync_all().map_err(|e| format!("sync v2 state: {e}"))?;
    std::fs::rename(&temporary, &path).map_err(|e| format!("install v2 state: {e}"))
}

fn save_existing_v2_sync_state(collection_path: &str, state: &V2SyncState) -> Result<(), String> {
    let mut cards = serde_json::Map::new();
    for (canonical_id, (guid, ord)) in &state.cards {
        cards.insert(canonical_id.clone(), json!({ "guid": guid, "ord": ord }));
    }
    let value = json!({
        "version": 1,
        "notes": state.notes,
        "cards": cards,
        "notetypes": state.notetypes,
        "decks": state.decks,
        "media": state.media,
        "pendingNotes": state.pending_notes,
        "pendingCards": state.pending_cards,
        "downloadedMedia": state.downloaded_media,
    });
    let path = v2_state_path(collection_path);
    let temporary = format!("{path}.tmp");
    let bytes = serde_json::to_vec(&value).map_err(|e| format!("encode v2 state: {e}"))?;
    let mut file =
        std::fs::File::create(&temporary).map_err(|e| format!("create v2 state: {e}"))?;
    use std::io::Write;
    file.write_all(&bytes)
        .map_err(|e| format!("write v2 state: {e}"))?;
    file.sync_all().map_err(|e| format!("sync v2 state: {e}"))?;
    std::fs::rename(&temporary, &path).map_err(|e| format!("install v2 state: {e}"))
}

fn manifest_string_set(manifest: &Value, resource: &str, key: &str) -> HashSet<String> {
    manifest
        .get(resource)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.get(key).and_then(Value::as_str).map(str::to_string))
        .collect()
}

fn manifest_i64_set(manifest: &Value, resource: &str, key: &str) -> HashSet<i64> {
    manifest
        .get(resource)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.get(key).and_then(Value::as_i64))
        .collect()
}

fn push_v2_pending_deletes(
    endpoint: &str,
    token: &str,
    collection_path: &str,
    state: &mut V2SyncState,
) -> Result<usize, String> {
    let mut notes = state.pending_notes.iter().cloned().collect::<Vec<_>>();
    let mut cards = state.pending_cards.iter().copied().collect::<Vec<_>>();
    notes.sort();
    cards.sort_unstable();
    let requested = notes.len() + cards.len();
    if requested == 0 {
        return Ok(0);
    }

    let mut batch_available = true;
    for chunk in notes.chunks(3000) {
        if batch_available {
            match v2_json(
                "POST",
                endpoint,
                "/v2/batch/delete",
                Some(token),
                Some(json!({
                    "notes": chunk, "cards": [], "notetypes": [], "decks": []
                })),
            ) {
                Ok(_) => continue,
                Err(error) if error.contains("404 Not Found") => batch_available = false,
                Err(error) => return Err(error),
            }
        }
        for guid in chunk {
            v2_json(
                "DELETE",
                endpoint,
                &format!("/v2/notes/{}", urlencode(guid)),
                Some(token),
                None,
            )?;
        }
    }
    for chunk in cards.chunks(3000) {
        if batch_available {
            match v2_json(
                "POST",
                endpoint,
                "/v2/batch/delete",
                Some(token),
                Some(json!({
                    "notes": [], "cards": chunk, "notetypes": [], "decks": []
                })),
            ) {
                Ok(_) => continue,
                Err(error) if error.contains("404 Not Found") => batch_available = false,
                Err(error) => return Err(error),
            }
        }
        for card_id in chunk {
            v2_json(
                "DELETE",
                endpoint,
                &format!("/v2/cards/{card_id}"),
                Some(token),
                None,
            )?;
        }
    }
    state.pending_notes.clear();
    state.pending_cards.clear();
    save_existing_v2_sync_state(collection_path, state)?;
    Ok(requested)
}

fn apply_v2_tombstones(
    col: &mut Collection,
    manifest: &Value,
    state: &V2SyncState,
    media_folder: &str,
    allow_deletions: bool,
) -> Result<usize, String> {
    let current_notes = manifest_string_set(manifest, "notes", "guid");
    let current_cards = manifest_i64_set(manifest, "cards", "card_id");
    let current_notetypes = manifest_i64_set(manifest, "notetypes", "notetype_id");
    let current_decks = manifest_string_set(manifest, "decks", "name");
    let current_media = manifest_string_set(manifest, "media", "filename");
    let tombstones = manifest
        .get("tombstones")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut planned = Vec::<V2LocalDeletion>::new();
    let mut conflicts = Vec::<String>::new();
    for wanted_type in ["note", "card", "deck", "notetype", "media"] {
        for tombstone in tombstones
            .iter()
            .filter(|t| t.get("type").and_then(Value::as_str) == Some(wanted_type))
        {
            let rid = tombstone
                .get("resource_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            if rid.is_empty() {
                continue;
            }
            match wanted_type {
                "note" => {
                    if current_notes.contains(rid) {
                        continue; // resource was restored after an older tombstone
                    }
                    if state.initialized && !state.notes.contains(rid) {
                        continue;
                    }
                    let row: Option<(i64, i64)> = col
                        .storage
                        .db()
                        .query_row("SELECT id, usn FROM notes WHERE guid=?", [rid], |r| {
                            Ok((r.get(0)?, r.get(1)?))
                        })
                        .optional()
                        .map_err(|e| format!("check note tombstone {rid}: {e}"))?;
                    let Some((nid, usn)) = row else { continue };
                    let pending_cards: i64 = col
                        .storage
                        .db()
                        .query_row(
                            "SELECT count(*) FROM cards WHERE nid=? AND usn=-1",
                            [nid],
                            |r| r.get(0),
                        )
                        .unwrap_or(0);
                    if usn == -1 || pending_cards > 0 {
                        conflicts.push(format!("note {rid}"));
                    }
                    planned.push(V2LocalDeletion::Note {
                        guid: rid.to_string(),
                        nid,
                    });
                }
                "card" => {
                    let Ok(canonical_id) = rid.parse::<i64>() else {
                        continue;
                    };
                    if current_cards.contains(&canonical_id) {
                        continue;
                    }
                    let logical = state.cards.get(rid).cloned();
                    let row: Option<(String, i64, i64, i64)> = if let Some((guid, ord)) = logical {
                        col.storage
                            .db()
                            .query_row(
                                "SELECT n.guid, c.ord, c.id, c.usn FROM cards c JOIN notes n ON n.id=c.nid WHERE n.guid=? AND c.ord=?",
                                (&guid, ord),
                                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                            )
                            .optional()
                            .map_err(|e| format!("check card tombstone {rid}: {e}"))?
                    } else if !state.initialized {
                        col.storage
                            .db()
                            .query_row(
                                "SELECT n.guid, c.ord, c.id, c.usn FROM cards c JOIN notes n ON n.id=c.nid WHERE c.id=?",
                                [canonical_id],
                                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                            )
                            .optional()
                            .map_err(|e| format!("check legacy card tombstone {rid}: {e}"))?
                    } else {
                        None
                    };
                    let Some((guid, ord, cid, usn)) = row else {
                        continue;
                    };
                    if usn == -1 {
                        conflicts.push(format!("card {guid}:{ord}"));
                    }
                    planned.push(V2LocalDeletion::Card { guid, ord, cid });
                }
                "deck" => {
                    let child_prefix = format!("{rid}::");
                    if current_decks.contains(rid)
                        || current_decks
                            .iter()
                            .any(|name| name.starts_with(&child_prefix))
                        || !state.initialized
                        || !state.decks.contains(rid)
                    {
                        continue;
                    }
                    let Some(did) = deck_id_by_name(col, rid)? else {
                        continue;
                    };
                    let pending: i64 = col
                        .storage
                        .db()
                        .query_row(
                            "SELECT count(*) FROM cards WHERE did=? AND usn=-1",
                            [did.0],
                            |r| r.get(0),
                        )
                        .unwrap_or(0);
                    if pending > 0 {
                        conflicts.push(format!("deck {rid}"));
                    }
                    planned.push(V2LocalDeletion::Deck {
                        name: rid.to_string(),
                        did: did.0,
                    });
                }
                "notetype" => {
                    let Ok(ntid) = rid.parse::<i64>() else {
                        continue;
                    };
                    if current_notetypes.contains(&ntid)
                        || !state.initialized
                        || !state.notetypes.contains(&ntid)
                    {
                        continue;
                    }
                    if col
                        .get_notetype(NotetypeId(ntid))
                        .map_err(|e| format!("check notetype {ntid}: {e:?}"))?
                        .is_some()
                    {
                        planned.push(V2LocalDeletion::Notetype(ntid));
                    }
                }
                "media" => {
                    if current_media.contains(rid)
                        || !state.initialized
                        || !state.media.contains(rid)
                        || !safe_media_name(rid)
                    {
                        continue;
                    }
                    planned.push(V2LocalDeletion::Media(rid.to_string()));
                }
                _ => {}
            }
        }
    }
    if !conflicts.is_empty() && !allow_deletions {
        return Err(format!("KELMA_DELETION_CONFIRM:{}", conflicts.join(", ")));
    }

    let mut applied = 0usize;
    for deletion in planned {
        match deletion {
            V2LocalDeletion::Note { guid, nid } => {
                if col
                    .storage
                    .db()
                    .query_row("SELECT 1 FROM notes WHERE id=?", [nid], |_| Ok(()))
                    .optional()
                    .map_err(|e| format!("recheck note {guid}: {e}"))?
                    .is_some()
                {
                    col.remove_notes(&[NoteId(nid)])
                        .map_err(|e| format!("delete note {guid}: {e:?}"))?;
                    applied += 1;
                }
            }
            V2LocalDeletion::Card { guid, ord, cid } => {
                let exists: bool = col
                    .storage
                    .db()
                    .query_row("SELECT 1 FROM cards WHERE id=?", [cid], |_| Ok(()))
                    .optional()
                    .map_err(|e| format!("recheck card {guid}:{ord}: {e}"))?
                    .is_some();
                if exists {
                    let _ = col
                        .remove_cards(anki_proto::cards::RemoveCardsRequest {
                            card_ids: vec![cid],
                        })
                        .map_err(|e| format!("delete card {guid}:{ord}: {e:?}"))?;
                    applied += 1;
                }
            }
            V2LocalDeletion::Deck { name, did } => {
                let count: i64 = col
                    .storage
                    .db()
                    .query_row("SELECT count(*) FROM cards WHERE did=?", [did], |r| {
                        r.get(0)
                    })
                    .unwrap_or(0);
                if count == 0 {
                    col.remove_decks_and_child_decks(&[DeckId(did)])
                        .map_err(|e| format!("delete deck {name}: {e:?}"))?;
                    applied += 1;
                }
            }
            V2LocalDeletion::Notetype(ntid) => {
                let count: i64 = col
                    .storage
                    .db()
                    .query_row("SELECT count(*) FROM notes WHERE mid=?", [ntid], |r| {
                        r.get(0)
                    })
                    .unwrap_or(0);
                if count == 0 {
                    col.remove_notetype(NotetypeId(ntid))
                        .map_err(|e| format!("delete notetype {ntid}: {e:?}"))?;
                    applied += 1;
                }
            }
            V2LocalDeletion::Media(filename) => {
                let path = std::path::Path::new(media_folder).join(&filename);
                if path.is_file() {
                    std::fs::remove_file(&path)
                        .map_err(|e| format!("delete media {filename}: {e}"))?;
                    applied += 1;
                }
            }
        }
    }
    Ok(applied)
}

fn safe_media_name(filename: &str) -> bool {
    !filename.is_empty()
        && filename != "."
        && filename != ".."
        && !filename.contains('/')
        && !filename.contains('\\')
}

fn v2_checksum_parts(parts: &[Value]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(serde_json::to_vec(part).unwrap_or_default());
        hasher.update(b"\n");
    }
    let digest = hasher.finalize();
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn v2_note_checksum(fields: &[String], tags: &[String]) -> String {
    v2_checksum_parts(&[json!(fields), json!(tags)])
}

fn normalize_v2_deck_config(value: &Value) -> Value {
    let mut object = value.as_object().cloned().unwrap_or_default();
    for key in [
        "id",
        "mod",
        "usn",
        "name",
        "newToday",
        "revToday",
        "lrnToday",
        "timeToday",
    ] {
        object.remove(key);
    }
    Value::Object(object)
}

fn normalize_v2_notetype_definition(value: &Value) -> Value {
    let mut object = value.as_object().cloned().unwrap_or_default();
    for key in ["id", "mod", "usn"] {
        object.remove(key);
    }
    for key in ["flds", "tmpls"] {
        if let Some(items) = object.get_mut(key).and_then(Value::as_array_mut) {
            for item in items {
                if let Some(item) = item.as_object_mut() {
                    item.remove("id");
                }
            }
        }
    }
    Value::Object(object)
}

fn local_v2_notetype_checksums(col: &mut Collection) -> Result<HashMap<i64, String>, String> {
    let entries = col
        .get_notetype_names()
        .map_err(|e| format!("list notetypes: {e:?}"))?
        .entries;
    let mut checksums = HashMap::new();
    for entry in entries {
        let raw = col
            .get_notetype_legacy(anki_proto::notetypes::NotetypeId { ntid: entry.id })
            .map_err(|e| format!("export notetype {}: {e:?}", entry.id))?;
        let value: Value = serde_json::from_slice(&raw.json)
            .map_err(|e| format!("decode notetype {}: {e}", entry.id))?;
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&entry.name);
        let definition = normalize_v2_notetype_definition(&value);
        checksums.insert(entry.id, v2_checksum_parts(&[json!(name), definition]));
    }
    Ok(checksums)
}

fn local_v2_deck_checksums(col: &mut Collection) -> Result<HashMap<String, String>, String> {
    let decks = col
        .get_all_deck_names(false)
        .map_err(|e| format!("list decks: {e:?}"))?;
    let mut checksums = HashMap::new();
    for (did, name) in decks {
        let raw = col
            .get_deck_legacy(anki_proto::decks::DeckId { did: did.0 })
            .map_err(|e| format!("export deck {name}: {e:?}"))?;
        let value: Value =
            serde_json::from_slice(&raw.json).map_err(|e| format!("decode deck {name}: {e}"))?;
        let config = normalize_v2_deck_config(&value);
        checksums.insert(name, v2_checksum_parts(&[config]));
    }
    Ok(checksums)
}

fn json_i64(value: Option<&Value>) -> i64 {
    value
        .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
        .unwrap_or(0)
}

fn v2_notetype_payload(col: &mut Collection, ntid: i64) -> Result<Value, String> {
    let raw = col
        .get_notetype_legacy(anki_proto::notetypes::NotetypeId { ntid })
        .map_err(|e| format!("export notetype {ntid}: {e:?}"))?;
    let value: Value =
        serde_json::from_slice(&raw.json).map_err(|e| format!("decode notetype {ntid}: {e}"))?;
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Mobile Notetype");
    Ok(json!({
        "notetype_id": ntid,
        "name": name,
        "definition": normalize_v2_notetype_definition(&value),
        "client_modified_at": rfc3339_from_secs(json_i64(value.get("mod"))),
        "base_checksum": "",
    }))
}

fn v2_deck_payload(col: &mut Collection, name: &str) -> Result<Value, String> {
    let did =
        deck_id_by_name(col, name)?.ok_or_else(|| format!("local deck disappeared: {name}"))?;
    let raw = col
        .get_deck_legacy(anki_proto::decks::DeckId { did: did.0 })
        .map_err(|e| format!("export deck {name}: {e:?}"))?;
    let value: Value =
        serde_json::from_slice(&raw.json).map_err(|e| format!("decode deck {name}: {e}"))?;
    Ok(json!({
        "name": name,
        "config": normalize_v2_deck_config(&value),
        "client_modified_at": rfc3339_from_secs(json_i64(value.get("mod"))),
        "base_checksum": "",
    }))
}

fn prepare_v2_notetype_slot(
    col: &mut Collection,
    server_id: i64,
    server_name: &str,
    previously_known: bool,
    force_server: bool,
) -> Result<(), String> {
    // A brand-new Anki collection comes with unused stock notetypes whose IDs
    // are generated locally. They can collide with a server ID/name while
    // representing a different stock model (Basic vs Basic+). Remove only
    // UNUSED collisions before preserving the canonical server ID.
    let entries = col
        .get_notetype_names()
        .map_err(|e| format!("list notetypes before apply: {e:?}"))?
        .entries;
    let mut removals = HashSet::new();
    for entry in entries {
        if entry.id != server_id && entry.name != server_name {
            continue;
        }
        let count: i64 = col
            .storage
            .db()
            .query_row("SELECT count(*) FROM notes WHERE mid=?", [entry.id], |r| {
                r.get(0)
            })
            .unwrap_or(0);
        if count == 0 {
            removals.insert(entry.id);
        } else if entry.id != server_id || (!previously_known && !force_server) {
            return Err(format!(
                "KELMA_CONTENT_CONFIRM:notetype {server_name} conflicts with local notes"
            ));
        }
    }
    for ntid in removals {
        col.remove_notetype(NotetypeId(ntid))
            .map_err(|e| format!("remove unused notetype collision {ntid}: {e:?}"))?;
    }
    Ok(())
}

fn apply_v2_deck(col: &mut Collection, record: &Value) -> Result<bool, String> {
    let name = record
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Default");
    let created = ensure_deck(col, name)?;
    let did = deck_id_by_name(col, name)?.unwrap_or(DeckId(1));
    let mut value = record
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let modified = record
        .get("client_modified_at")
        .or_else(|| record.get("modified_at"))
        .and_then(Value::as_str)
        .and_then(rfc3339_to_secs)
        .unwrap_or(0);
    value.insert("id".to_string(), json!(did.0));
    value.insert("name".to_string(), json!(name));
    value.insert("mod".to_string(), json!(modified));
    value.insert("usn".to_string(), json!(0));
    value.entry("newToday".to_string()).or_insert(json!([0, 0]));
    value.entry("revToday".to_string()).or_insert(json!([0, 0]));
    value.entry("lrnToday".to_string()).or_insert(json!([0, 0]));
    value
        .entry("timeToday".to_string())
        .or_insert(json!([0, 0]));
    value.entry("collapsed".to_string()).or_insert(json!(false));
    value
        .entry("browserCollapsed".to_string())
        .or_insert(json!(false));
    value.entry("dyn".to_string()).or_insert(json!(0));
    value.entry("conf".to_string()).or_insert(json!(1));
    let deck = serde_json::to_vec(&Value::Object(value))
        .map_err(|e| format!("encode deck {name}: {e}"))?;
    let _ = col
        .add_or_update_deck_legacy(anki_proto::decks::AddOrUpdateDeckLegacyRequest {
            deck,
            preserve_usn_and_mtime: true,
        })
        .map_err(|e| format!("apply deck {name}: {e:?}"))?;
    Ok(created)
}

fn ensure_v2_batch_without_conflicts(
    response: &Value,
    resource: &str,
    expected: usize,
) -> Result<(), String> {
    let conflicts = response
        .get("conflicts")
        .and_then(|v| v.get(resource))
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let accepted = response
        .get("accepted")
        .and_then(|v| v.get(resource))
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    if conflicts > 0 {
        return Err(format!(
            "KELMA_CONTENT_CONFIRM:{conflicts} {resource} conflict(s)"
        ));
    }
    if accepted != expected {
        return Err(format!(
            "server accepted {accepted}/{expected} {resource}; keeping local changes pending"
        ));
    }
    Ok(())
}

fn v2_json(
    method: &str,
    endpoint: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Result<Value, String> {
    let url = format!("{}{}", endpoint.trim_end_matches('/'), path);
    block_on(async {
        let client = web_client();
        let mut req = match method {
            "GET" => client.get(&url),
            "POST" => client.post(&url),
            "PUT" => client.put(&url),
            "DELETE" => client.delete(&url),
            other => return Err(format!("unsupported v2 method {other}")),
        }
        .header("user-agent", kelma_client_label());
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| format!("v2 request {path}: {e}"))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("v2 read {path}: {e}"))?;
        if !status.is_success() {
            return Err(format!("v2 {path} failed ({status}): {text}"));
        }
        if text.trim().is_empty() {
            Ok(Value::Null)
        } else {
            serde_json::from_str(&text).map_err(|e| format!("v2 JSON {path}: {e}: {text}"))
        }
    })
}

/// Canonical structural checksum for a card. Scheduling is deliberately not
/// included because due values are collection-relative.
fn v2_card_checksum(guid: &str, deck_name: &str, ord: i64) -> String {
    v2_checksum_parts(&[json!(guid), json!(deck_name), json!(ord)])
}

/// Parse RFC3339 timestamps (including explicit offsets) without adding a
/// second date/time dependency to the native bridge.
fn rfc3339_to_secs(value: &str) -> Option<i64> {
    if value.len() < 19 {
        return None;
    }
    let year = value.get(0..4)?.parse::<i64>().ok()?;
    let month = value.get(5..7)?.parse::<i64>().ok()?;
    let day = value.get(8..10)?.parse::<i64>().ok()?;
    let hour = value.get(11..13)?.parse::<i64>().ok()?;
    let minute = value.get(14..16)?.parse::<i64>().ok()?;
    let second = value.get(17..19)?.parse::<i64>().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let adjusted_year = year - i64::from(month <= 2);
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146097 + day_of_era - 719468;
    let mut secs = days * 86400 + hour * 3600 + minute * 60 + second;

    let timezone = &value[19..];
    let offset_start = timezone.find('+').or_else(|| timezone.find('-'));
    if let Some(index) = offset_start {
        let sign = if timezone.as_bytes().get(index) == Some(&b'-') {
            -1
        } else {
            1
        };
        let offset = &timezone[index + 1..];
        let offset_hour = offset.get(0..2)?.parse::<i64>().ok()?;
        let offset_minute = offset.get(3..5)?.parse::<i64>().ok()?;
        secs -= sign * (offset_hour * 3600 + offset_minute * 60);
    }
    Some(secs.max(0))
}

/// Format a unix-seconds timestamp as an RFC3339 UTC string, matching the
/// `client_modified_at` shape the v2 server parses (`time.Time` JSON).
fn rfc3339_from_secs(secs: i64) -> String {
    use std::time::{Duration, UNIX_EPOCH};
    // Minimal RFC3339 formatter without pulling in chrono at this layer.
    let secs = secs.max(0) as u64;
    let days = secs / 86400;
    let rem = secs % 86400;
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant's algorithm), epoch 1970-01-01.
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let _ = UNIX_EPOCH + Duration::from_secs(secs);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

fn referenced_v2_media(col: &mut Collection) -> Result<HashSet<String>, String> {
    let db = col.storage.db();
    let image = regex::Regex::new(r#"(?i)<img\b[^>]*\bsrc=["']([^"']+)["']"#)
        .map_err(|e| format!("image media regex: {e}"))?;
    let sound =
        regex::Regex::new(r"\[sound:([^\]]+)\]").map_err(|e| format!("sound media regex: {e}"))?;
    let mut statement = db
        .prepare("SELECT flds FROM notes")
        .map_err(|e| format!("prepare media note scan: {e}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("scan media notes: {e}"))?;
    let mut names = HashSet::new();
    for fields in rows.filter_map(Result::ok) {
        for captures in image
            .captures_iter(&fields)
            .chain(sound.captures_iter(&fields))
        {
            let name = captures
                .get(1)
                .map(|m| m.as_str().trim().replace("%20", " "))
                .unwrap_or_default();
            if safe_media_name(&name)
                && !name.starts_with("http://")
                && !name.starts_with("https://")
                && !name.starts_with("data:")
            {
                names.insert(name);
            }
        }
    }
    Ok(names)
}

fn v2_media_manifest(manifest: &Value, refs: &HashSet<String>) -> HashMap<String, String> {
    manifest
        .get("media")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let name = entry.get("filename")?.as_str()?;
            if !refs.contains(name) || !safe_media_name(name) {
                return None;
            }
            Some((
                name.to_string(),
                entry
                    .get("modified_at")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            ))
        })
        .collect()
}

fn v2_sync_media_downloads(
    endpoint: &str,
    token: &str,
    collection_path: &str,
    media_folder: &str,
    refs: HashSet<String>,
    progress: Option<Arc<Mutex<V2MediaProgress>>>,
) -> Result<usize, String> {
    std::fs::create_dir_all(media_folder).map_err(|e| format!("create media dir: {e}"))?;
    let mut state = load_v2_sync_state(collection_path);
    let mut manifest = v2_json("GET", endpoint, "/v2/sync/manifest", Some(token), None)?;
    let mut server_media = v2_media_manifest(&manifest, &refs);
    let root = std::path::Path::new(media_folder);
    let uploads = refs
        .iter()
        .filter(|name| !server_media.contains_key(*name) && root.join(name).is_file())
        .cloned()
        .collect::<Vec<_>>();

    let endpoint_owned = endpoint.trim_end_matches('/').to_string();
    let token_owned = token.to_string();
    let media_folder_owned = media_folder.to_string();
    let upload_progress = progress.clone();
    let uploaded_names = block_on(async move {
        let client = web_client();
        let mut names = uploads.into_iter();
        let mut tasks = tokio::task::JoinSet::new();
        let spawn_upload = |tasks: &mut tokio::task::JoinSet<Result<String, String>>,
                            filename: String| {
            let client = client.clone();
            let endpoint = endpoint_owned.clone();
            let token = token_owned.clone();
            let media_folder = media_folder_owned.clone();
            tasks.spawn(async move {
                let bytes = std::fs::read(std::path::Path::new(&media_folder).join(&filename))
                    .map_err(|e| format!("read media {filename}: {e}"))?;
                let path = format!("/v2/media/{}", urlencode(&filename));
                let mut last_error = String::new();
                for attempt in 0..3 {
                    match client
                        .put(format!("{endpoint}{path}"))
                        .bearer_auth(&token)
                        .header("content-type", "application/octet-stream")
                        .header("user-agent", kelma_client_label())
                        .body(bytes.clone())
                        .send()
                        .await
                    {
                        Ok(response) if response.status().is_success() => return Ok(filename),
                        Ok(response) => {
                            let status = response.status();
                            let text = response.text().await.unwrap_or_default();
                            last_error = format!("v2 media {path} failed ({status}): {text}");
                        }
                        Err(error) => last_error = format!("v2 media upload {path}: {error}"),
                    }
                    if attempt < 2 {
                        tokio::time::sleep(std::time::Duration::from_millis(500 * (attempt + 1)))
                            .await;
                    }
                }
                Err(last_error)
            });
        };
        for filename in names.by_ref().take(50) {
            spawn_upload(&mut tasks, filename);
        }
        let mut uploaded = Vec::new();
        while let Some(joined) = tasks.join_next().await {
            uploaded.push(joined.map_err(|e| format!("media upload task failed: {e}"))??);
            if let Some(cell) = &upload_progress {
                if let Ok(mut p) = cell.lock() {
                    p.uploaded_files = uploaded.len();
                }
            }
            if let Some(filename) = names.next() {
                spawn_upload(&mut tasks, filename);
            }
        }
        Ok::<_, String>(uploaded)
    })?;

    // Upload responses do not include modified_at. Refresh once so the local
    // media baseline records the exact server version.
    if !uploaded_names.is_empty() {
        manifest = v2_json("GET", endpoint, "/v2/sync/manifest", Some(token), None)?;
        server_media = v2_media_manifest(&manifest, &refs);
    }
    let uploaded_names = uploaded_names.into_iter().collect::<HashSet<_>>();
    let mut checked = 0usize;
    let mut downloads = Vec::<(String, String)>::new();
    for name in &refs {
        let Some(server_modified) = server_media.get(name) else {
            checked += 1; // referenced but absent both locally/server-side
            continue;
        };
        let path = root.join(name);
        if uploaded_names.contains(name) {
            state
                .downloaded_media
                .insert(name.clone(), server_modified.clone());
            checked += 1;
        } else if path.is_file() {
            match state.downloaded_media.get(name) {
                Some(local_version) if local_version == server_modified => checked += 1,
                None => {
                    // Migration from builds without media version tracking: an
                    // existing file is assumed to be the current server copy.
                    state
                        .downloaded_media
                        .insert(name.clone(), server_modified.clone());
                    checked += 1;
                }
                Some(_) => downloads.push((name.clone(), server_modified.clone())),
            }
        } else {
            downloads.push((name.clone(), server_modified.clone()));
        }
    }
    if let Some(cell) = &progress {
        if let Ok(mut p) = cell.lock() {
            p.checked = checked;
        }
    }

    let endpoint_owned = endpoint.trim_end_matches('/').to_string();
    let token_owned = token.to_string();
    let media_folder_owned = media_folder.to_string();
    let download_progress = progress.clone();
    let (downloaded, downloaded_versions) = block_on(async move {
        let client = web_client();
        let mut entries = downloads.into_iter();
        let mut tasks = tokio::task::JoinSet::new();
        let spawn_download = |tasks: &mut tokio::task::JoinSet<
            Result<Option<(String, String)>, String>,
        >,
                              entry: (String, String)| {
            let client = client.clone();
            let endpoint = endpoint_owned.clone();
            let token = token_owned.clone();
            let media_folder = media_folder_owned.clone();
            tasks.spawn(async move {
                let (filename, modified) = entry;
                let path = format!("/v2/media/{}", urlencode(&filename));
                let mut last_error = String::new();
                for attempt in 0..3 {
                    match client
                        .get(format!("{endpoint}{path}"))
                        .bearer_auth(&token)
                        .header("user-agent", kelma_client_label())
                        .send()
                        .await
                    {
                        Ok(response) if response.status() == reqwest::StatusCode::NOT_FOUND => {
                            return Ok(None)
                        }
                        Ok(response) if response.status().is_success() => {
                            let bytes = response
                                .bytes()
                                .await
                                .map_err(|e| format!("v2 media bytes {path}: {e}"))?;
                            let target = std::path::Path::new(&media_folder).join(&filename);
                            let temporary = std::path::Path::new(&media_folder)
                                .join(format!(".{filename}.kelma-download"));
                            std::fs::write(&temporary, bytes)
                                .map_err(|e| format!("write media {filename}: {e}"))?;
                            std::fs::rename(&temporary, &target)
                                .map_err(|e| format!("install media {filename}: {e}"))?;
                            return Ok(Some((filename, modified)));
                        }
                        Ok(response) => {
                            let status = response.status();
                            let text = response.text().await.unwrap_or_default();
                            last_error = format!("v2 media {path} failed ({status}): {text}");
                        }
                        Err(error) => last_error = format!("v2 media request {path}: {error}"),
                    }
                    if attempt < 2 {
                        tokio::time::sleep(std::time::Duration::from_millis(500 * (attempt + 1)))
                            .await;
                    }
                }
                Err(last_error)
            });
        };
        for entry in entries.by_ref().take(50) {
            spawn_download(&mut tasks, entry);
        }
        let mut versions = Vec::new();
        while let Some(joined) = tasks.join_next().await {
            if let Some(version) =
                joined.map_err(|e| format!("media download task failed: {e}"))??
            {
                versions.push(version);
            }
            checked += 1;
            if let Some(cell) = &download_progress {
                if let Ok(mut p) = cell.lock() {
                    p.checked = checked;
                    p.downloaded_files = versions.len();
                }
            }
            if let Some(entry) = entries.next() {
                spawn_download(&mut tasks, entry);
            }
        }
        Ok::<_, String>((versions.len(), versions))
    })?;
    for (name, modified) in downloaded_versions {
        state.downloaded_media.insert(name, modified);
    }
    state.media = server_media.keys().cloned().collect();
    state
        .downloaded_media
        .retain(|name, _| server_media.contains_key(name));
    save_existing_v2_sync_state(collection_path, &state)?;
    Ok(downloaded)
}

fn deck_id_by_name(col: &mut Collection, name: &str) -> Result<Option<DeckId>, String> {
    let names = col
        .get_all_deck_names(false)
        .map_err(|e| format!("deck names: {e:?}"))?;
    Ok(names.into_iter().find(|(_, n)| n == name).map(|(id, _)| id))
}

fn ensure_deck(col: &mut Collection, name: &str) -> Result<bool, String> {
    if deck_id_by_name(col, name)?.is_some() {
        return Ok(false);
    }
    let mut deck = Deck::new_normal();
    deck.name = NativeDeckName::from_human_name(name);
    col.add_or_update_deck(&mut deck)
        .map_err(|e| format!("create deck {name}: {e:?}"))?;
    Ok(true)
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
        // Generous per-request timeout so a large full-download or a big media
        // batch over a slow connection isn't killed mid-transfer. rslib applies
        // this to its sync HTTP requests; None would fall back to a shorter
        // default that a first-time full sync can exceed.
        io_timeout_secs: Some(600),
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

/// Anki-compatible sync header for the Kelma-native inspect/write endpoints.
fn inspect_header(hkey: &str) -> String {
    json!({
        "v": 11,
        "k": hkey,
        "c": kelma_client_label(),
        "s": "",
    })
    .to_string()
}

/// Percent-encode a query/path value (Anki GUIDs contain URL-unsafe base91
/// chars). Encodes everything that isn't an unreserved char.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Generate a unique base91 GUID, matching rslib's note-guid alphabet.
fn gen_guid() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let c = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let n = nanos ^ (c.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    anki::notes::to_base_n(
        n,
        b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\
0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~",
    )
}

fn note_preview(flds: &str) -> String {
    let first = flds.split('\u{1f}').next().unwrap_or("");
    let mut plain = String::new();
    let mut in_tag = false;
    for ch in first.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => plain.push(ch),
            _ => {}
        }
    }
    let decoded = plain
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    let collapsed = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > 120 {
        let mut out = collapsed.chars().take(120).collect::<String>();
        out.push('…');
        out
    } else {
        collapsed
    }
}

/// Read `media.db`'s `meta` row (last_usn + total_nonempty_files) for the local
/// manifest. Returns zeros if the file doesn't exist or isn't a valid media db.
fn media_manifest_from_path(media_db_path: &str) -> Value {
    use rusqlite::OpenFlags;
    if media_db_path.is_empty() {
        return json!({ "usn": 0, "files": 0 });
    }
    let path = std::path::Path::new(media_db_path);
    if !path.exists() {
        return json!({ "usn": 0, "files": 0 });
    }
    let conn = match rusqlite::Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(_) => return json!({ "usn": 0, "files": 0 }),
    };
    let row: Option<(i64, i64)> = conn
        .query_row("SELECT last_usn, total_nonempty_files FROM meta", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .ok();
    match row {
        Some((usn, files)) => json!({ "usn": usn, "files": files }),
        None => json!({ "usn": 0, "files": 0 }),
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
fn find_deck_node<'a>(node: &'a DeckTreeNode, deck_id: DeckId) -> Option<&'a DeckTreeNode> {
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

// --- Statistics serialization (GraphsResponse -> JSON) -----------------------
// Serialize the full rslib graph payload for `deck_stats`. Maps become JSON
// objects with stringified integer keys; the RN layer sorts them into series.

fn graphs_to_json(deck_name: &str, days: u32, g: &anki_proto::stats::GraphsResponse) -> Value {
    use anki_proto::stats::graphs_response as gr;

    fn imap_i32(m: &std::collections::HashMap<i32, u32>) -> Value {
        let mut o = serde_json::Map::new();
        for (k, v) in m {
            o.insert(k.to_string(), json!(v));
        }
        Value::Object(o)
    }
    fn imap_u32(m: &std::collections::HashMap<u32, u32>) -> Value {
        let mut o = serde_json::Map::new();
        for (k, v) in m {
            o.insert(k.to_string(), json!(v));
        }
        Value::Object(o)
    }
    fn today(t: &gr::Today) -> Value {
        json!({
            "answerCount": t.answer_count,
            "answerMillis": t.answer_millis,
            "correctCount": t.correct_count,
            "matureCorrect": t.mature_correct,
            "matureCount": t.mature_count,
            "learnCount": t.learn_count,
            "reviewCount": t.review_count,
            "relearnCount": t.relearn_count,
            "earlyReviewCount": t.early_review_count,
        })
    }
    fn counts(c: &gr::card_counts::Counts) -> Value {
        json!({
            "new": c.new_cards, "learn": c.learn, "relearn": c.relearn,
            "young": c.young, "mature": c.mature,
            "suspended": c.suspended, "buried": c.buried,
        })
    }
    fn reviews_map(
        m: &std::collections::HashMap<i32, gr::review_counts_and_times::Reviews>,
    ) -> Value {
        let mut o = serde_json::Map::new();
        for (k, r) in m {
            o.insert(
                k.to_string(),
                json!({"learn": r.learn, "relearn": r.relearn, "young": r.young, "mature": r.mature, "filtered": r.filtered}),
            );
        }
        Value::Object(o)
    }
    fn hours(v: &[gr::hours::Hour]) -> Value {
        Value::Array(
            v.iter()
                .map(|h| json!({"total": h.total, "correct": h.correct}))
                .collect(),
        )
    }
    fn buttons(b: &gr::buttons::ButtonCounts) -> Value {
        json!({"learning": b.learning, "young": b.young, "mature": b.mature})
    }
    fn tr(t: &gr::true_retention_stats::TrueRetention) -> Value {
        json!({
            "youngPassed": t.young_passed, "youngFailed": t.young_failed,
            "maturePassed": t.mature_passed, "matureFailed": t.mature_failed,
        })
    }

    let mut out = serde_json::Map::new();
    out.insert("deckName".into(), json!(deck_name));
    out.insert("days".into(), json!(days));
    out.insert("fsrs".into(), json!(g.fsrs));
    out.insert("rolloverHour".into(), json!(g.rollover_hour));

    if let Some(t) = &g.today {
        out.insert("today".into(), today(t));
    }
    if let Some(cc) = &g.card_counts {
        out.insert(
            "cardCounts".into(),
            json!({
                "includingInactive": cc.including_inactive.as_ref().map(counts),
                "excludingInactive": cc.excluding_inactive.as_ref().map(counts),
            }),
        );
    }
    if let Some(fd) = &g.future_due {
        out.insert(
            "futureDue".into(),
            json!({
                "futureDue": imap_i32(&fd.future_due),
                "haveBacklog": fd.have_backlog,
                "dailyLoad": fd.daily_load,
            }),
        );
    }
    if let Some(a) = &g.added {
        out.insert("added".into(), json!({ "added": imap_i32(&a.added) }));
    }
    if let Some(i) = &g.intervals {
        out.insert(
            "intervals".into(),
            json!({ "intervals": imap_u32(&i.intervals) }),
        );
    }
    if let Some(s) = &g.stability {
        out.insert(
            "stability".into(),
            json!({ "intervals": imap_u32(&s.intervals) }),
        );
    }
    if let Some(e) = &g.eases {
        out.insert(
            "eases".into(),
            json!({ "eases": imap_u32(&e.eases), "average": e.average }),
        );
    }
    if let Some(d) = &g.difficulty {
        out.insert(
            "difficulty".into(),
            json!({ "eases": imap_u32(&d.eases), "average": d.average }),
        );
    }
    if let Some(r) = &g.retrievability {
        out.insert(
            "retrievability".into(),
            json!({
                "retrievability": imap_u32(&r.retrievability),
                "average": r.average, "sumByCard": r.sum_by_card, "sumByNote": r.sum_by_note,
            }),
        );
    }
    if let Some(rv) = &g.reviews {
        out.insert(
            "reviews".into(),
            json!({ "count": reviews_map(&rv.count), "time": reviews_map(&rv.time) }),
        );
    }
    if let Some(h) = &g.hours {
        out.insert(
            "hours".into(),
            json!({
                "oneMonth": hours(&h.one_month), "threeMonths": hours(&h.three_months),
                "oneYear": hours(&h.one_year), "allTime": hours(&h.all_time),
            }),
        );
    }
    if let Some(b) = &g.buttons {
        out.insert(
            "buttons".into(),
            json!({
                "oneMonth": b.one_month.as_ref().map(buttons),
                "threeMonths": b.three_months.as_ref().map(buttons),
                "oneYear": b.one_year.as_ref().map(buttons),
                "allTime": b.all_time.as_ref().map(buttons),
            }),
        );
    }
    if let Some(t) = &g.true_retention {
        out.insert(
            "trueRetention".into(),
            json!({
                "today": t.today.as_ref().map(tr), "yesterday": t.yesterday.as_ref().map(tr),
                "week": t.week.as_ref().map(tr), "month": t.month.as_ref().map(tr),
                "year": t.year.as_ref().map(tr), "allTime": t.all_time.as_ref().map(tr),
            }),
        );
    }

    Value::Object(out)
}

#[cfg(test)]
mod v2_tests {
    use super::*;

    #[test]
    fn note_checksum_matches_canonical_hasher() {
        assert_eq!(
            v2_note_checksum(&["a".to_string(), "b".to_string()], &["x".to_string()]),
            "a148b9a3db29df2e6dd510b634c61765701e2c0795bb900e9ab07b035988c16f"
        );
    }

    #[test]
    fn rfc3339_round_trip() {
        for seconds in [0, 1, 1_720_656_789, 1_783_820_000] {
            let encoded = rfc3339_from_secs(seconds);
            assert_eq!(rfc3339_to_secs(&encoded), Some(seconds));
        }
        assert_eq!(
            rfc3339_to_secs("2026-07-12T01:02:03.123456Z"),
            rfc3339_to_secs("2026-07-12T01:02:03Z")
        );
    }

    #[test]
    fn normalizes_volatile_metadata() {
        let deck = normalize_v2_deck_config(&json!({
            "id": 123, "name": "Test", "mod": 456, "usn": -1,
            "newToday": [1, 2], "dyn": 0, "conf": 1
        }));
        assert_eq!(deck, json!({ "dyn": 0, "conf": 1 }));
        let notetype = normalize_v2_notetype_definition(&json!({
            "id": 123, "mod": 456, "usn": -1, "name": "Basic",
            "flds": [{"name": "Front", "id": 99}],
            "tmpls": [{"name": "Card 1", "id": 100}]
        }));
        assert_eq!(
            notetype,
            json!({
                "name": "Basic",
                "flds": [{"name": "Front"}],
                "tmpls": [{"name": "Card 1"}]
            })
        );
    }

    fn test_session(root: &std::path::Path, name: &str) -> Box<KelmaSession> {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        KelmaSession::open(&json!({
            "collectionPath": dir.join("collection.anki2").to_string_lossy(),
            "mediaFolderPath": dir.join("collection.media").to_string_lossy(),
            "mediaDbPath": dir.join("collection.media.db2").to_string_lossy(),
            "timeZone": "UTC",
        }))
        .unwrap()
    }

    /// Full native-v2 regression against the local isolated server user. Run:
    /// `cargo test --manifest-path rust/kelma-core/Cargo.toml -- --ignored`
    #[test]
    #[ignore = "requires the local v2 server on localhost:8081"]
    fn native_v2_fresh_pull_updates_scheduling_and_tombstones() {
        let endpoint = "http://localhost:8081";
        let unique = format!(
            "ios-e2e-{}-{}",
            std::process::id(),
            TimestampMillis::now().0
        );
        let password = "ios-native-v2-test";
        v2_json(
            "POST",
            endpoint,
            "/v2/auth/register",
            None,
            Some(json!({ "username": unique, "password": password })),
        )
        .unwrap();
        let login = v2_json(
            "POST",
            endpoint,
            "/v2/auth/login",
            None,
            Some(json!({
                "username": unique,
                "password": password,
                "client_label": "kelma-ios-e2e"
            })),
        )
        .unwrap();
        let token = login.get("token").and_then(Value::as_str).unwrap();
        let auth = json!({ "hkey": token, "endpoint": endpoint });

        let root = std::env::temp_dir().join(format!("kelma-ios-v2-{unique}"));
        let source = test_session(&root, "source");
        let target = test_session(&root, "target");
        let ntid = source.notetypes().unwrap()["notetypes"][0]["id"]
            .as_i64()
            .unwrap();
        let added = source
            .add_note(&json!({
                "notetypeId": ntid,
                "deckId": 1,
                "fields": ["mobile front [sound:ios-e2e.mp3]", "mobile back"],
                "tags": ["ios-e2e"]
            }))
            .unwrap();
        let source_nid = added["noteId"].as_i64().unwrap();
        let source_media = root.join("source/collection.media/ios-e2e.mp3");
        std::fs::create_dir_all(source_media.parent().unwrap()).unwrap();
        std::fs::write(&source_media, b"mobile-media-v1").unwrap();

        source.sync_collection(&auth).unwrap();
        source.sync_media(&auth).unwrap();
        target.sync_collection(&auth).unwrap();
        target.sync_media(&auth).unwrap();
        let target_media = root.join("target/collection.media/ios-e2e.mp3");
        assert_eq!(std::fs::read(&target_media).unwrap(), b"mobile-media-v1");
        let stable = target.sync_collection(&auth).unwrap();
        assert_eq!(
            stable["required"], "noChanges",
            "{}",
            stable["serverMessage"]
        );

        // Same-name server replacements must invalidate the downloaded-media
        // baseline and overwrite the stale local file.
        let response = block_on(async {
            web_client()
                .put(format!("{endpoint}/v2/media/ios-e2e.mp3"))
                .bearer_auth(token)
                .header("content-type", "application/octet-stream")
                .body(b"mobile-media-v2".to_vec())
                .send()
                .await
        })
        .unwrap();
        assert!(response.status().is_success());
        target.sync_media(&auth).unwrap();
        assert_eq!(std::fs::read(&target_media).unwrap(), b"mobile-media-v2");
        let (target_nid, guid, fields): (i64, String, String) = target
            .with_col_result(|col| {
                col.storage
                    .db()
                    .query_row(
                        "SELECT id, guid, flds FROM notes WHERE tags LIKE '%ios-e2e%'",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert!(!guid.is_empty());
        assert!(fields.contains("mobile front"));

        std::thread::sleep(std::time::Duration::from_secs(1));
        source
            .update_note(&json!({
                "noteId": source_nid,
                "notetypeId": ntid,
                "fields": ["updated on iOS", "mobile back"],
                "tags": ["ios-e2e"]
            }))
            .unwrap();
        source.sync_collection(&auth).unwrap();
        target.sync_collection(&auth).unwrap();
        let updated: String = target
            .with_col_result(|col| {
                col.storage
                    .db()
                    .query_row("SELECT flds FROM notes WHERE id=?", [target_nid], |r| {
                        r.get(0)
                    })
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert!(updated.starts_with("updated on iOS"));

        std::thread::sleep(std::time::Duration::from_secs(1));
        source
            .with_col_result(|col| {
                col.storage
                    .db()
                    .execute("UPDATE col SET crt=crt-(5*86400)", [])
                    .map_err(|e| e.to_string())?;
                col.storage
                    .db()
                    .execute(
                        "UPDATE cards SET type=2, queue=2, due=30, mod=?, usn=-1 WHERE nid=?",
                        (TimestampSecs::now().0, source_nid),
                    )
                    .map_err(|e| e.to_string())?;
                Ok(())
            })
            .unwrap();
        source.sync_collection(&auth).unwrap();
        target.sync_collection(&auth).unwrap();
        let source_due: i64 = source
            .with_col_result(|col| {
                col.storage
                    .db()
                    .query_row("SELECT due FROM cards WHERE nid=?", [source_nid], |r| {
                        r.get(0)
                    })
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        let target_due: i64 = target
            .with_col_result(|col| {
                col.storage
                    .db()
                    .query_row("SELECT due FROM cards WHERE nid=?", [target_nid], |r| {
                        r.get(0)
                    })
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        let source_crt: i64 = source
            .with_col_result(|col| {
                col.storage
                    .db()
                    .query_row("SELECT crt FROM col", [], |r| r.get(0))
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        let target_crt: i64 = target
            .with_col_result(|col| {
                col.storage
                    .db()
                    .query_row("SELECT crt FROM col", [], |r| r.get(0))
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(
            source_crt / 86400 + source_due,
            target_crt / 86400 + target_due
        );

        // A deletion authored on Mobile is persisted as an outgoing tombstone,
        // uploaded on the next sync, and removed from another device.
        let delete_note = source
            .add_note(&json!({
                "notetypeId": ntid,
                "deckId": 1,
                "fields": ["delete me", "mobile tombstone"],
                "tags": ["ios-delete-e2e"]
            }))
            .unwrap();
        let delete_source_nid = delete_note["noteId"].as_i64().unwrap();
        source.sync_collection(&auth).unwrap();
        target.sync_collection(&auth).unwrap();
        let delete_target_card: i64 = target
            .with_col_result(|col| {
                col.storage
                    .db()
                    .query_row(
                        "SELECT c.id FROM cards c JOIN notes n ON n.id=c.nid WHERE n.tags LIKE '%ios-delete-e2e%'",
                        [],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        target
            .delete_card(&json!({ "cardId": delete_target_card }))
            .unwrap();
        target.sync_collection(&auth).unwrap();
        source.sync_collection(&auth).unwrap();
        let source_deleted: i64 = source
            .with_col_result(|col| {
                col.storage
                    .db()
                    .query_row(
                        "SELECT count(*) FROM notes WHERE id=?",
                        [delete_source_nid],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(source_deleted, 0);

        // A local review against server-deleted data requires explicit one-sync
        // approval; no device work is discarded silently.
        target
            .with_col_result(|col| {
                col.storage
                    .db()
                    .execute(
                        "UPDATE cards SET due=due+1, mod=?, usn=-1 WHERE nid=?",
                        (TimestampSecs::now().0, target_nid),
                    )
                    .map_err(|e| e.to_string())?;
                Ok(())
            })
            .unwrap();
        v2_json(
            "DELETE",
            endpoint,
            &format!("/v2/notes/{}", urlencode(&guid)),
            Some(token),
            None,
        )
        .unwrap();
        let blocked = target.sync_collection(&auth).unwrap_err();
        assert!(blocked.contains("KELMA_DELETION_CONFIRM:"));
        let approved = json!({
            "hkey": token,
            "endpoint": endpoint,
            "allowDeletions": true,
        });
        target.sync_collection(&approved).unwrap();
        let remaining: i64 = target
            .with_col_result(|col| {
                col.storage
                    .db()
                    .query_row("SELECT count(*) FROM notes WHERE id=?", [target_nid], |r| {
                        r.get(0)
                    })
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(remaining, 0);

        drop(source);
        drop(target);
        let _ = std::fs::remove_dir_all(root);
    }
}

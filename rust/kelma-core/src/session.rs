// Kelma collection session: review, scheduling, and sync driven entirely by
// Anki's rslib. No study state is reimplemented here — every operation is a
// thin translation between JSON (for the platform layer) and rslib's public
// `Collection` API.
//
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;

use anki::browser_table::Column;
use anki::card::CardId;
use anki::collection::{Collection, CollectionBuilder};
use anki::decks::{Deck, DeckId, DeckKind, NativeDeckName};
use anki::import_export::package::ExportAnkiPackageOptions;
use anki::notetype::NotetypeId;
use anki::prelude::{AnkiError, OrInvalid, OrNotFound};
use anki::progress::{Progress, ProgressState};
use anki::scheduler::answering::{CardAnswer, Rating};
use anki::scheduler::states::SchedulingStates;
use anki::search::{parse_search, JoinSearches, SearchBuilder, SearchNode, SortMode, StateKind};
use anki::services::{CardsService, NotesService, NotetypesService, SearchService, TagsService};
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
}

/// Build the reqwest client rslib expects for sync. It must be the same
/// `reqwest` version rslib links against (see Cargo.toml pinning note).
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
        self.with_col(|col| {
            let out = col.remove_cards(anki_proto::cards::RemoveCardsRequest {
                card_ids: vec![card_id],
            })?;
            Ok(json!({ "count": out.count }))
        })
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
            let _ = col.update_notes(anki_proto::notes::UpdateNotesRequest {
                notes: vec![anki_proto::notes::Note {
                    id: note_id,
                    guid: String::new(),
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
            "c": format!("kelma-mobile:{}", crate::ANKI_VERSION),
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
            let _ = col.update_notes(anki_proto::notes::UpdateNotesRequest {
                notes: vec![anki_proto::notes::Note {
                    id: nid,
                    guid: String::new(),
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
                "client_label": format!("kelma-mobile:{}", crate::ANKI_VERSION),
            })),
        )?;
        let token = resp
            .get("token")
            .and_then(Value::as_str)
            .ok_or_else(|| "v2 login response missing token".to_string())?
            .to_string();
        Ok(json!({ "hkey": token, "endpoint": endpoint }))
    }

    /// Run a KelmaSync v2 content sync. This first mobile bridge is
    /// intentionally conservative:
    /// - pulls missing server decks/notetypes/notes/cards into mobile
    /// - applies server cards by logical identity `(note_guid, ord)`
    /// - does not silently overwrite existing changed local notes/cards
    /// Upload of mobile-origin changes will be layered on after scheduling is
    /// represented as absolute due dates server-side.
    pub fn sync_collection(&self, request: &Value) -> Result<Value, String> {
        let token = str_field(request, "hkey")?;
        let endpoint = str_field(request, "endpoint")?;
        let outcome = self.v2_sync_collection(&endpoint, &token)?;
        Ok(json!({
            "required": if outcome.changed { "normalSyncRequired" } else { "noChanges" },
            "uploadOk": false,
            "downloadOk": false,
            "serverMessage": outcome.message,
            "newEndpoint": Value::Null,
        }))
    }

    fn v2_sync_collection(&self, endpoint: &str, token: &str) -> Result<V2SyncOutcome, String> {
        let manifest = v2_json("GET", endpoint, "/v2/sync/manifest", Some(token), None)?;
        let server_note_guids = manifest
            .get("notes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|n| n.get("guid").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        let server_card_ids = manifest
            .get("cards")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|c| c.get("card_id").and_then(Value::as_i64))
            .collect::<Vec<_>>();
        let server_notetype_ids = manifest
            .get("notetypes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|n| n.get("notetype_id").and_then(Value::as_i64))
            .collect::<Vec<_>>();
        let server_deck_names = manifest
            .get("decks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|d| d.get("name").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();

        let mut pulled_notes = Vec::<Value>::new();
        for chunk in server_note_guids.chunks(500) {
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
        for chunk in server_card_ids.chunks(500) {
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
        for deck in &pulled_decks {
            let name = deck
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Default");
            if ensure_deck(col, name)? {
                created_decks += 1;
            }
        }

        let mut applied_notetypes = 0usize;
        for nt in &pulled_notetypes {
            let ntid = nt.get("notetype_id").and_then(Value::as_i64).unwrap_or(0);
            if ntid == 0
                || col
                    .get_notetype(NotetypeId(ntid))
                    .map_err(|e| format!("{e:?}"))?
                    .is_some()
            {
                continue;
            }
            let mut definition = nt.get("definition").cloned().unwrap_or_else(|| json!({}));
            if let Some(obj) = definition.as_object_mut() {
                obj.insert("id".to_string(), json!(ntid));
                if let Some(name) = nt.get("name").and_then(Value::as_str) {
                    obj.insert("name".to_string(), json!(name));
                }
                obj.entry("mod".to_string()).or_insert(json!(0));
                obj.entry("usn".to_string()).or_insert(json!(0));
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
        for note in &pulled_notes {
            let guid = note.get("guid").and_then(Value::as_str).unwrap_or("");
            if guid.is_empty() {
                continue;
            }
            let exists: Option<i64> = col
                .storage
                .db()
                .query_row("SELECT id FROM notes WHERE guid = ?", [guid], |r| r.get(0))
                .optional()
                .map_err(|e| format!("check note {guid}: {e}"))?;
            if exists.is_some() {
                continue;
            }
            let ntid = note.get("notetype_id").and_then(Value::as_i64).unwrap_or(0);
            let nt = col
                .get_notetype(NotetypeId(ntid))
                .map_err(|e| format!("get notetype {ntid}: {e:?}"))?
                .ok_or_else(|| format!("server note {guid} references missing notetype {ntid}"))?;
            let deck_name = note_deck.get(guid).map(String::as_str).unwrap_or("Default");
            ensure_deck(col, deck_name)?;
            let did = deck_id_by_name(col, deck_name)?.unwrap_or(DeckId(1));
            let mut local = nt.new_note();
            let fields = note
                .get("fields")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for (idx, field) in fields.iter().enumerate() {
                if idx < local.fields().len() {
                    local
                        .set_field(idx, field.as_str().unwrap_or("").to_string())
                        .map_err(|e| format!("set note field {guid}: {e:?}"))?;
                }
            }
            local.tags = note
                .get("tags")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect();
            col.add_note(&mut local, did)
                .map_err(|e| format!("add note {guid}: {e:?}"))?;
            col.storage
                .db()
                .execute(
                    "UPDATE notes SET guid = ?, usn = 0 WHERE id = ?",
                    (&guid, local.id.0),
                )
                .map_err(|e| format!("stamp guid {guid}: {e}"))?;
            added_notes += 1;
        }

        let mut applied_cards = 0usize;
        for card in &pulled_cards {
            let guid = card.get("note_guid").and_then(Value::as_str).unwrap_or("");
            let ord = card.get("ord").and_then(Value::as_i64).unwrap_or(0);
            if guid.is_empty() {
                continue;
            }
            let cid: Option<i64> = col.storage.db()
                .query_row(
                    "SELECT c.id FROM cards c JOIN notes n ON n.id = c.nid WHERE n.guid = ? AND c.ord = ? LIMIT 1",
                    (guid, ord),
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| format!("find local card {guid}:{ord}: {e}"))?;
            let Some(cid) = cid else { continue };
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
            col.storage.db().execute(
                "UPDATE cards SET did=?, type=?, queue=?, due=?, ivl=?, factor=?, reps=?, lapses=?, left=?, odue=?, odid=?, flags=?, data=?, usn=0 WHERE id=?",
                rusqlite::params![
                    did.0, s_i64("type"), queue, due, s_i64("ivl"),
                    s_i64("factor"), s_i64("reps"), s_i64("lapses"), s_i64("left"),
                    odue, s_i64("odid"), s_i64("flags"), s_str("data"), cid
                ],
            )
            .map_err(|e| format!("apply card {guid}:{ord}: {e}"))?;
            applied_cards += 1;
        }

        // --- Upload local changes (usn = -1 marks rows changed since last sync,
        // e.g. a card answered during review, or a note edited on device). ---
        let now_secs = TimestampSecs::now().0;

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
        for (guid, mid, nmod, flds, tags) in &pending_notes {
            note_payloads.push(json!({
                "guid": guid,
                "notetype_id": mid,
                "fields": flds.split('\u{1f}').collect::<Vec<_>>(),
                "tags": tags.split_whitespace().collect::<Vec<_>>(),
                "client_modified_at": rfc3339_from_secs(*nmod),
                "base_checksum": "",
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
            String,
        )> = {
            let db = col.storage.db();
            let mut stmt = db
                .prepare(
                    "SELECT c.id, n.guid, c.ord, d.name, c.mod, c.type, c.queue, c.due, c.ivl, c.factor, \
                            c.reps, c.lapses, c.left, c.odue, c.odid, c.data \
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
                        r.get::<_, String>(15)?,
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
                    "flags": 0, "data": data, "_crt": local_crt,
                },
                "client_modified_at": rfc3339_from_secs(*cmod),
            }));
        }

        let mut pushed_notes = 0usize;
        let mut pushed_cards = 0usize;
        if !note_payloads.is_empty() || !card_payloads.is_empty() {
            for nchunk in note_payloads.chunks(500) {
                let resp = v2_json(
                    "POST",
                    endpoint,
                    "/v2/batch/push",
                    Some(token),
                    Some(json!({
                        "notes": nchunk, "cards": [], "notetypes": [], "decks": []
                    })),
                )?;
                pushed_notes += resp
                    .get("accepted")
                    .and_then(|a| a.get("notes"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
            }
            for cchunk in card_payloads.chunks(500) {
                let resp = v2_json(
                    "POST",
                    endpoint,
                    "/v2/batch/push",
                    Some(token),
                    Some(json!({
                        "notes": [], "cards": cchunk, "notetypes": [], "decks": []
                    })),
                )?;
                pushed_cards += resp
                    .get("accepted")
                    .and_then(|a| a.get("cards"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
            }
            // Mark uploaded rows as synced so we don't resend them next time.
            let db = col.storage.db();
            db.execute("UPDATE notes SET usn = 0 WHERE usn = -1 AND guid <> ''", [])
                .map_err(|e| format!("clear note usn: {e}"))?;
            db.execute(
                "UPDATE cards SET usn = 0 WHERE usn = -1 AND nid IN (SELECT id FROM notes WHERE guid <> '')",
                [],
            )
            .map_err(|e| format!("clear card usn: {e}"))?;
        }
        let _ = now_secs;

        Ok(V2SyncOutcome {
            changed: added_notes > 0 || applied_cards > 0 || applied_notetypes > 0
                || created_decks > 0 || pushed_notes > 0 || pushed_cards > 0,
            message: format!(
                "v2 sync: pulled {created_decks} deck(s), {applied_notetypes} notetype(s), {added_notes} note(s), {applied_cards} card(s); pushed {pushed_notes} note(s), {pushed_cards} card(s)"
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

    /// Download missing media through KelmaSync v2 with the same 50-request
    /// concurrency used by the desktop clients.
    pub fn sync_media(&self, request: &Value) -> Result<Value, String> {
        let token = str_field(request, "hkey")?;
        let endpoint = str_field(request, "endpoint")?;
        let media_folder = {
            let guard = self
                .inner
                .lock()
                .map_err(|_| "session poisoned".to_string())?;
            guard.media_folder_path.clone()
        };
        let downloaded = v2_sync_media_downloads(&endpoint, &token, &media_folder, None)?;
        let (files, bytes) = media_folder_totals(&media_folder)?;
        Ok(json!({ "files": files, "bytes": bytes, "downloaded": downloaded }))
    }

    /// Start a 50-request v2 media download on a background thread. The UI
    /// polls `sync_media_poll`, so review/UI work remains responsive.
    pub fn sync_media_start(&self, request: &Value) -> Result<Value, String> {
        let token = str_field(request, "hkey")?;
        let endpoint = str_field(request, "endpoint")?;
        let media_folder = {
            let guard = self
                .inner
                .lock()
                .map_err(|_| "session poisoned".to_string())?;
            guard.media_folder_path.clone()
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
                v2_sync_media_downloads(&endpoint, &token, &media_folder, Some(progress))
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
                Some(p) => (p.checked, p.downloaded_files, 0, 0, 0),
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
            other => return Err(format!("unsupported v2 method {other}")),
        }
        .header(
            "user-agent",
            format!("kelma-mobile:{}", crate::ANKI_VERSION),
        );
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

fn v2_sync_media_downloads(
    endpoint: &str,
    token: &str,
    media_folder: &str,
    progress: Option<Arc<Mutex<V2MediaProgress>>>,
) -> Result<usize, String> {
    std::fs::create_dir_all(media_folder).map_err(|e| format!("create media dir: {e}"))?;
    let manifest = v2_json("GET", endpoint, "/v2/sync/manifest", Some(token), None)?;
    let mut checked = 0usize;
    let mut missing = Vec::new();
    for filename in manifest
        .get("media")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| {
            m.get("filename")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
    {
        if filename.contains('/') || filename.contains('\\') || filename == "." || filename == ".."
        {
            checked += 1;
            continue;
        }
        if std::path::Path::new(media_folder).join(&filename).exists() {
            checked += 1;
        } else {
            missing.push(filename);
        }
    }
    if let Some(cell) = &progress {
        if let Ok(mut p) = cell.lock() {
            p.checked = checked;
        }
    }

    let endpoint = endpoint.trim_end_matches('/').to_string();
    let token = token.to_string();
    let media_folder = media_folder.to_string();
    let progress_for_tasks = progress.clone();
    block_on(async move {
        let client = web_client();
        let mut names = missing.into_iter();
        let mut tasks = tokio::task::JoinSet::new();

        let spawn_download = |tasks: &mut tokio::task::JoinSet<Result<bool, String>>,
                              filename: String| {
            let client = client.clone();
            let endpoint = endpoint.clone();
            let token = token.clone();
            let media_folder = media_folder.clone();
            tasks.spawn(async move {
                let path = format!("/v2/media/{}", urlencode(&filename));
                let response = client
                    .get(format!("{endpoint}{path}"))
                    .bearer_auth(token)
                    .header(
                        "user-agent",
                        format!("kelma-mobile:{}", crate::ANKI_VERSION),
                    )
                    .send()
                    .await
                    .map_err(|e| format!("v2 media request {path}: {e}"))?;
                if response.status() == reqwest::StatusCode::NOT_FOUND {
                    return Ok(false);
                }
                let status = response.status();
                if !status.is_success() {
                    let text = response.text().await.unwrap_or_default();
                    return Err(format!("v2 media {path} failed ({status}): {text}"));
                }
                let bytes = response
                    .bytes()
                    .await
                    .map_err(|e| format!("v2 media bytes {path}: {e}"))?;
                std::fs::write(std::path::Path::new(&media_folder).join(&filename), bytes)
                    .map_err(|e| format!("write media {filename}: {e}"))?;
                Ok(true)
            });
        };

        for filename in names.by_ref().take(50) {
            spawn_download(&mut tasks, filename);
        }
        let mut downloaded = 0usize;
        while let Some(joined) = tasks.join_next().await {
            let did_download = joined.map_err(|e| format!("media download task failed: {e}"))??;
            if did_download {
                downloaded += 1;
            }
            checked += 1;
            if let Some(cell) = &progress_for_tasks {
                if let Ok(mut p) = cell.lock() {
                    p.checked = checked;
                    p.downloaded_files = downloaded;
                }
            }
            if let Some(filename) = names.next() {
                spawn_download(&mut tasks, filename);
            }
        }
        Ok(downloaded)
    })
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
        "c": format!("kelma-mobile:{}", crate::ANKI_VERSION),
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

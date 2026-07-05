// Kelma collection session: review, scheduling, and sync driven entirely by
// Anki's rslib. No study state is reimplemented here — every operation is a
// thin translation between JSON (for the platform layer) and rslib's public
// `Collection` API.
//
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::Arc;
use std::sync::Mutex;
use std::thread;

use anki::browser_table::Column;
use anki::card::CardId;
use anki::collection::{Collection, CollectionBuilder};
use anki::progress::{Progress, ProgressState};
use anki::decks::{DeckId, DeckKind};
use anki::notetype::NotetypeId;
use anki::prelude::{AnkiError, OrInvalid, OrNotFound};
use anki::scheduler::answering::{CardAnswer, Rating};
use anki::scheduler::states::SchedulingStates;
use anki::search::{parse_search, JoinSearches, SearchBuilder, SearchNode, SortMode, StateKind};
use anki::services::{CardsService, NotesService, SearchService, TagsService};
use anki::sync::login::{sync_login, SyncAuth};
use anki::timestamp::{TimestampMillis, TimestampSecs};
use anki::types::Usn;
use anki_proto::decks::DeckTreeNode;
use anki_proto::generic::StringList;
use anki::import_export::package::ExportAnkiPackageOptions;
use rusqlite::params;
use serde_json::{json, Value};

/// A long-lived handle owning one open collection. The platform layer keeps a
/// single session per profile and serializes calls; rslib itself guards the
/// SQLite connection, but we add a `Mutex` so the FFI surface is `Send`/`Sync`.
pub struct KelmaSession {
    inner: Mutex<SessionState>,
    /// Live progress cell of an in-flight background media sync (see
    /// `sync_media_start`). Read by `sync_media_poll` without the `inner` lock,
    /// so progress can be polled while the sync runs on its own thread.
    media_progress: Mutex<Option<Arc<Mutex<ProgressState>>>>,
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
        let guard = self.inner.lock().map_err(|_| "session poisoned".to_string())?;
        let media_path = std::path::Path::new(&guard.media_folder_path);
        let profile_dir = media_path
            .parent()
            .ok_or_else(|| "media folder has no parent directory".to_string())?;

        // A fresh filename per render: WKWebView can otherwise keep serving a
        // cached copy of a `file://` URL it already loaded even after the
        // underlying file changes on disk.
        let scratch_path = profile_dir.join(format!("kelma_card_{}.html", TimestampMillis::now().0));
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
            let nt = col
                .get_notetype(notetype_id)?
                .or_invalid("note type")?;
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
            let nt = col
                .get_notetype(notetype_id)?
                .or_invalid("note type")?;
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
            let dids: std::collections::BTreeSet<i64> = added.keys().chain(changed.keys()).copied().collect();
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

    /// Start a media sync on a background thread and return immediately. The
    /// blocking transfer runs on its own thread, so `sync_media_poll` can read
    /// live progress without waiting on the session lock. Used by the UI to show
    /// real-time counts during a large (multi-GB) media download.
    pub fn sync_media_start(&self, request: &Value) -> Result<Value, String> {
        let auth = sync_auth_from(request)?;

        if self
            .media_progress
            .lock()
            .map_err(|_| "session poisoned".to_string())?
            .is_some()
        {
            return Err("a media sync is already running".to_string());
        }

        // Build the owned media manager + progress handler under the lock, grab a
        // handle to the shared progress cell, then release the lock.
        let (manager, handler, progress_cell, media_folder) = {
            let mut guard = self.inner.lock().map_err(|_| "session poisoned".to_string())?;
            let col = guard
                .col
                .as_mut()
                .ok_or_else(|| "collection is not open".to_string())?;
            let manager = col.media().map_err(|e| format!("{e:?}"))?;
            let handler = col.new_progress_handler();
            let progress_cell = col.shared_progress();
            (manager, handler, progress_cell, guard.media_folder_path.clone())
        };

        let done: Arc<Mutex<Option<Result<Value, String>>>> = Arc::new(Mutex::new(None));
        *self
            .media_progress
            .lock()
            .map_err(|_| "session poisoned".to_string())? = Some(progress_cell);
        *self
            .media_done
            .lock()
            .map_err(|_| "session poisoned".to_string())? = Some(done.clone());

        thread::spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                block_on(manager.sync_media(handler, auth, web_client(), None))
            }));
            let result = match outcome {
                Ok(Ok(())) => {
                    let (files, bytes) = media_folder_totals(&media_folder).unwrap_or((0, 0));
                    Ok(json!({ "files": files, "bytes": bytes }))
                }
                Ok(Err(error)) => {
                    let (files, bytes) = media_folder_totals(&media_folder).unwrap_or((0, 0));
                    Err(format!(
                        "Media sync stopped after {files} files ({bytes} bytes): {error:?}"
                    ))
                }
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
            match cell.as_ref().and_then(|arc| arc.lock().ok().and_then(|s| s.last_progress)) {
                Some(Progress::MediaSync(p)) => (
                    p.checked,
                    p.downloaded_files,
                    p.downloaded_deletions,
                    p.uploaded_files,
                    p.uploaded_deletions,
                ),
                _ => (0, 0, 0, 0, 0),
            }
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
            let mut guard = self.inner.lock().map_err(|_| "session poisoned".to_string())?;
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
            match cell.as_ref().and_then(|arc| arc.lock().ok().and_then(|s| s.last_progress)) {
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
                let mut guard = self.inner.lock().map_err(|_| "session poisoned".to_string())?;
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
        let mut guard = self.inner.lock().map_err(|_| "session poisoned".to_string())?;

        // Close the collection first so no handle keeps media.db open.
        guard.col.take();

        let media_dir = std::path::Path::new(&guard.media_folder_path).to_path_buf();
        if media_dir.exists() {
            for entry in std::fs::read_dir(&media_dir).map_err(|e| format!("read media dir: {e}"))? {
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
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    let slug = if slug.is_empty() { "export".to_owned() } else { slug };
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

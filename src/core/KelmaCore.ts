/**
 * The only application-facing entry point to Anki collection behavior.
 *
 * Every function here is backed by rslib through the NativeKelmaCore
 * TurboModule. No scheduler, FSRS, template, or sync logic is reimplemented in
 * TypeScript — this module only types the JSON contract and shuttles intent.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Platform } from 'react-native';
import NativeKelmaCore from '../../specs/NativeKelmaCore';
import { DEFAULT_PROFILE_ID, DEFAULT_SYNC_ENDPOINT } from '../config';

export type CoreInfo = {
  ankiVersion: string;
  ankiCommit: string;
  bridgeVersion: string;
  platform: 'android' | 'ios';
};

export type StudyCounts = {
  new: number;
  learning: number;
  review: number;
};

export type ReviewCard = {
  cardId: number;
  deckName: string;
  question: string;
  answer: string;
  css: string;
  /** Next-interval labels for the rating buttons: [again, hard, good, easy]. */
  intervals: string[];
};

export type NextCard = {
  counts: StudyCounts;
  card: ReviewCard | null;
};

export type DeckNode = {
  deckId: number;
  name: string;
  level: number;
  collapsed: boolean;
  filtered: boolean;
  newCount: number;
  learnCount: number;
  reviewCount: number;
  children: DeckNode[];
};

/** Anki rating: Again=0, Hard=1, Good=2, Easy=3. */
export enum Rating {
  Again = 0,
  Hard = 1,
  Good = 2,
  Easy = 3,
}

export type SyncAuth = {
  hkey: string;
  endpoint: string;
};

export type SyncOutcome = {
  required: 'noChanges' | 'normalSyncRequired' | 'fullSyncRequired';
  uploadOk: boolean;
  downloadOk: boolean;
  serverMessage: string;
  newEndpoint: string | null;
};

function requireModule(): NonNullable<typeof NativeKelmaCore> {
  if (!NativeKelmaCore) {
    throw new Error(
      Platform.OS === 'ios'
        ? 'The iOS Rust module is missing. Run pod install and rebuild the app.'
        : 'NativeKelmaCore is not registered in this build.',
    );
  }
  return NativeKelmaCore;
}

async function runOp<T>(op: string, request: unknown = ''): Promise<T> {
  const module = requireModule();
  const payload = request === '' ? '' : JSON.stringify(request);
  const result = await module.runCollectionOp(op, payload);
  return JSON.parse(result) as T;
}

// --- Core identity -----------------------------------------------------------

function isCoreInfo(value: unknown): value is CoreInfo {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const info = value as Partial<CoreInfo>;
  return (
    typeof info.ankiVersion === 'string' &&
    typeof info.ankiCommit === 'string' &&
    typeof info.bridgeVersion === 'string' &&
    (info.platform === 'android' || info.platform === 'ios')
  );
}

export function decodeCoreInfo(payload: string): CoreInfo {
  const parsed: unknown = JSON.parse(payload);
  if (!isCoreInfo(parsed)) {
    throw new Error('The native core returned an invalid identity payload.');
  }
  return parsed;
}

export async function getCoreInfo(): Promise<CoreInfo> {
  return decodeCoreInfo(await requireModule().getCoreInfo());
}

// --- Collection lifecycle ----------------------------------------------------

/**
 * Open (or create) the active profile's collection. The native layer resolves
 * the on-device paths from the profile id, so the JS layer never hardcodes a
 * filesystem location.
 *
 * Also passes the device's IANA timezone (e.g. "America/Chicago"), which the
 * Rust core uses to set `TZ` before touching rslib's scheduler. rslib's
 * day-rollover math (what counts as "today", and the seed for new/review
 * queue shuffling) depends on `chrono::Local`, which reads `TZ`/the OS
 * timezone database — a step that's reliable on desktop but not guaranteed
 * inside an embedded mobile Rust runtime. Without an explicit `TZ`, the app
 * can silently compute a different "today" than Anki Desktop/AnkiMobile for
 * the same collection, producing a different due-card order.
 */
export async function openProfile(
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<void> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  await requireModule().openCollection(JSON.stringify({ profileId, timeZone }));
}

export async function closeProfile(): Promise<void> {
  await requireModule().closeCollection();
}

// --- Decks -------------------------------------------------------------------

export async function getDeckTree(): Promise<DeckNode> {
  return runOp<DeckNode>('deckTree');
}

/** Absolute path of the collection's media folder (for resolving audio files). */
export async function getMediaDir(): Promise<string> {
  return (await runOp<{ dir: string }>('mediaDir')).dir;
}

export type CardHtmlFile = {
  /** file:// URI of the freshly written scratch HTML file. */
  uri: string;
  /** file:// URI of the directory to grant the WebView read access to (covers
   *  both the scratch file and the media folder). iOS only — WKWebView's
   *  `loadHTMLString:baseURL:` (used by `source.html`) never grants its
   *  sandboxed renderer read access to local `file://` subresources, which is
   *  why card images wouldn't load; `source.uri` + this grant does. */
  allowedRoot: string;
};

/**
 * Persist rendered card HTML (from `buildCardHtml`) to a scratch file next to
 * the media folder, so the reviewer can load it via `source.uri` instead of
 * `source.html` and have its images actually resolve.
 */
export async function writeCardHtml(html: string): Promise<CardHtmlFile> {
  return runOp<CardHtmlFile>('writeCardHtml', { html });
}

// --- Statistics --------------------------------------------------------------

export type CardCounts = {
  total: number;
  new: number;
  learning: number;
  young: number;
  mature: number;
  suspended: number;
};

export type Stats = {
  /** Localised "Studied N cards in M minutes today" message from rslib. */
  studiedToday: string;
  counts: CardCounts;
};

export async function getStats(): Promise<Stats> {
  return runOp<Stats>('stats');
}

// --- Deck inspector ----------------------------------------------------------

/** Per-deck overview: the AnkiDroid StudyOptionsFragment numbers. */
export type DeckOverview = {
  deckId: number;
  name: string;
  /** Raw deck description (markdown source if the deck uses markdown). */
  description: string;
  filtered: boolean;
  /** Today's due counts, including subdecks, after per-deck limits. */
  todayNew: number;
  todayLearn: number;
  todayReview: number;
  /** Total new cards in this deck and its subdecks. */
  totalNew: number;
  /** Total cards in this deck and its subdecks. */
  totalCards: number;
};

/** One row of the deck card browser. `color` mirrors rslib's BrowserRow.Color. */
export type BrowseCard = {
  cardId: number;
  question: string;
  due: string;
  interval: string;
  reps: string;
  lapses: string;
  color: number;
};

export type BrowseDeckResult = {
  deckId: number;
  total: number;
  offset: number;
  limit: number;
  cards: BrowseCard[];
};

/** rslib BrowserRow.Color discriminants we surface as `BrowseCard.color`. */
export const CardColor = {
  Default: 0,
  Marked: 1,
  Suspended: 2,
  FlagRed: 3,
  FlagOrange: 4,
  FlagGreen: 5,
  FlagBlue: 6,
  FlagPink: 7,
  FlagTurquoise: 8,
  FlagPurple: 9,
  Buried: 10,
} as const;

/** The Card Browser scoped to one deck (and its subdecks). */
export async function getDeckOverview(deckId: number): Promise<DeckOverview> {
  return runOp<DeckOverview>('deckOverview', { deckId });
}

export async function browseDeck(
  deckId: number,
  options: { query?: string; limit?: number; offset?: number } = {},
): Promise<BrowseDeckResult> {
  return runOp<BrowseDeckResult>('browseDeck', {
    deckId,
    query: options.query ?? '',
    limit: options.limit ?? 50,
    offset: options.offset ?? 0,
  });
}

/** A fully rendered card (front/back + the note type's CSS), for the card
 * detail view. Mirrors the reviewer's `ReviewCard` minus the intervals.
 * Also carries the card's scheduling/flag state and the note's mark state so
 * the detail screen can show browser-style actions (suspend / bury / flag /
 * deck / mark / delete) and reflect the current state. */
export type CardDetail = {
  cardId: number;
  question: string;
  answer: string;
  css: string;
  /** The note id owning this card (mark is a note-level tag). */
  noteId: number;
  /** The deck id the card currently lives in. */
  deckId: number;
  /** rslib `CardQueue` value: 0=new,1=learn,2=review,3=day-learn,4=preview,
   * -1=suspended, -2=sched-buried, -3=user-buried. */
  queue: number;
  /** Flag 0-7 (0 = no flag). */
  flags: number;
  /** Whether the note currently has the "marked" tag. */
  marked: boolean;
};

export async function getCardDetail(cardId: number): Promise<CardDetail> {
  return runOp<CardDetail>('cardDetail', { cardId });
}

// --- Card actions (browser-style, all rslib transactional) ------------------

export async function suspendCard(cardId: number): Promise<{ count: number }> {
  return runOp('suspendCard', { cardId });
}

export async function unsuspendCard(cardId: number): Promise<{ restored: boolean }> {
  return runOp('unsuspendCard', { cardId });
}

export async function buryCard(cardId: number): Promise<{ count: number }> {
  return runOp('buryCard', { cardId });
}

/** Set the flag (0-7) on a card. 0 = no flag. */
export async function setCardFlag(cardId: number, flag: number): Promise<{ flag: number }> {
  return runOp('setCardFlag', { cardId, flag });
}

export async function setCardDeck(cardId: number, deckId: number): Promise<{ deckId: number }> {
  return runOp('setCardDeck', { cardId, deckId });
}

export async function deleteCard(cardId: number): Promise<{ count: number }> {
  return runOp('deleteCard', { cardId });
}

/** Toggle the "marked" tag on the card's note; returns the new marked state. */
export async function toggleCardMark(cardId: number): Promise<{ marked: boolean }> {
  return runOp('toggleCardMark', { cardId });
}

// --- Note editing ----------------------------------------------------------

/** One editable field of a note: the notetype's field name + current value. */
export type NoteField = { name: string; value: string };

/** A note loaded for editing (from a card id). */
export type NoteEdit = {
  noteId: number;
  notetypeId: number;
  notetypeName: string;
  fields: NoteField[];
  tags: string[];
};

export async function getNoteEdit(cardId: number): Promise<NoteEdit> {
  return runOp<NoteEdit>('getNoteEdit', { cardId });
}

/** Save an edited note. `fields` must be in the notetype's field order. */
export async function updateNote(
  noteId: number,
  notetypeId: number,
  fields: string[],
  tags: string[],
): Promise<{ saved: boolean }> {
  return runOp('updateNote', { noteId, notetypeId, fields, tags });
}

// --- Add / notetypes --------------------------------------------------------

/** A notetype listed by the Add screen's notetype picker. */
export type NotetypeInfo = {
  id: number;
  name: string;
  /** Field names in notetype order; the editor lays out one input each. */
  fields: string[];
  /** Number of notes currently using this notetype. */
  useCount: number;
};

/** List every notetype in the collection, for the Add screen's picker. */
export async function getNotetypes(): Promise<NotetypeInfo[]> {
  const result = await runOp<{ notetypes: NotetypeInfo[] }>('notetypes');
  return result.notetypes;
}

/** Create a new note (and its generated cards) in the given deck — AnkiDroid's
 *  Add. `fields` must be in the notetype's field order. Returns the new note id
 *  and the number of cards generated. */
export async function addNote(
  notetypeId: number,
  deckId: number,
  fields: string[],
  tags: string[],
): Promise<{ noteId: number; cards: number }> {
  return runOp('addNote', { notetypeId, deckId, fields, tags });
}

/** rslib `NoteFieldsCheckResponse.State`: the result of checking a note's
 *  fields before adding — mirrors Anki's Add screen duplicate check. */
export const NoteFieldState = {
  Normal: 0,
  Empty: 1,
  Duplicate: 2,
  MissingCloze: 3,
  NotetypeNotCloze: 4,
  FieldNotCloze: 5,
} as const;

/** Check a note's fields before adding — the same check Anki's Add screen runs
 *  via `Collection::note_fields_check`. Returns the state (normal / empty /
 *  duplicate / cloze issues). The UI uses this to warn the user before creating
 *  a duplicate note, which is the cause of 1-card sync divergences when the
 *  same content already exists on the server with a different GUID. */
export async function checkNoteFields(
  notetypeId: number,
  fields: string[],
): Promise<{ state: number }> {
  return runOp<{ state: number }>('checkNoteFields', { notetypeId, fields });
}

// --- Export -----------------------------------------------------------------

/** The absolute path + note count returned by a deck export. */
export type ExportResult = {
  /** Absolute filesystem path to the generated `.apkg` file. */
  path: string;
  /** Number of notes included in the package. */
  notes: number;
};

/** Export a deck (and its subdecks) to an `.apkg` package in the OS temp dir,
 *  like AnkiDroid's Export. Returns the file path for a share sheet. */
export async function exportDeck(
  deckId: number,
  deckName: string,
  options: { withScheduling?: boolean; withMedia?: boolean; withDeckConfigs?: boolean } = {},
): Promise<ExportResult> {
  return runOp<ExportResult>('exportDeck', {
    deckId,
    deckName,
    withScheduling: options.withScheduling ?? true,
    withMedia: options.withMedia ?? true,
    withDeckConfigs: options.withDeckConfigs ?? true,
  });
}

// --- Import -----------------------------------------------------------------

/** Summary of an `.apkg` import, mirroring rslib's ImportResponse log. */
export type ImportResult = {
  /** Notes newly added to the collection. */
  added: number;
  /** Existing notes whose fields were updated. */
  updated: number;
  /** Notes skipped as duplicates of existing first fields. */
  duplicates: number;
  /** Notes that conflicted (e.g. notetype mismatch) and were skipped. */
  conflicts: number;
  /** Total notes the package contained. */
  foundNotes: number;
};

/** Import an `.apkg` package into the collection — AnkiDroid's Import. The
 *  `packagePath` must be a real filesystem path rslib can open (use
 *  `pickFile`/`copyUriToTempPath` to resolve a picker selection or shared
 *  file URI to a path first). */
export async function importApkg(
  packagePath: string,
  options: { mergeNotetypes?: boolean; withScheduling?: boolean; withDeckConfigs?: boolean } = {},
): Promise<ImportResult> {
  return runOp<ImportResult>('importApkg', {
    packagePath,
    mergeNotetypes: options.mergeNotetypes ?? false,
    withScheduling: options.withScheduling ?? true,
    withDeckConfigs: options.withDeckConfigs ?? true,
  });
}

// --- Sync state (per-deck pending badges + stored credentials) ----------------

/** Per-deck unsynced card counts, mirroring the Kelma plugin's deck badges. */
export type PendingDeckChanges = {
  deckId: number;
  /** Cards created since the last sync (card id newer than `col.ls`). */
  added: number;
  /** Pre-existing cards reviewed/edited since the last sync. */
  changed: number;
};

export type PendingChanges = {
  /** rslib's authoritative collection-wide "local changes pending" signal. */
  hasChanges: boolean;
  /** rslib's last-sync timestamp (ms), or 0 if never synced. */
  lastSyncMs: number;
  decks: PendingDeckChanges[];
};

export async function getPendingChanges(): Promise<PendingChanges> {
  return runOp<PendingChanges>('pendingChanges');
}

/** Load the persisted KelmaSync credentials (from the collection's config
 * store), or `null` if the user hasn't signed in. */
export async function getStoredSyncAuth(): Promise<SyncAuth | null> {
  const result = await runOp<SyncAuth | null>('getSyncAuth');
  return result ?? null;
}

/** Persist the KelmaSync host key + endpoint so the home Sync button can sync
 * without re-prompting for a login. */
export async function storeSyncAuth(auth: SyncAuth): Promise<void> {
  await runOp('setSyncAuth', auth);
}

export async function clearStoredSyncAuth(): Promise<void> {
  await runOp('clearSyncAuth');
}

/** Diagnostic dump of sync-relevant state — `col` timestamps/usn + raw counts
 * of rows still marked pending (`usn=-1`). For localizing upload bugs. */
export type SyncDebug = {
  col: { mod: number; scm: number; ls: number; usn: number };
  pendingCards: number;
  pendingNotes: number;
  pendingRevlogs: number;
  pendingGraves: number;
  totalCards: number;
  totalRevlogs: number;
};

export async function getSyncDebug(): Promise<SyncDebug> {
  return runOp<SyncDebug>('syncDebug');
}

/** Run a full incremental sync (collection + media) using stored credentials,
 * for the home-screen Sync button. Handles the full-sync case the server may
 * demand. Returns a one-line status string for the UI. */
export async function runSyncNow(auth: SyncAuth): Promise<string> {
  const outcome = await syncCollection(auth);
  if (outcome.required === 'fullSyncRequired') {
    await fullSync(auth, outcome.downloadOk ? false : true);
  }
  const media = await syncMedia(auth);
  const collectionSummary =
    outcome.required === 'noChanges' ? 'no collection changes' : 'collection updated';
  const mediaSummary = `${media.files.toLocaleString()} media file${media.files === 1 ? '' : 's'}`;
  return `Synced (${collectionSummary}, ${mediaSummary}).`;
}

// --- Review / scheduling -----------------------------------------------------

/**
 * Set the deck that `getNextCard` pulls from (rslib's "current deck").
 * Descendant decks are included automatically, exactly like tapping a deck in
 * AnkiDroid to start its review session.
 */
export async function selectDeck(deckId: number): Promise<void> {
  await runOp('setDeck', { deckId });
}

export async function getNextCard(): Promise<NextCard> {
  return runOp<NextCard>('nextCard');
}

/**
 * Answer the current card. rslib recomputes the scheduling states from the card
 * id and the chosen rating, so the only inputs are the card, the rating, and
 * how long the answer took.
 */
export async function answerCard(
  cardId: number,
  rating: Rating,
  millisecondsTaken: number,
): Promise<void> {
  await runOp('answerCard', { cardId, rating, millisecondsTaken });
}

export type UndoStatus = {
  canUndo: boolean;
  /** Debug name of rslib's internal `Op` (e.g. "AnswerCard"), not localized. */
  operation: string | null;
};

/**
 * Whether there's a change to undo — an answered card, or a suspend/bury/
 * flag/delete from the card menu — so the reviewer can show/hide its "Undo"
 * control, matching the desktop client's Ctrl+Z availability.
 */
export async function getUndoStatus(): Promise<UndoStatus> {
  return runOp<UndoStatus>('undoStatus');
}

export type UndoResult = {
  undone: boolean;
  operation: string | null;
};

/**
 * Undo the last change, exactly like Ctrl+Z on the desktop client. rslib has
 * a single global undo stack, so if the last change was answering the current
 * card, the reviewer should reload the next card afterwards to show it again.
 */
export async function undo(): Promise<UndoResult> {
  return runOp<UndoResult>('undo');
}

// --- Sync (KelmaSync by default) --------------------------------------------

export async function syncLogin(
  username: string,
  password: string,
  endpoint: string = DEFAULT_SYNC_ENDPOINT,
): Promise<SyncAuth> {
  return runOp<SyncAuth>('syncLogin', { username, password, endpoint });
}

export async function syncCollection(auth: SyncAuth): Promise<SyncOutcome> {
  return runOp<SyncOutcome>('syncCollection', auth);
}

export type MediaSyncResult = {
  files: number;
  bytes: number;
};

export async function syncMedia(auth: SyncAuth): Promise<MediaSyncResult> {
  return runOp<MediaSyncResult>('syncMedia', auth);
}

/** Live progress of a background media sync (see `syncMediaMonitored`). */
export type MediaProgress = {
  done: boolean;
  ok?: boolean;
  error?: string;
  files?: number; // final total files on disk, once done
  bytes?: number; // final total bytes on disk, once done
  checked: number;
  downloadedFiles: number;
  downloadedDeletions: number;
  uploadedFiles: number;
  uploadedDeletions: number;
};

async function syncMediaStart(auth: SyncAuth): Promise<void> {
  await runOp('syncMediaStart', auth);
}

async function syncMediaPoll(): Promise<MediaProgress> {
  return runOp<MediaProgress>('syncMediaPoll');
}

/**
 * Media sync with live progress. Runs the transfer on a background thread in the
 * core and polls it, invoking `onProgress` with running counts — so a large
 * (multi-GB) media download shows real activity instead of a frozen spinner.
 * Falls back to the blocking `syncMedia` on cores that predate the start/poll
 * ops (i.e. before the app is rebuilt).
 */
export async function syncMediaMonitored(
  auth: SyncAuth,
  onProgress: (p: MediaProgress) => void,
  intervalMs = 700,
): Promise<MediaSyncResult> {
  try {
    await syncMediaStart(auth);
  } catch {
    // Older core without background media sync — use the blocking path.
    return syncMedia(auth);
  }
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  for (;;) {
    await sleep(intervalMs);
    const p = await syncMediaPoll();
    onProgress(p);
    if (p.done) {
      if (p.ok === false) {
        throw new Error(p.error ?? 'Media sync failed.');
      }
      return { files: p.files ?? 0, bytes: p.bytes ?? 0 };
    }
  }
}

export async function fullSync(
  auth: SyncAuth,
  upload: boolean,
): Promise<void> {
  await runOp('fullSync', { ...auth, upload });
}

/** Live progress of a background full collection sync (byte counts). */
export type FullSyncProgress = {
  done: boolean;
  ok?: boolean;
  error?: string;
  transferredBytes: number;
  totalBytes: number;
};

async function fullSyncStart(auth: SyncAuth, upload: boolean): Promise<void> {
  await runOp('fullSyncStart', {...auth, upload});
}

async function fullSyncPoll(): Promise<FullSyncProgress> {
  return runOp<FullSyncProgress>('fullSyncPoll');
}

/**
 * Full collection sync (`upload=false` downloads and replaces local) with live
 * byte progress. Runs on a background thread in the core and polls, so the
 * "replacing local collection" phase shows transferred/total bytes instead of
 * freezing. Falls back to the blocking `fullSync` on un-rebuilt cores.
 */
export async function fullSyncMonitored(
  auth: SyncAuth,
  upload: boolean,
  onProgress: (p: FullSyncProgress) => void,
  intervalMs = 500,
): Promise<void> {
  try {
    await fullSyncStart(auth, upload);
  } catch {
    await fullSync(auth, upload);
    return;
  }
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  for (;;) {
    await sleep(intervalMs);
    const p = await fullSyncPoll();
    onProgress(p);
    if (p.done) {
      if (p.ok === false) {
        throw new Error(p.error ?? 'Full sync failed.');
      }
      return;
    }
  }
}

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
 */
export async function openProfile(
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<void> {
  await requireModule().openCollection(JSON.stringify({ profileId }));
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
 * detail view. Mirrors the reviewer's `ReviewCard` minus the intervals. */
export type CardDetail = {
  cardId: number;
  question: string;
  answer: string;
  css: string;
};

export async function getCardDetail(cardId: number): Promise<CardDetail> {
  return runOp<CardDetail>('cardDetail', { cardId });
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

export async function fullSync(
  auth: SyncAuth,
  upload: boolean,
): Promise<void> {
  await runOp('fullSync', { ...auth, upload });
}

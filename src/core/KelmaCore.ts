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

// --- Review / scheduling -----------------------------------------------------

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

export async function fullSync(
  auth: SyncAuth,
  upload: boolean,
): Promise<void> {
  await runOp('fullSync', { ...auth, upload });
}

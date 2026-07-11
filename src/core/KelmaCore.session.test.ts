/**
 * Verifies the JSON contract the TS layer sends to / receives from the native
 * rslib bridge. The native module is mocked; we assert the wrappers encode
 * intent correctly and decode typed results.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

jest.mock('../../specs/NativeKelmaCore', () => ({
  __esModule: true,
  // Defined inside the factory so they exist when jest instantiates the mock.
  default: {
    getCoreInfo: jest.fn(),
    openCollection: jest.fn(),
    closeCollection: jest.fn(),
    runCollectionOp: jest.fn(),
  },
}));

import NativeKelmaCore from '../../specs/NativeKelmaCore';
import {
  answerCard,
  fullSync,
  getDeckTree,
  getMediaDir,
  getNextCard,
  openProfile,
  Rating,
  selectDeck,
  syncCollection,
  syncLogin,
  syncMedia,
} from './KelmaCore';
import { DEFAULT_SYNC_ENDPOINT } from '../config';

// The mocked module exposes plain jest.fns; cast away the strict Spec typing.
const native = NativeKelmaCore as unknown as {
  openCollection: jest.Mock<Promise<string>, [string]>;
  runCollectionOp: jest.Mock<Promise<string>, [string, string]>;
};

beforeEach(() => {
  native.openCollection.mockReset().mockResolvedValue('{"opened":true}');
  native.runCollectionOp.mockReset().mockResolvedValue('{}');
});

describe('collection lifecycle', () => {
  it('opens the default profile by id (native resolves the path)', async () => {
    await openProfile();
    expect(native.openCollection).toHaveBeenCalledTimes(1);
    expect(JSON.parse(native.openCollection.mock.calls[0][0])).toEqual({
      profileId: 'default',
      timeZone: expect.any(String),
    });
  });
});

describe('review + scheduling', () => {
  it('decodes the next card and counts', async () => {
    native.runCollectionOp.mockResolvedValueOnce(
      JSON.stringify({
        counts: { new: 5, learning: 2, review: 9 },
        card: { cardId: 17, deckName: 'Arabic', question: 'q', answer: 'a', css: '' },
      }),
    );

    const next = await getNextCard();
    expect(native.runCollectionOp).toHaveBeenCalledWith('nextCard', '');
    expect(next.card?.cardId).toBe(17);
    expect(next.counts.review).toBe(9);
  });

  it('reports the chosen rating and elapsed time without touching scheduling', async () => {
    await answerCard(17, Rating.Good, 4200);
    expect(native.runCollectionOp).toHaveBeenCalledWith(
      'answerCard',
      JSON.stringify({ cardId: 17, rating: 2, millisecondsTaken: 4200 }),
    );
  });

  it('reads the deck tree', async () => {
    native.runCollectionOp.mockResolvedValueOnce(
      JSON.stringify({
        deckId: 1,
        name: 'Default',
        level: 0,
        collapsed: false,
        filtered: false,
        newCount: 0,
        learnCount: 0,
        reviewCount: 0,
        children: [],
      }),
    );
    const tree = await getDeckTree();
    expect(native.runCollectionOp).toHaveBeenCalledWith('deckTree', '');
    expect(tree.name).toBe('Default');
  });

  it('sets the current deck before review', async () => {
    await selectDeck(42);
    expect(native.runCollectionOp).toHaveBeenCalledWith(
      'setDeck',
      JSON.stringify({ deckId: 42 }),
    );
  });

  it('exposes the collection media directory for audio playback', async () => {
    native.runCollectionOp.mockResolvedValueOnce(JSON.stringify({ dir: '/data/media' }));
    const dir = await getMediaDir();
    expect(native.runCollectionOp).toHaveBeenCalledWith('mediaDir', '');
    expect(dir).toBe('/data/media');
  });
});

describe('sync defaults to KelmaSync', () => {
  it('logs in against the default endpoint', async () => {
    native.runCollectionOp.mockResolvedValueOnce(
      JSON.stringify({ hkey: 'abc', endpoint: DEFAULT_SYNC_ENDPOINT }),
    );
    const auth = await syncLogin('user', 'pass');
    expect(native.runCollectionOp).toHaveBeenCalledWith(
      'syncLogin',
      JSON.stringify({ username: 'user', password: 'pass', endpoint: DEFAULT_SYNC_ENDPOINT }),
    );
    expect(auth.hkey).toBe('abc');
  });

  it('passes auth through for a normal sync', async () => {
    native.runCollectionOp.mockResolvedValueOnce(
      JSON.stringify({
        required: 'noChanges',
        uploadOk: false,
        downloadOk: false,
        serverMessage: '',
        newEndpoint: null,
      }),
    );
    const outcome = await syncCollection({ hkey: 'abc', endpoint: DEFAULT_SYNC_ENDPOINT });
    expect(outcome.required).toBe('noChanges');
  });

  it('reports media totals separately from collection sync', async () => {
    native.runCollectionOp.mockResolvedValueOnce(
      JSON.stringify({ files: 123, bytes: 456789 }),
    );
    const result = await syncMedia({
      hkey: 'abc',
      endpoint: DEFAULT_SYNC_ENDPOINT,
    });
    expect(native.runCollectionOp).toHaveBeenCalledWith(
      'syncMedia',
      JSON.stringify({ hkey: 'abc', endpoint: DEFAULT_SYNC_ENDPOINT }),
    );
    expect(result).toEqual({ files: 123, bytes: 456789 });
  });

  it('encodes the direction for a full sync', async () => {
    await fullSync({ hkey: 'abc', endpoint: DEFAULT_SYNC_ENDPOINT }, false);
    expect(native.runCollectionOp).toHaveBeenCalledWith(
      'fullSync',
      JSON.stringify({ hkey: 'abc', endpoint: DEFAULT_SYNC_ENDPOINT, upload: false }),
    );
  });
});

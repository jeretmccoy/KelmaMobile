import {
  decodeCoreInfo,
  diffManifests,
  type DeckManifest,
  type Manifest,
} from './KelmaCore';

const deck = (name: string, hash: string, mod: number): DeckManifest => ({
  id: [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0),
  name,
  cards: 1,
  notes: 1,
  mod,
  hash,
});

const manifest = (decks: DeckManifest[]): Manifest => ({
  ts: 0,
  mod: 0,
  scm: 0,
  usn: 0,
  schema: 18,
  decks,
  notes: decks.map((item, index) => ({
    guid: `guid-${item.name}`,
    nid: index + 1,
    mid: 1,
    mod: item.mod,
    decks: [item.id],
    cards_per_deck: [item.cards],
    hash: item.hash,
  })),
  media: { usn: 0, files: 0 },
});

describe('decodeCoreInfo', () => {
  it('accepts the native core identity contract', () => {
    expect(
      decodeCoreInfo(
        JSON.stringify({
          ankiVersion: '25.09.2',
          ankiCommit: 'abc123',
          bridgeVersion: '0.1.64-anki25.09.2',
          platform: 'android',
        }),
      ),
    ).toEqual({
      ankiVersion: '25.09.2',
      ankiCommit: 'abc123',
      bridgeVersion: '0.1.64-anki25.09.2',
      platform: 'android',
    });
  });

  it('rejects malformed native payloads', () => {
    expect(() => decodeCoreInfo('{"platform":"web"}')).toThrow(
      'invalid identity payload',
    );
  });
});

describe('diffManifests', () => {
  it('classifies matching, newer, and one-sided decks', () => {
    const local = manifest([
      deck('In sync', 'same', 10),
      deck('Local newer', 'local', 20),
      deck('Local only', 'local-only', 1),
      deck('Server newer', 'local', 10),
    ]);
    const server = manifest([
      deck('In sync', 'same', 99),
      deck('Local newer', 'server', 10),
      deck('Server newer', 'server', 20),
      deck('Server only', 'server-only', 1),
    ]);

    expect(diffManifests(local, server).map(d => [d.deck.name, d.status])).toEqual([
      ['In sync', 'in-sync'],
      ['Local newer', 'local-newer'],
      ['Local only', 'local-only'],
      ['Server newer', 'server-newer'],
      ['Server only', 'server-only'],
    ]);
  });

  it('reports equal-mtime hash divergence as a conflict', () => {
    const local = manifest([deck('Deck', 'local', 10)]);
    const server = manifest([deck('Deck', 'server', 10)]);

    expect(diffManifests(local, server)[0].status).toBe('conflict');
  });
});

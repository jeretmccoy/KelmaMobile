/**
 * Verifies the reviewer renders card audio as play controls (never the file
 * name) and autoplays the first clip when a card is shown.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

jest.mock('../audio/AudioPlayer', () => ({
  __esModule: true,
  audioPlayer: {
    play: jest.fn(),
    stop: jest.fn(),
    isAvailable: jest.fn().mockReturnValue(true),
  },
}));

jest.mock('../core/KelmaCore', () => ({
  answerCard: jest.fn(),
  getMediaDir: jest.fn().mockResolvedValue('/data/media'),
  getNextCard: jest.fn(),
  Rating: { Again: 0, Hard: 1, Good: 2, Easy: 3 },
}));

import React from 'react';
import { ScrollView } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { audioPlayer } from '../audio/AudioPlayer';
import { getMediaDir, getNextCard } from '../core/KelmaCore';
import { ReviewerScreen } from './ReviewerScreen';

const play = audioPlayer.play as jest.Mock;
const stop = audioPlayer.stop as jest.Mock;
const getMediaDirMock = getMediaDir as jest.Mock;
const getNextCardMock = getNextCard as jest.Mock;

const cardWith = (question: string, answer: string) => ({
  cardId: 1,
  deckName: 'Arabic',
  question,
  answer,
  css: '',
});

beforeEach(() => {
  play.mockReset();
  stop.mockReset();
  getMediaDirMock.mockReset();
  getMediaDirMock.mockResolvedValue('/data/media');
  getNextCardMock.mockReset();
});

describe('ReviewerScreen audio', () => {
  it('hides the file name and autoplays the first clip', async () => {
    getNextCardMock.mockResolvedValueOnce({
      counts: { new: 1, learning: 0, review: 0 },
      card: cardWith('Word? [sound:audio1.mp3] [sound:audio2.mp3]', 'Meaning'),
    });

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <ReviewerScreen
          deckName="Arabic"
          autoplayAudio
          onBack={jest.fn()}
        />,
      );
    });

    // The first question-side clip autoplays against the media dir.
    await Promise.resolve();
    await Promise.resolve();
    expect(play).toHaveBeenCalledWith('audio1.mp3', '/data/media');

    // The file name must never appear in the rendered output.
    const json = JSON.stringify(renderer!.toJSON());
    expect(json).not.toContain('audio1.mp3');
    expect(json).not.toContain('audio2.mp3');
    expect(json).toContain('▶');
    expect(renderer!.root.findByType(ScrollView).props.alwaysBounceVertical).toBe(
      true,
    );
  });

  it('waits for the media directory before autoplaying', async () => {
    let resolveMediaDir!: (dir: string) => void;
    getMediaDirMock.mockReturnValueOnce(
      new Promise<string>(resolve => {
        resolveMediaDir = resolve;
      }),
    );
    getNextCardMock.mockResolvedValueOnce({
      counts: { new: 1, learning: 0, review: 0 },
      card: cardWith('Word? [sound:audio1.mp3]', 'Meaning'),
    });

    await ReactTestRenderer.act(async () => {
      ReactTestRenderer.create(
        <ReviewerScreen
          deckName="Arabic"
          autoplayAudio
          onBack={jest.fn()}
        />,
      );
    });
    expect(play).not.toHaveBeenCalled();

    await ReactTestRenderer.act(async () => {
      resolveMediaDir('/data/media');
      await Promise.resolve();
    });

    expect(play).toHaveBeenCalledWith('audio1.mp3', '/data/media');
  });

  it('plays the first answer clip when revealed', async () => {
    getNextCardMock.mockResolvedValueOnce({
      counts: { new: 0, learning: 0, review: 1 },
      card: cardWith('Word?', 'Meaning [sound:ans.mp3]'),
    });

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <ReviewerScreen
          deckName="Arabic"
          autoplayAudio
          onBack={jest.fn()}
        />,
      );
    });
    await Promise.resolve();
    await Promise.resolve();
    play.mockClear();

    await ReactTestRenderer.act(async () => {
      ReactTestRenderer.act(() => {
        const text = renderer!.root.findByProps({ children: 'Show answer' });
        let node = text as { props: { onPress?: () => void }; parent?: unknown } | null;
        while (node && typeof node.props?.onPress !== 'function') {
          node = (node.parent as typeof node) ?? null;
        }
        if (!node) {
          throw new Error('Show answer button not found');
        }
        node.props.onPress!();
      });
    });
    await Promise.resolve();

    expect(play).toHaveBeenCalledWith('ans.mp3', '/data/media');
  });
});

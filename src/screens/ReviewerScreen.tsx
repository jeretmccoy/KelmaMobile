/**
 * Reviewer: shows the next due card and answers it. All scheduling is performed
 * by rslib — this screen only renders the card and reports the chosen rating.
 *
 * Anki embeds audio as `[sound:resource]` tags in the rendered card text.
 * Those are parsed out here so the filename never appears: each clip becomes a
 * dedicated play control, and the first clip on a side autoplays (mirroring
 * AnkiDroid, which plays question audio when the card is shown and answer
 * audio when the answer is revealed).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { audioPlayer } from '../audio/AudioPlayer';
import {
  answerCard,
  getMediaDir,
  getNextCard,
  Rating,
  type NextCard,
} from '../core/KelmaCore';
import { answerBack, buildCardHtml, extractSoundTags, palette } from './theme';

type Props = {
  deckName: string;
  autoplayAudio: boolean;
  onBack: () => void;
};

type CardData = NonNullable<NextCard['card']>;

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; counts: NextCard['counts'] }
  | { kind: 'card'; data: CardData; counts: NextCard['counts'] };

const RATINGS: { label: string; rating: Rating; color: string }[] = [
  { label: 'Again', rating: Rating.Again, color: palette.bad },
  { label: 'Hard', rating: Rating.Hard, color: '#b8995f' },
  { label: 'Good', rating: Rating.Good, color: palette.good },
  { label: 'Easy', rating: Rating.Easy, color: '#6f9fb0' },
];

export function ReviewerScreen({ deckName, autoplayAudio, onBack }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [revealed, setRevealed] = useState(false);
  const [mediaDir, setMediaDir] = useState<string | null>(null);
  const shownAt = useRef<number>(Date.now());
  const mediaDirRequest = useRef<Promise<string> | null>(null);

  const resolveMediaDir = useCallback(() => {
    if (!mediaDirRequest.current) {
      mediaDirRequest.current = getMediaDir();
    }
    return mediaDirRequest.current;
  }, []);

  // Warm the lookup, but playback also awaits this promise to avoid racing the
  // first card against the native media-directory response.
  useEffect(() => {
    resolveMediaDir().then(setMediaDir).catch(() => {});
  }, [resolveMediaDir]);

  const playSound = useCallback(
    (sound: string) => {
      resolveMediaDir()
        .then(dir => audioPlayer.play(sound, dir))
        .catch(error => console.warn('Could not resolve the Anki media directory.', error));
    },
    [resolveMediaDir],
  );

  const playFirst = useCallback((sounds: string[]) => {
    if (sounds.length > 0) {
      playSound(sounds[0]);
    }
  }, [playSound]);

  const loadNext = useCallback(() => {
    // Stop any clip that was playing on the previous card before moving on.
    audioPlayer.stop();
    setRevealed(false);
    setState({ kind: 'loading' });
    getNextCard()
      .then(next => {
        shownAt.current = Date.now();
        if (next.card) {
          setState({ kind: 'card', data: next.card, counts: next.counts });
          // Autoplay the first question-side audio, like AnkiDroid.
          if (autoplayAudio) {
            playFirst(extractSoundTags(next.card.question));
          }
        } else {
          setState({ kind: 'done', counts: next.counts });
        }
      })
      .catch(error =>
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Could not load the next card.',
        }),
      );
  }, [autoplayAudio, playFirst]);

  useEffect(loadNext, [loadNext]);

  // Release audio resources when leaving the reviewer.
  useEffect(() => audioPlayer.stop, []);

  const reveal = () => {
    setRevealed(true);
    if (state.kind === 'card') {
      // Autoplay the first BACK-side audio (not the front's, which also appears
      // in the answer HTML before the <hr id=answer> separator).
      if (autoplayAudio) {
        playFirst(extractSoundTags(answerBack(state.data.answer)));
      }
    }
  };

  const onRate = (rating: Rating) => {
    if (state.kind !== 'card') {
      return;
    }
    const elapsed = Date.now() - shownAt.current;
    const cardId = state.data.cardId;
    setState({ kind: 'loading' });
    answerCard(cardId, rating, elapsed)
      .then(loadNext)
      .catch(error =>
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Could not record your answer.',
        }),
      );
  };

  return (
    <View style={styles.screen}>
      <View style={styles.topBar}>
        <Pressable onPress={onBack} accessibilityRole="button" hitSlop={12}>
          <Text style={styles.back}>‹ Decks</Text>
        </Pressable>
        <Text style={styles.deckTitle} numberOfLines={1}>
          {deckName}
        </Text>
        {state.kind === 'card' && (
          <Text style={styles.counts}>
            <Text style={styles.countNew}>{state.counts.new} </Text>
            <Text style={styles.countLearn}>{state.counts.learning} </Text>
            <Text style={styles.countReview}>{state.counts.review}</Text>
          </Text>
        )}
      </View>

      {state.kind === 'loading' && (
        <View style={styles.center}>
          <ActivityIndicator color={palette.gold} />
        </View>
      )}

      {state.kind === 'error' && (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Something went wrong</Text>
          <Text style={styles.errorBody}>{state.message}</Text>
          <Pressable onPress={loadNext} style={styles.retry}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      )}

      {state.kind === 'done' && (
        <View style={styles.center}>
          <Text style={styles.doneTitle}>All caught up.</Text>
          <Text style={styles.doneBody}>
            No more cards are due right now. Come back later or sync to pull new
            material.
          </Text>
          <Pressable onPress={onBack} style={styles.retry}>
            <Text style={styles.retryText}>Back to decks</Text>
          </Pressable>
        </View>
      )}

      {state.kind === 'card' && (
        <CardView
          card={state.data}
          revealed={revealed}
          mediaDir={mediaDir}
          onReveal={reveal}
          onRate={onRate}
          onPlay={playSound}
        />
      )}
    </View>
  );
}

/**
 * Renders the card faithfully (its own HTML + CSS, so blur/cloze/colours/fonts
 * and images all work) in a WebView, plus the answer actions. Audio plays
 * natively; the WebView only posts which clip to play and whether to reveal.
 */
function CardView({
  card,
  revealed,
  mediaDir,
  onReveal,
  onRate,
  onPlay,
}: {
  card: CardData;
  revealed: boolean;
  mediaDir: string | null;
  onReveal: () => void;
  onRate: (rating: Rating) => void;
  onPlay: (sound: string) => void;
}) {
  // After revealing, show only the BACK — the part after Anki's `<hr id=answer>`
  // separator — so the front (and its image) isn't repeated below itself.
  const sideHtml = useMemo(
    () => (revealed ? answerBack(card.answer) : card.question),
    [revealed, card.question, card.answer],
  );

  const html = useMemo(
    () => buildCardHtml(sideHtml, card.css ?? '', !revealed),
    [sideHtml, card.css, revealed],
  );

  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as { type: string; sound?: string };
      if (msg.type === 'play' && msg.sound) {
        onPlay(msg.sound);
      } else if (msg.type === 'reveal') {
        onReveal();
      }
    } catch {
      // ignore malformed messages
    }
  };

  // baseUrl lets relative <img src> resolve to the collection's media folder.
  const baseUrl = mediaDir ? `file://${mediaDir}/` : undefined;

  return (
    <>
      <WebView
        style={styles.web}
        originWhitelist={['*']}
        source={baseUrl ? { html, baseUrl } : { html }}
        onMessage={onMessage}
        allowFileAccess
        allowsInlineMediaPlayback
        allowingReadAccessToURL={baseUrl}
        scrollEnabled
        showsVerticalScrollIndicator
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
      />

      {revealed ? (
        <View style={styles.ratings}>
          {RATINGS.map(({ label, rating, color }, index) => (
            <Pressable
              key={rating}
              onPress={() => onRate(rating)}
              style={({ pressed }) => [
                styles.ratingButton,
                { borderColor: color },
                pressed && { backgroundColor: color },
              ]}>
              {card.intervals?.[index] ? (
                <Text style={styles.ratingInterval}>{card.intervals[index]}</Text>
              ) : null}
              <Text style={[styles.ratingText, { color }]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <Pressable onPress={onReveal} style={styles.showAnswer}>
          <Text style={styles.showAnswerText}>Show answer</Text>
        </Pressable>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 20, paddingBottom: 16 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
  },
  back: { color: palette.goldSoft, fontSize: 16, fontWeight: '600' },
  deckTitle: {
    color: palette.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    flex: 1,
    marginHorizontal: 12,
    textAlign: 'center',
  },
  counts: { fontSize: 15, fontWeight: '700' },
  countNew: { color: '#6f9fb0' },
  countLearn: { color: palette.bad },
  countReview: { color: palette.good },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  web: {
    flex: 1,
    marginTop: 12,
    marginHorizontal: -20, // span full width (cancel the screen's side padding)
    backgroundColor: palette.background,
  },
  showAnswer: {
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  showAnswerText: { color: palette.goldSoft, fontSize: 16, fontWeight: '700' },
  ratings: { flexDirection: 'row', gap: 8 },
  ratingButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
    gap: 2,
  },
  ratingInterval: { color: palette.textMuted, fontSize: 11, fontWeight: '600' },
  ratingText: { fontSize: 14, fontWeight: '700' },
  errorTitle: { color: palette.bad, fontSize: 18, fontWeight: '700' },
  errorBody: { color: palette.textSecondary, fontSize: 14, textAlign: 'center', paddingHorizontal: 20 },
  doneTitle: { color: palette.textPrimary, fontSize: 24, fontWeight: '700' },
  doneBody: {
    color: palette.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  retry: {
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 8,
  },
  retryText: { color: palette.goldSoft, fontSize: 14, fontWeight: '700' },
});

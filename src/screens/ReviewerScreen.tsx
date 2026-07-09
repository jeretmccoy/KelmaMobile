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
  Alert,
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
  getUndoStatus,
  Rating,
  undo,
  writeCardHtml,
  type NextCard,
} from '../core/KelmaCore';
import { CardOptionsSheet } from './CardOptionsSheet';
import { answerBack, buildCardHtml, extractSoundTags, palette, radius, spacing } from './theme';

type Props = {
  deckName: string;
  autoplayAudio: boolean;
  onEditCard?: (cardId: number) => void;
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

export function ReviewerScreen({ deckName, autoplayAudio, onEditCard, onBack }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [revealed, setRevealed] = useState(false);
  const [mediaDir, setMediaDir] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const shownAt = useRef<number>(Date.now());
  const mediaDirRequest = useRef<Promise<string> | null>(null);

  // Refreshed after every card load and answer — mirrors the desktop client's
  // Ctrl+Z availability, which covers answering a card as well as anything
  // done through the card menu (suspend/bury/flag/delete), since rslib keeps
  // one global undo stack.
  const refreshUndo = useCallback(() => {
    getUndoStatus()
      .then(status => setCanUndo(status.canUndo))
      .catch(() => setCanUndo(false));
  }, []);

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
        refreshUndo();
      })
      .catch(error =>
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Could not load the next card.',
        }),
      );
  }, [autoplayAudio, playFirst, refreshUndo]);

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

  // Go back a card: undoes the last change (usually the previous answer,
  // which re-queues that card) via rslib's own undo stack, then reloads —
  // exactly what pressing Ctrl+Z mid-review does on the desktop client.
  const onUndo = () => {
    setState({ kind: 'loading' });
    undo()
      .then(loadNext)
      .catch(error =>
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Could not undo.',
        }),
      );
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
        <Pressable onPress={onBack} accessibilityRole="button" hitSlop={12} style={styles.backHit}>
          <Text style={styles.back}>‹</Text>
          <Text style={styles.backLabel} numberOfLines={1}>{deckName}</Text>
        </Pressable>
        <View style={styles.topBarRight}>
          {canUndo ? (
            <Pressable
              onPress={onUndo}
              accessibilityRole="button"
              accessibilityLabel="Go back a card"
              hitSlop={10}
              style={({ pressed }) => [styles.undoButton, pressed && styles.iconButtonPressed]}>
              <Text style={styles.undoButtonText}>↶</Text>
            </Pressable>
          ) : null}
          {state.kind === 'card' ? (
            <>
              <View style={styles.counts}>
                <Text style={[styles.countPill, styles.countNew]}>{state.counts.new}</Text>
                <Text style={[styles.countPill, styles.countLearn]}>{state.counts.learning}</Text>
                <Text style={[styles.countPill, styles.countReview]}>{state.counts.review}</Text>
              </View>
              <Pressable
                onPress={() => setOptionsOpen(true)}
                accessibilityRole="button"
                hitSlop={10}
                style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}>
                <Text style={styles.menuButton}>⋯</Text>
              </Pressable>
            </>
          ) : null}
        </View>
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

      {state.kind === 'card' && (
        <CardOptionsSheet
          cardId={state.data.cardId}
          visible={optionsOpen}
          onClose={() => setOptionsOpen(false)}
          onCardRemoved={loadNext}
          onCardUpdated={() => setOptionsOpen(false)}
          onEdit={onEditCard}
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
  // The rendered `answer` is the full Answer Template output — normally
  // `{{FrontSide}}<hr id=answer>{{Back}}` — exactly what desktop Anki shows on
  // reveal. Templates often rely on that FrontSide portion (e.g. repeating the
  // front's text or image above the translation), so it must not be stripped.
  const sideHtml = useMemo(
    () => (revealed ? card.answer : card.question),
    [revealed, card.question, card.answer],
  );

  const html = useMemo(
    () => buildCardHtml(sideHtml, card.css ?? '', !revealed, mediaDir),
    [sideHtml, card.css, revealed, mediaDir],
  );

  // Loaded via `source.uri` (a scratch file), not `source.html` — WKWebView
  // never grants the latter's sandboxed renderer read access to local
  // `file://` images (see `writeCardHtml` in KelmaCore.ts). Keeps the
  // previous card's WebView content on screen until the next one is ready,
  // rather than flashing an intermediate broken-image state.
  const [source, setSource] = useState<{ uri: string; allowedRoot: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    writeCardHtml(html)
      .then(file => {
        if (!cancelled) {
          setSource({ uri: file.uri, allowedRoot: file.allowedRoot });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [html]);

  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as { type: string; sound?: string; rating?: number; info?: string };
      if (msg.type === 'play' && msg.sound) {
        onPlay(msg.sound);
      } else if (msg.type === 'reveal') {
        onReveal();
      } else if (msg.type === 'rate' && typeof msg.rating === 'number') {
        onRate(msg.rating);
      } else if (msg.type === 'debug') {
        // TEMPORARY: long-press on a card surfaces what's under the finger, so
        // we can see how a "blur" spot is actually implemented.
        Alert.alert('Card tap debug', msg.info ?? '(no info)');
      }
    } catch {
      // ignore malformed messages
    }
  };

  const webView = source ? (
    <WebView
      style={styles.web}
      originWhitelist={['*']}
      source={{ uri: source.uri }}
      allowingReadAccessToURL={source.allowedRoot}
      onMessage={onMessage}
      allowFileAccess
      allowsInlineMediaPlayback
      scrollEnabled
      showsVerticalScrollIndicator
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
    />
  ) : (
    <View style={styles.web} />
  );

  return (
    <>
      {/*
        The card area is NOT wrapped in a native Pressable: doing so fired a
        flip on any touch (including scroll drags) and bypassed the WebView's
        own tap logic. Instead the WebView's injected JS (see theme.ts) is the
        sole in-card tap handler — it distinguishes a real tap from a scroll,
        un-blurs blurred spots without flipping, and only otherwise posts
        {type:'reveal'}. The explicit bar below is a native tap target for
        deliberately showing the answer.
      */}
      <View style={styles.cardShell}>{webView}</View>
      {!revealed && (
        <Pressable
          onPress={onReveal}
          accessibilityRole="button"
          accessibilityLabel="Show answer"
          style={({ pressed }) => [styles.showAnswerBar, pressed && styles.showAnswerBarPressed]}>
          <Text style={styles.showAnswerText}>Show answer</Text>
        </Pressable>
      )}

      {revealed ? (
        <View style={styles.ratingsWrap}>
          <Text style={styles.tapHint}>Tap card: left = Again · right = Good</Text>
          <View style={styles.ratings}>
            {RATINGS.map(({ label, rating, color }, index) => (
              <Pressable
                key={rating}
                onPress={() => onRate(rating)}
                style={({ pressed }) => [
                  styles.ratingButton,
                  { borderColor: color, backgroundColor: pressed ? color : color + '22' },
                ]}>
                <Text style={[styles.ratingText, { color }]}>{label}</Text>
                {card.intervals?.[index] ? (
                  <Text style={styles.ratingInterval}>{card.intervals[index]}</Text>
                ) : null}
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  backHit: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 4 },
  back: { color: palette.goldSoft, fontSize: 26, fontWeight: '700', lineHeight: 28 },
  backLabel: { color: palette.textPrimary, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  topBarRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  counts: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  countPill: {
    fontSize: 13,
    fontWeight: '800',
    minWidth: 24,
    textAlign: 'center',
    overflow: 'hidden',
    borderRadius: radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  countNew: { color: palette.newCard, backgroundColor: palette.newCard + '1f' },
  countLearn: { color: palette.bad, backgroundColor: palette.bad + '1f' },
  countReview: { color: palette.good, backgroundColor: palette.good + '1f' },
  iconButton: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
  },
  iconButtonPressed: { backgroundColor: palette.surfaceElevated },
  undoButton: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
  },
  undoButtonText: { color: palette.goldSoft, fontSize: 18, fontWeight: '700', lineHeight: 20 },
  menuButton: { color: palette.goldSoft, fontSize: 24, fontWeight: '700', lineHeight: 24 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  cardShell: {
    flex: 1,
    marginTop: spacing.xs,
    marginBottom: spacing.md,
    // Span the full device width (cancel the screen's side padding); no border,
    // radius, or shadow — an edge-to-edge card.
    marginHorizontal: -spacing.lg,
    backgroundColor: palette.surface,
  },
  web: {
    flex: 1,
    backgroundColor: palette.surface,
  },
  showAnswerBar: {
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
  showAnswerBarPressed: { backgroundColor: palette.surfaceElevated, borderColor: palette.gold },
  showAnswerText: {
    color: palette.goldSoft,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  ratingsWrap: { gap: spacing.sm },
  tapHint: { color: palette.textMuted, fontSize: 12, fontWeight: '600', textAlign: 'center' },
  ratings: { flexDirection: 'row', gap: spacing.sm },
  ratingButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    gap: 3,
  },
  ratingInterval: { color: palette.textSecondary, fontSize: 11, fontWeight: '700' },
  ratingText: { fontSize: 15, fontWeight: '800', letterSpacing: 0.2 },
  errorTitle: { color: palette.bad, fontSize: 18, fontWeight: '700' },
  errorBody: { color: palette.textSecondary, fontSize: 14, textAlign: 'center', paddingHorizontal: 20 },
  doneTitle: { color: palette.textPrimary, fontSize: 26, fontWeight: '800' },
  doneBody: {
    color: palette.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  retry: {
    backgroundColor: palette.gold,
    borderRadius: radius.md,
    paddingHorizontal: 20,
    paddingVertical: 12,
    marginTop: 8,
  },
  retryText: { color: palette.background, fontSize: 15, fontWeight: '800' },
});

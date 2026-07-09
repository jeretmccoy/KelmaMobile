/**
 * Card detail: the front/back of a single card rendered faithfully (its own
 * HTML + CSS, so cloze/blur/images/fonts all work) in a WebView, the way the
 * reviewer shows it — but read-only, with a reveal toggle and native audio.
 *
 * Browser-style card options (suspend / bury / mark / flag / change deck /
 * delete) live in the shared `CardOptionsSheet`.
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
import { getCardDetail, getMediaDir, writeCardHtml, type CardDetail } from '../core/KelmaCore';
import { CardOptionsSheet } from './CardOptionsSheet';
import { answerBack, buildCardHtml, extractSoundTags, palette, radius, shadow, spacing } from './theme';

type Props = {
  cardId: number;
  deckName: string;
  onBack: () => void;
  /** Open the note editor for a card (the sheet closes itself first). */
  onEditCard?: (cardId: number) => void;
  /** Called after any mutating action so callers can refresh the browser/list. */
  onChanged?: () => void;
};

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'card'; data: CardDetail };

export function CardDetailScreen({ cardId, deckName, onBack, onEditCard, onChanged }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [revealed, setRevealed] = useState(false);
  const [mediaDir, setMediaDir] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const mediaDirRequest = useRef<Promise<string> | null>(null);

  const resolveMediaDir = useCallback(() => {
    if (!mediaDirRequest.current) {
      mediaDirRequest.current = getMediaDir();
    }
    return mediaDirRequest.current;
  }, []);

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

  const load = useCallback(() => {
    setState({ kind: 'loading' });
    setRevealed(false);
    getCardDetail(cardId)
      .then(data => setState({ kind: 'card', data }))
      .catch(error =>
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Could not load this card.',
        }),
      );
  }, [cardId]);

  useEffect(load, [load]);

  // Release audio resources when leaving.
  useEffect(() => audioPlayer.stop, []);

  const reveal = () => {
    setRevealed(true);
    if (state.kind === 'card') {
      playFirst(extractSoundTags(answerBack(state.data.answer)), playSound);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.topBar}>
        <Pressable onPress={onBack} accessibilityRole="button" hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.deckTitle} numberOfLines={1}>
          {deckName}
        </Text>
        <Pressable
          onPress={() => setOptionsOpen(true)}
          accessibilityRole="button"
          hitSlop={12}
          disabled={state.kind !== 'card'}>
          <Text style={styles.menuButton}>⋯</Text>
        </Pressable>
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
          <Pressable onPress={load} style={styles.retry}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      )}

      {state.kind === 'card' && (
        <>
          <CardSideView
            card={state.data}
            revealed={revealed}
            mediaDir={mediaDir}
            onPlay={playSound}
          />
          {revealed ? (
            <Pressable onPress={() => setRevealed(false)} style={styles.flipButton}>
              <Text style={styles.flipText}>Show front</Text>
            </Pressable>
          ) : (
            <Pressable onPress={reveal} style={styles.flipButton}>
              <Text style={styles.flipText}>Show back</Text>
            </Pressable>
          )}
        </>
      )}

      <CardOptionsSheet
        cardId={cardId}
        visible={optionsOpen}
        onClose={() => setOptionsOpen(false)}
        onCardRemoved={() => {
          onChanged?.();
          onBack(); // deleted/suspended/buried: nothing to show here
        }}
        onCardUpdated={() => {
          onChanged?.();
          load(); // refresh this screen's own state (flag/mark/deck)
        }}
        onEdit={onEditCard}
      />
    </View>
  );
}

function CardSideView({
  card,
  revealed,
  mediaDir,
  onPlay,
}: {
  card: CardDetail;
  revealed: boolean;
  mediaDir: string | null;
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
    () => buildCardHtml(sideHtml, card.css ?? '', false, mediaDir),
    [sideHtml, card.css, mediaDir],
  );

  // Loaded via `source.uri` (a scratch file), not `source.html` — WKWebView
  // never grants the latter's sandboxed renderer read access to local
  // `file://` images (see `writeCardHtml` in KelmaCore.ts).
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
      const msg = JSON.parse(event.nativeEvent.data) as { type: string; sound?: string };
      if (msg.type === 'play' && msg.sound) {
        onPlay(msg.sound);
      }
    } catch {
      // ignore malformed messages
    }
  };

  if (!source) {
    return (
      <View style={styles.cardShell}>
        <View style={styles.web} />
      </View>
    );
  }

  return (
    <View style={styles.cardShell}>
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
    </View>
  );
}

function playFirst(sounds: string[], play: (s: string) => void) {
  if (sounds.length > 0) {
    play(sounds[0]);
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
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
  menuButton: { color: palette.goldSoft, fontSize: 26, fontWeight: '700', lineHeight: 28 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  cardShell: {
    flex: 1,
    marginTop: spacing.xs,
    marginBottom: spacing.md,
    // Full width, edge-to-edge: no border, radius, or shadow.
    marginHorizontal: -spacing.lg,
    backgroundColor: palette.surface,
  },
  web: {
    flex: 1,
    backgroundColor: palette.surface,
  },
  flipButton: {
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingVertical: 16,
    alignItems: 'center',
    ...shadow.subtle,
  },
  flipText: { color: palette.goldSoft, fontSize: 16, fontWeight: '800' },
  errorTitle: { color: palette.bad, fontSize: 18, fontWeight: '700' },
  errorBody: { color: palette.textSecondary, fontSize: 14, textAlign: 'center', paddingHorizontal: 20 },
  retry: {
    backgroundColor: palette.gold,
    borderRadius: radius.md,
    paddingHorizontal: 20,
    paddingVertical: 12,
    marginTop: 8,
  },
  retryText: { color: palette.background, fontSize: 15, fontWeight: '800' },
});

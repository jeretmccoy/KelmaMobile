/**
 * Card detail: the front/back of a single card rendered faithfully (its own
 * HTML + CSS, so cloze/blur/images/fonts all work) in a WebView, the way the
 * reviewer shows it — but read-only, with a reveal toggle and native audio.
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
import { getCardDetail, getMediaDir, type CardDetail } from '../core/KelmaCore';
import { answerBack, buildCardHtml, extractSoundTags, palette } from './theme';

type Props = {
  cardId: number;
  deckName: string;
  onBack: () => void;
};

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'card'; data: CardDetail };

export function CardDetailScreen({ cardId, deckName, onBack }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [revealed, setRevealed] = useState(false);
  const [mediaDir, setMediaDir] = useState<string | null>(null);
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
        <View style={styles.topBarSpacer} />
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
  const sideHtml = useMemo(
    () => (revealed ? answerBack(card.answer) : card.question),
    [revealed, card.question, card.answer],
  );

  const html = useMemo(
    () => buildCardHtml(sideHtml, card.css ?? '', false),
    [sideHtml, card.css],
  );

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

  const baseUrl = mediaDir ? `file://${mediaDir}/` : undefined;

  return (
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
  );
}

function playFirst(sounds: string[], play: (s: string) => void) {
  if (sounds.length > 0) {
    play(sounds[0]);
  }
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
  topBarSpacer: { width: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  web: {
    flex: 1,
    marginTop: 12,
    marginHorizontal: -20,
    backgroundColor: palette.background,
  },
  flipButton: {
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  flipText: { color: palette.goldSoft, fontSize: 16, fontWeight: '700' },
  errorTitle: { color: palette.bad, fontSize: 18, fontWeight: '700' },
  errorBody: { color: palette.textSecondary, fontSize: 14, textAlign: 'center', paddingHorizontal: 20 },
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

/**
 * Kelma Mobile
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * App shell: boots the rslib-backed core, opens the active profile's
 * collection, then hands off to the deck list / reviewer. Navigation is a tiny
 * local state machine — no router dependency needed for two screens.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { getCoreInfo, openProfile } from './src/core/KelmaCore';
import { DeckListScreen } from './src/screens/DeckListScreen';
import { ReviewerScreen } from './src/screens/ReviewerScreen';
import { palette } from './src/screens/theme';

type Boot =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; reason: string };

type Screen = 'decks' | 'review';

function App() {
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' });
  const [screen, setScreen] = useState<Screen>('decks');

  const start = useCallback(() => {
    setBoot({ kind: 'loading' });
    // Verify the native core is linked, then open the profile collection. Both
    // are rslib-backed; failures here mean the app is not yet buildable on this
    // platform rather than a user error.
    getCoreInfo()
      .then(() => openProfile())
      .then(() => setBoot({ kind: 'ready' }))
      .catch(error =>
        setBoot({
          kind: 'error',
          reason:
            error instanceof Error
              ? error.message
              : 'The Rust backend could not be loaded.',
        }),
      );
  }, []);

  useEffect(start, [start]);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={palette.background} />
      <SafeAreaView style={styles.safeArea}>
        {boot.kind === 'loading' && (
          <View style={styles.center}>
            <ActivityIndicator color={palette.gold} />
            <Text style={styles.muted}>Opening your collection…</Text>
          </View>
        )}

        {boot.kind === 'error' && (
          <View style={styles.center}>
            <Text style={styles.eyebrow}>KELMA</Text>
            <Text style={styles.errorTitle}>Core not linked</Text>
            <Text style={styles.errorBody}>{boot.reason}</Text>
            <Pressable onPress={start} style={styles.retry}>
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        )}

        {boot.kind === 'ready' &&
          (screen === 'decks' ? (
            <DeckListScreen onStudy={() => setScreen('review')} />
          ) : (
            <ReviewerScreen onBack={() => setScreen('decks')} />
          ))}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 30 },
  muted: { color: palette.textSecondary, fontSize: 14 },
  eyebrow: {
    color: palette.gold,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 3.2,
  },
  errorTitle: { color: palette.textPrimary, fontSize: 24, fontWeight: '700' },
  errorBody: { color: palette.textSecondary, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  retry: {
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 6,
  },
  retryText: { color: palette.goldSoft, fontSize: 14, fontWeight: '700' },
});

export default App;

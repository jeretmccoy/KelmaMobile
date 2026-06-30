/**
 * Kelma Mobile
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * App shell: boots the rslib-backed core, opens the active profile's
 * collection, then hands off to decks, sync, settings, or the reviewer.
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
import { getCoreInfo, openProfile, selectDeck } from './src/core/KelmaCore';
import { DeckListScreen } from './src/screens/DeckListScreen';
import { ReviewerScreen } from './src/screens/ReviewerScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { StatisticsScreen } from './src/screens/StatisticsScreen';
import { SyncScreen } from './src/screens/SyncScreen';
import { palette } from './src/screens/theme';

type Boot =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; reason: string };

type MainScreen = 'decks' | 'stats' | 'sync' | 'settings';
type Screen = { name: MainScreen } | { name: 'review'; deckName: string };

function App() {
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' });
  const [screen, setScreen] = useState<Screen>({ name: 'decks' });
  const [deckReloadToken, setDeckReloadToken] = useState(0);
  const [autoplayAudio, setAutoplayAudio] = useState(true);

  const openDeck = useCallback((deckId: number, deckName: string) => {
    // Tap a deck -> review it, like AnkiDroid. Selecting the current deck
    // drives rslib's queue builder (and includes descendant decks).
    selectDeck(deckId)
      .then(() => setScreen({ name: 'review', deckName }))
      .catch(error =>
        setBoot({
          kind: 'error',
          reason:
            error instanceof Error
              ? error.message
              : 'Could not open that deck.',
        }),
      );
  }, []);

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
          (screen.name === 'review' ? (
            <ReviewerScreen
              deckName={screen.deckName}
              autoplayAudio={autoplayAudio}
              onBack={() => setScreen({ name: 'decks' })}
            />
          ) : (
            <View style={styles.main}>
              <View
                style={[
                  styles.page,
                  screen.name !== 'decks' && styles.hiddenPage,
                ]}>
                <DeckListScreen
                  onOpenDeck={openDeck}
                  onOpenSync={() => setScreen({ name: 'sync' })}
                  onOpenSettings={() => setScreen({ name: 'settings' })}
                  reloadToken={deckReloadToken}
                />
              </View>
              <View
                style={[
                  styles.page,
                  screen.name !== 'stats' && styles.hiddenPage,
                ]}>
                <StatisticsScreen reloadToken={deckReloadToken} />
              </View>
              <View
                style={[
                  styles.page,
                  screen.name !== 'sync' && styles.hiddenPage,
                ]}>
                <SyncScreen
                  onSynced={() => setDeckReloadToken(token => token + 1)}
                />
              </View>
              <View
                style={[
                  styles.page,
                  screen.name !== 'settings' && styles.hiddenPage,
                ]}>
                <SettingsScreen
                  autoplayAudio={autoplayAudio}
                  onAutoplayAudioChange={setAutoplayAudio}
                />
              </View>
              <MainTabBar
                active={screen.name}
                onSelect={name => setScreen({ name })}
              />
            </View>
          ))}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function MainTabBar({
  active,
  onSelect,
}: {
  active: MainScreen;
  onSelect: (screen: MainScreen) => void;
}) {
  const tabs: { name: MainScreen; icon: string; label: string }[] = [
    { name: 'decks', icon: '▤', label: 'Decks' },
    { name: 'stats', icon: '▦', label: 'Stats' },
    { name: 'sync', icon: '↻', label: 'Sync' },
    { name: 'settings', icon: '⚙', label: 'Settings' },
  ];

  return (
    <View style={styles.tabBar}>
      {tabs.map(tab => {
        const selected = tab.name === active;
        return (
          <Pressable
            key={tab.name}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onSelect(tab.name)}
            style={styles.tab}>
            <Text style={[styles.tabIcon, selected && styles.tabSelected]}>
              {tab.icon}
            </Text>
            <Text style={[styles.tabLabel, selected && styles.tabSelected]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.background },
  main: { flex: 1 },
  page: { flex: 1 },
  hiddenPage: { display: 'none' },
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
  tabBar: {
    flexDirection: 'row',
    minHeight: 62,
    backgroundColor: palette.surface,
    borderTopColor: palette.surfaceBorder,
    borderTopWidth: 1,
    paddingBottom: 3,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabIcon: { color: palette.textMuted, fontSize: 21, lineHeight: 24 },
  tabLabel: {
    color: palette.textMuted,
    fontSize: 11,
    fontWeight: '700',
    marginTop: 2,
  },
  tabSelected: { color: palette.goldSoft },
});

export default App;

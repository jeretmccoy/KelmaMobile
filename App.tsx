/**
 * Kelma Mobile
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * App shell: boots the rslib-backed core, opens the active profile's
 * collection, then hands off to decks, sync, settings, or the reviewer.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { clearStoredSyncAuth, getCoreInfo, getStoredSyncAuth, importApkg, openProfile, runSyncNow, selectDeck, storeSyncAuth, type SyncAuth } from './src/core/KelmaCore';
import { copyUriToTempPath, downloadUrlToTempPath, looksLikeApkgUrl, pickFile } from './src/core/Share';
import { CardDetailScreen } from './src/screens/CardDetailScreen';
import { DeckInspectorScreen } from './src/screens/DeckInspectorScreen';
import { NoteEditorScreen } from './src/screens/NoteEditorScreen';
import { AddNoteScreen } from './src/screens/AddNoteScreen';
import { DeckListScreen } from './src/screens/DeckListScreen';
import { ReviewerScreen } from './src/screens/ReviewerScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { StatisticsScreen } from './src/screens/StatisticsScreen';
import { SyncScreen } from './src/screens/SyncScreen';
import { palette, radius, spacing } from './src/screens/theme';
import { DeckIcon, SettingsIcon, StatsIcon, SyncIcon } from './src/screens/TabIcons';

type Boot =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; reason: string };

type MainScreen = 'decks' | 'stats' | 'sync' | 'settings';
type Screen =
  | { name: MainScreen }
  | { name: 'review'; deckId: number; deckName: string }
  | { name: 'deckInspector'; deckId: number; deckName: string }
  | { name: 'cardDetail'; cardId: number; deckId: number; deckName: string }
  | {
      name: 'noteEditor';
      cardId: number;
      returnTo: 'review' | 'cardDetail';
      deckId: number;
      deckName: string;
    }
  | { name: 'addNote'; deckId: number; deckName: string };

function App() {
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' });
  const [screen, setScreen] = useState<Screen>({ name: 'decks' });
  const [deckReloadToken, setDeckReloadToken] = useState(0);
  const [autoplayAudio, setAutoplayAudio] = useState(true);

  // Persisted KelmaSync credentials, so the home Sync button can sync without
  // re-prompting for a login. Loaded from the collection's config store after
  // the collection opens; updated by SyncScreen on a successful sign-in.
  const [syncAuth, setSyncAuth] = useState<SyncAuth | null>(null);
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'error' | 'done'>('idle');
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  // Run an incremental sync (collection + media) using the stored credentials.
  // If the user has never signed in, fall through to the Sync/Account screen
  // instead. Bumps the deck reload token so badges refresh afterwards.
  const syncNow = useCallback(() => {
    if (!syncAuth) {
      setScreen({ name: 'sync' });
      return;
    }
    setSyncState('syncing');
    setSyncStatus('Syncing collection and media…');
    runSyncNow(syncAuth)
      .then(summary => {
        setSyncState('done');
        setSyncStatus(summary);
        setDeckReloadToken(token => token + 1);
      })
      .catch(error => {
        const msg = error instanceof Error ? error.message : String(error);
        // A full sync needs an explicit upload/download choice — send the user
        // to the Sync screen to make it, rather than failing or picking blindly.
        if (msg === 'FULL_SYNC_REQUIRED') {
          setSyncState('idle');
          setSyncStatus(null);
          setScreen({ name: 'sync' });
          return;
        }
        setSyncState('error');
        setSyncStatus(msg);
      });
  }, [syncAuth]);

  const onSignedIn = useCallback((auth: SyncAuth) => {
    setSyncAuth(auth);
    storeSyncAuth(auth).catch(() => {
      // best-effort persistence; in-memory auth still works for this session
    });
  }, []);

  const onSignedOut = useCallback(() => {
    setSyncAuth(null);
    clearStoredSyncAuth().catch(() => {});
  }, []);

  // Tap a deck -> open its inspector (overview + browse), the AnkiDroid
  // StudyOptions + Card Browser equivalent. Selecting the deck for review and
  // jumping into the reviewer happens from the inspector's Study button.
  const openDeck = useCallback((deckId: number, deckName: string) => {
    setScreen({ name: 'deckInspector', deckId, deckName });
  }, []);

  const startReview = useCallback((deckId: number, deckName: string) => {
    selectDeck(deckId)
      .then(() => setScreen({ name: 'review', deckId, deckName }))
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
      .then(() => getStoredSyncAuth().then(setSyncAuth).catch(() => {}))
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

  // --- Import from .apkg ---------------------------------------------------
  // Two entry points feed the same importer:
  //   1. A deep link: the OS launched Kelma with a file:// (iOS) or
  //      content:// (Android) URI for an .apkg. Linking surfaces it via
  //      getInitialURL() and the url event.
  //   2. An explicit Import button in the deck list that opens the OS file
  //      picker.
  // Both resolve to a real filesystem path (copied into the app temp/cache
  // dir, since rslib opens by path and cannot take a security-scoped or
  // content:// URI directly), then call rslib import_apkg.
  const [importing, setImporting] = useState(false);
  // Guard against re-importing the same launch URL twice (initial URL + event).
  const [handledUrl, setHandledUrl] = useState<string | null>(null);

  const runImport = useCallback(
    (path: string) => {
      if (!path || importing) {
        return;
      }
      setImporting(true);
      importApkg(path)
        .then(result => {
          setDeckReloadToken(token => token + 1);
          const parts: string[] = [];
          if (result.added) {
            parts.push(`${result.added} added`);
          }
          if (result.updated) {
            parts.push(`${result.updated} updated`);
          }
          const skipped = result.duplicates + result.conflicts;
          if (skipped) {
            parts.push(`${skipped} skipped`);
          }
          Alert.alert(
            'Import complete',
            parts.length
              ? `${parts.join(' · ')}${result.foundNotes ? `\nof ${result.foundNotes} notes` : ''}.`
              : 'No new notes were found in the package.',
          );
        })
        .catch(error => {
          Alert.alert(
            'Import failed',
            error instanceof Error ? error.message : 'Could not import the package.',
          );
        })
        .finally(() => setImporting(false));
    },
    [importing],
  );

  const importFromUri = useCallback(
    (uri: string) => {
      if (!uri || uri === handledUrl) {
        return;
      }
      setHandledUrl(uri);
      // Route by scheme: remote http(s) URLs are downloaded, local file/content
      // URIs are copied. Both resolve to a filesystem path rslib can import.
      const fetchPath = /^https?:\/\//i.test(uri)
        ? downloadUrlToTempPath(uri)
        : copyUriToTempPath(uri);
      fetchPath
        .then(runImport)
        .catch(error =>
          Alert.alert(
            'Import failed',
            error instanceof Error ? error.message : 'Could not read the shared file.',
          ),
        );
    },
    [handledUrl, runImport],
  );

  // Import an .apkg the app was launched/opened with.
  useEffect(() => {
    if (boot.kind !== 'ready') {
      return;
    }
    Linking.getInitialURL()
      .then(url => {
        if (url && looksLikeApkgUrl(url)) {
          importFromUri(url);
        }
      })
      .catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (looksLikeApkgUrl(url)) {
        importFromUri(url);
      }
    });
    return () => sub.remove();
  }, [boot.kind, importFromUri]);

  const importFromPicker = useCallback(() => {
    pickFile()
      .then(path => {
        if (path) {
          runImport(path);
        }
      })
      .catch(error =>
        Alert.alert(
          'Import failed',
          error instanceof Error ? error.message : 'Could not open the file picker.',
        ),
      );
  }, [runImport]);

  // Download an .apkg from a pasted remote URL (Import from URL sheet).
  const importFromUrl = useCallback(
    (url: string) => {
      const trimmed = url.trim();
      if (!/^https?:\/\//i.test(trimmed)) {
        Alert.alert('Import failed', 'Enter a full http(s) URL to an .apkg file.');
        return;
      }
      downloadUrlToTempPath(trimmed)
        .then(runImport)
        .catch(error =>
          Alert.alert(
            'Import failed',
            error instanceof Error ? error.message : 'Could not download the file.',
          ),
        );
    },
    [runImport],
  );

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
            <Text style={styles.eyebrow}>Kelma</Text>
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
              onEditCard={cardId =>
                setScreen({
                  name: 'noteEditor',
                  cardId,
                  returnTo: 'review',
                  deckId: screen.deckId,
                  deckName: screen.deckName,
                })
              }
              onBack={() => {
                setScreen({ name: 'deckInspector', deckId: screen.deckId, deckName: screen.deckName });
                setDeckReloadToken(token => token + 1);
              }}
            />
          ) : screen.name === 'deckInspector' ? (
            <DeckInspectorScreen
              deckId={screen.deckId}
              deckName={screen.deckName}
              onStudy={() => startReview(screen.deckId, screen.deckName)}
              onOpenCard={cardId =>
                setScreen({
                  name: 'cardDetail',
                  cardId,
                  deckId: screen.deckId,
                  deckName: screen.deckName,
                })
              }
              onAdd={() =>
                setScreen({ name: 'addNote', deckId: screen.deckId, deckName: screen.deckName })
              }
              onBack={() => setScreen({ name: 'decks' })}
              reloadToken={deckReloadToken}
            />
          ) : screen.name === 'cardDetail' ? (
            <CardDetailScreen
              cardId={screen.cardId}
              deckName={screen.deckName}
              onEditCard={cardId =>
                setScreen({
                  name: 'noteEditor',
                  cardId,
                  returnTo: 'cardDetail',
                  deckId: screen.deckId,
                  deckName: screen.deckName,
                })
              }
              onChanged={() => setDeckReloadToken(token => token + 1)}
              onBack={() => {
                setDeckReloadToken(token => token + 1);
                setScreen({
                  name: 'deckInspector',
                  deckId: screen.deckId,
                  deckName: screen.deckName,
                });
              }}
            />
          ) : screen.name === 'noteEditor' ? (
            <NoteEditorScreen
              cardId={screen.cardId}
              onSaved={() => setDeckReloadToken(token => token + 1)}
              onClose={() =>
                setScreen(
                  screen.returnTo === 'review'
                    ? { name: 'review', deckId: screen.deckId, deckName: screen.deckName }
                    : {
                        name: 'cardDetail',
                        cardId: screen.cardId,
                        deckId: screen.deckId,
                        deckName: screen.deckName,
                      },
                )
              }
            />
          ) : screen.name === 'addNote' ? (
            <AddNoteScreen
              deckId={screen.deckId}
              deckName={screen.deckName}
              onSaved={() => setDeckReloadToken(token => token + 1)}
              onClose={() =>
                setScreen({
                  name: 'deckInspector',
                  deckId: screen.deckId,
                  deckName: screen.deckName,
                })
              }
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
                  onSyncNow={syncNow}
                  onImport={importFromPicker}
                  onImportUrl={importFromUrl}
                  importing={importing}
                  reloadToken={deckReloadToken}
                  syncState={syncState}
                  syncStatus={syncStatus}
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
                  onSignedIn={onSignedIn}
                  onSignedOut={onSignedOut}
                  initialAuth={syncAuth}
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
  const tabs: {
    name: MainScreen;
    glyph?: string;
    Icon?: (props: { color: string }) => ReactNode;
    label: string;
  }[] = [
    { name: 'decks', Icon: DeckIcon, label: 'Decks' },
    { name: 'stats', Icon: StatsIcon, label: 'Stats' },
    { name: 'sync', Icon: SyncIcon, label: 'KelmaSync' },
    { name: 'settings', Icon: SettingsIcon, label: 'Settings' },
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
            <View style={[styles.tabIcon, selected && styles.tabIconActive]}>
              {tab.Icon ? (
                <tab.Icon color={selected ? palette.background : palette.textMuted} />
              ) : (
                <Text style={[styles.tabIconGlyph, selected && styles.tabGlyphSelected]}>
                  {tab.glyph}
                </Text>
              )}
            </View>
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
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  errorTitle: { color: palette.textPrimary, fontSize: 24, fontWeight: '800' },
  errorBody: { color: palette.textSecondary, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  retry: {
    backgroundColor: palette.gold,
    borderRadius: radius.md,
    paddingHorizontal: 20,
    paddingVertical: 12,
    marginTop: 6,
  },
  retryText: { color: palette.background, fontSize: 15, fontWeight: '800' },
  tabBar: {
    flexDirection: 'row',
    minHeight: 64,
    // Same colour as the canvas so it flows seamlessly into the bottom safe
    // area (home indicator) instead of showing a two-tone band; a hairline is
    // the only separator from content.
    backgroundColor: palette.background,
    borderTopColor: palette.hairline,
    borderTopWidth: 1,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 },
  tabIcon: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 30,
    minWidth: 52,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  tabIconActive: { backgroundColor: palette.gold },
  tabIconGlyph: { color: palette.textMuted, fontSize: 20, lineHeight: 24 },
  tabGlyphSelected: { color: palette.background },
  tabLabel: {
    color: palette.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  tabSelected: { color: palette.goldSoft },
});

export default App;

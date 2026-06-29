/**
 * Deck list + sync. Lists the collection's decks (with today's counts) and
 * provides KelmaSync sign-in and one-tap sync. Everything is rslib-backed.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { DEFAULT_SYNC_ENDPOINT } from '../config';
import {
  fullSync,
  getDeckTree,
  syncCollection,
  syncLogin,
  type DeckNode,
  type SyncAuth,
} from '../core/KelmaCore';
import { palette } from './theme';

type Props = {
  onStudy: () => void;
};

type FlatDeck = { id: number; name: string; depth: number; due: number };

function flatten(node: DeckNode, depth = -1, acc: FlatDeck[] = []): FlatDeck[] {
  // The synthetic root (depth -1) is skipped; its children are the real decks.
  if (depth >= 0) {
    acc.push({
      id: node.deckId,
      name: node.name,
      depth,
      due: node.newCount + node.learnCount + node.reviewCount,
    });
  }
  for (const child of node.children) {
    flatten(child, depth + 1, acc);
  }
  return acc;
}

export function DeckListScreen({ onStudy }: Props) {
  const [decks, setDecks] = useState<FlatDeck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    setError(null);
    return getDeckTree()
      .then(tree => setDecks(flatten(tree)))
      .catch(e => setError(e instanceof Error ? e.message : 'Could not load decks.'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = () => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.gold} />
      }>
      <Text style={styles.eyebrow}>KELMA</Text>
      <Text style={styles.title}>Your decks</Text>

      {decks === null && !error && (
        <View style={styles.center}>
          <ActivityIndicator color={palette.gold} />
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {decks?.length === 0 && (
        <Text style={styles.empty}>
          No decks yet. Sign in below and sync to pull your collection from
          KelmaSync.
        </Text>
      )}

      {decks?.map(deck => (
        <View key={deck.id} style={[styles.deckRow, { paddingLeft: 4 + deck.depth * 16 }]}>
          <Text style={styles.deckName} numberOfLines={1}>
            {deck.name}
          </Text>
          <Text style={[styles.deckDue, deck.due === 0 && styles.deckDueZero]}>
            {deck.due}
          </Text>
        </View>
      ))}

      <Pressable onPress={onStudy} style={styles.studyButton}>
        <Text style={styles.studyText}>Study now</Text>
      </Pressable>

      <SyncPanel onSynced={load} />
    </ScrollView>
  );
}

function SyncPanel({ onSynced }: { onSynced: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [auth, setAuth] = useState<SyncAuth | null>(null);
  const [status, setStatus] = useState<string>('Sign in to your KelmaSync account.');
  const [busy, setBusy] = useState(false);

  const runSync = useCallback(
    async (credentials: SyncAuth) => {
      const outcome = await syncCollection(credentials);
      if (outcome.required === 'fullSyncRequired') {
        // The server and device diverged. Default to download so a fresh device
        // pulls the server's collection; the UI can later prompt for direction.
        setStatus('Schemas differ — performing a full download…');
        await fullSync(credentials, outcome.downloadOk ? false : true);
        setStatus('Full sync complete.');
      } else if (outcome.required === 'noChanges') {
        setStatus('Already up to date.');
      } else {
        setStatus('Sync complete.');
      }
      onSynced();
    },
    [onSynced],
  );

  const onSignInAndSync = () => {
    setBusy(true);
    setStatus('Signing in…');
    syncLogin(username, password, DEFAULT_SYNC_ENDPOINT)
      .then(credentials => {
        setAuth(credentials);
        setStatus('Signed in. Syncing…');
        return runSync(credentials);
      })
      .catch(e => setStatus(e instanceof Error ? e.message : 'Sync failed.'))
      .finally(() => setBusy(false));
  };

  const onSyncAgain = () => {
    if (!auth) {
      return;
    }
    setBusy(true);
    setStatus('Syncing…');
    runSync(auth)
      .catch(e => setStatus(e instanceof Error ? e.message : 'Sync failed.'))
      .finally(() => setBusy(false));
  };

  return (
    <View style={styles.syncCard}>
      <Text style={styles.syncTitle}>Sync</Text>
      <Text style={styles.syncEndpoint}>{DEFAULT_SYNC_ENDPOINT}</Text>

      {!auth && (
        <>
          <TextInput
            style={styles.input}
            placeholder="Username or email"
            placeholderTextColor={palette.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            value={username}
            onChangeText={setUsername}
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor={palette.textMuted}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />
        </>
      )}

      <Pressable
        disabled={busy}
        onPress={auth ? onSyncAgain : onSignInAndSync}
        style={[styles.syncButton, busy && styles.syncButtonDisabled]}>
        {busy ? (
          <ActivityIndicator color={palette.background} />
        ) : (
          <Text style={styles.syncButtonText}>{auth ? 'Sync now' : 'Sign in & sync'}</Text>
        )}
      </Pressable>

      <Text style={styles.syncStatus}>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  content: { paddingHorizontal: 24, paddingTop: 36, paddingBottom: 40 },
  eyebrow: {
    color: palette.gold,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 3.2,
    marginBottom: 10,
  },
  title: {
    color: palette.textPrimary,
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -1,
    marginBottom: 20,
  },
  center: { paddingVertical: 30, alignItems: 'center' },
  error: { color: palette.bad, fontSize: 14, marginBottom: 12 },
  empty: { color: palette.textSecondary, fontSize: 15, lineHeight: 22, marginBottom: 8 },
  deckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomColor: palette.surfaceBorder,
    borderBottomWidth: 1,
  },
  deckName: { color: palette.textPrimary, fontSize: 16, flex: 1, marginRight: 12 },
  deckDue: { color: palette.good, fontSize: 16, fontWeight: '700' },
  deckDueZero: { color: palette.textMuted, fontWeight: '400' },
  studyButton: {
    backgroundColor: palette.gold,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 24,
  },
  studyText: { color: palette.background, fontSize: 16, fontWeight: '800' },
  syncCard: {
    marginTop: 30,
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 18,
    padding: 20,
  },
  syncTitle: { color: palette.textPrimary, fontSize: 18, fontWeight: '700' },
  syncEndpoint: { color: palette.textMuted, fontSize: 12, marginTop: 4, marginBottom: 16 },
  input: {
    backgroundColor: palette.background,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 10,
    color: palette.textPrimary,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  syncButton: {
    backgroundColor: palette.goldSoft,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  syncButtonDisabled: { opacity: 0.6 },
  syncButtonText: { color: palette.background, fontSize: 15, fontWeight: '800' },
  syncStatus: { color: palette.textSecondary, fontSize: 13, marginTop: 12, textAlign: 'center' },
});

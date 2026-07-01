/**
 * Deck browser (AnkiDroid-style): the deck tree with per-deck New / Learning /
 * Due counts and collapsible subdecks. Tapping a deck starts its review.
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
  View,
} from 'react-native';
import {
  getDeckTree,
  getPendingChanges,
  type DeckNode,
  type PendingChanges,
} from '../core/KelmaCore';
import { palette } from './theme';

type Props = {
  onOpenDeck: (deckId: number, deckName: string) => void;
  /** Execute a sync with stored credentials (falls back to login if none). */
  onSyncNow: () => void;
  onOpenSync: () => void;
  onOpenSettings: () => void;
  reloadToken: number;
  /** 'idle' | 'syncing' | 'error' | 'done' — drives the Sync button state. */
  syncState: SyncState;
  syncStatus: string | null;
};

type SyncState = 'idle' | 'syncing' | 'error' | 'done';

type Row = {
  id: number;
  name: string;
  depth: number;
  hasChildren: boolean;
  newCount: number;
  learnCount: number;
  reviewCount: number;
};

type PendingMap = Map<number, { added: number; changed: number }>;

/** Walk the tree into visible rows, skipping children of collapsed decks. */
function flatten(
  node: DeckNode,
  collapsed: Set<number>,
  depth = -1,
  acc: Row[] = [],
): Row[] {
  if (depth >= 0) {
    acc.push({
      id: node.deckId,
      name: node.name,
      depth,
      hasChildren: node.children.length > 0,
      newCount: node.newCount,
      learnCount: node.learnCount,
      reviewCount: node.reviewCount,
    });
  }
  const isCollapsed = depth >= 0 && collapsed.has(node.deckId);
  if (!isCollapsed) {
    for (const child of node.children) {
      flatten(child, collapsed, depth + 1, acc);
    }
  }
  return acc;
}

/** Seed collapse state from rslib's stored per-deck collapsed flags. */
function initialCollapsed(node: DeckNode, acc = new Set<number>()): Set<number> {
  if (node.collapsed && node.children.length > 0) {
    acc.add(node.deckId);
  }
  for (const child of node.children) {
    initialCollapsed(child, acc);
  }
  return acc;
}

/** Index the per-deck pending counts by deck id for O(1) row lookup. */
function pendingToMap(changes: PendingChanges): PendingMap {
  const map: PendingMap = new Map();
  for (const deck of changes.decks) {
    map.set(deck.deckId, { added: deck.added, changed: deck.changed });
  }
  return map;
}

/** A one-line collection-wide summary for the header (e.g. "3 added · 2 changed"). */
function pendingLabel(changes: PendingChanges): string | null {
  const added = changes.decks.reduce((sum, d) => sum + d.added, 0);
  const changed = changes.decks.reduce((sum, d) => sum + d.changed, 0);
  if (!changes.hasChanges || (added === 0 && changed === 0)) {
    return null;
  }
  const parts: string[] = [];
  if (added) {
    parts.push(`${added} added`);
  }
  if (changed) {
    parts.push(`${changed} changed`);
  }
  return parts.length ? parts.join(' · ') : null;
}

export function DeckListScreen({
  onOpenDeck,
  onSyncNow,
  onOpenSync,
  onOpenSettings,
  reloadToken,
  syncState,
  syncStatus,
}: Props) {
  const [tree, setTree] = useState<DeckNode | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState<PendingMap>(new Map());
  const [pendingSummary, setPendingSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    setError(null);
    return Promise.all([getDeckTree(), getPendingChanges()])
      .then(([t, changes]) => {
        setTree(t);
        setCollapsed(initialCollapsed(t));
        setPending(pendingToMap(changes));
        setPendingSummary(pendingLabel(changes));
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Could not load decks.'));
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadToken]);

  const onRefresh = () => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  };

  const toggle = (deckId: number) =>
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(deckId) ? next.delete(deckId) : next.add(deckId);
      return next;
    });

  const rows = tree ? flatten(tree, collapsed) : null;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.gold} />
      }>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>KELMA</Text>
          <Text style={styles.title}>Your decks</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sync now"
            onPress={onSyncNow}
            disabled={syncState === 'syncing'}
            style={[styles.headerButton, syncState === 'syncing' && styles.headerButtonDisabled]}>
            {syncState === 'syncing' ? (
              <ActivityIndicator color={palette.goldSoft} style={styles.headerSpinner} />
            ) : (
              <Text style={[styles.headerIcon, pendingSummary && styles.headerIconPending]}>↻</Text>
            )}
            <Text style={styles.headerButtonText}>
              {syncState === 'syncing' ? 'Syncing' : 'Sync'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sync account"
            onPress={onOpenSync}
            style={styles.headerButton}>
            <Text style={styles.headerIcon}>👤</Text>
            <Text style={styles.headerButtonText}>Account</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            onPress={onOpenSettings}
            style={styles.headerButton}>
            <Text style={styles.headerIcon}>⚙</Text>
            <Text style={styles.headerButtonText}>Settings</Text>
          </Pressable>
        </View>
      </View>

      {pendingSummary && syncState !== 'syncing' && (
        <Text style={styles.pendingBanner}>↑ {pendingSummary} unsynced</Text>
      )}
      {syncState !== 'idle' && syncState !== 'syncing' && syncStatus ? (
        <Text style={[styles.syncStatus, syncState === 'error' && styles.syncStatusError]}>
          {syncStatus}
        </Text>
      ) : null}
      {syncState === 'syncing' && syncStatus ? (
        <Text style={styles.syncStatus}>{syncStatus}</Text>
      ) : null}

      {rows === null && !error && (
        <View style={styles.center}>
          <ActivityIndicator color={palette.gold} />
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {rows?.length === 0 && (
        <Text style={styles.empty}>
          No decks yet. Tap Sync above to pull your collection from KelmaSync.
        </Text>
      )}

      {rows && rows.length > 0 && (
        <View style={styles.columnHeader}>
          <View style={styles.deckNameCol} />
          <Text style={[styles.colLabel, styles.colNew]}>New</Text>
          <Text style={[styles.colLabel, styles.colLearn]}>Learn</Text>
          <Text style={[styles.colLabel, styles.colReview]}>Due</Text>
        </View>
      )}

      {rows?.map(deck => {
        const p = pending.get(deck.id);
        return (
        <Pressable
          key={deck.id}
          onPress={() => onOpenDeck(deck.id, deck.name)}
          style={({ pressed }) => [styles.deckRow, pressed && styles.deckRowPressed]}
          android_ripple={{ color: palette.surfaceBorder, radius: 0 }}>
          <View style={[styles.deckNameCol, { paddingLeft: deck.depth * 16 }]}>
            {deck.hasChildren ? (
              <Pressable
                onPress={() => toggle(deck.id)}
                hitSlop={10}
                style={styles.chevronHit}
                accessibilityRole="button"
                accessibilityLabel={collapsed.has(deck.id) ? 'Expand' : 'Collapse'}>
                <Text style={styles.chevron}>{collapsed.has(deck.id) ? '▸' : '▾'}</Text>
              </Pressable>
            ) : (
              <View style={styles.chevronHit} />
            )}
            <Text style={styles.deckName} numberOfLines={1}>
              {deck.name}
            </Text>
            {p && (p.added > 0 || p.changed > 0) ? (
              <Text style={styles.syncBadge}>
                {p.added > 0 ? `+${p.added}` : ''}
                {p.added > 0 && p.changed > 0 ? ' ' : ''}
                {p.changed > 0 ? `~${p.changed}` : ''}
              </Text>
            ) : null}
          </View>
          <Text style={[styles.count, styles.colNew, deck.newCount === 0 && styles.zero]}>
            {deck.newCount}
          </Text>
          <Text style={[styles.count, styles.colLearn, deck.learnCount === 0 && styles.zero]}>
            {deck.learnCount}
          </Text>
          <Text style={[styles.count, styles.colReview, deck.reviewCount === 0 && styles.zero]}>
            {deck.reviewCount}
          </Text>
        </Pressable>
        );
      })}
    </ScrollView>
  );
}

const COL_W = 46;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  content: { paddingHorizontal: 24, paddingTop: 36, paddingBottom: 40 },
  eyebrow: { color: palette.gold, fontSize: 13, fontWeight: '800', letterSpacing: 3.2, marginBottom: 10 },
  title: { color: palette.textPrimary, fontSize: 34, fontWeight: '700', letterSpacing: -1 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 20,
  },
  headerActions: { flexDirection: 'row', gap: 8 },
  headerButton: {
    minWidth: 54,
    alignItems: 'center',
    paddingHorizontal: 7,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
  },
  headerButtonDisabled: { opacity: 0.6 },
  headerIcon: { color: palette.goldSoft, fontSize: 19, lineHeight: 22 },
  headerSpinner: { height: 22, justifyContent: 'center' },
  headerIconPending: { color: palette.gold },
  headerButtonText: { color: palette.textSecondary, fontSize: 10, fontWeight: '700', marginTop: 2 },
  center: { paddingVertical: 30, alignItems: 'center' },
  error: { color: palette.bad, fontSize: 14, marginBottom: 12 },
  empty: { color: palette.textSecondary, fontSize: 15, lineHeight: 22, marginBottom: 8 },
  pendingBanner: {
    color: palette.gold,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6,
  },
  syncStatus: { color: palette.textSecondary, fontSize: 13, marginBottom: 10 },
  syncStatusError: { color: palette.bad },
  columnHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 6,
    borderBottomColor: palette.surfaceBorder,
    borderBottomWidth: 1,
  },
  colLabel: { width: COL_W, textAlign: 'center', fontSize: 11, fontWeight: '700' },
  deckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 15,
    borderBottomColor: palette.surfaceBorder,
    borderBottomWidth: 1,
  },
  deckRowPressed: { backgroundColor: palette.surfaceBorder },
  deckNameCol: { flex: 1, flexDirection: 'row', alignItems: 'center', marginRight: 8 },
  chevronHit: { width: 22, alignItems: 'center' },
  chevron: { color: palette.textMuted, fontSize: 14 },
  deckName: { color: palette.textPrimary, fontSize: 16, flex: 1 },
  syncBadge: {
    color: palette.gold,
    fontSize: 11,
    fontWeight: '800',
    marginLeft: 8,
    borderWidth: 1,
    borderColor: palette.gold,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  count: { width: COL_W, textAlign: 'center', fontSize: 16, fontWeight: '700' },
  colNew: { color: '#6f9fb0' },
  colLearn: { color: palette.bad },
  colReview: { color: palette.good },
  zero: { color: palette.textMuted, fontWeight: '400' },
});

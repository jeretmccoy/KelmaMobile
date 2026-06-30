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
import { getDeckTree, type DeckNode } from '../core/KelmaCore';
import { palette } from './theme';

type Props = {
  onOpenDeck: (deckId: number, deckName: string) => void;
  onOpenSync: () => void;
  onOpenSettings: () => void;
  reloadToken: number;
};

type Row = {
  id: number;
  name: string;
  depth: number;
  hasChildren: boolean;
  newCount: number;
  learnCount: number;
  reviewCount: number;
};

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

export function DeckListScreen({
  onOpenDeck,
  onOpenSync,
  onOpenSettings,
  reloadToken,
}: Props) {
  const [tree, setTree] = useState<DeckNode | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    setError(null);
    return getDeckTree()
      .then(t => {
        setTree(t);
        setCollapsed(initialCollapsed(t));
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
            accessibilityLabel="Sync"
            onPress={onOpenSync}
            style={styles.headerButton}>
            <Text style={styles.headerIcon}>↻</Text>
            <Text style={styles.headerButtonText}>Sync</Text>
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

      {rows?.map(deck => (
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
      ))}
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
    minWidth: 58,
    alignItems: 'center',
    paddingHorizontal: 7,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
  },
  headerIcon: { color: palette.goldSoft, fontSize: 19, lineHeight: 22 },
  headerButtonText: { color: palette.textSecondary, fontSize: 10, fontWeight: '700', marginTop: 2 },
  center: { paddingVertical: 30, alignItems: 'center' },
  error: { color: palette.bad, fontSize: 14, marginBottom: 12 },
  empty: { color: palette.textSecondary, fontSize: 15, lineHeight: 22, marginBottom: 8 },
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
  count: { width: COL_W, textAlign: 'center', fontSize: 16, fontWeight: '700' },
  colNew: { color: '#6f9fb0' },
  colLearn: { color: palette.bad },
  colReview: { color: palette.good },
  zero: { color: palette.textMuted, fontWeight: '400' },
});

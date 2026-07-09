/**
 * Deck browser (AnkiDroid-style): the deck tree with per-deck New / Learning /
 * Due counts and collapsible subdecks. Tapping a deck starts its review.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  getDeckTree,
  getPendingChanges,
  type DeckNode,
  type PendingChanges,
} from '../core/KelmaCore';
import { ImportIcon, SyncIcon } from './TabIcons';
import { headerStyles, palette, radius, spacing } from './theme';

type Props = {
  onOpenDeck: (deckId: number, deckName: string) => void;
  /** Execute a sync with stored credentials (falls back to login if none). */
  onSyncNow: () => void;
  /** Open the OS file picker to import an .apkg package (AnkiDroid Import). */
  onImport: () => void;
  /** Download + import an .apkg from a pasted remote URL. */
  onImportUrl: (url: string) => void;
  /** True while an import is running; disables the Import button. */
  importing: boolean;
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
  onImport,
  onImportUrl,
  importing,
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
  const [importSheetOpen, setImportSheetOpen] = useState(false);

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
    <View style={styles.screen}>
      <View style={styles.topBar}>
        <Text style={styles.brand}>Kelma</Text>
        <View style={styles.topBarActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sync now"
            onPress={onSyncNow}
            disabled={syncState === 'syncing'}
            style={({ pressed }) => [
              styles.iconBtn,
              pressed && styles.iconBtnPressed,
              syncState === 'syncing' && styles.iconBtnDisabled,
            ]}>
            {syncState === 'syncing' ? (
              <ActivityIndicator color={palette.goldSoft} />
            ) : (
              <SyncIcon color={pendingSummary ? palette.gold : palette.goldSoft} size={22} />
            )}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Import deck"
            onPress={() => setImportSheetOpen(true)}
            disabled={importing}
            style={({ pressed }) => [
              styles.iconBtn,
              pressed && styles.iconBtnPressed,
              importing && styles.iconBtnDisabled,
            ]}>
            {importing ? (
              <ActivityIndicator color={palette.goldSoft} />
            ) : (
              <ImportIcon color={palette.goldSoft} size={22} />
            )}
          </Pressable>
        </View>
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.gold} />
        }>
        <View style={[headerStyles.titleRow, styles.titleRow]}>
          <View style={headerStyles.accentTall} />
          <Text style={styles.title}>Your decks</Text>
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
          android_ripple={{ color: palette.surfaceElevated, radius: 0 }}>
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
      <ImportSheet
        visible={importSheetOpen}
        importing={importing}
        onPickFile={() => {
          setImportSheetOpen(false);
          onImport();
        }}
        onImportUrl={url => {
          setImportSheetOpen(false);
          onImportUrl(url);
        }}
        onClose={() => setImportSheetOpen(false)}
      />
    </View>
  );
}

/** Import sheet: choose a local `.apkg` file, or paste a remote URL to
 *  download + import. Mirrors the ExportSheet's bottom-modal pattern. */
function ImportSheet({
  visible,
  importing,
  onPickFile,
  onImportUrl,
  onClose,
}: {
  visible: boolean;
  importing: boolean;
  onPickFile: () => void;
  onImportUrl: (url: string) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState('');

  const submit = () => {
    const trimmed = url.trim();
    if (!trimmed) {
      return;
    }
    setUrl('');
    onImportUrl(trimmed);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={stylesImport.overlay} onPress={onClose}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={stylesImport.sheetWrap}
          onStartShouldSetResponder={() => true}>
          <Pressable style={stylesImport.sheet} onPress={e => e.stopPropagation()}>
            <View style={stylesImport.handle} />
            <Text style={stylesImport.title}>Import deck</Text>
            <Text style={stylesImport.subtitle}>
              Add cards from an Anki package (.apkg).
            </Text>

            <Pressable
              onPress={onPickFile}
              disabled={importing}
              style={({ pressed }) => [
                stylesImport.optionButton,
                pressed && stylesImport.optionButtonPressed,
                importing && stylesImport.optionButtonDisabled,
              ]}>
              <Text style={stylesImport.optionIcon}>📂</Text>
              <View style={stylesImport.optionText}>
                <Text style={stylesImport.optionTitle}>Choose a file</Text>
                <Text style={stylesImport.optionHint}>Browse Files / iCloud Drive</Text>
              </View>
              <Text style={stylesImport.chevron}>›</Text>
            </Pressable>

            <View style={stylesImport.dividerWrap}>
              <View style={stylesImport.divider} />
              <Text style={stylesImport.dividerText}>OR</Text>
              <View style={stylesImport.divider} />
            </View>

            <Text style={stylesImport.optionTitle}>From a URL</Text>
            <Text style={stylesImport.optionHint}>Paste a direct link to an .apkg file.</Text>
            <View style={stylesImport.urlRow}>
              <TextInput
                style={stylesImport.urlInput}
                value={url}
                onChangeText={setUrl}
                placeholder="https://example.com/deck.apkg"
                placeholderTextColor={palette.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                onSubmitEditing={submit}
                editable={!importing}
              />
              <Pressable
                onPress={submit}
                disabled={importing || !url.trim()}
                style={({ pressed }) => [
                  stylesImport.goButton,
                  pressed && stylesImport.optionButtonPressed,
                  (importing || !url.trim()) && stylesImport.optionButtonDisabled,
                ]}>
                {importing ? (
                  <ActivityIndicator color={palette.background} />
                ) : (
                  <Text style={stylesImport.goButtonText}>Go</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

const COL_W = 46;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  content: { paddingHorizontal: spacing.xxl, paddingTop: spacing.xl, paddingBottom: 48 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.md,
    // Same colour as the canvas so it flows seamlessly into the top safe area
    // (status bar / notch); a hairline is the only separator from content.
    backgroundColor: palette.background,
    borderBottomColor: palette.hairline,
    borderBottomWidth: 1,
  },
  brand: { color: palette.textPrimary, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  titleRow: { marginBottom: spacing.xl },
  title: { color: palette.textPrimary, fontSize: 38, fontWeight: '800', letterSpacing: -1.2 },
  topBarActions: { flexDirection: 'row', gap: spacing.sm },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
  },
  iconBtnPressed: { backgroundColor: palette.surfaceElevated },
  iconBtnDisabled: { opacity: 0.6 },
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
    paddingBottom: spacing.sm,
    borderBottomColor: palette.hairline,
    borderBottomWidth: 1,
  },
  colLabel: { width: COL_W, textAlign: 'center', fontSize: 10, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' },
  deckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.lg,
    borderBottomColor: palette.hairline,
    borderBottomWidth: 1,
  },
  deckRowPressed: { backgroundColor: palette.surface },
  deckNameCol: { flex: 1, flexDirection: 'row', alignItems: 'center', marginRight: 8 },
  chevronHit: { width: 22, alignItems: 'center' },
  chevron: { color: palette.textMuted, fontSize: 14 },
  deckName: { color: palette.textPrimary, fontSize: 16, fontWeight: '600', flex: 1 },
  syncBadge: {
    color: palette.gold,
    fontSize: 11,
    fontWeight: '800',
    marginLeft: 8,
    borderWidth: 1,
    borderColor: palette.gold,
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  count: { width: COL_W, textAlign: 'center', fontSize: 17, fontWeight: '800' },
  colNew: { color: palette.newCard },
  colLearn: { color: palette.bad },
  colReview: { color: palette.good },
  zero: { color: palette.textMuted, fontWeight: '500' },
});

const stylesImport = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheetWrap: { justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: palette.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 36,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.surfaceBorder,
    alignSelf: 'center',
    marginBottom: 14,
  },
  title: {
    color: palette.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  subtitle: {
    color: palette.textSecondary,
    fontSize: 14,
    marginBottom: 16,
  },
  optionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: palette.background,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 12,
  },
  optionButtonPressed: { opacity: 0.7 },
  optionButtonDisabled: { opacity: 0.5 },
  optionIcon: { fontSize: 22 },
  optionText: { flex: 1 },
  optionTitle: { color: palette.textPrimary, fontSize: 15, fontWeight: '700' },
  optionHint: { color: palette.textMuted, fontSize: 12, marginTop: 2 },
  chevron: { color: palette.textMuted, fontSize: 18, fontWeight: '700' },
  dividerWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 18,
    gap: 10,
  },
  divider: {
    flex: 1,
    height: 1,
    backgroundColor: palette.surfaceBorder,
  },
  dividerText: {
    color: palette.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
  },
  urlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 10,
  },
  urlInput: {
    flex: 1,
    backgroundColor: palette.background,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: palette.textPrimary,
    fontSize: 15,
  },
  goButton: {
    backgroundColor: palette.gold,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  goButtonText: {
    color: palette.background,
    fontSize: 15,
    fontWeight: '800',
  },
});

/**
 * Statistics: today's study summary plus a card-count breakdown (new, learning,
 * young, mature, suspended) — the core of AnkiDroid's stats, backed by rslib.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { getStats, type Stats } from '../core/KelmaCore';
import { palette } from './theme';

type Props = { reloadToken: number };

type Segment = { key: keyof Stats['counts']; label: string; color: string };

const SEGMENTS: Segment[] = [
  { key: 'new', label: 'New', color: '#6f9fb0' },
  { key: 'learning', label: 'Learning', color: palette.bad },
  { key: 'young', label: 'Young', color: '#8fb98a' },
  { key: 'mature', label: 'Mature', color: palette.good },
  { key: 'suspended', label: 'Suspended', color: palette.gold },
];

export function StatisticsScreen({ reloadToken }: Props) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    setError(null);
    return getStats()
      .then(setStats)
      .catch(e => setError(e instanceof Error ? e.message : 'Could not load statistics.'));
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadToken]);

  const onRefresh = () => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  };

  const counts = stats?.counts;
  const barTotal = counts
    ? SEGMENTS.reduce((sum, s) => sum + counts[s.key], 0)
    : 0;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.gold} />
      }>
      <Text style={styles.eyebrow}>KELMA</Text>
      <Text style={styles.title}>Statistics</Text>

      {stats === null && !error && (
        <View style={styles.center}>
          <ActivityIndicator color={palette.gold} />
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {stats && (
        <>
          <View style={styles.cardBox}>
            <Text style={styles.sectionLabel}>Today</Text>
            <Text style={styles.today}>{stats.studiedToday}</Text>
          </View>

          <View style={styles.cardBox}>
            <Text style={styles.sectionLabel}>Card counts</Text>

            {barTotal > 0 && (
              <View style={styles.bar}>
                {SEGMENTS.map(seg =>
                  counts![seg.key] > 0 ? (
                    <View
                      key={seg.key}
                      style={{
                        flex: counts![seg.key],
                        backgroundColor: seg.color,
                      }}
                    />
                  ) : null,
                )}
              </View>
            )}

            {SEGMENTS.map(seg => (
              <View key={seg.key} style={styles.row}>
                <View style={[styles.dot, { backgroundColor: seg.color }]} />
                <Text style={styles.rowLabel}>{seg.label}</Text>
                <Text style={styles.rowValue}>{counts![seg.key].toLocaleString()}</Text>
              </View>
            ))}

            <View style={[styles.row, styles.totalRow]}>
              <View style={styles.dot} />
              <Text style={[styles.rowLabel, styles.totalLabel]}>Total</Text>
              <Text style={[styles.rowValue, styles.totalLabel]}>
                {counts!.total.toLocaleString()}
              </Text>
            </View>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  content: { paddingHorizontal: 24, paddingTop: 36, paddingBottom: 40 },
  eyebrow: { color: palette.gold, fontSize: 13, fontWeight: '800', letterSpacing: 3.2, marginBottom: 10 },
  title: { color: palette.textPrimary, fontSize: 34, fontWeight: '700', letterSpacing: -1, marginBottom: 20 },
  center: { paddingVertical: 30, alignItems: 'center' },
  error: { color: palette.bad, fontSize: 14 },
  cardBox: {
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
  },
  sectionLabel: {
    color: palette.textMuted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginBottom: 12,
    textTransform: 'uppercase',
  },
  today: { color: palette.textPrimary, fontSize: 17, lineHeight: 24 },
  bar: {
    flexDirection: 'row',
    height: 14,
    borderRadius: 7,
    overflow: 'hidden',
    marginBottom: 16,
    backgroundColor: palette.background,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7 },
  dot: { width: 12, height: 12, borderRadius: 6, marginRight: 12 },
  rowLabel: { color: palette.textSecondary, fontSize: 15, flex: 1 },
  rowValue: { color: palette.textPrimary, fontSize: 15, fontWeight: '700' },
  totalRow: {
    borderTopColor: palette.surfaceBorder,
    borderTopWidth: 1,
    marginTop: 6,
    paddingTop: 12,
  },
  totalLabel: { color: palette.textPrimary, fontWeight: '800' },
});

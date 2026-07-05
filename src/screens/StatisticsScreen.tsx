/**
 * Per-deck statistics — the full rslib graph set AnkiDroid shows, scoped to a
 * chosen deck (and its subdecks): Today, Future due, Card counts, Reviews (count
 * & time), Answer buttons, Intervals, Ease/Difficulty, Added, Hourly breakdown,
 * Stability, Retrievability, and True retention. Charts are drawn with plain RN
 * views (no chart dependency).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  getDeckStats,
  getDeckTree,
  type ButtonCounts,
  type DeckNode,
  type DeckStats,
  type IntMap,
  type ReviewsByType,
  type TrueRetention,
} from '../core/KelmaCore';
import { headerStyles, palette, radius, shadow, spacing } from './theme';

type Props = { reloadToken: number };

type FlatDeck = { deckId: number; name: string; leaf: string; level: number };

const PERIODS = [
  { label: '1M', days: 31 },
  { label: '3M', days: 90 },
  { label: '1Y', days: 365 },
  { label: 'All', days: 0 },
];

// Review-type + card-state colors, roughly matching AnkiDroid's legend.
const C = {
  learn: palette.newCard,
  relearn: palette.bad,
  young: palette.young,
  mature: palette.good,
  filtered: palette.textMuted,
  newCard: palette.newCard,
  suspended: palette.gold,
  buried: palette.textMuted,
  bar: palette.goldSoft,
};

function flattenDecks(node: DeckNode, level = 0, acc: FlatDeck[] = []): FlatDeck[] {
  // The tree root is synthetic (empty name); include only real decks.
  if (node.name) {
    const parts = node.name.split('::');
    acc.push({
      deckId: node.deckId,
      name: node.name,
      leaf: parts[parts.length - 1],
      level: Math.max(0, level - 1),
    });
  }
  for (const child of node.children) flattenDecks(child, level + 1, acc);
  return acc;
}

/** Sorted [numericKey, value] pairs from a string-keyed histogram. */
function series(map: IntMap | undefined): [number, number][] {
  if (!map) return [];
  return Object.entries(map)
    .map(([k, v]) => [Number(k), v] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}

/** Bucket a [key,value] series into at most `maxBars` contiguous groups
 *  (summing), so long ranges stay renderable. */
function bucket(
  pairs: [number, number][],
  maxBars: number,
): { value: number; key: number }[] {
  if (pairs.length === 0) return [];
  if (pairs.length <= maxBars) return pairs.map(([key, value]) => ({ key, value }));
  const size = Math.ceil(pairs.length / maxBars);
  const out: { value: number; key: number }[] = [];
  for (let i = 0; i < pairs.length; i += size) {
    const slice = pairs.slice(i, i + size);
    out.push({ key: slice[0][0], value: slice.reduce((s, [, v]) => s + v, 0) });
  }
  return out;
}

const REVIEW_TYPES: { key: keyof ReviewsByType; color: string; label: string }[] = [
  { key: 'learn', color: C.learn, label: 'Learn' },
  { key: 'relearn', color: C.relearn, label: 'Relearn' },
  { key: 'young', color: C.young, label: 'Young' },
  { key: 'mature', color: C.mature, label: 'Mature' },
  { key: 'filtered', color: C.filtered, label: 'Filtered' },
];

export function StatisticsScreen({ reloadToken }: Props) {
  const [decks, setDecks] = useState<FlatDeck[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [days, setDays] = useState(31);
  const [stats, setStats] = useState<DeckStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Load the deck list once (and on external reload).
  useEffect(() => {
    getDeckTree()
      .then(tree => {
        const flat = flattenDecks(tree);
        setDecks(flat);
        setSelected(prev => (prev != null ? prev : flat[0]?.deckId ?? null));
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Could not load decks.'));
  }, [reloadToken]);

  const load = useCallback(() => {
    if (selected == null) return Promise.resolve();
    setLoading(true);
    setError(null);
    return getDeckStats(selected, days)
      .then(setStats)
      .catch(e => setError(e instanceof Error ? e.message : 'Could not load statistics.'))
      .finally(() => setLoading(false));
  }, [selected, days]);

  useEffect(() => {
    load();
  }, [load, reloadToken]);

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
      <View style={[headerStyles.titleRow, styles.titleRow]}>
        <View style={headerStyles.accentTall} />
        <Text style={styles.title}>Statistics</Text>
      </View>

      {/* Deck picker */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}>
        {decks.map(d => (
          <Pressable
            key={d.deckId}
            onPress={() => setSelected(d.deckId)}
            style={[styles.chip, selected === d.deckId && styles.chipActive]}>
            <Text
              style={[styles.chipText, selected === d.deckId && styles.chipTextActive]}
              numberOfLines={1}>
              {'· '.repeat(d.level)}
              {d.leaf}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* Period selector */}
      <View style={styles.periodRow}>
        {PERIODS.map(p => (
          <Pressable
            key={p.label}
            onPress={() => setDays(p.days)}
            style={[styles.period, days === p.days && styles.periodActive]}>
            <Text style={[styles.periodText, days === p.days && styles.periodTextActive]}>
              {p.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}
      {loading && !stats && (
        <View style={styles.center}>
          <ActivityIndicator color={palette.gold} />
        </View>
      )}

      {stats && <StatsBody stats={stats} />}
    </ScrollView>
  );
}

function StatsBody({ stats }: { stats: DeckStats }) {
  return (
    <>
      {stats.today && <TodaySection today={stats.today} />}
      {stats.futureDue && (
        <FutureDueSection map={stats.futureDue.futureDue} load={stats.futureDue.dailyLoad} />
      )}
      {stats.cardCounts?.excludingInactive && (
        <CardCountsSection counts={stats.cardCounts.excludingInactive} />
      )}
      {stats.reviews && <ReviewsSection reviews={stats.reviews} />}
      {stats.buttons && <ButtonsSection buttons={stats.buttons} days={stats.days} />}
      {stats.intervals && (
        <HistogramCard
          title="Intervals"
          hint="Days until each card is next due"
          map={stats.intervals.intervals}
          color={C.mature}
        />
      )}
      {stats.fsrs && stats.stability && (
        <HistogramCard
          title="Stability"
          hint="Memory stability (days)"
          map={stats.stability.intervals}
          color={C.young}
        />
      )}
      {stats.fsrs
        ? stats.difficulty && (
            <HistogramCard
              title="Difficulty"
              hint={`Average ${Math.round(stats.difficulty.average)}%`}
              map={stats.difficulty.eases}
              color={C.relearn}
            />
          )
        : stats.eases && (
            <HistogramCard
              title="Card ease"
              hint={`Average ${Math.round(stats.eases.average)}%`}
              map={stats.eases.eases}
              color={C.bar}
            />
          )}
      {stats.fsrs && stats.retrievability && (
        <HistogramCard
          title="Retrievability"
          hint={`Average ${Math.round(stats.retrievability.average)}%`}
          map={stats.retrievability.retrievability}
          color={C.mature}
        />
      )}
      {stats.added && (
        <HistogramCard
          title="Added"
          hint="Cards added per day"
          map={stats.added.added}
          color={C.newCard}
          maxBars={60}
        />
      )}
      {stats.hours && <HoursSection hours={stats.hours} days={stats.days} />}
      {stats.trueRetention && <TrueRetentionSection tr={stats.trueRetention} />}
    </>
  );
}

// --- Sections ---------------------------------------------------------------

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.cardBox}>
      <Text style={styles.sectionLabel}>{title}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {children}
    </View>
  );
}

function TodaySection({ today }: { today: NonNullable<DeckStats['today']> }) {
  const mins = Math.round(today.answerMillis / 60000);
  const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');
  const tiles = [
    { label: 'Reviews', value: today.answerCount.toLocaleString() },
    { label: 'Minutes', value: mins.toLocaleString() },
    { label: 'Correct', value: pct(today.correctCount, today.answerCount) },
    { label: 'Mature correct', value: pct(today.matureCorrect, today.matureCount) },
  ];
  return (
    <Card title="Today">
      <View style={styles.tileRow}>
        {tiles.map(t => (
          <View key={t.label} style={styles.tile}>
            <Text style={styles.tileValue}>{t.value}</Text>
            <Text style={styles.tileLabel}>{t.label}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}

type StatCountsT = NonNullable<NonNullable<DeckStats['cardCounts']>['excludingInactive']>;
const CARD_COUNT_SEGS: { key: keyof StatCountsT; label: string; color: string }[] = [
  { key: 'new', label: 'New', color: C.newCard },
  { key: 'learn', label: 'Learning', color: C.learn },
  { key: 'relearn', label: 'Relearning', color: C.relearn },
  { key: 'young', label: 'Young', color: C.young },
  { key: 'mature', label: 'Mature', color: C.mature },
  { key: 'suspended', label: 'Suspended', color: C.suspended },
  { key: 'buried', label: 'Buried', color: C.buried },
];

function CardCountsSection({ counts }: { counts: StatCountsT }) {
  const total = CARD_COUNT_SEGS.reduce((s, seg) => s + (counts[seg.key] || 0), 0);
  return (
    <Card title="Card counts">
      {total > 0 && (
        <View style={styles.segBar}>
          {CARD_COUNT_SEGS.map(seg =>
            counts[seg.key] > 0 ? (
              <View key={seg.key} style={{ flex: counts[seg.key], backgroundColor: seg.color }} />
            ) : null,
          )}
        </View>
      )}
      {CARD_COUNT_SEGS.map(seg => (
        <View key={seg.key} style={styles.legendRow}>
          <View style={[styles.dot, { backgroundColor: seg.color }]} />
          <Text style={styles.legendLabel}>{seg.label}</Text>
          <Text style={styles.legendValue}>{(counts[seg.key] || 0).toLocaleString()}</Text>
        </View>
      ))}
      <View style={[styles.legendRow, styles.totalRow]}>
        <View style={styles.dot} />
        <Text style={[styles.legendLabel, styles.totalLabel]}>Total</Text>
        <Text style={[styles.legendValue, styles.totalLabel]}>{total.toLocaleString()}</Text>
      </View>
    </Card>
  );
}

function FutureDueSection({ map, load }: { map: IntMap; load: number }) {
  const pairs = series(map).filter(([d]) => d >= 0 && d <= 30);
  const bars = pairs.map(([key, value]) => ({ key, segments: [{ value, color: C.mature }] }));
  return (
    <Card title="Future due" hint={`~${load}/day average load · next 30 days`}>
      <StackedBars bars={bars} xLabel={k => (k === 0 ? '0' : k % 7 === 0 ? String(k) : '')} />
    </Card>
  );
}

function ReviewsSection({ reviews }: { reviews: NonNullable<DeckStats['reviews']> }) {
  const countBars = useReviewBars(reviews.count);
  const timeBars = useMemo(() => {
    const pairs = Object.entries(reviews.time)
      .map(
        ([k, r]) =>
          [Number(k), (r.learn + r.relearn + r.young + r.mature + r.filtered) / 60000] as [
            number,
            number,
          ],
      )
      .sort((a, b) => a[0] - b[0]);
    return bucket(pairs, 60).map(b => ({ key: b.key, segments: [{ value: b.value, color: C.bar }] }));
  }, [reviews.time]);
  return (
    <>
      <Card title="Reviews">
        <StackedBars bars={countBars} xLabel={dayLabel} />
        <View style={styles.legendWrap}>
          {REVIEW_TYPES.map(t => (
            <View key={t.key} style={styles.legendChip}>
              <View style={[styles.dot, { backgroundColor: t.color }]} />
              <Text style={styles.legendChipText}>{t.label}</Text>
            </View>
          ))}
        </View>
      </Card>
      <Card title="Review time" hint="Minutes per day">
        <StackedBars bars={timeBars} xLabel={dayLabel} valueFormat={v => `${Math.round(v)}m`} />
      </Card>
    </>
  );
}

function useReviewBars(count: Record<string, ReviewsByType>) {
  return useMemo(() => {
    const pairs = Object.entries(count)
      .map(([k, r]) => [Number(k), r] as [number, ReviewsByType])
      .sort((a, b) => a[0] - b[0]);
    const size = Math.max(1, Math.ceil(pairs.length / 60));
    const out: { key: number; segments: { value: number; color: string }[] }[] = [];
    for (let i = 0; i < pairs.length; i += size) {
      const slice = pairs.slice(i, i + size);
      const agg: ReviewsByType = { learn: 0, relearn: 0, young: 0, mature: 0, filtered: 0 };
      for (const [, r] of slice) {
        agg.learn += r.learn;
        agg.relearn += r.relearn;
        agg.young += r.young;
        agg.mature += r.mature;
        agg.filtered += r.filtered;
      }
      out.push({
        key: slice[0][0],
        segments: REVIEW_TYPES.map(t => ({ value: agg[t.key], color: t.color })),
      });
    }
    return out;
  }, [count]);
}

function dayLabel(k: number): string {
  if (k === 0) return 'today';
  if (k % 30 === 0) return String(k);
  return '';
}

function pickByDays<T>(
  obj: { oneMonth?: T; threeMonths?: T; oneYear?: T; allTime?: T },
  days: number,
): T | undefined {
  const byDays = days === 31 ? obj.oneMonth : days === 90 ? obj.threeMonths : days === 365 ? obj.oneYear : obj.allTime;
  return byDays ?? obj.allTime ?? obj.oneYear ?? obj.threeMonths ?? obj.oneMonth;
}

function ButtonsSection({ buttons, days }: { buttons: NonNullable<DeckStats['buttons']>; days: number }) {
  const bc = pickByDays(buttons, days);
  if (!bc) return null;
  return (
    <Card title="Answer buttons" hint="Presses of Again / Hard / Good / Easy">
      <ButtonsChart bc={bc} />
    </Card>
  );
}

function ButtonsChart({ bc }: { bc: ButtonCounts }) {
  const phases: { key: keyof ButtonCounts; color: string }[] = [
    { key: 'learning', color: C.learn },
    { key: 'young', color: C.young },
    { key: 'mature', color: C.mature },
  ];
  const names = ['1', '2', '3', '4'];
  const bars = names.map((label, i) => ({
    key: i,
    label,
    segments: phases
      .map(p => ({ value: bc[p.key]?.[i] || 0, color: p.color }))
      .filter(s => s.value > 0),
  }));
  return <StackedBars bars={bars} xLabel={(_k, i) => names[i]} />;
}

function HistogramCard({
  title,
  hint,
  map,
  color,
  maxBars = 40,
}: {
  title: string;
  hint?: string;
  map: IntMap;
  color: string;
  maxBars?: number;
}) {
  const bucketed = bucket(series(map), maxBars);
  const bars = bucketed.map(b => ({ key: b.key, segments: [{ value: b.value, color }] }));
  const n = bucketed.length;
  return (
    <Card title={title} hint={hint}>
      <StackedBars
        bars={bars}
        xLabel={(_k, i) =>
          i === 0 || i === n - 1 || i === Math.floor(n / 2) ? String(bucketed[i]?.key ?? '') : ''
        }
      />
    </Card>
  );
}

function HoursSection({ hours, days }: { hours: NonNullable<DeckStats['hours']>; days: number }) {
  const h =
    days === 31
      ? hours.oneMonth
      : days === 90
        ? hours.threeMonths
        : days === 365
          ? hours.oneYear
          : hours.allTime;
  const bars = h.map((hour, i) => ({ key: i, segments: [{ value: hour.total, color: C.bar }] }));
  return (
    <Card title="Hourly breakdown" hint="Reviews by hour of day">
      <StackedBars bars={bars} xLabel={k => (k % 6 === 0 ? String(k) : '')} />
    </Card>
  );
}

function TrueRetentionSection({ tr }: { tr: NonNullable<DeckStats['trueRetention']> }) {
  const rows: { label: string; v?: TrueRetention }[] = [
    { label: 'Today', v: tr.today },
    { label: 'Yesterday', v: tr.yesterday },
    { label: 'Week', v: tr.week },
    { label: 'Month', v: tr.month },
    { label: 'Year', v: tr.year },
    { label: 'All time', v: tr.allTime },
  ];
  const rate = (v?: TrueRetention) => {
    if (!v) return '—';
    const passed = v.youngPassed + v.maturePassed;
    const total = passed + v.youngFailed + v.matureFailed;
    return total > 0 ? `${((passed / total) * 100).toFixed(1)}%` : '—';
  };
  return (
    <Card title="True retention" hint="Pass rate of reviewed cards (excludes new)">
      {rows.map(r => (
        <View key={r.label} style={styles.legendRow}>
          <Text style={[styles.legendLabel, { flex: 1 }]}>{r.label}</Text>
          <Text style={styles.legendValue}>{rate(r.v)}</Text>
        </View>
      ))}
    </Card>
  );
}

// --- Chart primitive: stacked vertical bars ---------------------------------

type Bar = { key: number; segments: { value: number; color: string }[]; label?: string };

function StackedBars({
  bars,
  height = 120,
  xLabel,
  valueFormat,
}: {
  bars: Bar[];
  height?: number;
  xLabel?: (key: number, index: number) => string;
  valueFormat?: (v: number) => string;
}) {
  const totals = bars.map(b => b.segments.reduce((s, seg) => s + seg.value, 0));
  const max = Math.max(1, ...totals);
  if (bars.length === 0 || max <= 1) {
    return <Text style={styles.emptyChart}>No data for this period.</Text>;
  }
  const fmt = valueFormat ?? ((v: number) => v.toLocaleString());
  return (
    <View>
      <View style={styles.chartHead}>
        <Text style={styles.axisMax}>{fmt(max)}</Text>
      </View>
      <View style={[styles.chart, { height }]}>
        {bars.map((b, i) => (
          <View key={`${b.key}-${i}`} style={styles.barCol}>
            <View style={styles.barStack}>
              {b.segments.map((seg, j) => (
                <View
                  key={j}
                  style={{
                    height: (seg.value / max) * height,
                    backgroundColor: seg.color,
                    borderTopLeftRadius: j === b.segments.length - 1 ? 2 : 0,
                    borderTopRightRadius: j === b.segments.length - 1 ? 2 : 0,
                  }}
                />
              ))}
            </View>
          </View>
        ))}
      </View>
      <View style={styles.xAxis}>
        {bars.map((b, i) => (
          <View key={`${b.key}-x-${i}`} style={styles.barCol}>
            <Text style={styles.xLabel} numberOfLines={1}>
              {b.label ?? xLabel?.(b.key, i) ?? ''}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  content: { paddingHorizontal: 24, paddingTop: 36, paddingBottom: 40 },
  titleRow: { marginBottom: 16 },
  title: { color: palette.textPrimary, fontSize: 38, fontWeight: '800', letterSpacing: -1.2 },
  center: { paddingVertical: 30, alignItems: 'center' },
  error: { color: palette.bad, fontSize: 14, marginTop: 8 },

  chipRow: { gap: 8, paddingBottom: 4, paddingRight: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    maxWidth: 200,
  },
  chipActive: { backgroundColor: palette.surfaceHigh, borderColor: palette.gold },
  chipText: { color: palette.textSecondary, fontSize: 14, fontWeight: '600' },
  chipTextActive: { color: palette.textPrimary },

  periodRow: { flexDirection: 'row', gap: 8, marginTop: 14, marginBottom: 6 },
  period: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: radius.sm,
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
  },
  periodActive: { backgroundColor: palette.surfaceHigh, borderColor: palette.gold },
  periodText: { color: palette.textSecondary, fontSize: 13, fontWeight: '700' },
  periodTextActive: { color: palette.textPrimary },

  cardBox: {
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginTop: spacing.lg,
    ...shadow.card,
  },
  sectionLabel: {
    color: palette.textSecondary,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  hint: { color: palette.textMuted, fontSize: 12, marginTop: 3, marginBottom: 4 },

  tileRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 },
  tile: { width: '50%', paddingVertical: 8 },
  tileValue: { color: palette.textPrimary, fontSize: 24, fontWeight: '800' },
  tileLabel: { color: palette.textMuted, fontSize: 12, marginTop: 2 },

  segBar: {
    flexDirection: 'row',
    height: 16,
    borderRadius: 8,
    overflow: 'hidden',
    marginTop: 12,
    marginBottom: 14,
    backgroundColor: palette.background,
    gap: 2,
  },
  legendRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  legendLabel: { color: palette.textSecondary, fontSize: 15, flex: 1 },
  legendValue: { color: palette.textPrimary, fontSize: 15, fontWeight: '700' },
  dot: { width: 12, height: 12, borderRadius: 3, marginRight: 12 },
  totalRow: {
    borderTopColor: palette.surfaceBorder,
    borderTopWidth: 1,
    marginTop: 6,
    paddingTop: 10,
  },
  totalLabel: { color: palette.textPrimary, fontWeight: '800' },

  legendWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 12 },
  legendChip: { flexDirection: 'row', alignItems: 'center' },
  legendChipText: { color: palette.textSecondary, fontSize: 12 },

  chartHead: { marginTop: 12 },
  axisMax: { color: palette.textMuted, fontSize: 11 },
  chart: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    borderBottomColor: palette.surfaceBorder,
    borderBottomWidth: 1,
    marginTop: 2,
  },
  barCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  barStack: { width: '78%', minWidth: 2, flexDirection: 'column-reverse' },
  xAxis: { flexDirection: 'row', gap: 2, marginTop: 4 },
  xLabel: { color: palette.textMuted, fontSize: 9 },
  emptyChart: { color: palette.textMuted, fontSize: 13, paddingVertical: 16 },
});

/**
 * Deck inspector (AnkiDroid's StudyOptionsFragment + a deck-scoped Card
 * Browser rolled into one): the per-deck overview — name, description, today's
 * due counts and totals — plus a searchable, paged list of the cards actually
 * in the deck. Tapping a card opens its front/back in the card detail view.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  browseDeck,
  CardColor,
  getDeckOverview,
  type BrowseCard,
  type DeckOverview,
} from '../core/KelmaCore';
import { palette } from './theme';

type Props = {
  deckId: number;
  deckName: string;
  onStudy: () => void;
  onOpenCard: (cardId: number) => void;
  onBack: () => void;
  /** Bump to refresh after a sync or review session. */
  reloadToken: number;
};

type Tab = 'overview' | 'browse';

const PAGE_SIZE = 50;

/** Map an rslib BrowserRow.Color to a label + accent. */
function badgeFor(color: number): { label: string; color: string } | null {
  switch (color) {
    case CardColor.Suspended:
      return { label: 'Suspended', color: palette.bad };
    case CardColor.Buried:
      return { label: 'Buried', color: palette.textMuted };
    case CardColor.Marked:
      return { label: 'Marked', color: palette.gold };
    case CardColor.FlagRed:
    case CardColor.FlagOrange:
    case CardColor.FlagGreen:
    case CardColor.FlagBlue:
    case CardColor.FlagPink:
    case CardColor.FlagTurquoise:
    case CardColor.FlagPurple:
      return { label: 'Flagged', color: palette.goldSoft };
    default:
      return null;
  }
}

export function DeckInspectorScreen({
  deckId,
  deckName,
  onStudy,
  onOpenCard,
  onBack,
  reloadToken,
}: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<DeckOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [cards, setCards] = useState<BrowseCard[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loadingCards, setLoadingCards] = useState(false);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadOverview = useCallback(() => {
    setOverviewError(null);
    return getDeckOverview(deckId)
      .then(setOverview)
      .catch(e =>
        setOverviewError(e instanceof Error ? e.message : 'Could not load the deck.'),
      );
  }, [deckId]);

  const loadCards = useCallback(
    (reset: boolean) => {
      setLoadingCards(true);
      setCardsError(null);
      const pageOffset = reset ? 0 : offset;
      return browseDeck(deckId, { query, limit: PAGE_SIZE, offset: pageOffset })
        .then(result => {
          setTotal(result.total);
          setOffset(pageOffset + result.cards.length);
          setCards(prev => (reset ? result.cards : [...prev, ...result.cards]));
        })
        .catch(e =>
          setCardsError(e instanceof Error ? e.message : 'Could not load cards.'),
        )
        .finally(() => setLoadingCards(false));
    },
    [deckId, query, offset],
  );

  useEffect(() => {
    loadOverview();
  }, [loadOverview, reloadToken]);

  // Load the first page when the user opens the Browse tab, and again whenever
  // the query changes (lightly debounced). Subsequent pages append via the
  // FlatList onEndReached.
  useEffect(() => {
    if (tab !== 'browse') {
      return;
    }
    setCards([]);
    setOffset(0);
    const handle = setTimeout(() => {
      loadCards(true);
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, deckId, reloadToken, query]);

  const onRefresh = () => {
    setRefreshing(true);
    const after = tab === 'browse' ? loadCards(true) : loadOverview();
    after.finally(() => setRefreshing(false));
  };

  const hasMore = cards.length < total;

  return (
    <View style={styles.screen}>
      <View style={styles.headerWrap}>
        <View style={styles.header}>
          <Pressable
            onPress={onBack}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Back to decks">
            <Text style={styles.back}>‹ Decks</Text>
          </Pressable>
          <Text style={styles.eyebrow}>DECK</Text>
          <View style={styles.headerSpacer} />
        </View>
        <Text style={styles.deckName} numberOfLines={2}>
          {deckName}
        </Text>

        <View style={styles.tabBar}>
          <Pressable
            onPress={() => setTab('overview')}
            style={[styles.tab, tab === 'overview' && styles.tabActive]}>
            <Text style={[styles.tabText, tab === 'overview' && styles.tabTextActive]}>
              Overview
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setTab('browse')}
            style={[styles.tab, tab === 'browse' && styles.tabActive]}>
            <Text style={[styles.tabText, tab === 'browse' && styles.tabTextActive]}>
              Cards
            </Text>
          </Pressable>
        </View>
      </View>

      {tab === 'overview' ? (
        <ScrollView
          style={styles.scrollArea}
          contentContainerStyle={styles.scrollContent}
          alwaysBounceVertical
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.gold} />
          }>
          <OverviewTab overview={overview} error={overviewError} onStudy={onStudy} />
        </ScrollView>
      ) : (
        <View style={styles.scrollArea}>
          <View style={styles.searchBar}>
            <View style={styles.searchBox}>
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search this deck…"
                placeholderTextColor={palette.textMuted}
                style={styles.searchInput}
                returnKeyType="search"
                autoCorrect={false}
              />
            </View>
            <Text style={styles.resultCount}>
              {total.toLocaleString()} {total === 1 ? 'card' : 'cards'}
            </Text>
          </View>

          {cardsError ? (
            <ScrollView
              contentContainerStyle={styles.scrollContent}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.gold} />
              }>
              <Text style={styles.error}>{cardsError}</Text>
            </ScrollView>
          ) : (
            <FlatList
              style={styles.listArea}
              contentContainerStyle={styles.listContent}
              data={cards}
              keyExtractor={item => String(item.cardId)}
              renderItem={({ item }) => (
                <CardRow card={item} onPress={() => onOpenCard(item.cardId)} />
              )}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.gold} />
              }
              onEndReached={() => hasMore && !loadingCards && loadCards(false)}
              onEndReachedThreshold={0.3}
              ListFooterComponent={
                loadingCards ? (
                  <View style={styles.center}>
                    <ActivityIndicator color={palette.gold} />
                  </View>
                ) : cards.length === 0 ? (
                  <Text style={styles.empty}>No cards match.</Text>
                ) : null
              }
            />
          )}
        </View>
      )}
    </View>
  );
}

function OverviewTab({
  overview,
  error,
  onStudy,
}: {
  overview: DeckOverview | null;
  error: string | null;
  onStudy: () => void;
}) {
  const dueToday = overview
    ? overview.todayNew + overview.todayLearn + overview.todayReview
    : 0;

  if (error) {
    return <Text style={styles.error}>{error}</Text>;
  }
  if (!overview) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={palette.gold} />
      </View>
    );
  }

  return (
    <>
      <View style={styles.cardBox}>
        <Text style={styles.sectionLabel}>Due today</Text>
        <View style={styles.countRow}>
          <Count label="New" value={overview.todayNew} color="#6f9fb0" />
          <Count label="Learning" value={overview.todayLearn} color={palette.bad} />
          <Count label="Review" value={overview.todayReview} color={palette.good} />
        </View>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Total cards</Text>
          <Text style={styles.totalValue}>
            {overview.totalCards.toLocaleString()}
          </Text>
        </View>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>New cards</Text>
          <Text style={styles.totalValue}>
            {overview.totalNew.toLocaleString()}
          </Text>
        </View>
      </View>

      {overview.description ? (
        <View style={styles.cardBox}>
          <Text style={styles.sectionLabel}>Description</Text>
          <Text style={styles.description}>{overview.description}</Text>
        </View>
      ) : null}

      <Pressable
        onPress={onStudy}
        disabled={overview.filtered && dueToday === 0}
        style={({ pressed }) => [
          styles.studyButton,
          pressed && styles.studyButtonPressed,
        ]}>
        <Text style={styles.studyButtonText}>
          {dueToday === 0 ? 'Study (nothing due)' : 'Study now'}
        </Text>
      </Pressable>
    </>
  );
}

function Count({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <View style={styles.countCell}>
      <Text style={[styles.countValue, { color }]}>{value}</Text>
      <Text style={styles.countLabel}>{label}</Text>
    </View>
  );
}

function CardRow({ card, onPress }: { card: BrowseCard; onPress: () => void }) {
  const badge = badgeFor(card.color);
  const meta = [
    card.due,
    card.interval ? `${card.interval}` : null,
    card.reps ? `${card.reps} reps` : null,
  ]
    .filter(Boolean)
    .join('  ·  ');
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.cardRow, pressed && styles.cardRowPressed]}
      android_ripple={{ color: palette.surfaceBorder, radius: 0 }}>
      <Text style={styles.cardQuestion} numberOfLines={3}>
        {card.question || '(empty)'}
      </Text>
      <View style={styles.cardMetaRow}>
        {badge && (
          <Text style={[styles.badge, { color: badge.color }]}>{badge.label}</Text>
        )}
        {meta ? <Text style={styles.cardMeta}>{meta}</Text> : null}
        <Text style={styles.chevron}>›</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  headerWrap: { paddingHorizontal: 24, paddingTop: 36 },
  scrollArea: { flex: 1 },
  scrollContent: { paddingHorizontal: 24, paddingBottom: 40 },
  searchBar: { paddingHorizontal: 24, paddingBottom: 8 },
  listArea: { flex: 1 },
  listContent: { paddingHorizontal: 24, paddingBottom: 40 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  back: { color: palette.goldSoft, fontSize: 15, fontWeight: '700' },
  eyebrow: {
    color: palette.gold,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 3.2,
    marginLeft: 'auto',
  },
  headerSpacer: { width: 60 },
  deckName: {
    color: palette.textPrimary,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.5,
    marginBottom: 18,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: palette.surface,
    borderRadius: 12,
    padding: 4,
    marginBottom: 18,
  },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center' },
  tabActive: { backgroundColor: palette.background },
  tabText: { color: palette.textSecondary, fontSize: 14, fontWeight: '700' },
  tabTextActive: { color: palette.textPrimary },
  center: { paddingVertical: 24, alignItems: 'center' },
  error: { color: palette.bad, fontSize: 14, marginBottom: 8 },
  empty: { color: palette.textSecondary, fontSize: 15, lineHeight: 22, paddingVertical: 16 },

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
  countRow: { flexDirection: 'row', marginBottom: 14 },
  countCell: { flex: 1, alignItems: 'center' },
  countValue: { fontSize: 26, fontWeight: '800' },
  countLabel: { color: palette.textSecondary, fontSize: 12, fontWeight: '700', marginTop: 3 },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderTopColor: palette.surfaceBorder,
    borderTopWidth: 1,
  },
  totalLabel: { color: palette.textSecondary, fontSize: 15 },
  totalValue: { color: palette.textPrimary, fontSize: 15, fontWeight: '700' },
  description: {
    color: palette.textPrimary,
    fontSize: 15,
    lineHeight: 22,
  },

  studyButton: {
    backgroundColor: palette.gold,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 4,
  },
  studyButtonPressed: { opacity: 0.85 },
  studyButtonText: {
    color: palette.background,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.3,
  },

  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  searchInput: { flex: 1, color: palette.textPrimary, fontSize: 15, paddingVertical: 12 },
  resultCount: {
    color: palette.textMuted,
    fontSize: 13,
    fontWeight: '700',
  },
  cardRow: {
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardRowPressed: { backgroundColor: palette.surfaceBorder },
  cardQuestion: { color: palette.textPrimary, fontSize: 15, lineHeight: 21 },
  cardMetaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 10 },
  badge: { fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
  cardMeta: { color: palette.textMuted, fontSize: 12, flex: 1 },
  chevron: { color: palette.textMuted, fontSize: 18, fontWeight: '700' },
});

/**
 * Reviewer: shows the next due card and answers it. All scheduling is performed
 * by rslib — this screen only renders the card and reports the chosen rating.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  answerCard,
  getNextCard,
  Rating,
  type NextCard,
} from '../core/KelmaCore';
import { htmlToText, palette } from './theme';

type Props = {
  onBack: () => void;
};

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; counts: NextCard['counts'] }
  | { kind: 'card'; data: NonNullable<NextCard['card']>; counts: NextCard['counts'] };

const RATINGS: { label: string; rating: Rating; color: string }[] = [
  { label: 'Again', rating: Rating.Again, color: palette.bad },
  { label: 'Hard', rating: Rating.Hard, color: '#b8995f' },
  { label: 'Good', rating: Rating.Good, color: palette.good },
  { label: 'Easy', rating: Rating.Easy, color: '#6f9fb0' },
];

export function ReviewerScreen({ onBack }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [revealed, setRevealed] = useState(false);
  const shownAt = useRef<number>(Date.now());

  const loadNext = useCallback(() => {
    setRevealed(false);
    setState({ kind: 'loading' });
    getNextCard()
      .then(next => {
        shownAt.current = Date.now();
        if (next.card) {
          setState({ kind: 'card', data: next.card, counts: next.counts });
        } else {
          setState({ kind: 'done', counts: next.counts });
        }
      })
      .catch(error =>
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Could not load the next card.',
        }),
      );
  }, []);

  useEffect(loadNext, [loadNext]);

  const onRate = (rating: Rating) => {
    if (state.kind !== 'card') {
      return;
    }
    const elapsed = Date.now() - shownAt.current;
    const cardId = state.data.cardId;
    setState({ kind: 'loading' });
    answerCard(cardId, rating, elapsed)
      .then(loadNext)
      .catch(error =>
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Could not record your answer.',
        }),
      );
  };

  return (
    <View style={styles.screen}>
      <View style={styles.topBar}>
        <Pressable onPress={onBack} accessibilityRole="button" hitSlop={12}>
          <Text style={styles.back}>‹ Decks</Text>
        </Pressable>
        {state.kind === 'card' && (
          <Text style={styles.counts}>
            <Text style={styles.countNew}>{state.counts.new} </Text>
            <Text style={styles.countLearn}>{state.counts.learning} </Text>
            <Text style={styles.countReview}>{state.counts.review}</Text>
          </Text>
        )}
      </View>

      {state.kind === 'loading' && (
        <View style={styles.center}>
          <ActivityIndicator color={palette.gold} />
        </View>
      )}

      {state.kind === 'error' && (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Something went wrong</Text>
          <Text style={styles.errorBody}>{state.message}</Text>
          <Pressable onPress={loadNext} style={styles.retry}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      )}

      {state.kind === 'done' && (
        <View style={styles.center}>
          <Text style={styles.doneTitle}>All caught up.</Text>
          <Text style={styles.doneBody}>
            No more cards are due right now. Come back later or sync to pull new
            material.
          </Text>
          <Pressable onPress={onBack} style={styles.retry}>
            <Text style={styles.retryText}>Back to decks</Text>
          </Pressable>
        </View>
      )}

      {state.kind === 'card' && (
        <>
          <Text style={styles.deck}>{state.data.deckName}</Text>
          <ScrollView style={styles.cardScroll} contentContainerStyle={styles.cardContent}>
            <Text style={styles.cardText}>{htmlToText(state.data.question)}</Text>
            {revealed && (
              <>
                <View style={styles.divider} />
                <Text style={styles.cardText}>{htmlToText(state.data.answer)}</Text>
              </>
            )}
          </ScrollView>

          {revealed ? (
            <View style={styles.ratings}>
              {RATINGS.map(({ label, rating, color }) => (
                <Pressable
                  key={rating}
                  onPress={() => onRate(rating)}
                  style={({ pressed }) => [
                    styles.ratingButton,
                    { borderColor: color },
                    pressed && { backgroundColor: color },
                  ]}>
                  <Text style={[styles.ratingText, { color }]}>{label}</Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <Pressable onPress={() => setRevealed(true)} style={styles.showAnswer}>
              <Text style={styles.showAnswerText}>Show answer</Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 20, paddingBottom: 16 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
  },
  back: { color: palette.goldSoft, fontSize: 16, fontWeight: '600' },
  counts: { fontSize: 15, fontWeight: '700' },
  countNew: { color: '#6f9fb0' },
  countLearn: { color: palette.bad },
  countReview: { color: palette.good },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  deck: { color: palette.textMuted, fontSize: 13, fontWeight: '700', letterSpacing: 1.5 },
  cardScroll: { flex: 1, marginTop: 12 },
  cardContent: { paddingVertical: 24 },
  cardText: { color: palette.textPrimary, fontSize: 22, lineHeight: 32, textAlign: 'center' },
  divider: {
    height: 1,
    backgroundColor: palette.surfaceBorder,
    marginVertical: 24,
  },
  showAnswer: {
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  showAnswerText: { color: palette.goldSoft, fontSize: 16, fontWeight: '700' },
  ratings: { flexDirection: 'row', gap: 8 },
  ratingButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  ratingText: { fontSize: 14, fontWeight: '700' },
  errorTitle: { color: palette.bad, fontSize: 18, fontWeight: '700' },
  errorBody: { color: palette.textSecondary, fontSize: 14, textAlign: 'center', paddingHorizontal: 20 },
  doneTitle: { color: palette.textPrimary, fontSize: 24, fontWeight: '700' },
  doneBody: {
    color: palette.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  retry: {
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 8,
  },
  retryText: { color: palette.goldSoft, fontSize: 14, fontWeight: '700' },
});

/**
 * Card options action sheet — the AnkiDroid-style card menu (suspend / bury /
 * mark / flag / change deck / delete), shared by the reviewer (during study)
 * and the card detail (browser) screens.
 *
 * All actions go through rslib's own transactional ops, so undo, USN stamping
 * and sync bookkeeping match Anki desktop / AnkiDroid exactly. The component
 * fetches the card's current state (`getCardDetail`) when opened so the labels
 * (Suspend vs Unsuspend, current flag, marked) reflect reality.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  buryCard,
  deleteCard,
  getCardDetail,
  getDeckTree,
  setCardDeck,
  setCardFlag,
  suspendCard,
  toggleCardMark,
  unsuspendCard,
  type CardDetail,
  type DeckNode,
} from '../core/KelmaCore';
import { palette, radius, shadow } from './theme';

export type Props = {
  cardId: number;
  visible: boolean;
  onClose: () => void;
  /** Called after an action that removes the card from the review queue
   * (suspend / bury / delete) so the caller can advance to the next card. */
  onCardRemoved?: () => void;
  /** Called after an action that updates but keeps the card (mark / flag /
   * change deck) so the caller can refresh any dependent UI. */
  onCardUpdated?: () => void;
  /** Open the note editor for this card. The sheet closes itself first. */
  onEdit?: (cardId: number) => void;
};

/** rslib CardQueue discriminants we care about for the action labels. */
const QUEUE_SUSPENDED = -1;
const QUEUE_SCHED_BURIED = -2;
const QUEUE_USER_BURIED = -3;

/** Anki's 7 flag colours, index = flag number (0 = no flag). */
const FLAG_COLORS = ['', '#e15a5a', '#e09a3e', '#7fa67a', '#5a8fd8', '#a06ed8', '#d882a6', '#5ad0c6'];
const FLAG_NAMES = ['', 'Red', 'Orange', 'Green', 'Blue', 'Purple', 'Pink', 'Teal'];

type Sub = 'main' | 'flag' | 'deck';

export function CardOptionsSheet({
  cardId,
  visible,
  onClose,
  onCardRemoved,
  onCardUpdated,
  onEdit,
}: Props) {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [sub, setSub] = useState<Sub>('main');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // (Re)load the card's current state whenever the sheet is opened.
  useEffect(() => {
    if (!visible) return;
    setSub('main');
    setDetail(null);
    setDetailError(null);
    getCardDetail(cardId)
      .then(setDetail)
      .catch(e =>
        setDetailError(e instanceof Error ? e.message : 'Could not load card state.'),
      );
  }, [visible, cardId]);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1600);
  }, []);

  /** Run a mutating op, then either advance (card removed) or refresh the
   * sheet's own state (card updated). */
  const run = useCallback(
    async (
      fn: () => Promise<unknown>,
      opts: { message?: string; removed?: boolean; then?: () => void } = {},
    ) => {
      if (busy) return;
      setBusy(true);
      setSub('main');
      try {
        await fn();
        if (opts.message) flash(opts.message);
        if (opts.removed) {
          onCardRemoved?.();
          onClose();
        } else {
          onCardUpdated?.();
          // Refresh the labels in place.
          getCardDetail(cardId).then(setDetail).catch(() => {});
        }
        opts.then?.();
      } catch (error) {
        flash(error instanceof Error ? error.message : 'Action failed.');
      } finally {
        setBusy(false);
      }
    },
    [busy, cardId, flash, onClose, onCardRemoved, onCardUpdated],
  );

  const close = () => {
    if (sub !== 'main') {
      setSub('main');
      return;
    }
    onClose();
  };

  const isSuspended = detail?.queue === QUEUE_SUSPENDED;
  const isBuried =
    detail?.queue === QUEUE_SCHED_BURIED || detail?.queue === QUEUE_USER_BURIED;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={close}>
      <Pressable style={styles.scrim} onPress={close}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          {busy && (
            <View style={styles.busyBar}>
              <ActivityIndicator color={palette.gold} />
            </View>
          )}

          {sub === 'main' && (
            <>
              <Text style={styles.title}>Card options</Text>
              {detailError ? (
                <Text style={styles.errorBody}>{detailError}</Text>
              ) : !detail ? (
                <View style={styles.inlineLoad}>
                  <ActivityIndicator color={palette.gold} />
                </View>
              ) : (
                <>
                  <SheetButton
                    label={isSuspended ? 'Unsuspend' : isBuried ? 'Unbury' : 'Suspend'}
                    hint={
                      isSuspended
                        ? 'Restore to the review queue'
                        : isBuried
                          ? 'Restore the buried card to the queue'
                          : 'Hide from reviews until unsuspended'
                    }
                    onPress={() =>
                      run(
                        () =>
                          isSuspended || isBuried
                            ? unsuspendCard(cardId)
                            : suspendCard(cardId),
                        {
                          message:
                            isSuspended || isBuried ? 'Restored to queue' : 'Suspended',
                          removed: true,
                        },
                      )
                    }
                  />
                  <SheetButton
                    label="Bury"
                    hint="Hide this card until next day rollover"
                    disabled={isSuspended || isBuried}
                    onPress={() =>
                      run(() => buryCard(cardId), { message: 'Buried', removed: true })
                    }
                  />
                  <SheetButton
                    label={detail.marked ? 'Unmark' : 'Mark'}
                    hint={
                      detail.marked
                        ? 'Remove the "marked" tag from the note'
                        : 'Tag the note "marked"'
                    }
                    onPress={() =>
                      run(async () => {
                        const r = await toggleCardMark(cardId);
                        flash(r.marked ? 'Marked' : 'Unmarked');
                      })
                    }
                  />
                  <SheetButton
                    label="Edit"
                    hint="Edit this note's fields and tags"
                    onPress={() => {
                      onClose();
                      onEdit?.(cardId);
                    }}
                  />
                  <SheetButton
                    label={`Flag${
                      detail.flags > 0 ? ` (${FLAG_NAMES[detail.flags]})` : ''
                    }`}
                    hint="Set a coloured flag"
                    onPress={() => setSub('flag')}
                  />
                  <SheetButton
                    label="Change deck"
                    hint="Move this card to another deck"
                    onPress={() => setSub('deck')}
                  />
                  <SheetButton
                    label="Delete card"
                    hint="Removes the card (and its note if no other cards use it)"
                    danger
                    onPress={() =>
                      run(async () => {
                        await deleteCard(cardId);
                        flash('Card deleted');
                      }, { removed: true })
                    }
                  />
                </>
              )}
              <Pressable style={styles.cancel} onPress={close}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
            </>
          )}

          {sub === 'flag' && (
            <>
              <Text style={styles.title}>Set flag</Text>
              <View style={styles.flagGrid}>
                {FLAG_COLORS.map((color, i) => (
                  <Pressable
                    key={i}
                    style={[
                      styles.flagChip,
                      { borderColor: color || palette.surfaceBorder, backgroundColor: color || 'transparent' },
                      detail?.flags === i && styles.flagChipSelected,
                    ]}
                    onPress={() =>
                      run(() => setCardFlag(cardId, i), {
                        message: i === 0 ? 'Flag cleared' : `Flagged ${FLAG_NAMES[i]}`,
                      })
                    }>
                    <Text style={[styles.flagChipText, { color: color ? '#fff' : palette.textSecondary }]}>
                      {i === 0 ? 'None' : FLAG_NAMES[i]}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Pressable style={styles.cancel} onPress={() => setSub('main')}>
                <Text style={styles.cancelText}>Back</Text>
              </Pressable>
            </>
          )}

          {sub === 'deck' && (
            <DeckPickerBody
              currentDeckId={detail?.deckId}
              onPick={deckId =>
                run(async () => {
                  await setCardDeck(cardId, deckId);
                  flash('Card moved');
                })
              }
              onCancel={() => setSub('main')}
            />
          )}
        </Pressable>
      </Pressable>

      {toast && (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}
    </Modal>
  );
}

function DeckPickerBody({
  currentDeckId,
  onPick,
  onCancel,
}: {
  currentDeckId?: number;
  onPick: (deckId: number) => void;
  onCancel: () => void;
}) {
  const [decks, setDecks] = useState<{ deckId: number; name: string; level: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDeckTree()
      .then(tree => setDecks(flatten(tree)))
      .catch(e => setError(e instanceof Error ? e.message : 'Could not load decks.'));
  }, []);

  return (
    <>
      <Text style={styles.title}>Move card to deck</Text>
      {error ? (
        <Text style={styles.errorBody}>{error}</Text>
      ) : decks === null ? (
        <View style={styles.inlineLoad}>
          <ActivityIndicator color={palette.gold} />
        </View>
      ) : (
        <ScrollView style={styles.deckList}>
          {decks.map(d => (
            <Pressable
              key={d.deckId}
              style={[styles.deckRow, d.deckId === currentDeckId && styles.deckRowCurrent]}
              onPress={() => onPick(d.deckId)}>
              <Text style={styles.deckRowText}>
                {'  '.repeat(d.level)}
                {d.name}
              </Text>
              {d.deckId === currentDeckId && <Text style={styles.deckRowCheck}>✓</Text>}
            </Pressable>
          ))}
        </ScrollView>
      )}
      <Pressable style={styles.cancel} onPress={onCancel}>
        <Text style={styles.cancelText}>Cancel</Text>
      </Pressable>
    </>
  );
}

function flatten(node: DeckNode): { deckId: number; name: string; level: number }[] {
  const out: { deckId: number; name: string; level: number }[] = [];
  const walk = (n: DeckNode) => {
    out.push({ deckId: n.deckId, name: n.name, level: n.level });
    n.children.forEach(walk);
  };
  node.children.forEach(walk);
  return out;
}

function SheetButton({
  label,
  hint,
  onPress,
  disabled,
  danger,
}: {
  label: string;
  hint?: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.sheetButton,
        disabled && styles.sheetButtonDisabled,
        pressed && styles.sheetButtonPressed,
      ]}
      onPress={onPress}
      disabled={disabled}>
      <Text style={[styles.sheetButtonLabel, danger && styles.dangerText]}>{label}</Text>
      {hint ? <Text style={styles.sheetButtonHint}>{hint}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: {
    backgroundColor: palette.surfaceElevated,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: 16,
    paddingBottom: 34,
    paddingTop: 8,
    borderColor: palette.surfaceBorder,
    borderTopWidth: 1,
    ...shadow.floating,
  },
  title: {
    color: palette.textSecondary,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    textAlign: 'center',
    paddingVertical: 10,
  },
  inlineLoad: { paddingVertical: 24, alignItems: 'center' },
  errorBody: {
    color: palette.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  sheetButton: {
    paddingVertical: 14,
    borderBottomColor: palette.surfaceBorder,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetButtonPressed: { opacity: 0.6 },
  sheetButtonDisabled: { opacity: 0.35 },
  sheetButtonLabel: { color: palette.textPrimary, fontSize: 16, fontWeight: '600' },
  sheetButtonHint: { color: palette.textSecondary, fontSize: 12, marginTop: 2 },
  dangerText: { color: palette.bad },
  cancel: {
    marginTop: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: palette.background,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
  },
  cancelText: { color: palette.goldSoft, fontSize: 16, fontWeight: '700' },
  busyBar: {
    position: 'absolute',
    top: 8,
    right: 12,
  },
  toast: {
    position: 'absolute',
    bottom: 80,
    alignSelf: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  toastText: { color: palette.goldSoft, fontSize: 14, fontWeight: '600' },
  flagGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 10 },
  flagChip: {
    borderWidth: 1.5,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 70,
    alignItems: 'center',
  },
  flagChipSelected: { borderWidth: 3, borderColor: palette.gold },
  flagChipText: { fontSize: 13, fontWeight: '700' },
  deckList: { maxHeight: 360, paddingVertical: 6 },
  deckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomColor: palette.surfaceBorder,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  deckRowCurrent: { backgroundColor: 'rgba(198,169,105,0.08)' },
  deckRowText: { color: palette.textPrimary, fontSize: 15, flex: 1 },
  deckRowCheck: { color: palette.gold, fontSize: 16, fontWeight: '700' },
});

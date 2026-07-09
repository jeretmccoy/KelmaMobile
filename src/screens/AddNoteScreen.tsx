/**
 * Add note: create a brand-new note (and its generated cards) in a deck —
 * AnkiDroid's Add screen. A notetype picker lays out one plain-text field
 * editor per notetype field (in order) plus a tags field, exactly like the
 * editor. Saving calls rslib's `add_note`, which re-renders templates,
 * generates cards, normalizes text, and stamps USN/mod like the desktop Add.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { addNote, checkNoteFields, getNotetypes, NoteFieldState, type NotetypeInfo } from '../core/KelmaCore';
import { palette } from './theme';

type Props = {
  deckId: number;
  deckName: string;
  onClose: () => void;
  /** Called after a successful add so callers can refresh. */
  onSaved?: () => void;
};

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; notetypes: NotetypeInfo[] };

export function AddNoteScreen({ deckId, deckName, onClose, onSaved }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [selectedNt, setSelectedNt] = useState<number | null>(null);
  const [fields, setFields] = useState<string[]>([]);
  const [tagsText, setTagsText] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ kind: 'loading' });
    getNotetypes()
      .then(notetypes => {
        if (notetypes.length === 0) {
          setState({
            kind: 'error',
            message: 'This collection has no note types to add with.',
          });
          return;
        }
        // Default to "Basic" if present, else the first notetype — matching
        // AnkiDroid, which remembers the last-used type per deck.
        const preferred =
          notetypes.find(nt => nt.name === 'Basic') ?? notetypes[0];
        setSelectedNt(preferred.id);
        setFields(preferred.fields.map(() => ''));
        setState({ kind: 'ready', notetypes });
      })
      .catch(error =>
        setState({
          kind: 'error',
          message:
            error instanceof Error ? error.message : 'Could not load note types.',
        }),
      );
  }, []);

  useEffect(load, [load]);

  const selectNotetype = (nt: NotetypeInfo) => {
    setSelectedNt(nt.id);
    // Resize the working field array to the new notetype, preserving any
    // text in the fields that still exist by name position is not reliable
    // across types, so AnkiDroid-style we clear on type change.
    setFields(nt.fields.map(() => ''));
  };

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1600);
  };

  const save = async (force = false) => {
    if (state.kind !== 'ready' || selectedNt === null || saving) {
      return;
    }
    setSaving(true);
    try {
      // Anki's Add screen check: warn if the first field is empty or a
      // duplicate of an existing note. This prevents the 1-card sync
      // divergence that happens when the same content is added on two
      // devices (different GUIDs -> sync keeps both -> duplicate).
      if (!force) {
        const check = await checkNoteFields(selectedNt, fields);
        if (check.state === NoteFieldState.Duplicate) {
          setSaving(false);
          Alert.alert(
            'Duplicate first field',
            'A note with this first field already exists. Adding it will create a duplicate. Add anyway?',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Add anyway', style: 'destructive', onPress: () => save(true) },
            ],
          );
          return;
        }
        if (check.state === NoteFieldState.Empty) {
          setSaving(false);
          Alert.alert('Empty first field', 'The first field is empty. Add anyway?', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Add anyway', style: 'destructive', onPress: () => save(true) },
          ]);
          return;
        }
      }
      const tags = tagsText
        .split(/\s+/)
        .map(t => t.trim())
        .filter(t => t.length > 0);
      await addNote(selectedNt, deckId, fields, tags);
      flash('Added');
      onSaved?.();
      setTimeout(onClose, 350);
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Add failed.');
    } finally {
      setSaving(false);
    }
  };

  const ready = state.kind === 'ready' ? state : null;
  const activeNt =
    ready?.notetypes.find(nt => nt.id === selectedNt) ?? null;

  return (
    <View style={styles.screen}>
      <View style={styles.topBar}>
        <Pressable onPress={onClose} accessibilityRole="button" hitSlop={12}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          Add to {deckName}
        </Text>
        <Pressable onPress={() => save()} disabled={saving} hitSlop={12}>
          <Text style={[styles.saveText, saving && styles.saveTextDisabled]}>
            {saving ? 'Adding…' : 'Add'}
          </Text>
        </Pressable>
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
          <Pressable onPress={load} style={styles.retry}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      )}

      {ready && activeNt && (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}>
          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled">
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Type</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chips}>
                {ready.notetypes.map(nt => {
                  const selected = nt.id === activeNt.id;
                  return (
                    <Pressable
                      key={nt.id}
                      onPress={() => selectNotetype(nt)}
                      style={[styles.chip, selected && styles.chipSelected]}>
                      <Text
                        style={[
                          styles.chipText,
                          selected && styles.chipTextSelected,
                        ]}>
                        {nt.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>

            {activeNt.fields.map((name, i) => (
              <View key={i} style={styles.field}>
                <Text style={styles.fieldLabel}>{name}</Text>
                <TextInput
                  style={styles.fieldInput}
                  value={fields[i] ?? ''}
                  onChangeText={text =>
                    setFields(prev => {
                      const next = [...prev];
                      next[i] = text;
                      return next;
                    })
                  }
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={`(${name})`}
                  placeholderTextColor={palette.textMuted}
                  textAlignVertical="top"
                />
              </View>
            ))}

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Tags</Text>
              <TextInput
                style={[styles.fieldInput, styles.tagsInput]}
                value={tagsText}
                onChangeText={setTagsText}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="space-separated tags"
                placeholderTextColor={palette.textMuted}
              />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {toast && (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  flex: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomColor: palette.surfaceBorder,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cancelText: { color: palette.goldSoft, fontSize: 16, fontWeight: '600' },
  title: {
    color: palette.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    flex: 1,
    marginHorizontal: 12,
    textAlign: 'center',
  },
  saveText: { color: palette.gold, fontSize: 16, fontWeight: '700' },
  saveTextDisabled: { opacity: 0.4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  scrollContent: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40, gap: 16 },
  field: { gap: 6 },
  fieldLabel: {
    color: palette.textSecondary,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fieldInput: {
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: palette.textPrimary,
    fontSize: 16,
    minHeight: 96,
  },
  tagsInput: { minHeight: 44 },
  chips: { gap: 8, paddingVertical: 2 },
  chip: {
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipSelected: { borderColor: palette.gold, backgroundColor: palette.background },
  chipText: { color: palette.textSecondary, fontSize: 14, fontWeight: '700' },
  chipTextSelected: { color: palette.goldSoft },
  errorTitle: { color: palette.bad, fontSize: 18, fontWeight: '700' },
  errorBody: { color: palette.textSecondary, fontSize: 14, textAlign: 'center', paddingHorizontal: 20 },
  retry: {
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 8,
  },
  retryText: { color: palette.goldSoft, fontSize: 14, fontWeight: '700' },
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
});

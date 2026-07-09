/**
 * Note editor: edit a card's note fields (front/back text) and tags, AnkiDroid
 * NoteEditor-style. Plain-text field editors (one per notetype field, in
 * order) plus a tags field (space-separated, Anki convention).
 *
 * Saving calls rslib's `update_notes`, which re-renders templates, regenerates
 * cards, normalizes text, and stamps USN/mod exactly like the desktop editor.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  getNoteEdit,
  updateNote,
  type NoteEdit,
} from '../core/KelmaCore';
import { palette } from './theme';

type Props = {
  cardId: number;
  onClose: () => void;
  /** Called after a successful save so callers can refresh. */
  onSaved?: () => void;
};

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; edit: NoteEdit };

export function NoteEditorScreen({ cardId, onClose, onSaved }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  // Working copies, populated once the note loads.
  const [fields, setFields] = useState<string[]>([]);
  const [tagsText, setTagsText] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ kind: 'loading' });
    getNoteEdit(cardId)
      .then(edit => {
        setState({ kind: 'ready', edit });
        setFields(edit.fields.map(f => f.value));
        setTagsText(edit.tags.join(' '));
      })
      .catch(error =>
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Could not load the note.',
        }),
      );
  }, [cardId]);

  useEffect(load, [load]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1600);
  };

  const save = async () => {
    if (state.kind !== 'ready' || saving) return;
    setSaving(true);
    try {
      const tags = tagsText
        .split(/\s+/)
        .map(t => t.trim())
        .filter(t => t.length > 0);
      await updateNote(state.edit.noteId, state.edit.notetypeId, fields, tags);
      flash('Saved');
      onSaved?.();
      // Brief delay so the toast is visible before closing.
      setTimeout(onClose, 350);
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.topBar}>
        <Pressable onPress={onClose} accessibilityRole="button" hitSlop={12}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {state.kind === 'ready' ? state.edit.notetypeName : 'Edit note'}
        </Text>
        <Pressable onPress={save} disabled={saving} hitSlop={12}>
          <Text style={[styles.saveText, saving && styles.saveTextDisabled]}>
            {saving ? 'Saving…' : 'Save'}
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

      {state.kind === 'ready' && (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}>
          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled">
            {state.edit.fields.map((field, i) => (
              <View key={i} style={styles.field}>
                <Text style={styles.fieldLabel}>{field.name}</Text>
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
                  placeholder={`(${field.name})`}
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

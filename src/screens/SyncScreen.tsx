/**
 * Anki-compatible collection and media sync.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useState } from 'react';
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
import { DEFAULT_SYNC_ENDPOINT } from '../config';
import {
  fullSync,
  syncCollection,
  syncLogin,
  syncMedia,
  type SyncAuth,
} from '../core/KelmaCore';
import { palette } from './theme';

type Props = {
  onSynced: () => void;
};

type StepState = 'pending' | 'running' | 'done' | 'error';
type SyncStep = {
  key: 'login' | 'collection' | 'media';
  label: string;
  state: StepState;
  detail: string;
};

const INITIAL_STEPS: SyncStep[] = [
  { key: 'login', label: 'Account', state: 'pending', detail: 'Waiting to sign in' },
  {
    key: 'collection',
    label: 'Collection',
    state: 'pending',
    detail: 'Cards, decks, and scheduling',
  },
  {
    key: 'media',
    label: 'Media',
    state: 'pending',
    detail: 'Images and audio files',
  },
];

export function SyncScreen({ onSynced }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [auth, setAuth] = useState<SyncAuth | null>(null);
  const [status, setStatus] = useState('Sign in to sync your collection and media.');
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<SyncStep[]>(INITIAL_STEPS);

  const updateStep = useCallback(
    (key: SyncStep['key'], state: StepState, detail?: string) => {
      setSteps(current =>
        current.map(step =>
          step.key === key
            ? { ...step, state, detail: detail ?? step.detail }
            : step,
        ),
      );
    },
    [],
  );

  const runSync = useCallback(
    async (credentials: SyncAuth) => {
      updateStep('collection', 'running', 'Contacting collection sync server…');
      setStatus('Syncing collection…');
      const outcome = await syncCollection(credentials);
      if (outcome.required === 'fullSyncRequired') {
        updateStep('collection', 'running', 'Downloading full collection…');
        setStatus('Downloading the full collection…');
        await fullSync(credentials, outcome.downloadOk ? false : true);
        updateStep('collection', 'done', 'Full collection transfer complete');
      } else {
        updateStep(
          'collection',
          'done',
          outcome.required === 'noChanges'
            ? 'No collection changes'
            : 'Collection changes applied',
        );
      }

      updateStep('media', 'running', 'Checking and transferring media…');
      setStatus('Syncing images and audio…');
      const media = await syncMedia(credentials);
      const mediaDetail = `${media.files.toLocaleString()} files · ${formatBytes(
        media.bytes,
      )}`;
      updateStep('media', 'done', mediaDetail);
      setStatus(
        media.files === 0
          ? 'Media sync completed, but the server provided no media files.'
          : `Sync complete. ${mediaDetail} available.`,
      );
      onSynced();
    },
    [onSynced, updateStep],
  );

  const sync = () => {
    setBusy(true);
    setSteps(
      INITIAL_STEPS.map(step =>
        step.key === 'login' && auth
          ? { ...step, state: 'done', detail: 'Already signed in' }
          : { ...step },
      ),
    );
    if (!auth) {
      updateStep('login', 'running', 'Signing in…');
      setStatus('Signing in…');
    }
    const credentials = auth
      ? Promise.resolve(auth)
      : syncLogin(username.trim(), password, DEFAULT_SYNC_ENDPOINT).then(nextAuth => {
          setAuth(nextAuth);
          updateStep('login', 'done', 'Signed in');
          return nextAuth;
        });

    credentials
      .then(runSync)
      .catch(error => {
        const message = error instanceof Error ? error.message : 'Sync failed.';
        const partialMedia = message.match(
          /Media sync stopped after (\d+) files \((\d+) bytes\)/,
        );
        setSteps(current =>
          current.map(step =>
            step.state === 'running'
              ? {
                  ...step,
                  state: 'error',
                  detail:
                    step.key === 'media' && partialMedia
                      ? `${Number(partialMedia[1]).toLocaleString()} files · ${formatBytes(
                          Number(partialMedia[2]),
                        )} transferred before failure`
                      : 'Failed at this step',
                }
              : step,
          ),
        );
        setStatus(message);
      })
      .finally(() => setBusy(false));
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        <Text style={styles.eyebrow}>KELMA</Text>
        <Text style={styles.title}>Sync</Text>
        <Text style={styles.intro}>
          Sync cards, scheduling data, images, and audio through Anki’s Rust
          sync protocol.
        </Text>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>KelmaSync account</Text>
          <Text style={styles.endpoint}>{DEFAULT_SYNC_ENDPOINT}</Text>

          {!auth && (
            <>
              <TextInput
                style={styles.input}
                placeholder="Username or email"
                placeholderTextColor={palette.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="username"
                value={username}
                onChangeText={setUsername}
              />
              <TextInput
                style={styles.input}
                placeholder="Password"
                placeholderTextColor={palette.textMuted}
                secureTextEntry
                textContentType="password"
                value={password}
                onChangeText={setPassword}
              />
            </>
          )}

          {auth && (
            <Text style={styles.signedIn}>Signed in for this app session.</Text>
          )}

          <View style={styles.progress}>
            {steps.map(step => (
              <View key={step.key} style={styles.progressRow}>
                <View style={styles.progressIcon}>
                  {step.state === 'running' ? (
                    <ActivityIndicator size="small" color={palette.gold} />
                  ) : (
                    <Text
                      style={[
                        styles.progressMark,
                        step.state === 'done' && styles.progressDone,
                        step.state === 'error' && styles.progressError,
                      ]}>
                      {step.state === 'done'
                        ? '✓'
                        : step.state === 'error'
                          ? '!'
                          : '•'}
                    </Text>
                  )}
                </View>
                <View style={styles.progressText}>
                  <Text style={styles.progressLabel}>{step.label}</Text>
                  <Text style={styles.progressDetail}>{step.detail}</Text>
                </View>
              </View>
            ))}
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sync collection and media"
            disabled={busy || (!auth && (!username.trim() || !password))}
            onPress={sync}
            style={({ pressed }) => [
              styles.syncButton,
              (busy || (!auth && (!username.trim() || !password))) &&
                styles.disabled,
              pressed && styles.pressed,
            ]}>
            {busy ? (
              <ActivityIndicator color={palette.background} />
            ) : (
              <Text style={styles.syncButtonText}>
                {auth ? 'Sync now' : 'Sign in & sync'}
              </Text>
            )}
          </Pressable>

          <Text accessibilityLiveRegion="polite" style={styles.status}>
            {status}
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  content: { paddingHorizontal: 24, paddingTop: 36, paddingBottom: 40 },
  eyebrow: {
    color: palette.gold,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 3.2,
    marginBottom: 10,
  },
  title: {
    color: palette.textPrimary,
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -1,
  },
  intro: {
    color: palette.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
    marginBottom: 24,
  },
  card: {
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 18,
    padding: 20,
  },
  sectionTitle: { color: palette.textPrimary, fontSize: 18, fontWeight: '700' },
  endpoint: {
    color: palette.textMuted,
    fontSize: 12,
    marginTop: 4,
    marginBottom: 18,
  },
  input: {
    backgroundColor: palette.background,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 10,
    color: palette.textPrimary,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  signedIn: {
    color: palette.good,
    fontSize: 14,
    marginBottom: 10,
  },
  progress: {
    borderTopColor: palette.surfaceBorder,
    borderTopWidth: 1,
    marginTop: 2,
    marginBottom: 14,
    paddingTop: 8,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 50,
  },
  progressIcon: { width: 32, alignItems: 'flex-start' },
  progressMark: { color: palette.textMuted, fontSize: 20, fontWeight: '800' },
  progressDone: { color: palette.good },
  progressError: { color: palette.bad },
  progressText: { flex: 1 },
  progressLabel: {
    color: palette.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  progressDetail: { color: palette.textMuted, fontSize: 12, marginTop: 2 },
  syncButton: {
    minHeight: 50,
    backgroundColor: palette.goldSoft,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.75 },
  syncButtonText: {
    color: palette.background,
    fontSize: 15,
    fontWeight: '800',
  },
  status: {
    color: palette.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 14,
    textAlign: 'center',
  },
});

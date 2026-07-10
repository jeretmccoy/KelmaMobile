/**
 * Anki-compatible collection and media sync.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { DEFAULT_SYNC_ENDPOINT, KELMA_SIGNUP_URL } from '../config';
import {
  acceptServerNote,
  diffDeckNotes,
  diffManifests,
  fullSyncMonitored,
  generateNoteGuid,
  getLocalManifest,
  getLocalNoteDetail,
  getServerManifest,
  getServerNoteDetail,
  resetMedia,
  syncCollection,
  syncLogin,
  syncMediaMonitored,
  writeServerNote,
  type DeckDiff,
  type FullSyncProgress,
  type Manifest,
  type NoteDiff,
  type SyncAuth,
} from '../core/KelmaCore';
import { headerStyles, palette, radius, shadow } from './theme';

type Props = {
  onSynced: () => void;
  /** Called once after a successful sign-in, so credentials can be persisted
   *  for the home Sync button. */
  onSignedIn: (auth: SyncAuth) => void;
  /** Credentials already persisted for this profile (loaded by the app shell
   *  from the collection config). When present the screen starts signed-in and
   *  shows "Sync now" instead of re-prompting for a login the user already did. */
  initialAuth?: SyncAuth | null;
  /** Forget the persisted credentials (sign out), so the login form returns —
   *  used both by the explicit "Sign out" control and automatically when the
   *  server rejects the stored key. */
  onSignedOut: () => void;
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

type LogLevel = 'info' | 'ok' | 'error';
type LogEntry = { id: number; ts: number; text: string; level: LogLevel };

export function SyncScreen({ onSynced, onSignedIn, initialAuth, onSignedOut }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [auth, setAuth] = useState<SyncAuth | null>(initialAuth ?? null);
  const [status, setStatus] = useState('Sign in to sync your collection and media.');
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<SyncStep[]>(INITIAL_STEPS);

  // Monitoring: a timestamped event log + a live elapsed clock so a long
  // transfer visibly makes progress instead of looking frozen.
  const [log, setLog] = useState<LogEntry[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const logId = useRef(0);

  const pushLog = useCallback((text: string, level: LogLevel = 'info') => {
    setLog(current => [...current, { id: logId.current++, ts: Date.now(), text, level }]);
  }, []);

  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [busy]);

  // The app shell loads persisted credentials asynchronously (after the
  // collection opens), so they can arrive after this screen has mounted with a
  // null `auth`. Adopt them once — without clobbering a sign-in done here — so
  // the user is never asked to log in again for a session they already have.
  useEffect(() => {
    if (initialAuth) setAuth(prev => prev ?? initialAuth);
  }, [initialAuth]);
  const elapsedSec = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;

  // Client-side gate for the submit button when not already signed in.
  const credsIncomplete = !email.trim() || !password;

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

  // The collection + media transfer, with per-phase logging. When
  // `forceFullDownload` is set, we skip the incremental path and pull the whole
  // collection from the server, replacing local (the "reset from server" flow).
  const performSync = useCallback(
    async (credentials: SyncAuth, forceFullDownload: boolean) => {
      const t0 = Date.now();

      // Live byte progress for a full collection transfer.
      let lastFullLog = 0;
      const onFull = (label: string) => (p: FullSyncProgress) => {
        if (p.retrying) {
          updateStep('collection', 'running', `Connection dropped — retrying (try ${p.retrying + 1})…`);
          setStatus(`Collection connection dropped — retrying (attempt ${p.retrying + 1})…`);
          pushLog(`Connection dropped — retrying collection (attempt ${p.retrying + 1})…`, 'error');
          lastFullLog = 0;
          return;
        }
        const detail =
          p.totalBytes > 0
            ? `${formatBytes(p.transferredBytes)} / ${formatBytes(p.totalBytes)}`
            : formatBytes(p.transferredBytes);
        updateStep('collection', 'running', `${label} ${detail}`);
        setStatus(`${label} ${detail}`);
        if (p.transferredBytes - lastFullLog >= 2 * 1024 * 1024) {
          lastFullLog = p.transferredBytes;
          pushLog(`Collection ${label} ${detail}`);
        }
      };

      // --- collection ---
      if (forceFullDownload) {
        updateStep('collection', 'running', 'Downloading full collection from server…');
        setStatus('Downloading the full collection…');
        pushLog('Replacing local collection with the server copy…');
        await fullSyncMonitored(credentials, false, onFull('Downloading collection…'));
        updateStep('collection', 'done', 'Full collection downloaded from server');
        pushLog('Full collection downloaded.', 'ok');
        // A true reset: clear local media so the media phase DOWNLOADS the
        // server's copy instead of pushing this device's files back up.
        try {
          pushLog('Clearing local media to download the server copy…');
          await resetMedia();
          pushLog('Local media cleared.', 'ok');
        } catch {
          pushLog(
            'Could not clear local media — rebuild the app so reset downloads instead of uploads.',
            'error',
          );
        }
      } else {
        updateStep('collection', 'running', 'Checking collection changes…');
        setStatus('Syncing collection…');
        pushLog('Checking collection changes…');
        const outcome = await syncCollection(credentials);
        pushLog(`Server says: ${outcome.required}.`);
        if (outcome.required === 'fullSyncRequired') {
          // A full sync REPLACES one side wholesale — never pick a direction
          // silently, or a just-made local change (e.g. a review) gets wiped by
          // the server's copy. Ask; the safe choice keeps this device's work.
          const choice = await promptFullSyncDirection(outcome.uploadOk, outcome.downloadOk);
          if (choice === 'cancel') {
            updateStep('collection', 'done', 'Full sync needed — not run');
            setStatus('Full sync needed — choose Upload or Download to continue. Nothing was changed.');
            pushLog('Full sync required; cancelled — collection and media left untouched.', 'error');
            return;
          }
          const upload = choice === 'upload';
          const label = upload ? 'Uploading collection…' : 'Downloading collection…';
          updateStep('collection', 'running', label);
          setStatus(upload ? 'Uploading the full collection…' : 'Downloading the full collection…');
          pushLog(
            upload
              ? 'Full sync — uploading this device to the server…'
              : 'Full sync — replacing this device with the server copy…',
          );
          await fullSyncMonitored(credentials, upload, onFull(label));
          // If we replaced local with the server copy, clear local media so the
          // media phase downloads the server's files instead of re-uploading.
          if (!upload) {
            try {
              await resetMedia();
            } catch {
              pushLog('Could not clear local media after download.', 'error');
            }
          }
          updateStep('collection', 'done', 'Full collection transfer complete');
          pushLog('Full collection transfer complete.', 'ok');
        } else {
          const msg =
            outcome.required === 'noChanges'
              ? 'No collection changes'
              : 'Collection changes applied';
          updateStep('collection', 'done', msg);
          pushLog(`${msg}.`, 'ok');
        }
      }

      // --- media (live progress: runs on a background thread, polled here) ---
      updateStep('media', 'running', 'Checking media…');
      setStatus('Syncing images and audio…');
      pushLog('Syncing media (images & audio)…');
      let lastLoggedFiles = 0;
      const media = await syncMediaMonitored(credentials, p => {
        if (p.retrying) {
          updateStep('media', 'running', `Connection dropped — resuming (try ${p.retrying + 1})…`);
          setStatus(`Media connection dropped — resuming (attempt ${p.retrying + 1})…`);
          pushLog(`Connection dropped — resuming media sync (attempt ${p.retrying + 1})…`, 'error');
          lastLoggedFiles = 0;
          return;
        }
        const moved = Math.max(p.downloadedFiles, p.uploadedFiles);
        const detail = `↓ ${p.downloadedFiles.toLocaleString()} · ↑ ${p.uploadedFiles.toLocaleString()} · ${p.checked.toLocaleString()} checked`;
        updateStep('media', 'running', detail);
        setStatus(`Syncing media… ${moved.toLocaleString()} files transferred`);
        // Log a milestone every 200 files so the log stays useful, not spammy.
        if (moved - lastLoggedFiles >= 200) {
          lastLoggedFiles = moved;
          pushLog(`Media: ↓${p.downloadedFiles.toLocaleString()} ↑${p.uploadedFiles.toLocaleString()} transferred…`);
        }
      });
      const mediaDetail = `${media.files.toLocaleString()} files · ${formatBytes(media.bytes)}`;
      updateStep('media', 'done', mediaDetail);
      pushLog(`Media complete: ${mediaDetail}.`, 'ok');

      const secs = Math.round((Date.now() - t0) / 1000);
      setStatus(`Sync complete in ${secs}s — ${mediaDetail}.`);
      pushLog(`Done in ${secs}s.`, 'ok');
      onSynced();
    },
    [onSynced, updateStep, pushLog],
  );

  // Forget the stored credentials and return to the login form. Used by the
  // explicit control and automatically when the server rejects the stored key.
  const signOut = useCallback(() => {
    setAuth(null);
    setEmail('');
    setPassword('');
    onSignedOut();
  }, [onSignedOut]);

  const start = useCallback(
    (forceFullDownload: boolean) => {
      setBusy(true);
      setStartedAt(Date.now());
      setNow(Date.now());
      setLog([]);
      setSteps(
        INITIAL_STEPS.map(step =>
          step.key === 'login' && auth
            ? { ...step, state: 'done', detail: 'Signed in' }
            : { ...step },
        ),
      );
      pushLog(
        forceFullDownload
          ? 'Reset & download from server started.'
          : 'Sync started.',
      );

      const credentials = auth
        ? Promise.resolve(auth)
        : (updateStep('login', 'running', 'Signing in…'),
          setStatus('Signing in…'),
          pushLog('Signing in…'),
          syncLogin(email.trim(), password, DEFAULT_SYNC_ENDPOINT).then(nextAuth => {
            setAuth(nextAuth);
            onSignedIn(nextAuth);
            updateStep('login', 'done', 'Signed in');
            pushLog('Signed in.', 'ok');
            return nextAuth;
          }));

      credentials
        .then(creds => performSync(creds, forceFullDownload))
        .catch(error => {
          const message = error instanceof Error ? error.message : String(error);
          setSteps(current =>
            current.map(step =>
              step.state === 'running'
                ? { ...step, state: 'error', detail: 'Failed — see log' }
                : step,
            ),
          );
          // A rejected host key (server 403) means the stored session is no
          // longer valid — forget it and drop back to the login form so the user
          // can re-authenticate, instead of being stuck "signed in" with a key
          // the server won't accept.
          if (/\b403\b|forbidden|invalid host key|host key/i.test(message)) {
            setStatus('Your sync session expired — please sign in again.');
            pushLog('Session rejected by server (403). Signing out.', 'error');
            signOut();
          } else {
            setStatus(`Failed: ${message}`);
            pushLog(message, 'error');
          }
        })
        .finally(() => setBusy(false));
    },
    [auth, email, password, onSignedIn, performSync, pushLog, signOut, updateStep],
  );

  const sync = () => start(false);

  // --- Compare: fetch both manifests and show the user what differs -------
  const [comparing, setComparing] = useState(false);
  const [diffs, setDiffs] = useState<DeckDiff[] | null>(null);
  const [compareManifests, setCompareManifests] = useState<{ local: Manifest; server: Manifest } | null>(null);
  const [expandedDeck, setExpandedDeck] = useState<string | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);

  const compareWithServer = useCallback(async () => {
    if (!auth) return;
    setComparing(true);
    setCompareError(null);
    setDiffs(null);
    setCompareManifests(null);
    setExpandedDeck(null);
    try {
      const [local, server] = await Promise.all([
        getLocalManifest(),
        getServerManifest(auth),
      ]);
      setCompareManifests({ local, server });
      setDiffs(diffManifests(local, server));
    } catch (e) {
      setCompareError(e instanceof Error ? e.message : String(e));
    } finally {
      setComparing(false);
    }
  }, [auth]);

  // Per-note resolution actions. `resolving` holds the note key currently in
  // flight so we can disable its buttons and show progress.
  const [resolving, setResolving] = useState<string | null>(null);

  const resolveNote = useCallback(
    async (n: NoteDiff, action: 'accept' | 'force' | 'guid') => {
      if (!auth) return;
      const key = `${n.guid}:${n.local?.nid ?? 'x'}:${n.server?.nid ?? 'x'}`;
      setResolving(key);
      try {
        if (action === 'guid') {
          const nid = n.local?.nid;
          if (!nid) throw new Error('no local note');
          await generateNoteGuid(nid);
        } else if (action === 'accept') {
          const nid = n.local?.nid;
          const serverNid = n.server?.nid ?? 0;
          if (!nid) throw new Error('no local note to overwrite');
          const detail = await getServerNoteDetail(auth, serverNid, n.guid);
          if (!detail) throw new Error('server note not found');
          await acceptServerNote(nid, detail);
        } else {
          const nid = n.local?.nid;
          if (!nid) throw new Error('no local note to push');
          const detail = await getLocalNoteDetail(nid, n.guid);
          if (!detail) throw new Error('local note not found');
          if (!detail.guid) {
            throw new Error('empty GUID — generate one first');
          }
          await writeServerNote(auth, detail);
        }
        // Refresh the compare so the resolved note drops out of the diff.
        await compareWithServer();
      } catch (e) {
        Alert.alert('Resolve failed', e instanceof Error ? e.message : String(e));
      } finally {
        setResolving(null);
      }
    },
    [auth, compareWithServer],
  );

  const statusLabel: Record<DeckDiff['status'], string> = {
    'in-sync': '✓ in sync',
    'local-newer': '↑ local newer',
    'server-newer': '↓ server newer',
    'server-only': '↓ server only',
    'local-only': '↑ local only',
    'conflict': '⚠ conflict',
  };
  const statusColor: Record<DeckDiff['status'], string> = {
    'in-sync': palette.good,
    'local-newer': palette.gold,
    'server-newer': palette.gold,
    'server-only': palette.textSecondary,
    'local-only': palette.textSecondary,
    'conflict': palette.bad,
  };
  const noteStatusLabel: Record<NoteDiff['status'], string> = {
    'in-sync': '✓ in sync',
    conflict: '⚠ conflict',
    'card-count': 'cards differ',
    'local-newer': '↑ local newer',
    'server-newer': '↓ server newer',
    'local-only': '↑ local only',
    'server-only': '↓ server only',
    'local-extra': '↑ extra local duplicate',
    'server-extra': '↓ extra server duplicate',
  };
  const noteStatusColor: Record<NoteDiff['status'], string> = {
    'in-sync': palette.good,
    conflict: palette.bad,
    'card-count': palette.gold,
    'local-newer': palette.gold,
    'server-newer': palette.gold,
    'local-only': palette.textSecondary,
    'server-only': palette.textSecondary,
    'local-extra': palette.textSecondary,
    'server-extra': palette.textSecondary,
  };

  const resetFromServer = () => {
    Alert.alert(
      'Reset & download from server?',
      'This discards local changes on this device and replaces your collection with the copy on the server, then re-checks media. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset & download',
          style: 'destructive',
          onPress: () => start(true),
        },
      ],
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        <View style={[headerStyles.titleRow, styles.titleRow]}>
          <View style={headerStyles.accentTall} />
          <Text style={styles.title}>Sync</Text>
        </View>
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
                placeholder="Email"
                placeholderTextColor={palette.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="username"
                value={email}
                onChangeText={setEmail}
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
              <Pressable
                accessibilityRole="link"
                onPress={() => Linking.openURL(KELMA_SIGNUP_URL)}
                hitSlop={8}>
                <Text style={styles.signupLink}>
                  No account? Create one on Kelma Immersion ›
                </Text>
              </Pressable>
            </>
          )}

          {auth && (
            <View style={styles.signedInRow}>
              <Text style={styles.signedIn}>Signed in.</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Sign out"
                onPress={signOut}
                disabled={busy}
                hitSlop={8}>
                <Text style={[styles.signOutLink, busy && styles.disabled]}>Sign out</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.progress}>
            {steps.map(step => (
              <View key={step.key} style={styles.progressRow}>
                <View style={styles.progressIcon}>
                  {step.state === 'running' ? (
                    <ActivityIndicator size="small" color={palette.gold} />
                  ) : step.state === 'pending' ? (
                    <View style={styles.progressPending} />
                  ) : (
                    <Text
                      style={[
                        styles.progressMark,
                        step.state === 'done' && styles.progressDone,
                        step.state === 'error' && styles.progressError,
                      ]}>
                      {step.state === 'done' ? '✓' : '!'}
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

          {/* Compare: show the server's state before committing to a sync. */}
          {auth && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Compare local with server"
              disabled={busy || comparing}
              onPress={compareWithServer}
              style={({ pressed }) => [
                styles.compareButton,
                (busy || comparing) && styles.disabled,
                pressed && styles.pressed,
              ]}>
              {comparing ? (
                <ActivityIndicator size="small" color={palette.textPrimary} />
              ) : (
                <Text style={styles.compareButtonText}>Compare with server</Text>
              )}
            </Pressable>
          )}

          {compareError && (
            <Text style={styles.compareError}>Compare failed: {compareError}</Text>
          )}

          {diffs && (
            <View style={styles.diffPanel}>
              <Text style={styles.diffTitle}>
                {diffs.filter(d => d.status !== 'in-sync').length} different ·{' '}
                {diffs.filter(d => d.status === 'in-sync').length} in sync
              </Text>
              <ScrollView style={styles.diffScroll} nestedScrollEnabled>
                {diffs.filter(d => d.status !== 'in-sync').map(d => {
                  const noteDiffs = compareManifests && d.status === 'conflict'
                    ? diffDeckNotes(compareManifests.local, compareManifests.server, d)
                    : [];
                  const visibleNotes = noteDiffs.filter(n => n.status !== 'in-sync');
                  const expanded = expandedDeck === d.deck.name;
                  return (
                    <View key={d.deck.name}>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setExpandedDeck(expanded ? null : d.deck.name)}
                        style={({ pressed }) => [styles.diffRow, pressed && styles.pressed]}>
                        <Text style={styles.diffDeckName} numberOfLines={1}>
                          {d.deck.name}
                        </Text>
                        <Text
                          style={[
                            styles.diffStatus,
                            { color: statusColor[d.status] },
                          ]}>
                          {statusLabel[d.status]}{visibleNotes.length ? ` · ${visibleNotes.length}` : ''}
                        </Text>
                      </Pressable>
                      {expanded && d.status === 'conflict' && (
                        <View style={styles.noteDiffPanel}>
                          {visibleNotes.length === 0 ? (
                            <Text style={styles.noteDiffEmpty}>No note-level differences found.</Text>
                          ) : visibleNotes.map((n, index) => (
                            <View key={`${n.guid || 'empty'}:${n.local?.nid ?? 'x'}:${n.server?.nid ?? 'x'}:${index}`} style={styles.noteDiffRow}>
                              <Text style={styles.notePreview} numberOfLines={2}>{n.preview}</Text>
                              <Text style={[styles.noteStatus, { color: noteStatusColor[n.status] }]}>
                                {noteStatusLabel[n.status]}
                              </Text>
                              <Text style={styles.noteMeta}>
                                local cards {n.local?.cards_per_deck?.reduce((a, b) => a + b, 0) ?? 0} · server cards {n.server?.cards_per_deck?.reduce((a, b) => a + b, 0) ?? 0}
                                {n.guid === '' ? ' · empty GUID' : ''}
                              </Text>
                              {(() => {
                                const key = `${n.guid}:${n.local?.nid ?? 'x'}:${n.server?.nid ?? 'x'}`;
                                const busyNote = resolving === key;
                                const disabled = resolving != null;
                                return (
                                  <View style={styles.noteActions}>
                                    {n.guid === '' && n.local?.nid ? (
                                      <Pressable
                                        accessibilityRole="button"
                                        disabled={disabled}
                                        onPress={() => resolveNote(n, 'guid')}
                                        style={({ pressed }) => [styles.noteActionBtn, pressed && styles.pressed, disabled && styles.disabled]}>
                                        <Text style={styles.noteActionText}>{busyNote ? '…' : 'Generate GUID'}</Text>
                                      </Pressable>
                                    ) : null}
                                    {n.server?.nid && n.local?.nid ? (
                                      <Pressable
                                        accessibilityRole="button"
                                        disabled={disabled}
                                        onPress={() => resolveNote(n, 'accept')}
                                        style={({ pressed }) => [styles.noteActionBtn, pressed && styles.pressed, disabled && styles.disabled]}>
                                        <Text style={styles.noteActionText}>{busyNote ? '…' : '↓ Accept server'}</Text>
                                      </Pressable>
                                    ) : null}
                                    {n.local?.nid && n.guid !== '' ? (
                                      <Pressable
                                        accessibilityRole="button"
                                        disabled={disabled}
                                        onPress={() => resolveNote(n, 'force')}
                                        style={({ pressed }) => [styles.noteActionBtn, styles.noteActionBtnPush, pressed && styles.pressed, disabled && styles.disabled]}>
                                        <Text style={styles.noteActionText}>{busyNote ? '…' : '↑ Force local'}</Text>
                                      </Pressable>
                                    ) : null}
                                  </View>
                                );
                              })()}
                            </View>
                          ))}
                        </View>
                      )}
                    </View>
                  );
                })}
                {diffs.every(d => d.status === 'in-sync') && (
                  <Text style={styles.diffAllMatching}>
                    Everything matches the server.
                  </Text>
                )}
              </ScrollView>
              <Text style={styles.diffHint}>
                Syncing applies newest-wins per note. The diff above shows what
                will change.
              </Text>
            </View>
          )}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sync collection and media"
            disabled={busy || (!auth && credsIncomplete)}
            onPress={sync}
            style={({ pressed }) => [
              styles.syncButton,
              (busy || (!auth && credsIncomplete)) && styles.disabled,
              pressed && styles.pressed,
            ]}>
            {busy ? (
              <View style={styles.busyRow}>
                <ActivityIndicator color={palette.background} />
                <Text style={styles.busyText}>{elapsedSec}s</Text>
              </View>
            ) : (
              <Text style={styles.syncButtonText}>
                {auth ? 'Sync now' : 'Sign in & sync'}
              </Text>
            )}
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset and download from server"
            disabled={busy || (!auth && credsIncomplete)}
            onPress={resetFromServer}
            style={({ pressed }) => [
              styles.resetButton,
              (busy || (!auth && credsIncomplete)) && styles.disabled,
              pressed && styles.pressed,
            ]}>
            <Text style={styles.resetButtonText}>Reset &amp; download from server</Text>
          </Pressable>
          <Text style={styles.resetHint}>
            Discards local changes and replaces this device’s collection with the
            server copy.
          </Text>

          <Text accessibilityLiveRegion="polite" style={styles.status}>
            {status}
          </Text>

          {log.length > 0 && (
            <View style={styles.logPanel}>
              <View style={styles.logHeader}>
                <Text style={styles.logTitle}>Sync log</Text>
                {busy && <Text style={styles.logElapsed}>{elapsedSec}s</Text>}
              </View>
              <ScrollView style={styles.logScroll} nestedScrollEnabled>
                {log.map(entry => (
                  <Text key={entry.id} style={styles.logLine}>
                    <Text style={styles.logTime}>{formatClock(entry.ts)} </Text>
                    <Text
                      style={
                        entry.level === 'error'
                          ? styles.logError
                          : entry.level === 'ok'
                            ? styles.logOk
                            : styles.logInfo
                      }>
                      {entry.text}
                    </Text>
                  </Text>
                ))}
              </ScrollView>
            </View>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

type FullSyncChoice = 'upload' | 'download' | 'cancel';

// When the server can't merge (schema diverged), one side's changes are kept and
// the other discarded. Make the user choose — silently downloading here is what
// wiped freshly-reviewed cards back to "new".
function promptFullSyncDirection(
  uploadOk: boolean,
  downloadOk: boolean,
): Promise<FullSyncChoice> {
  return new Promise(resolve => {
    const buttons: Parameters<typeof Alert.alert>[2] = [];
    if (uploadOk) {
      buttons.push({ text: 'Upload — keep this device', onPress: () => resolve('upload') });
    }
    if (downloadOk) {
      buttons.push({
        text: 'Download — replace this device',
        style: 'destructive',
        onPress: () => resolve('download'),
      });
    }
    buttons.push({ text: 'Cancel', style: 'cancel', onPress: () => resolve('cancel') });
    Alert.alert(
      'Full sync required',
      'This device and the server have diverged and can’t be merged automatically. ' +
        'One side is kept and the other discarded:\n\n' +
        '• Upload keeps THIS device (including your latest reviews) and overwrites the server.\n' +
        '• Download replaces THIS device with the server’s copy.',
      buttons,
      { cancelable: true, onDismiss: () => resolve('cancel') },
    );
  });
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
  titleRow: {},
  title: {
    color: palette.textPrimary,
    fontSize: 38,
    fontWeight: '800',
    letterSpacing: -1.2,
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
    borderRadius: radius.lg,
    padding: 20,
    ...shadow.card,
  },
  sectionTitle: { color: palette.textPrimary, fontSize: 18, fontWeight: '700' },
  endpoint: {
    color: palette.textMuted,
    fontSize: 12,
    marginTop: 4,
    marginBottom: 18,
  },
  signupLink: {
    color: palette.gold,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 2,
    marginBottom: 6,
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
  signedInRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  signedIn: {
    color: palette.good,
    fontSize: 14,
  },
  signOutLink: {
    color: palette.textMuted,
    fontSize: 13,
    fontWeight: '600',
    textDecorationLine: 'underline',
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
  progressPending: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: palette.surfaceBorder,
  },
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
    minHeight: 52,
    backgroundColor: palette.gold,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    ...shadow.card,
  },
  compareButton: {
    minHeight: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.surfaceBorder,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  compareButtonText: {
    color: palette.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  compareError: {
    color: palette.bad,
    fontSize: 12,
    marginTop: 6,
    textAlign: 'center',
  },
  diffPanel: {
    marginTop: 10,
    borderTopColor: palette.surfaceBorder,
    borderTopWidth: 1,
    paddingTop: 10,
  },
  diffTitle: {
    color: palette.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  diffScroll: {
    maxHeight: 200,
    backgroundColor: palette.background,
    borderRadius: 8,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    padding: 10,
  },
  diffRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 3,
  },
  diffDeckName: {
    color: palette.textPrimary,
    fontSize: 13,
    flex: 1,
    marginRight: 8,
  },
  diffStatus: {
    fontSize: 12,
    fontWeight: '600',
  },
  noteDiffPanel: {
    marginLeft: 8,
    marginBottom: 6,
    borderLeftColor: palette.surfaceBorder,
    borderLeftWidth: 2,
    paddingLeft: 8,
    gap: 6,
  },
  noteDiffRow: {
    borderBottomColor: palette.surfaceBorder,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
  },
  notePreview: {
    color: palette.textPrimary,
    fontSize: 12,
    lineHeight: 16,
  },
  noteStatus: {
    fontSize: 11,
    fontWeight: '700',
    marginTop: 2,
  },
  noteMeta: {
    color: palette.textMuted,
    fontSize: 10,
    marginTop: 2,
  },
  noteActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  noteActionBtn: {
    borderWidth: 1,
    borderColor: palette.surfaceBorder,
    borderRadius: radius.sm,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  noteActionBtnPush: {
    borderColor: palette.gold,
  },
  noteActionText: {
    color: palette.textPrimary,
    fontSize: 11,
    fontWeight: '600',
  },
  noteDiffEmpty: {
    color: palette.textMuted,
    fontSize: 12,
    paddingVertical: 6,
  },
  diffAllMatching: {
    color: palette.good,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 6,
  },
  diffHint: {
    color: palette.textMuted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 6,
  },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.75 },
  syncButtonText: {
    color: palette.background,
    fontSize: 15,
    fontWeight: '800',
  },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  busyText: { color: palette.background, fontSize: 14, fontWeight: '700' },
  resetButton: {
    minHeight: 46,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.bad,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  resetButtonText: { color: palette.bad, fontSize: 14, fontWeight: '700' },
  resetHint: {
    color: palette.textMuted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 6,
  },
  status: {
    color: palette.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 14,
    textAlign: 'center',
  },
  logPanel: {
    marginTop: 14,
    borderTopColor: palette.surfaceBorder,
    borderTopWidth: 1,
    paddingTop: 10,
  },
  logHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  logTitle: {
    color: palette.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  logElapsed: { color: palette.gold, fontSize: 12, fontWeight: '700' },
  logScroll: {
    maxHeight: 180,
    backgroundColor: palette.background,
    borderRadius: 8,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    padding: 10,
  },
  logLine: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: 1,
  },
  logTime: { color: palette.textMuted },
  logInfo: { color: palette.textSecondary },
  logOk: { color: palette.good },
  logError: { color: palette.bad },
});

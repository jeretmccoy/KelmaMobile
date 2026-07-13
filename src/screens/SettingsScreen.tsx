/**
 * User-facing Kelma preferences.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { MOBILE_APP_VERSION, SYNC_CLIENT_VERSION } from '../config';
import { getSyncDebug, type SyncDebug } from '../core/KelmaCore';
import { availableMobileUpdate } from '../update';
import { headerStyles, palette, radius, shadow, spacing } from './theme';

type Props = {
  autoplayAudio: boolean;
  onAutoplayAudioChange: (enabled: boolean) => void;
};

export function SettingsScreen({
  autoplayAudio,
  onAutoplayAudioChange,
}: Props) {
  const [debug, setDebug] = useState<SyncDebug | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  const loadDebug = () => {
    getSyncDebug()
      .then(setDebug)
      .catch(() => setDebug(null));
  };

  useEffect(loadDebug, []);

  const checkForUpdate = () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    availableMobileUpdate()
      .then(update => {
        if (!update) {
          Alert.alert('Kelma Mobile is up to date', `Version ${MOBILE_APP_VERSION} is installed.`);
          return;
        }
        Alert.alert(
          `Kelma Mobile ${update.version} is available`,
          'AltStore performs iOS updates. Open the Kelma AltStore page now?',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open update page', onPress: () => Linking.openURL(update.notesUrl) },
          ],
        );
      })
      .catch(error =>
        Alert.alert(
          'Could not check for updates',
          error instanceof Error ? error.message : String(error),
        ),
      )
      .finally(() => setCheckingUpdate(false));
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      alwaysBounceVertical>
      <View style={[headerStyles.titleRow, styles.titleRow]}>
        <View style={headerStyles.accentTall} />
        <Text style={styles.title}>Settings</Text>
      </View>

      <Text style={styles.sectionLabel}>Reviewing</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>Automatically play audio</Text>
            <Text style={styles.rowDescription}>
              Play the first sound on each card side, like AnkiDroid.
            </Text>
          </View>
          <Switch
            accessibilityLabel="Automatically play audio"
            value={autoplayAudio}
            onValueChange={onAutoplayAudioChange}
            trackColor={{ false: palette.surfaceBorder, true: palette.gold }}
            thumbColor={palette.textPrimary}
          />
        </View>
      </View>

      <Text style={styles.sectionLabel}>Sync</Text>
      <View style={styles.card}>
        <Text style={styles.rowTitle}>Anki-compatible Rust core</Text>
        <Text style={styles.rowDescription}>
          Collection and media sync use the pinned Anki rslib implementation.
        </Text>
      </View>

      <Text style={styles.sectionLabel}>Sync diagnostics</Text>
      <View style={styles.card}>
        <Pressable onPress={loadDebug} style={styles.refreshRow}>
          <Text style={styles.rowTitle}>Collection sync state</Text>
          <Text style={styles.refreshText}>Refresh</Text>
        </Pressable>
        {debug ? (
          <View style={styles.debugBox}>
            <DebugRow label="col.mod (last change)" value={debug.col.mod} />
            <DebugRow label="col.scm (schema)" value={debug.col.scm} />
            <DebugRow label="col.ls (last sync)" value={debug.col.ls} />
            <DebugRow label="col.usn" value={debug.col.usn} />
            <View style={styles.debugSep} />
            <DebugRow label="pending cards (usn=-1)" value={debug.pendingCards} />
            <DebugRow label="pending notes (usn=-1)" value={debug.pendingNotes} />
            <DebugRow label="pending revlogs (usn=-1)" value={debug.pendingRevlogs} />
            <DebugRow label="pending graves" value={debug.pendingGraves} />
            <View style={styles.debugSep} />
            <DebugRow label="total cards" value={debug.totalCards} />
            <DebugRow label="total revlogs" value={debug.totalRevlogs} />
          </View>
        ) : (
          <Text style={styles.rowDescription}>Tap refresh to load.</Text>
        )}
        <Text style={styles.debugHelp}>
          If pending cards/revlogs stay &gt;0 after a sync, local reviews are
          not being uploaded. If col.ls does not advance after a sync, the
          server did not acknowledge the upload.
        </Text>
      </View>

      <Text style={styles.sectionLabel}>About</Text>
      <View style={styles.card}>
        <Text style={styles.rowTitle}>Kelma Mobile {MOBILE_APP_VERSION}</Text>
        <Text style={styles.rowDescription}>{SYNC_CLIENT_VERSION}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Check for Kelma Mobile updates"
          disabled={checkingUpdate}
          onPress={checkForUpdate}
          style={({ pressed }) => [
            styles.updateButton,
            pressed && styles.updatePressed,
          ]}>
          <Text style={styles.updateText}>
            {checkingUpdate ? 'Checking…' : 'Check for updates'}
          </Text>
        </Pressable>
        <Text style={styles.license}>AGPL-3.0-or-later</Text>
      </View>
    </ScrollView>
  );
}

function DebugRow({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.debugRow}>
      <Text style={styles.debugLabel}>{label}</Text>
      <Text style={styles.debugValue}>{value.toLocaleString()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  content: { paddingHorizontal: 24, paddingTop: 36, paddingBottom: 40 },
  titleRow: { marginBottom: 28 },
  title: {
    color: palette.textPrimary,
    fontSize: 38,
    fontWeight: '800',
    letterSpacing: -1.2,
  },
  sectionLabel: {
    color: palette.textSecondary,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.2,
    marginTop: 18,
    marginBottom: 8,
  },
  card: {
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg + 2,
    ...shadow.card,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  rowText: { flex: 1 },
  rowTitle: { color: palette.textPrimary, fontSize: 16, fontWeight: '700' },
  rowDescription: {
    color: palette.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 5,
  },
  license: { color: palette.goldSoft, fontSize: 13, marginTop: 12 },
  updateButton: {
    alignSelf: 'flex-start',
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: radius.md,
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  updatePressed: { opacity: 0.7 },
  updateText: { color: palette.textPrimary, fontSize: 13, fontWeight: '700' },
  refreshRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  refreshText: { color: palette.goldSoft, fontSize: 13, fontWeight: '700' },
  debugBox: { marginTop: 4 },
  debugRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  debugLabel: { color: palette.textSecondary, fontSize: 13 },
  debugValue: { color: palette.textPrimary, fontSize: 13, fontWeight: '700' },
  debugSep: {
    height: 1,
    backgroundColor: palette.surfaceBorder,
    marginVertical: 6,
  },
  debugHelp: {
    color: palette.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 12,
  },
});

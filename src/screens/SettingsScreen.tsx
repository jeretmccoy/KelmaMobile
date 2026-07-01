/**
 * User-facing Kelma preferences.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SYNC_CLIENT_VERSION } from '../config';
import { getSyncDebug, type SyncDebug } from '../core/KelmaCore';
import { palette } from './theme';

type Props = {
  autoplayAudio: boolean;
  onAutoplayAudioChange: (enabled: boolean) => void;
};

export function SettingsScreen({
  autoplayAudio,
  onAutoplayAudioChange,
}: Props) {
  const [debug, setDebug] = useState<SyncDebug | null>(null);

  const loadDebug = () => {
    getSyncDebug()
      .then(setDebug)
      .catch(() => setDebug(null));
  };

  useEffect(loadDebug, []);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      alwaysBounceVertical>
      <Text style={styles.eyebrow}>KELMA</Text>
      <Text style={styles.title}>Settings</Text>

      <Text style={styles.sectionLabel}>REVIEWING</Text>
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

      <Text style={styles.sectionLabel}>SYNC</Text>
      <View style={styles.card}>
        <Text style={styles.rowTitle}>Anki-compatible Rust core</Text>
        <Text style={styles.rowDescription}>
          Collection and media sync use the pinned Anki rslib implementation.
        </Text>
      </View>

      <Text style={styles.sectionLabel}>SYNC DIAGNOSTICS</Text>
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

      <Text style={styles.sectionLabel}>ABOUT</Text>
      <View style={styles.card}>
        <Text style={styles.rowTitle}>Kelma Mobile 0.1.0</Text>
        <Text style={styles.rowDescription}>{SYNC_CLIENT_VERSION}</Text>
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
    marginBottom: 28,
  },
  sectionLabel: {
    color: palette.textMuted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginTop: 18,
    marginBottom: 8,
  },
  card: {
    backgroundColor: palette.surface,
    borderColor: palette.surfaceBorder,
    borderWidth: 1,
    borderRadius: 16,
    padding: 18,
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

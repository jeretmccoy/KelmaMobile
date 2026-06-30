/**
 * User-facing Kelma preferences.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SYNC_CLIENT_VERSION } from '../config';
import { palette } from './theme';

type Props = {
  autoplayAudio: boolean;
  onAutoplayAudioChange: (enabled: boolean) => void;
};

export function SettingsScreen({
  autoplayAudio,
  onAutoplayAudioChange,
}: Props) {
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

      <Text style={styles.sectionLabel}>ABOUT</Text>
      <View style={styles.card}>
        <Text style={styles.rowTitle}>Kelma Mobile 0.1.0</Text>
        <Text style={styles.rowDescription}>{SYNC_CLIENT_VERSION}</Text>
        <Text style={styles.license}>AGPL-3.0-or-later</Text>
      </View>
    </ScrollView>
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
});

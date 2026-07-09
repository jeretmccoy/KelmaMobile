/**
 * Crisp, themeable tab icons drawn from plain Views.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * No icon-font dependency: each icon is a small composition of rounded
 * rectangles so it scales cleanly and tints to the active/inactive color
 * passed by the tab bar.
 */
import { StyleSheet, View } from 'react-native';

type IconProps = { color: string; size?: number };

const ICON = 24;

/**
 * A stacked deck of flashcards: a back card peeking out behind a front
 * card with a header accent line. Reads as "decks" rather than a plain box.
 */
export function DeckIcon({ color, size = ICON }: IconProps) {
  const s = size / ICON;
  return (
    <View style={styles.frame}>
      <View
        style={[
          styles.card,
          styles.cardBack,
          { borderColor: color, backgroundColor: 'transparent', transform: [{ scale: s }] },
        ]}
      />
      <View
        style={[
          styles.card,
          styles.cardFront,
          { borderColor: color, backgroundColor: 'transparent', transform: [{ scale: s }] },
        ]}>
        <View style={[styles.cardAccent, { backgroundColor: color }]} />
        <View style={[styles.cardLine, { backgroundColor: color, opacity: 0.55 }]} />
        <View style={[styles.cardLineShort, { backgroundColor: color, opacity: 0.35 }]} />
      </View>
    </View>
  );
}

/**
 * A bar chart: three ascending bars. Reads as "stats" rather than a grid box.
 */
export function StatsIcon({ color, size = ICON }: IconProps) {
  const s = size / ICON;
  return (
    <View style={styles.frame}>
      <View style={[styles.barsScale, { transform: [{ scale: s }] }]}>
        <View style={styles.barsRow}>
          <View style={[styles.bar, { height: 7, backgroundColor: color, opacity: 0.45 }]} />
          <View style={[styles.bar, { height: 12, backgroundColor: color, opacity: 0.7 }]} />
          <View style={[styles.bar, { height: 18, backgroundColor: color }]} />
        </View>
      </View>
    </View>
  );
}

/**
 * Settings as three sliders (an "adjustments" control): faint tracks with a
 * solid handle on each, at staggered positions. Cleaner than a gear to draw
 * from Views and reads unambiguously as settings.
 */
export function SettingsIcon({ color, size = ICON }: IconProps) {
  const s = size / ICON;
  const knobLeft = [1, 11, 6];
  return (
    <View style={styles.frame}>
      <View style={[styles.slidersScale, { transform: [{ scale: s }] }]}>
        {knobLeft.map((left, i) => (
          <View key={i} style={styles.sliderRow}>
            <View style={[styles.sliderTrack, { backgroundColor: color, opacity: 0.4 }]} />
            <View style={[styles.sliderKnob, { backgroundColor: color, left }]} />
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * Sync as a refresh loop: an open (gapped) ring with an arrowhead at the gap.
 * The gap comes from a transparent top border; the whole thing is rotated so
 * the opening + arrow sit at the top-right, reading as a circular arrow.
 */
export function SyncIcon({ color, size = ICON }: IconProps) {
  const s = size / ICON;
  return (
    <View style={styles.frame}>
      <View style={[styles.syncScale, { transform: [{ scale: s }] }]}>
        <View style={[styles.syncRing, { borderColor: color, borderTopColor: 'transparent' }]} />
        <View style={[styles.syncArrow, { borderBottomColor: color }]} />
      </View>
    </View>
  );
}

/**
 * Import as a download-into-tray: a down arrow (shaft + head) dropping into an
 * open U-shaped tray. Reads as "bring a file in".
 */
export function ImportIcon({ color, size = ICON }: IconProps) {
  const s = size / ICON;
  return (
    <View style={styles.frame}>
      <View style={[styles.importScale, { transform: [{ scale: s }] }]}>
        <View style={[styles.importShaft, { backgroundColor: color }]} />
        <View style={[styles.importHead, { borderTopColor: color }]} />
        <View style={[styles.trayBase, { backgroundColor: color }]} />
        <View style={[styles.trayLeft, { backgroundColor: color }]} />
        <View style={[styles.trayRight, { backgroundColor: color }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: ICON,
    height: ICON,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // --- Settings (sliders) ---
  slidersScale: { width: 20, height: 18, justifyContent: 'space-between' },
  sliderRow: { height: 3, justifyContent: 'center' },
  sliderTrack: { width: '100%', height: 2.5, borderRadius: 1.25 },
  sliderKnob: {
    position: 'absolute',
    top: -2,
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  // --- Sync (refresh loop) ---
  syncScale: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  syncRing: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2.5,
    transform: [{ rotate: '45deg' }],
  },
  syncArrow: {
    position: 'absolute',
    top: 1,
    right: 2,
    width: 0,
    height: 0,
    borderLeftWidth: 3.5,
    borderRightWidth: 3.5,
    borderBottomWidth: 5,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    transform: [{ rotate: '120deg' }],
  },
  // --- Import (download to tray) ---
  importScale: { width: 20, height: 20 },
  importShaft: {
    position: 'absolute',
    top: 1,
    left: 8.75,
    width: 2.5,
    height: 7,
    borderRadius: 1.25,
  },
  importHead: {
    position: 'absolute',
    top: 7,
    left: 6,
    width: 0,
    height: 0,
    borderLeftWidth: 4,
    borderRightWidth: 4,
    borderTopWidth: 5,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  trayBase: {
    position: 'absolute',
    bottom: 2,
    left: 3,
    width: 14,
    height: 2.5,
    borderRadius: 1.25,
  },
  trayLeft: {
    position: 'absolute',
    bottom: 2,
    left: 3,
    width: 2.5,
    height: 5,
    borderRadius: 1.25,
  },
  trayRight: {
    position: 'absolute',
    bottom: 2,
    right: 3,
    width: 2.5,
    height: 5,
    borderRadius: 1.25,
  },
  card: {
    position: 'absolute',
    width: 15,
    height: 19,
    borderRadius: 3,
    borderWidth: 1.6,
  },
  cardBack: {
    top: 1,
    left: 5,
  },
  cardFront: {
    top: 3,
    left: 3,
    paddingHorizontal: 2.5,
    paddingVertical: 3,
    alignItems: 'flex-start',
  },
  cardAccent: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginBottom: 2.5,
  },
  cardLine: {
    width: 11,
    height: 1.4,
    borderRadius: 1,
    marginBottom: 2,
  },
  cardLineShort: {
    width: 9,
    height: 1.4,
    borderRadius: 1,
  },
  barsScale: {
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
  },
  barsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2.4,
    height: 18,
    width: 20,
    justifyContent: 'flex-end',
  },
  bar: {
    width: 4.4,
    borderRadius: 1.4,
  },
});

/**
 * Shared visual language for Kelma Mobile screens.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { StyleSheet } from 'react-native';

export const palette = {
  background: '#12130f',
  surface: '#1c1e18',
  surfaceBorder: '#34362d',
  gold: '#c6a969',
  goldSoft: '#d8c18c',
  textPrimary: '#f2eee3',
  textSecondary: '#a9aa9f',
  textMuted: '#77796f',
  good: '#7fa67a',
  bad: '#be7467',
};

/**
 * Anki card HTML is rich, but a WebView dependency is overkill for an MVP.
 * This renders a readable plain-text approximation: tags are stripped and a few
 * common entities are decoded. Swap in react-native-webview later to render the
 * card's own CSS faithfully.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>(\n)?/gi, '\n')
    .replace(/<(p|div|li)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')

    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const sharedStyles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: palette.background,
  },
  screen: {
    flex: 1,
    paddingHorizontal: 24,
  },
  eyebrow: {
    color: palette.gold,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 3.2,
  },
});

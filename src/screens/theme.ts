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
 * Matches an Anki `[sound:resource]` (or video) tag, capturing the resource
 * name — the on-disk media file the collection should play.
 */
const SOUND_TAG = /\[sound:([^\]]+)\]/gi;

/** Extract every `[sound:resource]` resource from rendered card HTML. */
export function extractSoundTags(html: string): string[] {
  const sounds: string[] = [];
  for (const match of html.matchAll(SOUND_TAG)) {
    if (match[1]) {
      sounds.push(match[1]);
    }
  }
  return sounds;
}

/** Remove `[sound:...]` tags from rendered card HTML. */
export function stripSoundTags(html: string): string {
  return html.replace(SOUND_TAG, '');
}

/**
 * The back of a card: the portion after Anki's `<hr id=answer>` separator.
 * Anki's answer HTML is `FrontSide + <hr id=answer> + back`, so this drops the
 * repeated front — used both to render only the back and to autoplay the back's
 * (not the front's) first audio on reveal.
 */
export function answerBack(answerHtml: string): string {
  const parts = answerHtml.split(/<hr[^>]*\bid=["']?answer["']?[^>]*>/i);
  return parts.length > 1 ? parts.slice(1).join('') : answerHtml;
}

/**
 * Build a full HTML document for a card side, rendered faithfully (the note
 * type's own CSS, so blur/cloze/colours/fonts all work) inside a WebView.
 *
 * `[sound:...]` tags become tappable play buttons that post `{type:'play'}` to
 * React Native (audio is played natively, not in the WebView). When `allowReveal`
 * is set, a tap anywhere posts `{type:'reveal'}` so the back can be shown.
 */
export function buildCardHtml(sideHtml: string, css: string, allowReveal: boolean): string {
  const withAudio = sideHtml.replace(SOUND_TAG, (_match, name: string) => {
    const safe = String(name).replace(/"/g, '&quot;');
    return `<a class="kelma-audio" data-sound="${safe}">&#9654;</a>`;
  });
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  html,body{margin:0;padding:18px;background:${palette.background};color:${palette.textPrimary};
    font-size:22px;line-height:1.5;-webkit-text-size-adjust:100%;word-wrap:break-word;}
  img{max-width:100%;height:auto;}
  .kelma-audio{display:inline-flex;align-items:center;justify-content:center;width:42px;height:42px;
    border-radius:21px;border:1px solid ${palette.surfaceBorder};background:${palette.surface};
    color:${palette.goldSoft};font-size:16px;margin:6px;text-decoration:none;vertical-align:middle;}
  ${css}
  /* Forced dark mode. CSS filters don't render reliably in this WebView, so we
     override every background to dark and every text colour to light with
     !important — nothing white slips through and text is always readable.
     (Accent colours are normalised; bring them back via nightMode template CSS.)
     The audio button keeps its own colours via a more specific rule. */
  html,body{background:${palette.background} !important;}
  .card,.card *{background-color:${palette.background} !important;color:${palette.textPrimary} !important;}
  img{background-color:transparent !important;}
  .card .kelma-audio{background:${palette.surface} !important;border-color:${palette.surfaceBorder} !important;color:${palette.goldSoft} !important;}
</style></head>
<body class="card nightMode">${withAudio}
<script>
(function(){
  function post(m){ if(window.ReactNativeWebView){ window.ReactNativeWebView.postMessage(JSON.stringify(m)); } }
  document.querySelectorAll('.kelma-audio').forEach(function(el){
    el.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation();
      post({type:'play', sound: el.getAttribute('data-sound')}); });
  });
  ${allowReveal ? "document.addEventListener('click', function(){ post({type:'reveal'}); }, {once:true});" : ''}
}());
</script>
</body></html>`;
}

/** A piece of card content: a run of text, or an audio clip to render inline. */
export type CardToken =
  | { type: 'text'; value: string }
  | { type: 'sound'; value: string };

/**
 * Split rendered card HTML into ordered text/sound tokens, so the reviewer can
 * place each play control at the `[sound:...]` tag's actual position instead of
 * collecting them all at the bottom.
 */
export function tokenizeCard(html: string): CardToken[] {
  const tokens: CardToken[] = [];
  let last = 0;
  for (const match of html.matchAll(SOUND_TAG)) {
    const index = match.index ?? 0;
    const text = htmlToText(html.slice(last, index));
    if (text) {
      tokens.push({ type: 'text', value: text });
    }
    if (match[1]) {
      tokens.push({ type: 'sound', value: match[1] });
    }
    last = index + match[0].length;
  }
  const tail = htmlToText(html.slice(last));
  if (tail) {
    tokens.push({ type: 'text', value: tail });
  }
  return tokens;
}

/**
 * Anki card HTML is rich, but a WebView dependency is overkill for an MVP.
 * This renders a readable plain-text approximation: tags are stripped and a few
 * common entities are decoded. `[sound:...]` audio tags are removed here so the
 * filename never appears in the card text; the reviewer renders a dedicated
 * play control for them instead. Swap in react-native-webview later to render
 * the card's own CSS faithfully.
 */
export function htmlToText(html: string): string {
  return stripSoundTags(html)
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

/**
 * Shared visual language for Kelma Mobile screens.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { StyleSheet } from 'react-native';

export const palette = {
  // Layered surfaces, darkest → lightest. The deeper canvas lets elevated
  // cards read as genuinely raised (with the shadows below) instead of flat.
  background: '#0f100a',
  backgroundAlt: '#141610', // faint alternate band (headers, insets)
  surface: '#1b1d16', // standard card
  surfaceElevated: '#24271d', // raised / pressed card, active states
  surfaceHigh: '#2d3024', // top layer: active pill, chips
  surfaceBorder: '#3a3d31', // defined border
  hairline: '#2a2c22', // subtle divider

  // Brand gold, with a brighter highlight for primary buttons.
  gold: '#c9ac6b',
  goldSoft: '#dcc48f',
  goldBright: '#ecd49a',

  // Text ramp.
  textPrimary: '#f4f1e7',
  textSecondary: '#adaea1',
  textMuted: '#7b7d70',

  // Semantic study colours.
  good: '#84b07d', // review / mature / success
  bad: '#d38975', // learning / error
  newCard: '#7fb2c6', // new (cool blue)
  young: '#9cc593', // young cards

  shadowColor: '#000000',
};

/** Consistent spacing scale (multiples of 4). */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  huge: 32,
};

/** Corner-radius scale. */
export const radius = {
  sm: 10,
  md: 14,
  lg: 18,
  xl: 22,
  pill: 999,
};

/**
 * Elevation presets. On the near-black canvas these are subtle, but they lift
 * cards and the floating reviewer card just enough to feel layered. Spread one
 * into a style (iOS shadow* + Android elevation both included).
 */
export const shadow = {
  subtle: {
    shadowColor: palette.shadowColor,
    shadowOpacity: 0.22,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  card: {
    shadowColor: palette.shadowColor,
    shadowOpacity: 0.32,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 5,
  },
  floating: {
    shadowColor: palette.shadowColor,
    shadowOpacity: 0.45,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 14 },
    elevation: 14,
  },
} as const;

/**
 * Reusable typography presets (spread into a StyleSheet entry). Titles are big
 * and tightly tracked; labels use minimal letter-spacing (no "D E C K" look).
 */
export const typography = {
  display: { fontSize: 40, fontWeight: '800', letterSpacing: -1.2, color: palette.textPrimary },
  title: { fontSize: 24, fontWeight: '800', letterSpacing: -0.5, color: palette.textPrimary },
  eyebrow: { fontSize: 13, fontWeight: '800', letterSpacing: 0.2, color: palette.gold },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.2,
    color: palette.textSecondary,
  },
  body: { fontSize: 15, lineHeight: 22, color: palette.textSecondary },
} as const;

/**
 * A tall gold accent bar to sit left of a big screen title, giving headers
 * weight without the old spaced-out eyebrow label. Pair with `titleRow`.
 */
export const headerStyles = StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  accent: { width: 5, height: 30, borderRadius: 3, backgroundColor: palette.gold },
  accentTall: { width: 5, height: 38, borderRadius: 3, backgroundColor: palette.gold },
});

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

/** Matches an `<img src="...">` attribute (either quote style) so its value
 *  can be rewritten to an absolute `file://` URL into the media folder. */
const IMG_SRC = /(<img\b[^>]*\ssrc=)(["'])(.*?)\2/gi;

/**
 * Rewrite relative `<img src>` values (Anki media filenames, as rslib renders
 * them) to absolute `file://` URLs into the media folder. Needed because the
 * card HTML is loaded via a scratch file's `source.uri` rather than a
 * `baseUrl`-relative `source.html` (see `writeCardHtml` in KelmaCore.ts), so
 * relative filenames would otherwise resolve next to that scratch file
 * instead of inside `collection.media`. Already-absolute sources (http(s),
 * data, file) are left untouched.
 */
function absolutizeImageSrc(html: string, mediaDir: string): string {
  return html.replace(IMG_SRC, (match, prefix: string, quote: string, src: string) => {
    if (/^(?:https?:|data:|file:)/i.test(src)) {
      return match;
    }
    const encoded = src.split('/').map(encodeURIComponent).join('/');
    return `${prefix}${quote}file://${mediaDir}/${encoded}${quote}`;
  });
}

/**
 * Build a full HTML document for a card side, rendered faithfully (the note
 * type's own CSS, so blur/cloze/colours/fonts all work) inside a WebView.
 *
 * `[sound:...]` tags become tappable play buttons that post `{type:'play'}` to
 * React Native (audio is played natively, not in the WebView). `<img>` sources
 * are rewritten to absolute `file://` URLs into `mediaDir` (when provided) so
 * they resolve correctly once loaded via a scratch file rather than a
 * `baseUrl`. When `allowReveal` is set (the question side), a tap anywhere
 * posts `{type:'reveal'}` so the back can be shown. When `allowReveal` is not
 * set (the revealed answer side), a tap on the left half posts
 * `{type:'rate', rating:0}` (Again) and a tap on the right half posts
 * `{type:'rate', rating:2}` (Good) — AnkiDroid-style answer by tapping the
 * card. Audio buttons stop propagation so they never rate.
 *
 * Taps that land on an element the template itself made interactive (a link,
 * button, label/checkbox, `<details>`, or anything with its own `onclick` —
 * the common ways card templates implement tap-to-unblur/spoiler text) are
 * left alone instead of also triggering reveal/rate, so the template's own
 * handler isn't hijacked. A capture-phase listener also forces a repaint
 * after every tap, working around this WebView's known unreliable repaint of
 * `filter` (e.g. `blur()`) after a class/style change.
 */
export function buildCardHtml(
  sideHtml: string,
  css: string,
  allowReveal: boolean,
  mediaDir: string | null = null,
): string {
  const withImages = mediaDir ? absolutizeImageSrc(sideHtml, mediaDir) : sideHtml;
  const withAudio = withImages.replace(SOUND_TAG, (_match, name: string) => {
    const safe = String(name).replace(/"/g, '&quot;');
    return `<a class="kelma-audio" data-sound="${safe}">&#9654;</a>`;
  });
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  /* Base defaults use plain element selectors (lowest specificity), so the
     card is dark with light default text, but ANY colour the template sets on
     a class or inline (0,1,0+) overrides it — coloured fonts render faithfully.
     Full width: no side padding, only a little vertical breathing room. */
  html,body{margin:0;padding:10px 0;background:${palette.surface};color:${palette.textPrimary};
    font-size:22px;line-height:1.55;-webkit-text-size-adjust:100%;word-wrap:break-word;
    -webkit-user-select:none;user-select:none;-webkit-touch-callout:none;}
  img{max-width:100%;height:auto;border-radius:10px;}
  hr{border:none;border-top:1px solid ${palette.surfaceBorder};margin:20px 0;}
  hr#answer{border-top:1px solid ${palette.gold};opacity:0.5;}
  .kelma-audio{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;
    border-radius:22px;border:1px solid ${palette.surfaceBorder};background:${palette.surfaceElevated};
    color:${palette.goldSoft};font-size:16px;margin:6px;text-decoration:none;vertical-align:middle;}
  ${css}
  /* Keep the card surface dark, and give a light DEFAULT text colour — most
     templates set a plain .card color of black (they assume a white page),
     which would be unreadable on our dark surface. This overrides only that
     generic default: it matches the card root with normal specificity (no
     !important) and is placed after the template CSS, so it beats a plain
     black .card rule, while any colour the template sets on a class or inline
     style still wins and renders faithfully. The audio button keeps its own
     colours via a more specific rule. */
  html,body{background:${palette.surface} !important;}
  .card{color:${palette.textPrimary};}
  .card .kelma-audio{background:${palette.surfaceElevated} !important;border-color:${palette.surfaceBorder} !important;color:${palette.goldSoft} !important;}
</style></head>
<body class="card nightMode">${withAudio}
<script>
(function(){
  function post(m){ if(window.ReactNativeWebView){ window.ReactNativeWebView.postMessage(JSON.stringify(m)); } }

  // Tap should be left to the element itself (not flip the card): a link,
  // button, label/checkbox/select, <details>/<summary>, an inline onclick, or
  // our own audio buttons.
  function isInteractive(el){
    var tags = { A:1, BUTTON:1, LABEL:1, INPUT:1, SELECT:1, TEXTAREA:1, SUMMARY:1, OPTION:1, DETAILS:1 };
    while (el && el !== document.body) {
      if (tags[el.tagName] || el.onclick || (el.classList && el.classList.contains('kelma-audio'))) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  function coords(e){
    if (e.touches && e.touches[0]) return [e.touches[0].clientX, e.touches[0].clientY];
    if (e.changedTouches && e.changedTouches[0]) return [e.changedTouches[0].clientX, e.changedTouches[0].clientY];
    return [e.clientX || 0, e.clientY || 0];
  }

  // Any element stacked at the tap point that is hidden by a blur — via a
  // filter OR a backdrop-filter (blur overlays), inline or from any rule.
  // Uses elementsFromPoint so it catches an overlay covering the text (which is
  // NOT an ancestor of the tapped node) as well as the node's own ancestors.
  // Fully generic: no dependence on the card's classes or scripts.
  function blurredAtPoint(x, y){
    var els = (document.elementsFromPoint && document.elementsFromPoint(x, y)) || [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el || el === document.documentElement || el === document.body) continue;
      var cs = window.getComputedStyle(el);
      var f = (cs.filter || '') + ' ' + (cs.webkitFilter || '') + ' ' +
              (cs.backdropFilter || '') + ' ' + (cs.webkitBackdropFilter || '');
      if (f.indexOf('blur(') !== -1) return el;
    }
    return null;
  }

  // Un-blur an element ourselves (inline !important beats any rule). We reveal
  // it here rather than relying on the template, so blurred spots work on every
  // card regardless of how the template implements them.
  function unblur(el){
    el.style.setProperty('filter', 'none', 'important');
    el.style.setProperty('-webkit-filter', 'none', 'important');
    el.style.setProperty('backdrop-filter', 'none', 'important');
    el.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
  }

  // Latch what's under the finger at PRESS time — before any template handler
  // runs — so a card that toggles its own blur on tap can't make the spot look
  // un-blurred by the time the click fires. Also record the start point so a
  // scroll/drag (finger moves) is NOT treated as a tap: only a near-stationary
  // press-and-release flips the card or reveals a blur.
  var pendingBlur = null;
  var pressInteractive = false;
  var startX = 0, startY = 0, moved = false;
  var MOVE_SLOP = 10; // px of movement that turns a tap into a scroll/drag
  function latch(e){
    var c = coords(e);
    startX = c[0]; startY = c[1]; moved = false;
    pendingBlur = blurredAtPoint(c[0], c[1]);
    pressInteractive = !pendingBlur && isInteractive(e.target);
  }
  function onMove(e){
    var c = coords(e);
    if (Math.abs(c[0] - startX) > MOVE_SLOP || Math.abs(c[1] - startY) > MOVE_SLOP) moved = true;
  }
  document.addEventListener('pointerdown', latch, true);
  document.addEventListener('touchstart', latch, true);
  document.addEventListener('mousedown', latch, true);
  document.addEventListener('touchmove', onMove, true);
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('scroll', function(){ moved = true; }, true);

  // TEMPORARY diagnostic: long-press reports exactly what is stacked under the
  // finger (tag/class + filter/backdrop/opacity/color), so a hide mechanism
  // that isn't a CSS blur() can be identified. Shown via a native alert.
  var pressTimer = null;
  document.addEventListener('touchstart', function(e){
    var c = coords(e);
    clearTimeout(pressTimer);
    pressTimer = setTimeout(function(){
      var els = (document.elementsFromPoint && document.elementsFromPoint(c[0], c[1])) || [];
      var lines = [];
      for (var i = 0; i < els.length && i < 6; i++) {
        var el = els[i]; if (!el) continue;
        var cs = window.getComputedStyle(el);
        var before = window.getComputedStyle(el, '::before');
        var after = window.getComputedStyle(el, '::after');
        var cls = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().replace(/\\s+/g, '.') : '';
        lines.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls
          + '\\n  filter: ' + (cs.filter || 'none')
          + '\\n  backdrop: ' + (cs.backdropFilter || cs.webkitBackdropFilter || 'none')
          + '\\n  opacity: ' + cs.opacity + '  visibility: ' + cs.visibility
          + '\\n  color: ' + cs.color + '  bg: ' + cs.backgroundColor
          + '\\n  ::before filter/bd/content: ' + (before.filter || 'none') + ' / ' + (before.backdropFilter || before.webkitBackdropFilter || 'none') + ' / ' + before.content
          + '\\n  ::after filter/bd/content: ' + (after.filter || 'none') + ' / ' + (after.backdropFilter || after.webkitBackdropFilter || 'none') + ' / ' + after.content);
      }
      post({ type: 'debug', info: lines.join('\\n\\n') || 'nothing at point' });
    }, 500);
  }, true);
  document.addEventListener('touchend', function(){ clearTimeout(pressTimer); }, true);
  document.addEventListener('touchmove', function(){ clearTimeout(pressTimer); }, true);

  // Nudge the WebView into repainting, since a filter change can otherwise stay
  // visually stale in this engine.
  function forceRepaint(){
    var h = document.documentElement;
    var prev = h.style.webkitTransform;
    h.style.webkitTransform = 'translateZ(0)';
    void h.offsetHeight;
    h.style.webkitTransform = prev;
  }

  document.querySelectorAll('.kelma-audio').forEach(function(el){
    el.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation();
      post({type:'play', sound: el.getAttribute('data-sound')}); });
  });

  document.addEventListener('click', function(e){
    var c = coords(e);
    var blurred = pendingBlur || blurredAtPoint(c[0], c[1]);
    var interactive = pressInteractive || (!blurred && isInteractive(e.target));
    var wasDrag = moved;
    pendingBlur = null; pressInteractive = false; moved = false;
    if (wasDrag) return;           // a scroll/drag, not a tap: ignore entirely
    if (blurred) {                 // tapped a blurred spot: reveal it, never flip
      unblur(blurred);
      requestAnimationFrame(forceRepaint);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (interactive) return;       // link/button/etc: let it handle its own tap
    ${allowReveal
      ? "post({type:'reveal'});"
      : "var half = window.innerWidth / 2; post({type:'rate', rating: e.clientX < half ? 0 : 2});"}
  }, true);
  ${allowReveal
    ? ''
    : `function scrollToAnswer(){ var hr = document.getElementById('answer'); if (hr) { hr.scrollIntoView({block:'start'}); } }
  scrollToAnswer();
  window.addEventListener('load', scrollToAnswer);`}
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
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
});

/**
 * Audio playback for Anki `[sound:resource]` tags.
 *
 * rslib renders audio as literal `[sound:foo.mp3]` tags; the reviewer parses
 * those out (see `extractSoundTags`) and hands the resource names here together
 * with the collection's media directory. Playback is backed by
 * `react-native-sound`, which is imported lazily so the module is safe to load
 * in environments (tests, simulators without the native module linked) where it
 * is unavailable — `play` then becomes a silent no-op rather than crashing the
 * reviewer.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

type SoundLike = {
  play(onEnd?: (success: boolean) => void): void;
  stop(): void;
  release(): void;
};

type SoundCtor = new (
  filename: string,
  basePath: string,
  onLoaded: (error?: unknown) => void,
) => SoundLike;

type SoundModule = SoundCtor & {
  setCategory?(category: string, mixWithOthers?: boolean): void;
  setActive?(active: boolean): void;
};

let SoundCtorCache: SoundModule | null | undefined;

function loadSoundCtor(): SoundModule | null {
  if (SoundCtorCache !== undefined) {
    return SoundCtorCache;
  }
  // Lazy so the import never runs at module load time (keeps jest happy and
  // defers the native-module probe to the first real playback attempt).
  try {
    const mod = require('react-native-sound');
    SoundCtorCache = (mod?.default ?? mod) as SoundModule;
    // Anki audio is intentional media playback. On iOS the library defaults
    // to Ambient, which is inaudible while the device's Silent switch is on.
    SoundCtorCache.setCategory?.('Playback');
    SoundCtorCache.setActive?.(true);
  } catch (error) {
    console.warn('Kelma audio module is unavailable.', error);
    SoundCtorCache = null;
  }
  return SoundCtorCache;
}

export interface AudioPlayer {
  /** Play a media file by its name under the collection's media directory. */
  play(resourceName: string, mediaDir: string): void;
  /** Stop and release any currently playing clip. */
  stop(): void;
  /** Whether a native player is available on this platform/build. */
  isAvailable(): boolean;
}

class RNSoundPlayer implements AudioPlayer {
  private current: SoundLike | null = null;

  play(resourceName: string, mediaDir: string): void {
    const Sound = loadSoundCtor();
    if (!Sound) {
      return;
    }
    // Re-assert the audio session on every play: a WKWebView (the card renderer)
    // can reset AVAudioSession to a silent/ambient category after we set it once
    // at startup, which would make playback inaudible.
    Sound.setCategory?.('Playback');
    Sound.setActive?.(true);
    if (!mediaDir) {
      console.warn(`Cannot play "${resourceName}": media directory is unavailable.`);
      return;
    }
    this.stop();

    // Try the exact name; if it fails, retry lowercased. The iOS simulator's
    // sandbox filesystem is case-sensitive for the app, and media that collided
    // on case during sync (e.g. `Of_course.mp3` vs `of_course.mp3`) may only
    // survive under a different case than the note references.
    this.load(Sound, resourceName, mediaDir, () => {
      const lower = resourceName.toLowerCase();
      if (lower !== resourceName) {
        this.load(Sound, lower, mediaDir, () =>
          console.warn(`Could not load Anki media "${resourceName}" (tried lowercase too).`),
        );
      } else {
        console.warn(`Could not load Anki media "${resourceName}".`);
      }
    });
  }

  private load(Sound: SoundCtor, name: string, mediaDir: string, onFail: () => void): void {
    const filePath = joinMediaPath(mediaDir, name);
    const sound = new Sound(filePath, '', error => {
      if (error) {
        onFail();
        return;
      }
      this.current = sound;
      sound.play(() => {
        // released on next play()/stop()
      });
    });
  }

  stop(): void {
    if (this.current) {
      try {
        this.current.stop();
        this.current.release();
      } catch {
        // Ignore — the native handle may already be gone.
      }
      this.current = null;
    }
  }

  isAvailable(): boolean {
    return loadSoundCtor() !== null;
  }
}

/** Resolve a media resource name against the collection's media directory. */
function joinMediaPath(mediaDir: string, resourceName: string): string {
  const trimmed = mediaDir.replace(/\/+$/, '');
  return `${trimmed}/${resourceName}`;
}

export const audioPlayer: AudioPlayer = new RNSoundPlayer();

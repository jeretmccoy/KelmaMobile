/**
 * Native file sharing + picking — a thin typed wrapper over the
 * NativeKelmaShare TurboModule.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * React Native's built-in `Share` cannot hand a real file to other apps on
 * Android (it only shares text), so Kelma ships a small platform module that:
 *   - opens the OS share sheet for a file (UIActivityViewController on iOS,
 *     FileProvider-backed ACTION_SEND on Android),
 *   - opens the OS document picker for `.apkg` files and copies the selection
 *     into the app's temp/cache dir so rslib can open it by path,
 *   - copies a `file://`/`content://` URI (from a deep link that opened the
 *     app with an `.apkg`) into the temp/cache dir.
 */

import { Platform } from 'react-native';
import NativeKelmaShare from '../../specs/NativeKelmaShare';

export type ShareFileResult = {
  /** `true` if the user picked a share target; `false` if they dismissed. */
  completed: boolean;
};

function requireModule() {
  if (!NativeKelmaShare) {
    throw new Error(
      Platform.OS === 'ios'
        ? 'The share module is missing. Run pod install and rebuild.'
        : 'The share module is not registered in this build.',
    );
  }
  return NativeKelmaShare;
}

/**
 * Open the OS share sheet for the file at `path`.
 *
 * On iOS `path` is a plain filesystem path (resolved to a `file://` URL the
 * activity controller can read). On Android it is shared via a FileProvider
 * `content://` URI. Throws if the file is missing or the sheet can't be shown.
 */
export async function shareFile(
  path: string,
  title: string = '',
): Promise<ShareFileResult> {
  const completed = await requireModule().shareFile(path, title);
  return { completed };
}

/**
 * Open the OS document picker (`.apkg`/zip) and copy the selection into the
 * app's temp/cache dir. Resolves to the absolute filesystem path of the copy,
 * or an empty string if the user cancelled the picker. Pass the result to
 * `importApkg()`.
 */
export async function pickFile(): Promise<string> {
  return requireModule().pickFile();
}

/**
 * Copy a file referenced by a URI (a `file://` URL on iOS, or a
 * `content://`/`file://` URI on Android — e.g. from a deep link that opened
 * the app with an `.apkg` attachment) into the app's temp/cache dir. Resolves
 * to the absolute filesystem path of the copy. Pass the result to
 * `importApkg()`.
 */
export async function copyUriToTempPath(uri: string): Promise<string> {
  return requireModule().copyUriToTempPath(uri);
}

/**
 * Download a remote `http(s)://` URL into the app's temp/cache dir. Resolves
 * to the absolute filesystem path of the download. Pass the result to
 * `importApkg()`. Throws on network errors or 4xx/5xx responses.
 */
export async function downloadUrlToTempPath(url: string): Promise<string> {
  return requireModule().downloadUrlToTempPath(url);
}

/** True if a Linking URL looks like an `.apkg` the app should import. */
export function looksLikeApkgUrl(url: string): boolean {
  if (!url) {
    return false;
  }
  // Strip any query/fragment before checking the extension.
  const path = url.split('?')[0].split('#')[0];
  return path.toLowerCase().endsWith('.apkg');
}

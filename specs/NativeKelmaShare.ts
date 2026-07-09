/**
 * React Native Codegen contract for native file sharing + picking + download.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A minimal, platform-native module that can hand a real file (e.g. an exported
 * `.apkg`) to other apps. React Native's built-in `Share` cannot send file URIs
 * on Android, so this module uses a FileProvider there and
 * UIActivityViewController on iOS. It also opens the OS document picker and
 * downloads a remote URL, both producing a local path rslib can import.
 */

import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * Open the OS share sheet for the file at `path`. On iOS `path` is a plain
   * filesystem path (resolved to a file:// URL); on Android it is shared via a
   * FileProvider content:// URI. Resolves to `true` if a target was chosen,
   * `false` if the user dismissed the sheet.
   */
  shareFile(path: string, title: string): Promise<boolean>;

  /**
   * Open the OS document picker (restricted to `.apkg`/zip packages) and copy
   * the chosen file into the app's temp/cache dir so rslib can open it by path.
   * Resolves to the absolute filesystem path of the copy, or an empty string
   * if the user cancelled the picker.
   */
  pickFile(): Promise<string>;

  /**
   * Copy a file referenced by a URI (a `file://` URL on iOS, or a
   * `content://`/`file://` URI on Android, e.g. from a deep link that opened
   * the app with an `.apkg` attachment) into the app's temp/cache dir so rslib
   * can open it by path. Resolves to the absolute filesystem path of the copy.
   */
  copyUriToTempPath(uri: string): Promise<string>;

  /**
   * Download a remote `http(s)://...` URL to a file in the app's temp/cache dir
   * so rslib can open it by path (for "Import from URL"). Follows redirects,
   * fails on 4xx/5xx. Resolves to the absolute filesystem path of the download.
   */
  downloadUrlToTempPath(url: string): Promise<string>;
}

export default TurboModuleRegistry.get<Spec>('NativeKelmaShare');

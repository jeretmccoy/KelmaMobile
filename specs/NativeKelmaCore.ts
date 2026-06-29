/**
 * React Native Codegen contract for the Anki Rust backend.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The bridge stays deliberately coarse: every call crosses the native boundary
 * once and is fully backed by rslib. Structured data is exchanged as JSON
 * strings so the Codegen contract remains stable while the typed DTOs live in
 * `src/core/KelmaCore.ts`.
 */

import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * Loads the native Rust backend and returns its build identity as JSON.
   * This is intentionally asynchronous: backend work must never block the UI.
   */
  getCoreInfo(): Promise<string>;

  /**
   * Open (or create) the collection for the active profile. The native module
   * owns a single session at a time. `request` is JSON:
   * `{collectionPath, mediaFolderPath, mediaDbPath}`.
   */
  openCollection(request: string): Promise<string>;

  /** Close the active collection session and release native resources. */
  closeCollection(): Promise<void>;

  /**
   * Run a coarse, rslib-backed operation against the open collection.
   * `op` is one of: "deckTree", "nextCard", "answerCard", "syncLogin",
   * "syncCollection", "syncStatus", "fullSync". `request` is JSON (or "" when
   * the operation takes no argument). Resolves to a JSON string.
   */
  runCollectionOp(op: string, request: string): Promise<string>;
}

export default TurboModuleRegistry.get<Spec>('NativeKelmaCore');

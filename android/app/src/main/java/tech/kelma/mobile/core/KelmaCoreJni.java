/*
 * Kelma Mobile
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

package tech.kelma.mobile.core;

/** Thin JNI declarations for the shared Kelma Rust session. */
final class KelmaCoreJni {
  static {
    System.loadLibrary("kelma_core");
  }

  private KelmaCoreJni() {}

  static native String coreInfo();

  static native long open(String request);

  static native String run(long handle, String operation, String request);

  static native void close(long handle);
}

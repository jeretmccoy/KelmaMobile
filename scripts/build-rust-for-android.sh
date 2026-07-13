#!/usr/bin/env bash
# Build Kelma's shared Rust core as an Android JNI library.
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ABI="${1:-arm64-v8a}"
OUTPUT_ROOT="${2:-$ROOT/android/app/build/rustJniLibs}"
NDK_VERSION="${ANDROID_NDK_VERSION:-27.1.12297006}"

if [[ -n "${ANDROID_NDK_HOME:-}" ]]; then
  NDK="$ANDROID_NDK_HOME"
else
  SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  if [[ -z "$SDK" ]]; then
    case "$(uname -s)" in
      Darwin) SDK="$HOME/Library/Android/sdk" ;;
      *) SDK="$HOME/Android/Sdk" ;;
    esac
  fi
  NDK="$SDK/ndk/$NDK_VERSION"
fi

case "$(uname -s)" in
  Darwin) HOST_TAG="darwin-x86_64" ;;
  Linux) HOST_TAG="linux-x86_64" ;;
  *) echo "Unsupported Android Rust build host: $(uname -s)" >&2; exit 1 ;;
esac
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG/bin"

case "$ABI" in
  arm64-v8a)
    TARGET="aarch64-linux-android"
    CLANG_PREFIX="aarch64-linux-android"
    ;;
  armeabi-v7a)
    TARGET="armv7-linux-androideabi"
    CLANG_PREFIX="armv7a-linux-androideabi"
    ;;
  x86)
    TARGET="i686-linux-android"
    CLANG_PREFIX="i686-linux-android"
    ;;
  x86_64)
    TARGET="x86_64-linux-android"
    CLANG_PREFIX="x86_64-linux-android"
    ;;
  *)
    echo "Unsupported Android ABI: $ABI" >&2
    exit 1
    ;;
esac

LINKER="$TOOLCHAIN/${CLANG_PREFIX}24-clang"
CXX="$TOOLCHAIN/${CLANG_PREFIX}24-clang++"
if [[ ! -x "$LINKER" ]]; then
  echo "Android NDK linker not found: $LINKER" >&2
  exit 1
fi

if ! rustup target list --installed | grep -qx "$TARGET"; then
  rustup target add "$TARGET"
fi

TARGET_KEY="${TARGET//-/_}"
CARGO_KEY="$(printf '%s' "$TARGET" | tr '[:lower:]-' '[:upper:]_')"
export "CC_${TARGET_KEY}=$LINKER"
export "CXX_${TARGET_KEY}=$CXX"
export "AR_${TARGET_KEY}=$TOOLCHAIN/llvm-ar"
export "RANLIB_${TARGET_KEY}=$TOOLCHAIN/llvm-ranlib"
export "CARGO_TARGET_${CARGO_KEY}_LINKER=$LINKER"

# The manifest remains `staticlib` so iOS never attempts to link a forbidden
# dylib. For Android only, ask rustc for an additional JNI cdylib; Cargo places
# that override under release/deps with a build hash in its filename. Remove
# stale copies first so we always package the library from this invocation.
RELEASE_DEPS="$ROOT/rust/kelma-core/target/android/$TARGET/release/deps"
rm -f "$RELEASE_DEPS"/libkelma_core*.so
cargo rustc \
  --manifest-path "$ROOT/rust/kelma-core/Cargo.toml" \
  --locked \
  --release \
  --target "$TARGET" \
  --target-dir "$ROOT/rust/kelma-core/target/android" \
  --lib \
  -- \
  --crate-type cdylib

LIBRARY="$(find "$RELEASE_DEPS" -maxdepth 1 -type f -name 'libkelma_core*.so' -print -quit)"
if [[ -z "$LIBRARY" || ! -f "$LIBRARY" ]]; then
  echo "Android Rust library was not produced under: $RELEASE_DEPS" >&2
  exit 1
fi
mkdir -p "$OUTPUT_ROOT/$ABI"
cp "$LIBRARY" "$OUTPUT_ROOT/$ABI/libkelma_core.so"

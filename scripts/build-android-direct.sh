#!/usr/bin/env bash
# Build signed, architecture-specific APKs for GitHub/Obtainium distribution.
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$ROOT/android"
KEYCHAIN_SERVICE="tech.kelma.mobile.direct.signing"
DEFAULT_KEYSTORE="$HOME/Library/Application Support/KelmaMobile/signing/kelma-direct.p12"
EXPECTED_CERT_SHA256="f7cca2aaf28eb372e35fb797e0e7a481ff90137afbc9d37a54a04bf681430583"
ABIS="${KELMA_DIRECT_ABIS:-armeabi-v7a,arm64-v8a,x86,x86_64}"
ARTIFACT_DIR="$ROOT/dist/android"

export KELMA_DIRECT_KEYSTORE="${KELMA_DIRECT_KEYSTORE:-$DEFAULT_KEYSTORE}"
export KELMA_DIRECT_KEY_ALIAS="${KELMA_DIRECT_KEY_ALIAS:-kelma-direct}"
if [[ -z "${KELMA_DIRECT_STORE_PASSWORD:-}" ]] && [[ "$(uname -s)" == "Darwin" ]]; then
  KELMA_DIRECT_STORE_PASSWORD="$(
    security find-generic-password -a "$USER" -s "$KEYCHAIN_SERVICE" -w
  )"
  export KELMA_DIRECT_STORE_PASSWORD
fi
export KELMA_DIRECT_KEY_PASSWORD="${KELMA_DIRECT_KEY_PASSWORD:-${KELMA_DIRECT_STORE_PASSWORD:-}}"
trap 'unset KELMA_DIRECT_STORE_PASSWORD KELMA_DIRECT_KEY_PASSWORD' EXIT

if [[ ! -f "$KELMA_DIRECT_KEYSTORE" ]]; then
  echo "Kelma Direct keystore not found: $KELMA_DIRECT_KEYSTORE" >&2
  exit 1
fi
if [[ -z "${KELMA_DIRECT_STORE_PASSWORD:-}" ]]; then
  echo "Set KELMA_DIRECT_STORE_PASSWORD or add it to macOS Keychain service $KEYCHAIN_SERVICE." >&2
  exit 1
fi

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
APKSIGNER="${APKSIGNER:-$SDK/build-tools/36.0.0/apksigner}"
if [[ ! -x "$APKSIGNER" ]]; then
  echo "apksigner not found: $APKSIGNER" >&2
  exit 1
fi

rm -rf "$ANDROID_DIR/app/build/outputs/apk/release"
(
  cd "$ANDROID_DIR"
  ./gradlew --no-daemon assembleRelease \
    -PkelmaDirect=true \
    "-PreactNativeArchitectures=$ABIS"
)

VERSION="$(node -p "require('$ROOT/package.json').version")"
mkdir -p "$ARTIFACT_DIR"
rm -f "$ARTIFACT_DIR"/*.apk "$ARTIFACT_DIR"/*.sha256

shopt -s nullglob
outputs=("$ANDROID_DIR"/app/build/outputs/apk/release/app-*-release.apk)
if [[ ${#outputs[@]} -eq 0 ]]; then
  echo "No signed architecture APKs were produced." >&2
  exit 1
fi

for source_apk in "${outputs[@]}"; do
  output_name="$(basename "$source_apk")"
  abi="${output_name#app-}"
  abi="${abi%-release.apk}"
  destination="$ARTIFACT_DIR/Kelma-Direct-$VERSION-$abi.apk"
  cp "$source_apk" "$destination"

  signer_output="$($APKSIGNER verify --verbose --print-certs "$destination")"
  actual_cert="$(
    printf '%s\n' "$signer_output" |
      awk -F': ' '/Signer #1 certificate SHA-256 digest:/{print tolower($2); exit}'
  )"
  if [[ "$actual_cert" != "$EXPECTED_CERT_SHA256" ]]; then
    echo "Unexpected signing certificate for $destination: $actual_cert" >&2
    exit 1
  fi

  (
    cd "$ARTIFACT_DIR"
    shasum -a 256 "$(basename "$destination")" > "$(basename "$destination").sha256"
  )
  echo "Verified: $destination"
done

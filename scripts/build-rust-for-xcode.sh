#!/bin/bash
# Build the pinned Anki rslib bridge for the architectures in the active
# Xcode build. CocoaPods invokes this before compiling the KelmaCore pod.
#
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

ROOT="${PODS_TARGET_SRCROOT}"
MANIFEST="${ROOT}/rust/kelma-core/Cargo.toml"
TARGET_DIR="${ROOT}/rust/kelma-core/target/ios"
OUTPUT_DIR="${PODS_CONFIGURATION_BUILD_DIR}/KelmaCore"
OUTPUT="${OUTPUT_DIR}/libkelma_core.a"

mkdir -p "${OUTPUT_DIR}"

targets=()
archives=()

for arch in ${ARCHS}; do
  case "${PLATFORM_NAME}:${arch}" in
    iphoneos:arm64)
      target="aarch64-apple-ios"
      ;;
    iphonesimulator:arm64)
      target="aarch64-apple-ios-sim"
      ;;
    iphonesimulator:x86_64)
      target="x86_64-apple-ios"
      ;;
    *)
      echo "Unsupported Rust target: ${PLATFORM_NAME}:${arch}" >&2
      exit 1
      ;;
  esac

  targets+=("${target}")
done

rustup target add "${targets[@]}"

for target in "${targets[@]}"; do
  CARGO_TARGET_DIR="${TARGET_DIR}" \
    cargo build \
      --manifest-path "${MANIFEST}" \
      --locked \
      --release \
      --target "${target}"
  archives+=("${TARGET_DIR}/${target}/release/libkelma_core.a")
done

if [[ ${#archives[@]} -eq 1 ]]; then
  cp "${archives[0]}" "${OUTPUT}"
else
  lipo -create "${archives[@]}" -output "${OUTPUT}"
fi

echo "Built ${OUTPUT} for ${targets[*]}"

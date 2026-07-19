# Kelma Mobile

[Source code](https://github.com/jeretmccoy/KelmaMobile) · [Issue tracker](https://github.com/jeretmccoy/KelmaMobile/issues) · AGPL-3.0-or-later

Kelma is a spiritual fork of AnkiDroid with a shared React Native interface for
Android and iOS. It remains Anki-compatible by using Anki's Rust backend for
collections, scheduling, rendering data, imports/exports, and sync.

This repository is the beginning of that port. It currently contains:

- a React Native 0.86 TypeScript application for Android and iOS;
- a typed Turbo Native Module contract for the Rust core;
- working Android and iOS bridges backed by the same pinned Anki Rust core;
- a **deck list, reviewer, and sync flow** that open a real collection, draw the
  next due card from rslib's queue, answer it with rslib's scheduler (SM-2 or
  FSRS), and sync against [KelmaSync](#sync);
- architecture and screen-by-screen porting notes in [`docs/`](./docs/).

### What is backed by the Rust core

Nothing about study behavior is reimplemented in TypeScript. The app calls a
small set of coarse, rslib-backed operations through `src/core/KelmaCore.ts`:

| Operation | rslib entry point |
| --- | --- |
| `openProfile` | `CollectionBuilder::build` |
| `getDeckTree` | `Collection::deck_tree` |
| `getNextCard` | `Collection::get_queued_cards` + `render_existing_card` |
| `answerCard` | `Collection::get_scheduling_states` + `answer_card` |
| `syncLogin` | KelmaSync v2 `/v2/auth/login` |
| `syncCollection` | Native v2 manifest/batch sync over rslib collections |
| `syncMedia` | Scoped, concurrent KelmaSync v2 media transfer |

Both platforms run these operations through `rust/kelma-core` over the pinned
`vendor/anki`: iOS links its C ABI as a static library, while Android packages
it as a JNI shared library. Both expose the identical coarse JSON contract.

### Sync

Kelma ships pointed at the production **KelmaSync v2** REST service at
`https://sync2.kelma.tech`. The default endpoint lives in
[`src/config.ts`](./src/config.ts) (`DEFAULT_SYNC_ENDPOINT`). Native sync compares
canonical checksums, transfers notes/cards and complete review history in
3,000-item batches, converts collection-relative due dates and daily-limit
counters, applies tombstones safely, uploads mobile-created metadata and
deletions, and transfers referenced media with 50 connections.
Tied content changes and deletion-vs-local-edit conflicts always ask the user
which result to keep.

## Install on Android

The official F-Droid package (`tech.kelma.mobile`) is pending review in
[F-Droid RFP #4111](https://gitlab.com/fdroid/rfp/-/work_items/4111).
For immediate installation, download the architecture-appropriate **Kelma
Direct** APK (`tech.kelma.mobile.direct`) from
[GitHub Releases](https://github.com/jeretmccoy/KelmaMobile/releases/latest).
Android will ask permission to install apps from the browser or file manager.

For automatic direct-build updates without Google Play, install
[Obtainium](https://github.com/ImranR98/Obtainium) and add this repository URL:

```text
https://github.com/jeretmccoy/KelmaMobile
```

The F-Droid and direct packages have separate IDs and signing keys, so they may
be installed side by side. See the published certificate and release procedure
in [`docs/android-release.md`](./docs/android-release.md).

## Development

Requirements:

- Node.js 22.11 or newer
- Android Studio/JDK for Android
- Xcode and CocoaPods for iOS
- Rust via `rustup` (native builds install the required platform targets)

```sh
git submodule update --init --recursive
npm install
npm test
npm run lint
npm run android
```

### Quick Android emulator testing

On macOS, use Android Studio's bundled JDK instead of Java 25, which causes the
Android CMake/Prefab configuration to fail. Add these lines to `~/.zshrc`, then
run `source ~/.zshrc`:

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

Launch the configured emulator and run only its active CPU architecture:

```sh
emulator -avd KelmaPixel -dns-server 8.8.8.8,1.1.1.1

# In another terminal:
cd ~/projects/KelmaMobile
npm run android -- --active-arch-only
```

Use `emulator -list-avds` if the virtual device has a different name.

### Quick Android device testing

1. On the Android phone, enable Developer Options by tapping **Build number** 7 times.
2. Enable **USB debugging**.
3. Plug the phone into the computer and accept the USB debugging/RSA prompt.
4. Run:

```sh
npm run android:doctor
npm run android:device
```

`android:device` starts Metro if needed, finds the first connected phone, forwards Metro (`tcp:8081`), builds, installs, and launches KelmaMobile. If multiple devices are connected, choose one with:

```sh
# macOS/Linux/Git Bash
ANDROID_SERIAL=<adb-device-id> npm run android:device

# Windows PowerShell
$env:ANDROID_SERIAL='<adb-device-id>'; npm run android:device
```

Useful APK commands:

```sh
npm run android:apk:debug     # build debug APK only
npm run android:install:debug # build/install/launch debug APK
npm run android:apk:release   # build unsigned release APK for F-Droid
npm run android:apk:direct    # build signed GitHub/Obtainium APKs (maintainer only)
```

For iOS:

```sh
cd ios
bundle install
bundle exec pod install
cd ..
npm run ios
```

The Android/F-Droid release procedure is in
[`docs/android-release.md`](./docs/android-release.md). The unsigned AltStore
procedure and required iOS sync regression suite are in
[`docs/ios-release.md`](./docs/ios-release.md).

Both builds use Anki core `25.09.2` plus a small pinned mobile patch at commit
[`1b6b59f21e9c`](https://github.com/jeretmccoy/anki/commit/1b6b59f21e9c23e965c360ce00b3fb35a36100fa),
and compile the `vendor/anki` source through `rust/kelma-core`. Gradle invokes
`scripts/build-rust-for-android.sh` for the requested Android ABI; CocoaPods does
the equivalent for iOS. The first native build takes longer while Rust compiles
rslib. Later TypeScript changes still use React Native Fast Refresh; Rust,
Kotlin, Java, Swift, and Objective-C++ changes require a native rebuild.

## Source baselines

- AnkiDroid UX reference: <https://github.com/ankidroid/Anki-Android>
- Pinned Anki/rslib fork: [`vendor/anki`](./vendor/anki) at
  [`kelma-mobile-25.09.2`](https://github.com/jeretmccoy/anki/tree/kelma-mobile-25.09.2)

The pinned submodule is compiled from source as part of both reproducible native
builds; no sibling checkout is a runtime dependency.

## Licensing

Kelma is licensed as a whole under AGPL-3.0-or-later. Anki's Rust backend uses
the same license; compatible third-party components retain their original
licenses and notices. See [`COPYING`](./COPYING) and
[`docs/THIRD_PARTY_NOTICES.md`](./docs/THIRD_PARTY_NOTICES.md).

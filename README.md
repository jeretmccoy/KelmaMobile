# Kelma Mobile

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

On iOS these run through `rust/kelma-core` (the Kelma C ABI over the pinned
`vendor/anki`). On Android they run through the same rslib via AnkiDroid's
`rsdroid` backend. Both expose the identical coarse JSON contract.

### Sync

Kelma ships pointed at the production **KelmaSync v2** REST service at
`https://sync2.kelma.tech`. The default endpoint lives in
[`src/config.ts`](./src/config.ts) (`DEFAULT_SYNC_ENDPOINT`). Native sync compares
canonical checksums, transfers notes/cards in 3,000-item batches, converts
collection-relative due dates, applies tombstones safely, uploads mobile-created
metadata and deletions, and transfers referenced media with 50 connections.
Tied content changes and deletion-vs-local-edit conflicts always ask the user
which result to keep.


## Development

Requirements:

- Node.js 22.11 or newer
- Android Studio/JDK for Android
- Xcode and CocoaPods for iOS

```sh
git submodule update --init --recursive
npm install
npm test
npm run lint
npm run android
```

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
npm run android:apk:debug       # build debug APK only
npm run android:install:debug   # build/install/launch debug APK
npm run android:apk:release     # build release APK only, currently debug-signed
npm run android:install:release # build/install/launch standalone release APK
```

For iOS:

```sh
cd ios
bundle install
bundle exec pod install
cd ..
npm run ios
```

The unsigned AltStore release procedure and required sync regression suite are
in [`docs/ios-release.md`](./docs/ios-release.md).

Both builds target Anki core `25.09.2` at commit `3890e12c9e48`. iOS compiles
the pinned `vendor/anki` source through `rust/kelma-core`. The first iOS build
takes longer because Xcode cross-compiles rslib. Later TypeScript changes still
use React Native Fast Refresh; Rust, Kotlin, Swift, and Objective-C++ changes
require a native rebuild.

> Android is not part of the iOS 1.1 rollout: its React Native module is still a
> development stub. The real Android bridge is the next rollout milestone.

## Source baselines

- AnkiDroid: `~/projects/ankidroid-source`
- Pinned Anki/rslib: `vendor/anki` (Git submodule)
- Kelma sync server: `~/projects/kelma_sync`

The AnkiDroid and KelmaSync sibling paths are reference checkouts, not runtime
dependencies. The pinned Anki submodule is part of Kelma's reproducible iOS
build.

## Licensing

Kelma is licensed as a whole under AGPL-3.0-or-later. Anki's Rust backend uses
the same license; compatible third-party components retain their original
licenses and notices. See [`COPYING`](./COPYING) and
[`docs/THIRD_PARTY_NOTICES.md`](./docs/THIRD_PARTY_NOTICES.md).

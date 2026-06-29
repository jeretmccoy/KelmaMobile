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
| `syncLogin` | `sync::login::sync_login` |
| `syncCollection` | `Collection::normal_sync` |
| `fullSync` | `Collection::full_upload` / `full_download` |

On iOS these run through `rust/kelma-core` (the Kelma C ABI over the pinned
`vendor/anki`). On Android they run through the same rslib via AnkiDroid's
`rsdroid` backend. Both expose the identical coarse JSON contract.

### Sync

Kelma ships pointed at **KelmaSync**, the self-hosted, Anki-wire-compatible sync
server (`~/projects/kelma_sync`). The default endpoint lives in
[`src/config.ts`](./src/config.ts) (`DEFAULT_SYNC_ENDPOINT`). Sign in on the deck
screen with your KelmaSync credentials; a normal sync runs automatically and the
app falls back to a full download when the server and device schemas diverge.


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

For iOS:

```sh
cd ios
bundle install
bundle exec pod install
cd ..
npm run ios
```

Both builds use Anki core `25.09.2` at commit `3890e12c9e48`. Android loads it
through `anki-android-backend` `0.1.64-anki25.09.2`; iOS compiles the pinned
`vendor/anki` source through `rust/kelma-core`. The first iOS build takes longer
because Xcode cross-compiles rslib. Later TypeScript changes still use React
Native Fast Refresh; Rust, Kotlin, Swift, and Objective-C++ changes require a
native rebuild.

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

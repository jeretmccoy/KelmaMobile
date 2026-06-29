# Kelma Mobile Architecture

## Non-negotiable compatibility rule

Anki's Rust `rslib` is Kelma's source of truth.

React Native must not reimplement the collection schema, scheduler, FSRS,
search grammar, template rules, undo semantics, import/export behavior, or sync
protocol. A feature that requires those behaviors is not complete until it is
connected to `rslib`.

```text
React Native UI (TypeScript)
        │ typed app operations
        ▼
NativeKelmaCore TurboModule
        │ platform-thin adapter
        ▼
Kelma Rust bridge
        │ protobuf service + method + bytes
        ▼
Anki rslib ── SQLite collection / media / sync
```

The interface may share UI state such as selected tabs, dialog visibility, and
draft text with TypeScript. Persistent study state belongs to the core.

## Current state

Both platforms now exercise the real backend:

```text
Android:
  TypeScript → NativeKelmaCoreModule.kt
    → anki-android-backend / rsdroid → JNI → Anki rslib

iOS:
  TypeScript → RCTNativeKelmaCore.mm
    → Kelma C ABI → static Rust library → Anki rslib
```

`getCoreInfo()` constructs and closes a real backend instance on each platform.
It verifies packaging, native loading, TurboModule registration, and the
JS/native contract before collection work begins. The portable iOS C ABI also
exposes backend open, protobuf method dispatch, close, and buffer ownership.

## Target core bridge

Anki's backend API is already expressed as protobuf request and response
messages. The portable bridge should preserve the small handle-based shape
proven by AnkiDroid:

1. `open_backend(init_bytes) -> backend_handle`
2. `run_method(backend_handle, service, method, input_bytes) -> output_bytes`
3. `close_backend(backend_handle)`

Platform code owns only memory/lifecycle conversion:

- Android: JNI/Kotlin
- iOS: C ABI/Swift with a minimal Objective-C++ TurboModule shim

Business operations exposed to TypeScript should be coarse enough to avoid
thousands of bridge crossings. Generated protobuf types or intentionally
versioned DTOs must define each boundary; untyped maps are not a data layer.

## Collection lifecycle

Each profile owns:

```text
<application-support>/<profile-id>/
  collection.anki2
  collection.media/
  collection.media.db
```

One long-lived backend handle owns one open collection. Calls are serialized
on a dedicated native queue. React rendering must never block on SQLite,
network, media, or scheduler operations.

The first collection operation will:

1. resolve the platform application-support directory;
2. initialize a backend with the selected UI languages;
3. open or create `collection.anki2` through rslib;
4. request deck names/counts from rslib; and
5. return an immutable deck-list snapshot to React Native.

## Sync

The client uses rslib's sync implementation and points it at KelmaSync. The
React Native layer supplies credentials, endpoint selection, user intent, and
progress presentation. It does not implement the Anki sync state machine.

KelmaSync remains wire-compatible with Anki's protocol. Client and server core
versions must be tracked independently and tested against fixture collections.

## Rendering

Card template evaluation and scheduling inputs come from rslib. React Native
hosts the reviewer shell and a platform WebView renders card HTML/CSS/MathJax.
WebView messages are treated as untrusted input and must use an explicit
allowlist.

## Compatibility gates

A ported feature needs:

- fixture tests against known `.anki2`/`.apkg` data;
- identical Android and iOS core contract behavior;
- migrations exercised from supported Anki schema versions;
- round-trip sync tests with KelmaSync; and
- no JavaScript-side writes to Anki's SQLite database.

## Upstream strategy

AnkiDroid is the UX and Android behavior reference. Anki/rslib is the data and
protocol authority. Keep upstream commits recorded in
[`PORTING.md`](./PORTING.md), isolate Kelma-specific changes, and contribute
generally useful fixes upstream where practical.

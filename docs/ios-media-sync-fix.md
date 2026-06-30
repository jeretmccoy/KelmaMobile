# Media sync: `AlreadyExists` on case-aliased files (iOS)

## Symptom

Media sync aborted partway through with:

```
Media sync stopped after N files (… bytes): FileIoError {
  source: FileIoError {
    path: "…/Application Support/kelma/default/collection.media/a.mp3",
    op: Write,
    source: Os { code: 17, kind: AlreadyExists, message: "File exists" }
  }
}
```

It always failed on the same file and never progressed past it, so the device
could never finish pulling media.

## Cause

The collection's media set contained two filenames that differ only by case
(e.g. `A.mp3` and `a.mp3`). The Kelma sync server stores them as distinct files,
but the device writes them into one directory.

The **iOS simulator sandbox filesystem is inconsistent about case**: it reports
the lowercase name as *absent* to `open()` (so the "overwrite in place" path
isn't taken) yet still **rejects `O_CREAT` with `EEXIST`** because the
differently-cased sibling already exists. rslib's media writer
(`add_file_from_ankiweb` → `write_file`) only did a plain `std::fs::write`, so it
surfaced that `EEXIST` and stopped the whole media sync.

(This is hard to reproduce on a normal case-insensitive macOS volume, where both
`open` and `O_CREAT` resolve to the same inode and the write just succeeds —
which is why earlier "case-insensitive `O_CREAT`" reasoning didn't match.)

## Fix

`write_media_file_idempotently` in
[`vendor/anki/rslib/src/media/files.rs`](../vendor/anki/rslib/src/media/files.rs)
makes the media write tolerate the collision instead of failing:

1. Open the path with `write + truncate` and **no create flag**. If it opens
   (the file, or a case-alias the OS resolves), overwrite it in place.
2. Otherwise create it. If creation returns `AlreadyExists`, **remove the
   case-insensitive sibling in that directory and retry the create.**

So a case collision resolves to last-write-wins instead of wedging the sync.
This is the best achievable on a case-insensitive volume (two case-aliased media
files can't coexist as separate files there).

## Operational notes

- The fix lives in the **`vendor/anki` git submodule** as a working-tree change.
  Commit it there and bump the submodule pointer to persist it.
- The native library is built by
  [`scripts/build-rust-for-xcode.sh`](../scripts/build-rust-for-xcode.sh) during
  the Xcode build (a CocoaPods `script_phase` in
  [`KelmaCore.podspec`](../KelmaCore.podspec), which lists `files.rs` as a build
  input). **A source change only takes effect after the app is rebuilt** —
  `npm run ios`. If a stale binary is suspected, force a clean rebuild:
  ```bash
  rm -rf rust/kelma-core/target/ios
  rm -rf ~/Library/Developer/Xcode/DerivedData/KelmaMobile-*
  npm run ios
  ```
- If a device is stuck with a half-downloaded/inconsistent media folder, clear it
  so the next sync re-downloads cleanly (it's a re-downloadable local copy):
  ```bash
  find ~/Library/Developer/CoreSimulator/Devices -name collection.media -type d -exec rm -rf {} +
  find ~/Library/Developer/CoreSimulator/Devices -name collection.media.db2 -delete
  ```

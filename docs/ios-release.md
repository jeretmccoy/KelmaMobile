# iOS release process

Kelma iOS is currently distributed as an unsigned IPA through the Kelma
AltStore source. AltStore signs it for each installer. Keep the bundle ID
`tech.kelma.mobile.dev` so upgrades preserve the existing collection.

## Release gates

```sh
npm run typecheck
npm run lint -- --quiet
npm test -- --runInBand
cargo test --manifest-path rust/kelma-core/Cargo.toml
cargo test --manifest-path rust/kelma-core/Cargo.toml \
  native_v2_fresh_pull_updates_scheduling_and_tombstones -- --ignored
```

The ignored test requires the isolated local v2 server on `localhost:8081`. It
creates a unique user and verifies fresh restore, existing-note updates,
collection-relative scheduling, media upload/download/replacement, outgoing
Mobile deletions, incoming tombstones, and deletion conflict approval.

## Build the device app

```sh
rm -rf /tmp/KelmaMobileReleaseDerived
cd ios
xcodebuild \
  -workspace KelmaMobile.xcworkspace \
  -scheme KelmaMobile \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/KelmaMobileReleaseDerived \
  CODE_SIGNING_ALLOWED=NO \
  build
```

Package `Build/Products/Release-iphoneos/KelmaMobile.app` under a top-level
`Payload/` directory in `dist/ios-altstore/KelmaMobile.ipa`. Update the version,
size, SHA-256, date, and release notes in `dist/ios-altstore/source.json`.
Preserve older IPA filenames referenced by historical version entries.

Copy the AltStore directory into `anki_ai_frontend/public/altstore/`, run the
frontend production build, and deploy through that repository's normal GitHub
Actions workflow.

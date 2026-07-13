# Android / F-Droid release process

Kelma's permanent Android application ID is `tech.kelma.mobile`. Official
F-Droid builds are deliberately unsigned: F-Droid rebuilds each tagged version
from public source and applies its repository signing key.

## Prerequisites

- clean public source at <https://github.com/jeretmccoy/KelmaMobile>;
- the pinned `vendor/anki` submodule commit available from its public fork;
- Node.js 22.11 or newer;
- Rust 1.96.0 via `rustup`;
- Android SDK 36 and NDK `27.1.12297006`;
- Android Studio's bundled JDK 21 (do not build with Java 25).

## Prepare a version

1. Update `versionName` and monotonically increase `versionCode` in
   `android/app/build.gradle`.
2. Keep `package.json` and `rust/kelma-core/Cargo.toml` on the same public
   version.
3. Add `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`.
4. Run the validation suite:

   ```sh
   npm ci
   npm test -- --runInBand
   npm run typecheck
   npm run lint
   npm run rust:test
   ```

5. Build the unsigned release APK from source:

   ```sh
   npm run android:apk:release
   ```

   Output: `android/app/build/outputs/apk/release/app-release-unsigned.apk`.

6. Confirm its package/version and confirm that it has no signature:

   ```sh
   aapt dump badging android/app/build/outputs/apk/release/app-release-unsigned.apk | head
   apksigner verify android/app/build/outputs/apk/release/app-release-unsigned.apk
   ```

   `apksigner` must report that the APK does not verify; fdroidserver signs it.

7. Commit, push, and create an annotated tag named `android-v<version>`, for
   example `android-v1.1.4`.

Never commit an Android signing key, keystore password, account token, or a
locally signed release APK.

## Official F-Droid catalog

F-Droid does not accept an uploaded APK. Submit the public source/tag to the
[F-Droid Request For Packaging tracker](https://gitlab.com/fdroid/rfp/-/issues),
or contribute `metadata/tech.kelma.mobile.yml` directly to
[`fdroiddata`](https://gitlab.com/fdroid/fdroiddata). The recipe must initialize
git submodules, run `npm ci`, install the Rust Android target, use NDK 27, and
build the unsigned `release` variant.

After the first recipe is accepted, F-Droid's update checker can follow tags
matching `android-v%v` and build later releases automatically.

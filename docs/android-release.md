# Android release process

Kelma has two intentionally separate Android distribution identities:

| Channel | Application ID | Signing authority |
| --- | --- | --- |
| Official F-Droid | `tech.kelma.mobile` | F-Droid |
| GitHub / Obtainium | `tech.kelma.mobile.direct` | Kelma upstream |

Keeping separate IDs prevents Android signature conflicts and lets both builds
coexist on one device. F-Droid builds remain unsigned in the source checkout;
fdroidserver signs them after rebuilding from the public tag.

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
2. Keep `package.json`, `src/config.ts`, the iOS marketing version, and
   `rust/kelma-core/Cargo.toml` on the same public version.
3. Add `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`.
4. Run the validation suite:

   ```sh
   npm ci
   npm test -- --runInBand
   npm run typecheck
   npm run lint
   npm run rust:test
   ```

5. Commit and push, then create and push an annotated tag named
   `android-v<version>`, for example `android-v1.1.5`.

Never commit an Android signing key, keystore password, account token, or APK.

## Official F-Droid build

Build the unsigned package from source:

```sh
npm run android:apk:release
```

Output: `android/app/build/outputs/apk/release/app-release-unsigned.apk`.
Confirm its identity and lack of signature:

```sh
aapt dump badging android/app/build/outputs/apk/release/app-release-unsigned.apk | head
apksigner verify android/app/build/outputs/apk/release/app-release-unsigned.apk
```

The application ID must be `tech.kelma.mobile`, and `apksigner` must report that
the APK does not verify. The F-Droid recipe must initialize git submodules, run
`npm ci`, install the Rust Android target, use NDK r27b, and assemble `release`.
The packaging request is tracked at
<https://gitlab.com/fdroid/rfp/-/work_items/4111>.

## GitHub / Obtainium build

The direct build is enabled only with `-PkelmaDirect=true`. The release script
retrieves the local password from macOS Keychain, builds signed APKs for each
Android ABI, verifies their signing certificate, and writes artifacts under
`dist/android/`:

```sh
npm run android:apk:direct
```

The upstream signing certificate SHA-256 is:

```text
f7cca2aaf28eb372e35fb797e0e7a481ff90137afbc9d37a54a04bf681430583
```

Its public certificate is committed as
[`kelma-direct-signing-certificate.pem`](./kelma-direct-signing-certificate.pem).
The private keystore and password must remain outside Git and must be backed up
securely for the lifetime of the app. Losing the private key makes updates to
existing direct installations impossible.

After validating the APKs, attach every architecture APK and `.sha256` file to
the matching GitHub release. Obtainium users add this source URL:

```text
https://github.com/jeretmccoy/KelmaMobile
```

Obtainium detects the APKs from GitHub Releases and selects by CPU architecture.
It does not require Google Play or a Google developer account.

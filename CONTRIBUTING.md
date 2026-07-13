# Contributing

Kelma is licensed under AGPL-3.0-or-later. Contributions are welcome through
GitHub issues and pull requests.

## Development

1. Clone with submodules: `git clone --recurse-submodules https://github.com/jeretmccoy/KelmaMobile.git`.
2. Install Node.js 22.11+, Rust 1.96, and the platform SDK described in the README.
3. Run `npm ci`, `npm test`, `npm run typecheck`, and `npm run lint` before opening a pull request.
4. Keep persistent collection, scheduler, rendering, import/export, and sync behavior in the Rust core rather than reimplementing it in TypeScript.

Do not commit credentials, signing keys, generated APK/IPA files, dependency
folders, or user collection/media data.

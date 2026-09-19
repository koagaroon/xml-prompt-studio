# Third-Party Notices

## JavaScript runtime notices

The **Licenses** button in the application opens an offline notice viewer.
`npm run dev` and `npm run build` generate `public/third-party-notices.txt`
from the exact installed versions in `package-lock.json`, retaining full
license and NOTICE files for every production npm package. Vite's package
license is also retained because its modulepreload helper is emitted into
the application. The build verifies the copy in `dist/` byte-for-byte; Tauri
embeds that directory in the portable executable.

The frontend inventory includes React, React DOM, Scheduler, `@tauri-apps/api`,
and the bundled assets below. A missing license or a mismatch between installed
packages and the lockfile fails generation. Additional package notices may
also describe code used only during development.

## Windows native notices

The same offline text includes the reviewed inventory in
[`licenses/native/manifest.json`](licenses/native/manifest.json), with full
license texts and provenance under [`licenses/native/`](licenses/native/).
Coverage is for `x86_64-pc-windows-msvc`. It includes dependencies reached
through normal and build-support edges of the locked Cargo graph, including
transitive packages. This deliberately conservative inventory does not claim
that the linker retained every package's entire code.

The inventory records each package's identity, version, source, selected license,
enabled features, and local notice files. It separately records the bundled
WebView2 static loader, its Microsoft license, and the exact Rust toolchain's
standard-library copyright notices. The WebView2 loader's payload is checked
against the reviewed artifact hash; its terms are not inferred from the wrapper
crate's license. The WebView2 browser runtime itself is an external prerequisite.

`npm run native-notices:check` compares the Windows inventory with Cargo's
locked dependency graph, compiler identity, and bundled artifacts. The Tauri
build hook runs this check before building the frontend. Missing entries or
texts, changed features or dependency identities, and stale input fingerprints
fail the check. `npm run native-notices:check -- --print-inventory` prints a
proposal for review; it does not acquire license texts or approve their terms.

This check validates the committed standard Windows profile, including Tauri's
automatic `tauri/custom-protocol` feature. Custom `--features`, platform/config
overrides, or compiler selection in Cargo configuration require a separate
review of the resulting graph and compiler notices before distribution. The
check refuses compiler/wrapper environment overrides rather than attributing
their output to the compiler found on `PATH`.

Frontend notice generation reads only the local inventory and source files,
checks their fingerprints and text hashes, and remains usable without Rust.
Do not hand-edit `public/third-party-notices.txt`; update the reviewed source
inventory and regenerate it. Preserve the full upstream texts when updating.

Exact crate source-download links accompany the native notices, including
unmodified dependencies available under the Mozilla Public License 2.0.
The original Rust standard-library copyright notice is retained alongside its
plain-text rendering. Native coverage for other targets is unverified: source
builds remain available, but their dependency and artifact notices require a
separate review before distribution.

## Bundled fonts

The application bundles font files in `public/fonts/`, each licensed under
the SIL Open Font License (OFL) Version 1.1, not under the repository's MIT
License:

- **Inter** — Copyright (c) 2016 The Inter Project Authors.
  See `public/fonts/Inter-LICENSE.txt`.
- **JetBrains Mono** — Copyright 2020 The JetBrains Mono Project Authors.
  See `public/fonts/JetBrainsMono-OFL.txt`.

See `public/fonts/LICENSES.md` for a quick-reference index.

## Icon attribution

The moon icon has the same path geometry as [Feather's moon icon](https://github.com/feathericons/feather/blob/v4.29.2/icons/moon.svg).
The verified [Feather MIT license](public/licenses/Feather-MIT.txt) and its
copyright attribution are included alongside it. The full text is also
included in the offline notice viewer.

(This file exists so the `LICENSE` file stays pure MIT — license-detection
tooling fuzzy-matches the file body, and substantial appended non-MIT text
can break the repository's license identification.)

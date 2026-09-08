# Third-Party Notices

## JavaScript runtime notices

The **Licenses** button in the application opens an offline notice viewer.
`npm run dev` and `npm run build` generate `public/third-party-notices.txt`
from the exact installed versions in `package-lock.json`, retaining full
license and NOTICE files for every production npm package. Vite's package
license is also retained because its modulepreload helper is emitted into
the application. The build verifies the copy in `dist/` byte-for-byte; Tauri
embeds that directory in the portable executable.

The inventory includes React, React DOM, Scheduler, `@tauri-apps/api`, and
the bundled assets below. A missing license or a mismatch between installed
packages and the lockfile fails generation. Additional package notices may
also describe code used only during development. This automated inventory
does not claim complete native Rust dependency license coverage; the README
lists the principal native dependency attributions separately.

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

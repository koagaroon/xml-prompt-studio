# XML Prompt Studio

A Windows desktop app for composing XML-tagged prompts to send to Claude Code and other CLI tools.

Build nested structures like `<feedback>...<reply>...</reply></feedback>` in a focused three-column UI — element outline on the left, the focused element's editor in the middle, and a live formatted preview on the right — then click **Copy XML** to paste the result straight into a chat.

The app is deliberately not a generic XML IDE: element-only, no attributes, no namespaces, no schema. Tag-name validation tracks the full W3C XML 1.0 §2.3 `Name` production, so any letter the spec allows — including Chinese, Japanese, Korean, Greek — is a valid tag name.

## Why it exists

Prompt engineering with Claude often benefits from explicit XML-style structure (`<feedback>…</feedback>`, `<question>…</question>`, etc.). Hand-typing these in a chat window is fiddly and error-prone. This app makes building and copying nested structures a few clicks, with live preview and validation.

## Features

- Element-only XML editing — nested children, sibling insertion, reorder up/down, delete
- Validation against the full W3C XML 1.0 §2.3 `Name` production — Unicode letters and ideographs work as tag names
- Live formatted preview that exactly mirrors what gets copied to the clipboard
- One-click preset chips (`feedback` / `question` / `instruction` / `extra`) that fill the Tag Name input, auto-suffixing `_1`, `_2`, … to keep siblings unique
- Persistent red row highlight + red input border for any element with a validation or duplicate-name issue
- WYSIWYG text content — `<`, `&`, `>` go to the clipboard verbatim, suitable for LLM prompts (which are pattern-matched, not strictly XML-parsed)
- Confirmation modal on **New Blank** to prevent accidental wipe
- Copy XML success feedback via a 3-second green bloom on the preview pane
- Dark / light theme toggle with system-preference default and persisted choice
- DPI-aware startup sizing and centered window placement
- Bundled fonts (Inter + JetBrains Mono) for consistent look across machines

## Tech stack

- [Tauri 2](https://tauri.app/) (Rust core + WebView2)
- [React](https://react.dev/) 18 with TypeScript
- [Vite](https://vite.dev/) frontend build
- [arboard](https://github.com/1Password/arboard) clipboard layer with cross-platform CLI fallbacks (Windows `clip.exe`, macOS `pbcopy`, Linux `wl-copy` / `xclip`) for RDP / locked-clipboard / sandboxed-Wayland cases
- [Inter](https://rsms.me/inter/) and [JetBrains Mono](https://www.jetbrains.com/lp/mono/) fonts, bundled under SIL OFL 1.1

## Install & Run

### Prerequisites (Windows)

- [Node.js](https://nodejs.org/) v20+
- [Rust toolchain](https://rustup.rs/) (`rustup` + `cargo`)
- Visual Studio Build Tools (MSVC linker)
- WebView2 (pre-installed on Windows 10 / 11)

### Development

```powershell
npm install          # one-time, installs JS deps into node_modules/.bin
npm run tauri dev    # first run compiles the Rust crates, slow once
```

If you see `'tauri' is not recognized`, `npm install` was skipped.

### Production build

```powershell
npm run tauri build
```

The portable single-exe lands at `target/release/xml-prompt-studio.exe` — installer bundling is off by default (`bundle.active: false` in `tauri.conf.json`); flip it to `true` for a one-off MSI / NSIS bundle.

### Type check

```powershell
npx tsc --noEmit
```

### Rust check

The Rust crate lives in `src-tauri/` (standard Tauri 2 layout):

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

Or from inside that directory:

```powershell
cd src-tauri
cargo check
```

## Future ideas

Direction-compatible extensions worth considering:

- Smarter duplicate-name guidance ("merge these into one element with multi-line text content")
- User-configurable preset list (currently hard-coded to four names)
- Undo / redo — the data model is already immutable, a history stack is straightforward

## Non-goals

Intentional product boundaries, not missing features:

- Full XML editor parity
- Attributes, namespaces, DTDs, or schema tooling
- Multiple top-level elements (single-root per W3C XML 1.0 §2.1)
- Complex document import
- Rich-text editing inside text content
- Multi-document workspace features

## License

Copyright (c) 2026 koagaroon

The application's source code is licensed under the [MIT License](LICENSE).

### Bundled fonts

The fonts in `public/fonts/` ship with the application binary under their own license, the SIL Open Font License (OFL) Version 1.1 — separate from the project's MIT license. The verbatim license texts are included alongside the font files; see [`public/fonts/LICENSES.md`](public/fonts/LICENSES.md) for an index, and the [`Inter-LICENSE.txt`](public/fonts/Inter-LICENSE.txt) / [`JetBrainsMono-OFL.txt`](public/fonts/JetBrainsMono-OFL.txt) files for the full text.

### Third-party dependencies

#### Runtime (shipped with the application)

| Component | License | Usage |
| --- | --- | --- |
| [Tauri](https://tauri.app/) | MIT OR Apache-2.0 | Desktop application framework |
| [@tauri-apps/api](https://github.com/tauri-apps/tauri) | MIT OR Apache-2.0 | Frontend-to-Rust IPC bridge |
| [React](https://react.dev/) | MIT | UI framework |
| [arboard](https://github.com/1Password/arboard) | MIT OR Apache-2.0 | Cross-platform clipboard access (Rust) |
| [Inter](https://rsms.me/inter/) | SIL OFL 1.1 | Bundled UI font (Regular / Medium / Bold) |
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | SIL OFL 1.1 | Bundled monospace font (Regular / SemiBold) |

#### Build-time only (not shipped)

| Component | License | Usage |
| --- | --- | --- |
| [TypeScript](https://www.typescriptlang.org/) | Apache-2.0 | Type checking |
| [Vite](https://vite.dev/) | MIT | Frontend build tool |
| [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | MIT | React support for Vite |
| [@tauri-apps/cli](https://github.com/tauri-apps/tauri) | MIT OR Apache-2.0 | Tauri build and dev CLI |
| [tauri-build](https://github.com/tauri-apps/tauri) | MIT OR Apache-2.0 | Tauri Rust build script helper |

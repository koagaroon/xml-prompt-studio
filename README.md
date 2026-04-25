# XML Prompt Studio

XML Prompt Studio is a small Windows desktop app for building XML prompts with a focused, element-only workflow.

The project deliberately avoids becoming a generic XML IDE. It is optimized for one job: help you write nested XML prompt structures quickly, keep the currently edited element obvious, and show a readable formatted preview that can be copied directly into a CLI workflow.

## Why it exists

This app reduces prompt-authoring friction. It is optimized for composing XML-tag-wrapped messages (`<feedback>`, `<reply>`, `<question>`, etc.) for conversations with Claude Code and other CLI tools. The preview pane produces formatted XML that gets copied to the clipboard and pasted into a chat.

## Features

- Element-only XML editing
- Nested child elements
- Sibling insertion
- Line reordering
- Element deletion and root reset
- Readable XML preview
- Preview-side selection indicator
- Copy XML to clipboard through Tauri
- Duplicate sibling-name warnings
- Fixed-height scrollable line list
- DPI-aware startup sizing and centered window placement

## Tech Stack

- Tauri 2
- React
- TypeScript
- Vite
- Rust

## Install & Run

### Prerequisites (Windows)

- [Node.js](https://nodejs.org/) (v20+)
- [Rust toolchain](https://rustup.rs/) (`rustup` + `cargo`)
- Visual Studio Build Tools (MSVC linker)
- WebView2 (pre-installed on Windows 10/11)

### Development

```powershell
npm install          # installs @tauri-apps/cli into node_modules/.bin
npm run tauri dev    # first run compiles the Rust deps, slow once
```

If you see `'tauri' is not recognized`, `npm install` was skipped.

### Frontend build

```powershell
npm run build
```

### Type check

```powershell
npx tsc --noEmit
```

### Rust check

The Rust crate lives at the repo root (no `src-tauri/` subdirectory), so `cargo` commands run from the repo root:

```powershell
cargo check
```

## Future Ideas

Reasonable extensions if they continue to support the same product direction:

- Keyboard navigation for moving between lines
- Better duplicate suggestions
- Optional quick-insert common prompt elements
- Export/import of the current tree
- Undo/redo

## Non-Goals for Now

- Full XML editor parity
- Attributes, namespaces, DTDs, or schema tooling
- Complex document import
- Rich text editing
- Multi-document workspace features

## License

Copyright (c) 2026 koagaroon

This project is licensed under the [MIT License](LICENSE).

### Third-Party Dependencies

All dependencies use licenses compatible with MIT.

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

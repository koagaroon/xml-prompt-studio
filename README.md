# XML Prompt Studio

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![GitHub release](https://img.shields.io/github/v/release/koagaroon/xml-prompt-studio?include_prereleases)](https://github.com/koagaroon/xml-prompt-studio/releases) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

> **XML Prompt Studio 是一款桌面工具，用于编写、预览和复制 XML 风格的大语言模型（LLM）提示词。** 你可以把 `<instructions>`、`<context>`、`<input>`、`<example>` 等片段组织成清晰的标签结构，然后一键复制到 Claude Code 或其他 CLI / chat 工具中。
>
> _XML Prompt Studio is a desktop app for writing, previewing, and copying XML-style prompts for large language model (LLM) workflows._ You can organize sections such as `<instructions>`, `<context>`, `<input>`, and `<example>` into a clear tag structure, then copy them into Claude Code or another CLI/chat tool.

这款应用有意保持聚焦：它是一个 XML 提示词创作工具，而不是通用的 XML IDE。它只使用元素标记提示词、允许多个顶层 section、支持同名标签重复出现、允许 Unicode 标签名，并原样输出文本内容（所见即所得，WYSIWYG）。

This app is intentionally focused: it is an XML prompt authoring tool, not a general-purpose XML IDE. It uses element-only prompt markup, allows multiple top-level sections, supports repeated same-name tags, accepts Unicode tag names, and outputs text content exactly as written (WYSIWYG).

---

## 目录 | Contents

- [下载 | Download](#下载--download)
- [功能 | Features](#功能--features)
- [支持范围 | Supported Scope](#支持范围--supported-scope)
- [使用方法 | Usage](#使用方法--usage)
- [预览与复制机制 | Preview and Copy Contract](#预览与复制机制--preview-and-copy-contract)
- [从源码构建 | Build from Source](#从源码构建--build-from-source)
- [架构 | Architecture](#架构--architecture)
- [许可证 | License](#许可证--license)

---

## 下载 | Download

Windows 用户可在 [Releases](https://github.com/koagaroon/xml-prompt-studio/releases) 页面下载免安装的便携版 exe。

Windows users can download the portable, no-installer exe from the [Releases](https://github.com/koagaroon/xml-prompt-studio/releases) page.

- **`xml-prompt-studio.exe`** — 图形界面（GUI），适合手动编写和复制提示词结构
- **`xml-prompt-studio.exe`** — graphical interface (GUI), for manually composing and copying prompt structures

> [!NOTE]
> 目前项目优先支持 Windows：代码和剪贴板层预留了 macOS / Linux 的备用方案，但现阶段仅测试与交付 Windows 便携版。
>
> The project currently prioritizes Windows: the codebase and clipboard layer include macOS / Linux fallback options, but only Windows portable builds are tested and shipped at this stage.

macOS / Linux 用户请参考下方「从源码构建」。

macOS / Linux users, see "Build from Source" below.

---

## 功能 | Features

| 功能 / Feature | 说明 / Description |
| --- | --- |
| **三栏编辑界面 / Three-column editor** | 左侧元素列表，中间编辑当前元素，右侧实时预览 / Element outline on the left, focused element editor in the middle, live preview on the right |
| **多顶层提示词结构 / Multiple top-level sections** | 可并列创建 `<instructions>`、`<context>`、`<input>` 等顶层标签，不会强制包进隐藏根节点 / Create top-level tags side by side, with no forced hidden wrapper root |
| **嵌套元素编辑 / Nested element editing** | 添加子元素、同级元素，上移 / 下移，删除元素 / Add children, add siblings, move elements up/down, and delete elements |
| **同名标签有效 / Same-name tags are valid** | `<example>` / `<example>` 或 `<document>` / `<document>` 这类重复同级标签不会报错 / Repeated sibling tags such as `<example>` / `<example>` or `<document>` / `<document>` do not produce warnings |
| **XML Name 校验 / XML Name validation** | 标签名按 W3C XML 1.0 第五版 `Name` 规则校验，支持中文、日文、韩文、希腊文等 Unicode 名称 / Tag names are validated against the W3C XML 1.0 Fifth Edition `Name` production, including CJK, Greek, and other Unicode names |
| **可编辑预设标签 / Editable preset chips** | 默认 `feedback` / `question` / `instruction` / `extra`，可重命名、删除、添加，并持久化到 `localStorage` / Default chips are editable, removable, addable, and persisted through `localStorage` |
| **预览内容 = 剪贴板内容 / Preview matches clipboard** | 右侧预览就是实际复制到剪贴板的文本 / The right-side preview is the text copied to the clipboard |
| **剪贴板防护 / Clipboard safeguards** | 拒绝 NUL 字符、孤立 UTF-16 代理项以及超大 UTF-8 载荷，并在 Tauri 与浏览器两条剪贴板路径中均进行校验 / Rejects NUL characters, lone UTF-16 surrogates, and oversized UTF-8 payloads, with validation on both the Tauri and browser clipboard paths |
| **主题与窗口体验 / Theme and window polish** | 深色 / 浅色主题、系统偏好初始值、DPI 感知启动尺寸、居中显示 / Dark/light themes, system-preference default, DPI-aware startup sizing, and centered launch |

> [!TIP]
> **中文标签名可用** — 例如 `<反馈>`、`<上下文>`、`<示例>` 都是有效标签名，只要符合 XML `Name` 规则。
>
> **Chinese tag names work** — Names such as `<反馈>`, `<上下文>`, and `<示例>` are valid as long as they follow XML `Name` rules.

---

## 支持范围 | Supported Scope

XML Prompt Studio 输出的是提示词标记，而不是严格给 XML 解析器消费的数据文件。这个边界是产品设计的一部分。

XML Prompt Studio outputs prompt markup, not strict data files meant for XML parsers. This boundary is intentional.

| 项目 / Area | 当前行为 / Current behavior |
| --- | --- |
| 文档形态 / Document shape | 非空森林模型：多个顶层元素并列存在 / Non-empty forest model: multiple top-level elements can sit side by side |
| 元素结构 / Element structure | 只有元素名、文本内容、子元素 / Element name, text content, and child elements only |
| 文本内容 / Text content | WYSIWYG：`<`、`>`、`&` 会原样输出，不自动转义 / WYSIWYG: `<`, `>`, and `&` are emitted literally, not escaped |
| 标签名 / Tag names | 对修剪后的标签名应用 XML 1.0 `Name` 校验 / XML 1.0 `Name` validation is applied to trimmed tag names |
| 顶层分隔 / Top-level separators | 顶层 section 之间复制一个空行，与预览一致 / One blank line is copied between top-level sections, matching the preview |
| 属性 / Attributes | 不支持 / Not supported |
| 命名空间 / Namespaces | `:` 可作为 XML Name 字符，但不会解析 namespace 语义 / `:` is allowed by XML Name syntax, but namespace semantics are not parsed |
| DTD / XSD / Schema | 不支持 / Not supported |
| XPath / query tooling | 不支持 / Not supported |
| 严格单根 XML 文档 / Strict single-root XML document | 不强制；多个顶层 prompt section 是正常用法 / Not enforced; multiple top-level prompt sections are normal |
| 多文档工作区 / Multi-document workspace | 不支持 / Not supported |

---

## 使用方法 | Usage

### 基本流程 | Basic Workflow

1. 点击 **New Blank** 从一个新的 `<feedback>` section 开始。 / Click **New Blank** to start from a fresh `<feedback>` section.
2. 在左侧 **Elements** 列选择当前元素。 / Select the current element in the **Elements** column.
3. 在 **Tag Name** 中输入标签名，或点击 preset chip 自动填入标签名。 / Type a tag name in **Tag Name**, or click a preset chip to generate one.
4. 在 **Text Content** 中输入提示词正文。 / Write prompt text in **Text Content**.
5. 使用 **Add Child** / **Add Sibling** 扩展结构。 / Use **Add Child** / **Add Sibling** to grow the structure.
6. 在右侧 **Preview** 确认复制内容。 / Confirm the copied content in **Preview**.
7. 点击 **Copy XML**，把预览文本复制到剪贴板。 / Click **Copy XML** to copy the preview text to the clipboard.

### 示例 | Example

下面的示例展示多个顶层 section 并列输出，中间用一个空行分隔。

The example below shows multiple top-level sections emitted side by side, separated by one blank line.

```xml
<instructions>
  Be direct, precise, and explain tradeoffs.
</instructions>

<context>
  The user is editing a Tauri desktop app README.
</context>

<input>
  Rewrite this section in a clearer public-facing style.
</input>
```

### 预设标签 | Preset Chips

- 默认预设：`feedback`、`question`、`instruction`、`extra`
- 点击齿轮按钮进入编辑模式，可重命名、删除、添加或恢复默认预设
- 最多 6 个预设，每个名称最多 24 个 code points
- 预设名称必须是有效的 XML 名称，且在预设列表中唯一（不区分大小写）
- 点击预设会生成形如 `feedback_1`、`feedback_2` 的标签名；同级已有编号时会选择最小可用正整数

- Default presets: `feedback`, `question`, `instruction`, `extra`
- Click the cog button to enter edit mode, then rename, delete, add, or reset presets
- Up to 6 presets, with 24 code points per preset name
- Preset names must be valid XML names and unique within the preset list (case-insensitive)
- Clicking a preset generates names such as `feedback_1` and `feedback_2`; the smallest available positive suffix is used among siblings

---

## 预览与复制机制 | Preview and Copy Contract

预览区是信任界面：用户看到什么，复制出去的就应该是什么。

The preview is the trust surface: what you see should be what gets copied.

```text
XmlNode[] forest
  |
  v
buildPreview(roots)
  |
  +-- PreviewLine[] rendered in the Preview column
  |
  `-- PreviewLine.text joined with "\n"
        |
        v
      Clipboard payload
```

复制前会按优先级检查：

Copy checks run in this priority order:

1. 已有复制正在进行 / Another copy is already in progress
2. 预览尚未更新到最新编辑内容 / The preview has not updated to the latest edit yet
3. 存在无效标签名 / There are invalid tag names
4. 复制内容超过 50 MB UTF-8 上限 / The payload exceeds the 50 MB UTF-8 cap

如果预览仍在更新，**Copy XML** 会拒绝复制并提示等待，以防将过时的内容复制出去。

If the preview is still updating, **Copy XML** refuses the copy and asks you to wait, preventing outdated content from being copied.

---

## 从源码构建 | Build from Source

### 前置条件 | Prerequisites

- [Node.js](https://nodejs.org/) satisfying `^20.19.0 || ^22.13.0 || >=24`
- [Rust 工具链 / Rust toolchain](https://rustup.rs/) 1.82+
- Windows: Visual Studio Build Tools (MSVC linker)
- Windows: WebView2 (Windows 10 / 11 通常已预装 / usually pre-installed on Windows 10 / 11)
- macOS / Linux: 参考 / see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

### 开发 | Development

```powershell
npm install
npm run tauri dev
```

如果看到 `'tauri' is not recognized`，通常是还没有运行 `npm install`。

If you see `'tauri' is not recognized`, `npm install` was probably skipped.

### 构建 | Production Build

```powershell
npm run tauri build
```

Windows 便携式 exe 会生成到：

The Windows portable exe is produced at:

```text
src-tauri/target/release/xml-prompt-studio.exe
```

`src-tauri/tauri.conf.json` 当前设置 `bundle.active: false`，所以默认输出是便携式二进制文件，而不是 MSI / NSIS 安装包。

`src-tauri/tauri.conf.json` currently sets `bundle.active: false`, so the default output is a portable binary rather than an MSI / NSIS installer.

### 测试 | Testing

```powershell
npm run lint
npm run test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

拆分命令：

Split commands:

```powershell
npm run lint:js
npm run lint:css
npm run lint:rs
npm run test:js
npm run test:rs
```

---

## 架构 | Architecture

```text
+----------------------------------------------------------------------+
| React + TypeScript frontend                                          |
| - App.tsx: UI state, handlers, selection, confirmations              |
| - document.ts: immutable tree operations                             |
| - xml.ts: validation and preview rendering                           |
| - helpers.ts: pure limits, copy readiness, preset helpers            |
| - tauri.ts: clipboard bridge and startup show request                |
+----------------------------------------------------------------------+
                                   |
                                Tauri IPC
                                   |
+----------------------------------------------------------------------+
| Rust native layer                                                    |
| - copy_xml_to_clipboard: serialized clipboard boundary               |
| - arboard persistent clipboard handle                                |
| - native fallbacks: clip.exe / pbcopy / wl-copy / xclip              |
| - launch sizing, centering, hidden-window show fallback              |
+----------------------------------------------------------------------+
```

重要设计约束：

Important design locks:

| 约束 / Lock | 说明 / Description |
| --- | --- |
| 应用版本来源 / App version source | `src-tauri/Cargo.toml` 是应用版本的唯一来源 / `src-tauri/Cargo.toml` is the app-version source of truth |
| Tauri 配置版本 / Tauri config version | `tauri.conf.json` 刻意省略 `version` / `tauri.conf.json` intentionally omits `version` |
| 预览与复制管线 / Preview and copy pipeline | `buildPreview(roots)` 同时驱动预览和复制 XML / `buildPreview(roots)` is the shared source for preview and copied XML |
| Content Security Policy (CSP, 内容安全策略) | 生产敏感代码避免 inline styles/scripts / Avoid inline styles/scripts in production-sensitive code |
| 原生层边界 / Native layer boundary | Rust 层保持很薄；除非必须使用原生 API，产品逻辑放在前端 / The Rust layer stays thin; product logic belongs in the frontend unless native APIs are required |

---

## 许可证 | License

Copyright (c) 2026 koagaroon

本项目采用 [MIT License](LICENSE) 授权。

This project is licensed under the [MIT License](LICENSE).

### 捆绑字体 | Bundled Fonts

`public/fonts/` 中的字体会随应用一起分发，并使用各自的 SIL Open Font License (OFL) Version 1.1，而不是项目的 MIT License。完整许可证文本已随字体文件一起包含。

The fonts in `public/fonts/` ship with the application and are licensed under their own SIL Open Font License (OFL) Version 1.1, not under the project's MIT License. The full license texts are included alongside the font files.

| 字体 / Font | 许可证 / License | 用途 / Usage |
| --- | --- | --- |
| [Inter](https://rsms.me/inter/) | [SIL Open Font License 1.1](public/fonts/Inter-LICENSE.txt) | UI 正文、标签和控件 / UI body, labels, and controls |
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | [SIL Open Font License 1.1](public/fonts/JetBrainsMono-OFL.txt) | XML 预览、标签名和等宽 UI 文本 / XML preview, tag names, and monospaced UI text |

更多简短归属索引见 [public/fonts/LICENSES.md](public/fonts/LICENSES.md) 和 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

See [public/fonts/LICENSES.md](public/fonts/LICENSES.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the short attribution index.

### 第三方依赖 | Third-Party Dependencies

下表列出主要直接依赖和随应用分发的资产；完整的传递依赖链请分别参见 `package-lock.json` 和 `src-tauri/Cargo.lock`。

The tables below list the main direct dependencies and bundled assets; for the full transitive dependency graph, see `package-lock.json` and `src-tauri/Cargo.lock`.

#### 运行时依赖（随应用分发）| Runtime (shipped with the application)

| 组件 / Component | 许可证 / License | 用途 / Usage |
| --- | --- | --- |
| [Tauri](https://tauri.app/) | MIT OR Apache-2.0 | 桌面应用框架 / Desktop app framework |
| [@tauri-apps/api](https://github.com/tauri-apps/tauri) | MIT OR Apache-2.0 | 前端到 Rust 的 IPC bridge / Frontend-to-Rust IPC bridge |
| [React](https://react.dev/) / React DOM | MIT | UI 框架 / UI framework |
| [arboard](https://github.com/1Password/arboard) | MIT OR Apache-2.0 | 跨平台剪贴板访问 / Cross-platform clipboard access |
| [Inter](https://rsms.me/inter/) | SIL OFL 1.1 | 捆绑 UI 字体 / Bundled UI font |
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | SIL OFL 1.1 | 捆绑等宽字体 / Bundled monospace font |

#### 构建时依赖（不随应用分发）| Build-time only (not shipped)

| 组件 / Component | 许可证 / License | 用途 / Usage |
| --- | --- | --- |
| [TypeScript](https://www.typescriptlang.org/) | Apache-2.0 | 类型检查 / Type checking |
| [Vite](https://vite.dev/) | MIT | 前端构建工具 / Frontend build tool |
| [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | MIT | Vite React 支持 / React support for Vite |
| [Tauri CLI](https://tauri.app/) | MIT OR Apache-2.0 | Tauri 构建入口 / Tauri build entry point |
| [tauri-build](https://github.com/tauri-apps/tauri) | MIT OR Apache-2.0 | Tauri Rust 构建脚本 helper / Tauri Rust build script helper |
| [ESLint](https://eslint.org/) | MIT | JavaScript / TypeScript 代码检查 / JavaScript and TypeScript linting |
| [Stylelint](https://stylelint.io/) | MIT | CSS 代码检查 / CSS linting |
| [Vitest](https://vitest.dev/) | MIT | 单元测试 / Unit testing |

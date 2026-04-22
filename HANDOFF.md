# Handoff —— 代码审查结果

本次会话只做审查，不动代码。需要修改的部分由下一次会话处理，按 P0 → P1 → P2 顺序。

设计文档在 CC_General 的 `docs/architecture/xml_prompt_studio_design.md`，本次 review 的发现不回写架构文档（留给修复会话）。

---

## P0 —— 核心 bug：文本内容被 XML 转义，违背产品意图

### 现象

用户在 **Text Content** 里输入 `<`、`>`、`&`，点 Copy XML 后拷贝出来的是 `&lt;`、`&gt;`、`&amp;`。粘贴到 Claude Code 对话框里就是字面的转义串。

### 根因

`src/xml.ts` 的 `renderNode`（line 83）把 textContent 过了一次 `escapeXml`：

```ts
const textContent = escapeXml(node.textContent);
```

`escapeXml`（line 134–140）把 `&`、`<`、`>`、`'` 都换成 XML 实体。这是严格 XML 的做法。

### 为什么现在的行为是错的

本工具输出的不是喂 XML parser 的严格 XML，是喂 Claude 的 prompt 标记文本。Claude 走 pattern matching，`&lt;` 对它是四个字符（`&`、`l`、`t`、`;`），不是 `<`。

设计文档里已经写了产品定位："**面向 prompt engineering**"、"**不是通用 XML 编辑器**"——但实现层面仍然按严格 XML 的方式转义，这是定位和实现不一致。

### 修复

一行改动：

```ts
// src/xml.ts 的 renderNode 里
const textContent = node.textContent;   // 不再 escapeXml
```

附带：`escapeXml` 函数整块删掉（`xml.ts` line 134–140）。

### 取舍（修之前需要认可）

去掉转义后，如果用户在 Text Content 里想写**字面的** `<somename>` 这种字符串（比如教 Claude "要这样写 `<feedback>...</feedback>`"），Claude 会把它解释成一个嵌套的子标签。

两种接受方式，任选其一：

1. **教用户用工具的嵌套能力**：想要字面的 `<feedback>content</feedback>`，就把 `<feedback>` 建成子节点，文本写 "content"。
2. **接受歧义，所见即所得**：用户写什么 Claude 就看到什么，歧义由用户自己管。

建议：采纳方式 2 的 WYSIWYG 哲学。和产品定位（轻量、反 friction）一致。

**可选未来扩展**：真的需要严格 XML 输出时，加个"严格模式"开关。当前不需要。

### 设计文档要同步的地方

`xml_prompt_studio_design.md` 的"渲染管线 > XML 转义规则"一节要重写。当前写的是"转义 `&`、`<`、`>`、`'`"，新行为是"文本内容原样输出"。

---

## P1 —— UI 精简

用户反馈的三个方向："大小、滚动条、以及对'写文本然后粘贴'这件事无用的元素"。下面按具体发现列，每项标建议。

### 1. 尺寸 / 滚动条

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 1.1 | `.line-list`（styles.css:227）`height: clamp(10rem, 30vh, 16rem)` | 硬性固定高度，内容少留大空白，内容多强制滚动；面板下方有空间也不延展 | 去掉 `height`，保留 `min-height` 或改用 `max-height` + flex 自适应 |
| 1.2 | `.line-list`（styles.css:230）`scrollbar-gutter: stable` | 不管溢不溢出都预留滚动条槽位，视觉上总有一条窄条 | 改 `auto` 或删掉 |
| 1.3 | body / #root / .app-shell 都有 `min-height: 100vh` | 三重冗余 | 只保留 `.app-shell` 的 |
| 1.4 | `.xml-preview` `font-size: clamp(0.98rem, 1.2vw, 1.2rem)` | 对 preview 而言明显偏大 | 可调到 `clamp(0.88rem, 1vw, 1.08rem)` 试手感 |
| 1.5 | 文本 textarea `rows={4}` | 写一段 prompt 偏小，每次都要拖 resize 把手 | `rows={8}` 或 content-height 自撑 |

### 2. "无用元素"候选（逐项等用户确认）

| # | 元素 | 出处 | 为什么可能无用 | 建议 |
|---|---|---|---|---|
| 2.1 | Line 编号 `01`、`02`、… | App.tsx:195 `<span className="line-number">` | prompt 写作用不着像栈跟踪那样的序号 | 删掉 |
| 2.2 | 顶 bar 的 eyebrow "XML PROMPT STUDIO" | App.tsx:154 | 和窗口标题栏重复 | 删掉，省一行纵向空间 |
| 2.3 | 面板 header 三级堆叠（eyebrow + h2 + muted-text 帮助） | App.tsx:176–184 等 | 工具窗口不需要这么重的层级 | 只保 h2，去掉 eyebrow 和帮助文字 |
| 2.4 | "SELECTED LINE" eyebrow + h2 的 `<tagname>` 或 `(empty tag)` | App.tsx:205–207 | 下面 input label 就是 "Tag Name"，信息重复 | 合并成一行："Editing: `<tagname>`" |
| 2.5 | 状态 banner（绿色）"Added a new line."、"Deleted the selected line." 等 | App.tsx:169，statusMessage state | 每个操作都弹条，长期是噪音 | 整块删，或换成顶 bar 短暂 toast |
| 2.6 | "Selected line warnings" 框（warning-box） | App.tsx:269–278 | line-badge "Duplicate" 已经提示了 | 删，保留 badge |
| 2.7 | "Duplicate detection" 框（duplicate-box） | App.tsx:321–330 | 同上，badge 足够 | 删 |
| 2.8 | 死 CSS：`.attribute-row`、`.attributes-section` | styles.css:172, 176 | 没有任何 JSX 用到（grep 过，确认死代码） | 删 |
| 2.9 | 验证框（validation-box）文字过长 | App.tsx:293–301 | input-error 红框已经提示了输入本身 | 文字砍短，或只在提交/拷贝时才展开长文字 |
| 2.10 | mini-toolbar 5 按钮（Add Child / Add Sibling / Up / Down / Delete） | App.tsx:208–228 | Up/Down 最适合键盘 | Up/Down 做成 Alt+↑/↓ 快捷键，按钮去掉，或整体做成小图标条 |
| 2.11 | 顶 bar "New Blank" 按钮 | App.tsx:158–160 | 和 root 态下的 "Delete" 变 "Reset" 功能重叠 | 去掉顶 bar 的 New Blank，保留 root 态的 Reset |

---

## P2 —— 其他 review 发现（非本次重点，UI 稳定后顺手清）

### 代码微优化

- **`src/document.ts:3` `createId` 的 `Math.random()` fallback** —— Tauri 2 webview 永远有 `crypto.randomUUID()`，fallback 分支永远不执行，是死代码。可简化为直接调用 `crypto.randomUUID()`。
- **`src/lib.rs:8` `xml.clone()` 多余** —— `arboard::Clipboard::set_text` 接受 `Into<Cow<str>>`，直接传 `&xml` 即可。小微 perf，不影响功能。
- **`src/App.tsx:308` React key `${line.nodeId ?? "line"}-${index}`** —— 混 id 和 index，在 reorder 时理论上可能影响 keyed reconciliation；当前流程没观察到问题，低优。

### 架构约束（与设计文档已记的一致，列出以免被顺手"改好"）

- `__TAURI_INTERNALS__` sentinel 不是公开 API，Tauri 升级必须回归测试 `src/tauri.ts:7`。
- `buildXml` 是 `buildPreview` 的一行包装；要改 XML 序列化行为只能改 `renderNode` / `buildPreview`，别去改 `buildXml`。
- Rust crate 在仓库根目录，`cargo` 从根目录跑，不要迁移到标准 `src-tauri/` 布局。

---

## 下一次会话的推荐顺序

1. **P0 修一把**：单行代码改 + 删死函数 + 同步设计文档里的"XML 转义规则"小节。
2. **P1 逐项确认**：11 项 UI 改动让用户选 3–4 项先做，跑一遍看效果，再决定下一轮。别一次改完，看不清哪个改对了。
3. **P2 清扫**：等 P1 收敛、UI 稳了再做，一次清完，commit 一个 "chore: 扫尾" 即可。

本次 review 不动代码。

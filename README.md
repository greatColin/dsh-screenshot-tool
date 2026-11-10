# dsh-screenshot-tool

**English** · [中文说明](#中文说明)

> Chat-app-style region screenshot for the DeepSeek Harness web composer — one click captures every
> display, you pick a region at 1:1 on the real screen, and the crop lands in the message draft.

Harness already accepts pasted and dropped images, but a screenshot still costs three steps: capture
with the OS, save a file, pick the file. This bundle collapses that into one button and keeps the whole
attachment flow inside the composer. The Host process grabs the pixels (no browser permission prompt,
per-monitor physical resolution, every display in one shot), and the confirmed crop enters the draft
through the composer's own draft pipeline, so thumbnails, uploads, retries and sending stay native.

## Features

- **Chat-app-style picking** — one click grabs the screen; the page enters OS fullscreen so the
  capture is shown 1:1 with the real display; drag to select, Enter or double-click to accept,
  Esc or right-click to cancel.
- **All displays at once** — every monitor is captured in a single Host call and numbered left to
  right; the display under the pointer opens first, the others are one `Tab` (or a pager click) away.
- **Native pixels** — selections map to physical screen pixels (per-monitor DPI aware), so 125% / 150%
  display scaling neither blurs nor shifts the crop.
- **Draft-native insertion** — the crop is added through the composer's draft attachment API; the
  harness owns previews, upload progress, retry-on-failure and sending.
- **Keyboard first** — Enter / double-click confirms, Esc / right-click cancels; each display keeps its
  own selection while you switch.
- **Local only** — pixels travel over localhost and the route keeps the harness connection fence;
  temporary files are removed right after use, and nothing is sent automatically.

<!-- TODO(demo): add a screenshot of the fullscreen picker and the composer attachment rail, e.g. docs/demo.png -->

## Install

This is a **Harness bundle plugin** — installed from a directory, not published to npm. Clone the
repository, then install that directory as a bundle inside Harness:

```powershell
git clone https://github.com/greatColin/dsh-screenshot-tool.git
```

```text
plugin_manager install_bundle  target: <absolute path to this repository>
```

The screenshot button then appears in the composer tool row, right beside the `+` add button. The
package name `dsh-screenshot-tool` matches this repository; its Loader row id is `screenshot-tool`.

## Usage

1. Click the screenshot button in the composer tool row (the spinner means a capture is running, ~2–3 s).
2. The page goes fullscreen and shows the display under your pointer at native size:
   - `1 2 …` or **Tab** — switch display; each display keeps its own selection;
   - **drag** — select any region, with a live width × height readout;
   - **Enter / double-click / Add to message** — confirm and insert;
   - **Esc / right-click / Cancel** — discard and leave fullscreen.
3. The crop appears in the draft attachment rail, focus returns to the composer, and nothing is sent.

## Compatibility

- Targets **DeepSeek Harness 0.2.x desktop / web GUI**. Unofficial plugin; not affiliated with DeepSeek.
- The client half uses harness-internal slot and draft APIs (`conversation.input.left`,
  `createDrafts()` / `addAttachments()`). They are not a public contract and may need adaptation after
  a harness upgrade.
- Multi-display capture is **Windows-only** (PowerShell + GDI, per-monitor DPI). macOS and Linux have a
  single-display fallback (`screencapture` / `gnome-screenshot`).
- Editing `client.js` takes effect on a page reload; editing `index.js` needs a **restart** of the DSH
  application (Host modules are not hot-reloaded).

## Known limitations

- **No cross-display selection** — one selection cannot span two monitors (a web page has a single
  overlay; desktop chat apps use one native overlay window per display). A "stitched desktop with 1:1
  panning" mode could lift this.
- **Mixed resolutions** — the active display is shown 1:1; a display with a different resolution is
  scaled to fit (the pager tooltip lists each display's size).
- **Capture latency** — one PowerShell start covers every display, ~2–3 s, surfaced by the button
  spinner.

## Protocol

`POST /screenshot-tool/capture`

- `Accept: application/json` → `200` JSON with every display: geometry plus a `data:image/png;base64,…`
  image per display.
- Any other `Accept` (older pages) → `200 image/png` for the display under the pointer.
- `GET` → `405`; unauthenticated or cross-site → `401` / `403` (the harness connection fence).

## Project layout

| Path | Role |
|---|---|
| `index.js` | Host half: capture route, connection fence, multi-display capture, both protocols. |
| `client.js` | Client half: composer button, fullscreen picker, display pager, crop, draft insertion. |
| `locale/{en,zh}.json` | Plugin manager title and description. |
| `icon.svg` | Original plugin icon. |
| `cordis.patch.yml` | Loader patch that inserts the bundle row. |
| `test/capture-check.mjs` | Host self-check: real capture plus protocol, PNG and fence assertions. |

## Development

```powershell
node --check index.js
node --check client.js
node test/capture-check.mjs   # captures once for real; checks multi-display JSON, legacy PNG, 405/403
```

Update a locally installed copy (a directory link; restart the app so the Host half reloads):

```text
plugin_manager install_bundle  target: <absolute path to this repository>
```

---

## 中文说明

> 给 DeepSeek Harness 的 Web 输入框补上聊天工具式的区域截图：点一下 `+` 旁边的按钮，抓取当前 / 全部显示器的画面，
> 在系统全屏里按 1:1 原生像素框选任意区域，确认后图片直接进入消息草稿。

Harness 本来就支持粘贴、拖拽图片，但截图仍要经过「系统截图 → 存文件 → 选文件」三步。这个插件把它并成一个按钮：
抓屏在 Host 进程完成（不弹浏览器权限框、按显示器物理分辨率、一次抓全部屏），确认后的裁剪图走输入框自己的
草稿附件管线，缩略图、上传进度、失败重试、发送逻辑全部复用，不绕过 Harness 的输入流程。

### 特性

- **聊天工具同款框选**：点按钮即抓屏，页面进入系统全屏，截图 1:1 铺满屏幕；拖动框选，Enter / 双击确认，Esc / 右键取消。
- **一键多屏**：一次抓取所有显示器，按左→右编号；默认显示鼠标所在那块，`Tab` 或底部数字切换。
- **原生像素**：选区对应屏幕物理像素（per-monitor DPI 感知），125% / 150% 缩放也不会模糊或偏移。
- **确认即插入**：通过输入框的草稿附件接口插入，缩略图、上传进度、失败重试、发送逻辑全部复用。
- **键盘优先**：Enter / 双击确认，Esc / 右键取消；每块屏各自记住选区，切屏不丢。
- **本地优先**：像素只在 localhost 传输，复用 Harness 的认证围栏；临时文件即用即删，不自动发送消息。

### 安装

本地 bundle 安装（不发布 npm）：先克隆仓库，然后在 Harness 里把该目录作为 bundle 安装：

```text
plugin_manager install_bundle  target: <本仓库的绝对路径>
```

安装后，输入框左侧工具行、`+` 添加按钮旁边会出现截图按钮。包名 `dsh-screenshot-tool` 与仓库同名，Loader 行 id 为
`screenshot-tool`。

### 使用

1. 点击工具行里的截图按钮（转圈表示正在抓屏，约 2–3 秒）。
2. 页面进入全屏，显示鼠标所在显示器的截图（1:1）：
   - `1 2 …` / **Tab**：切换显示器，每块屏各自记住选区；
   - 拖动鼠标：框选任意区域，实时显示「宽 × 高」；
   - **Enter / 双击 / 添加到输入框**：确认并插入草稿；
   - **Esc / 右键 / 取消**：放弃并退出全屏。
3. 截图出现在输入框附件栏，焦点回到输入框，不会自动发送。

### 兼容性

- 面向 **DeepSeek Harness 0.2.x 桌面版 / Web GUI**；非官方插件，与 DeepSeek 无隶属关系。
- Client 半边依赖 Harness 内部的插槽与草稿接口（`conversation.input.left`、`createDrafts()` /
  `addAttachments()`），属于非公开契约，Harness 升级后可能需要适配。
- 多显示器抓取**仅 Windows**（PowerShell + GDI，per-monitor DPI 感知）；macOS / Linux 只有单屏回退
  （`screencapture` / `gnome-screenshot`）。
- 修改 `client.js` 刷新页面生效；修改 `index.js` 需要**重启 DSH 应用**（Host 端模块运行期不热更）。

### 已知限制

- **跨屏连续选区**：不能一条选区横跨两块显示器（网页只有一个覆盖层；桌面聊天工具通常是每块屏一个原生覆盖窗）。
  如需要，可扩展为「整桌面拼接 + 1:1 可平移」模式。
- **混合分辨率**：当前屏 1:1；分辨率不同于当前屏的显示器会等比缩放显示（切屏按钮 tooltip 标有各自分辨率）。
- **抓屏耗时**：一次 PowerShell 启动完成所有显示器采集，约 2–3 秒，按钮上有转圈提示。

### 协议

`POST /screenshot-tool/capture`：`Accept: application/json` → 多屏 JSON（每屏几何信息 + PNG data URL）；
其他 `Accept` → 单屏 `image/png`；`GET` → `405`，未认证 / 跨站 → `401` / `403`。

### 开发

```powershell
node --check index.js
node --check client.js
node test/capture-check.mjs
```

## License

MIT — see [LICENSE](LICENSE).

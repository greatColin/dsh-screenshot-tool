# dsh-screenshot-tool

**English** · [中文说明](#中文说明)

> Chat-app-style region screenshot for the DeepSeek Harness web composer — one click freezes every
> display, a native always-on-top window on each real screen takes the region at 1:1, and the crop
> lands in the message draft.

Harness already accepts pasted and dropped images, but a screenshot still costs three steps: capture
with the OS, save a file, pick the file. This bundle collapses that into one button and keeps the
whole attachment flow inside the composer. The Host process grabs the pixels (no browser permission
prompt, per-monitor physical resolution, every display in one shot), the selection happens on the
screen itself — not in a scaled-down overlay inside the page — and the confirmed crop enters the
draft through the composer's own draft pipeline, so thumbnails, uploads, retries and sending stay
native.

## Features

- **Pick on the real screen** — on Windows every display gets its own borderless, always-on-top
  window showing that display's frozen capture at physical size, like WeChat / QQ / Snipping Tool.
  Other windows are dimmed; the region you drag is un-dimmed at native pixels, so a 1:1 selection on
  a 4K monitor is exactly 1:1.
- **One click, all displays** — every monitor is frozen and overlaid in one Host call, numbered left
  to right; the window on the monitor under the pointer is focused first.
- **Native pixels** — capture and overlay are per-monitor DPI aware, so 125% / 150% display scaling
  neither blurs nor shifts the crop.
- **Keyboard first** — Enter or double-click confirms, Esc or a right click cancels; the toolbar also
  carries Cancel / Done buttons.
- **Graceful fallback** — when the Host cannot put windows on the screens the user is looking at
  (macOS, Linux, or a browser on another machine), the page keeps its own fullscreen picker over the
  same captures, with a display pager.
- **Draft-native insertion** — the crop is added through the composer's draft attachment API; the
  harness owns previews, upload progress, retry-on-failure and sending.
- **Local only** — pixels travel over localhost and both routes keep the harness connection fence;
  temporary files are removed right after use, and nothing is sent automatically.

<!-- TODO(demo): add a screenshot of the per-display overlay and the composer attachment rail, e.g. docs/demo.png -->

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

1. Click the screenshot button in the composer tool row (the spinner means the capture is running,
   ~1–2 s). Every display dims behind a frozen copy of itself.
2. Drag a region on whichever screen holds what you want; the readout follows the drag:
   - **Enter / double-click / Done** — confirm and insert;
   - **Esc / right click / Cancel** — discard;
   - each display has its own overlay and its own selection.
3. The crop appears in the draft attachment rail, focus returns to the composer, and nothing is sent.

## Compatibility

- Targets **DeepSeek Harness 0.2.x desktop / web GUI**. Unofficial plugin; not affiliated with DeepSeek.
- The native per-display overlay is **Windows-only** (`overlay.ps1`: PowerShell + WinForms + GDI).
  macOS and Linux capture one display (`screencapture` / `gnome-screenshot`) and pick in the page;
  a browser that reaches this Host from another machine also falls back to the page picker.
- The client half uses harness-internal slot and draft APIs (`conversation.input.left`,
  `createDrafts()` / `addAttachments()`). They are not a public contract and may need adaptation after
  a harness upgrade.
- Editing `client.js` takes effect on a page reload; editing `index.js` or `overlay.ps1` needs a
  **restart** of the DSH application (Host modules are not hot-reloaded).

## Known limitations

- **One selection per display** — a selection cannot span two monitors; each screen's overlay owns
  its own rectangle. Desktop chat apps behave the same way.
- **Windowed apps keep their chrome** — the capture is a screen grab, so the Harness window itself is
  frozen into it; the overlay does not hide the app the way a dedicated snipper would.
- **Latency** — one PowerShell start freezes and overlays every display, ~1–2 s, surfaced by the
  button spinner.
- **Secure desktops** — a locked session or a UAC secure desktop cannot be captured; the click
  reports the failure in the composer.

## Protocol

`POST /screenshot-tool/pick` — the native path used by this client.

- `200 image/png` — the confirmed region, cropped at physical pixels.
- `204` — the user cancelled.
- `409` — this Host has no native picker (non-Windows, or a caller that is not on this machine); the
  page then runs its own picker.
- `405` for `GET`; `401` / `403` from the harness connection fence.

`POST /screenshot-tool/capture` — the page-side path and the pre-overlay protocol.

- `Accept: application/json` → `200` JSON with every display: geometry plus a `data:image/png;base64,…`
  image per display.
- Any other `Accept` (older pages) → `200 image/png` for the display under the pointer.
- `GET` → `405`; unauthenticated or cross-site → `401` / `403`.

## Project layout

| Path | Role |
|---|---|
| `index.js` | Host half: connection fence, native pick route, capture route, multi-display capture. |
| `overlay.ps1` | Host half on Windows: per-display always-on-top picker windows, crop and result contract. |
| `client.js` | Client half: composer button, native-first pick, page picker fallback, crop, draft insertion. |
| `locale/{en,zh}.json` | Plugin manager title and description. |
| `icon.svg` | Original plugin icon. |
| `cordis.patch.yml` | Loader patch that inserts the bundle row. |
| `test/capture-check.mjs` | Host self-check: real capture, both protocols, PNG and fence assertions. |
| `test/overlay-check.mjs` | Native picker self-check: compiles the overlay and takes a real demo selection. |

## Development

```powershell
node --check index.js
node --check client.js
node test/capture-check.mjs   # captures once for real; checks multi-display JSON, legacy PNG, fences
node test/overlay-check.mjs   # opens the real overlay briefly (demo mode), then checks the crop
```

Update a locally installed copy (a directory link; restart the app so the Host half reloads):

```text
plugin_manager install_bundle  target: <absolute path to this repository>
```

---

## 中文说明

> 给 DeepSeek Harness 的 Web 输入框补上聊天工具式的区域截图：点一下 `+` 旁边的按钮，冻结全部显示器，
> 每块真实屏幕上出现一个置顶的覆盖窗，直接在该屏按 1:1 原生像素框选，确认后图片进入消息草稿。

Harness 本来就支持粘贴、拖拽图片，但截图仍要经过「系统截图 → 存文件 → 选文件」三步。这个插件把它并成一个按钮：
抓屏在 Host 进程完成（不弹浏览器权限框、按显示器物理分辨率、一次抓全部屏），**框选发生在真实屏幕上**，而不是在页面里
缩小显示；确认后的裁剪图走输入框自己的草稿附件管线，缩略图、上传进度、失败重试、发送逻辑全部复用。

### 特性

- **在真实屏幕上框选**：Windows 下每块显示器各有一个无边框置顶窗口，铺着自己那块屏的冻结画面（和微信 / QQ / 系统截图
  工具一致）。其他窗口被压暗，拖出来的选区按原生像素还原，4K 屏上就是 1:1。
- **一键多屏**：一次调用冻结并覆盖所有显示器，按左→右编号，鼠标所在那块屏的窗口先拿到焦点。
- **原生像素**：抓屏与覆盖层都是 per-monitor DPI 感知，125% / 150% 缩放不会模糊或偏移。
- **键盘优先**：Enter / 双击确认，Esc / 右键取消，覆盖窗底部也有「取消 / 完成」按钮。
- **平滑回退**：Host 无法把窗口放到用户眼前的屏幕上时（macOS、Linux，或远程浏览器访问），页面自己用同一批冻结画面
  做全屏框选，并提供显示器切换。
- **确认即插入**：通过输入框的草稿附件接口插入，缩略图、上传进度、失败重试、发送逻辑全部复用。
- **本地优先**：像素只在 localhost 传输，两条路由都复用 Harness 的认证围栏；临时文件即用即删，不自动发送消息。

### 安装

本地 bundle 安装（不发布 npm）：先克隆仓库，然后在 Harness 里把该目录作为 bundle 安装：

```text
plugin_manager install_bundle  target: <本仓库的绝对路径>
```

安装后，输入框左侧工具行、`+` 添加按钮旁边会出现截图按钮。包名 `dsh-screenshot-tool` 与仓库同名，Loader 行 id 为
`screenshot-tool`。

### 使用

1. 点击工具行里的截图按钮（转圈表示正在抓屏，约 1–2 秒）。所有显示器被冻结画面压暗。
2. 想在哪个屏幕上选就在哪个屏幕上拖：
   - **Enter / 双击 / 完成**：确认并插入草稿；
   - **Esc / 右键 / 取消**：放弃；
   - 每块屏各自一个覆盖窗、各自一份选区。
3. 截图出现在输入框附件栏，焦点回到输入框，不会自动发送。

### 兼容性

- 面向 **DeepSeek Harness 0.2.x 桌面版 / Web GUI**；非官方插件，与 DeepSeek 无隶属关系。
- 原生按屏覆盖层**仅 Windows**（`overlay.ps1`：PowerShell + WinForms + GDI）；macOS / Linux 只抓单屏
  （`screencapture` / `gnome-screenshot`）并在页面内框选；从另一台机器访问本 Host 的浏览器同样回退到页面内框选。
- Client 半边依赖 Harness 内部的插槽与草稿接口（`conversation.input.left`、`createDrafts()` /
  `addAttachments()`），属于非公开契约，Harness 升级后可能需要适配。
- 修改 `client.js` 刷新页面生效；修改 `index.js` 或 `overlay.ps1` 需要**重启 DSH 应用**（Host 端运行期不热更）。

### 已知限制

- **一次只能选一块屏**：一条选区不能横跨两块显示器，每块屏的覆盖窗各自管自己的矩形（桌面聊天工具同样是这个行为）。
- **应用窗口会被拍进去**：抓的是屏幕，Harness 窗口本身也在冻结画面里；覆盖层不会像专用截图工具那样先把应用藏起来。
- **抓屏耗时**：一次 PowerShell 启动完成全部显示器的冻结与覆盖，约 1–2 秒，按钮上有转圈提示。
- **安全桌面**：锁屏或 UAC 安全桌面无法抓取，失败信息会显示在输入框上方。

### 协议

`POST /screenshot-tool/pick`（本客户端使用的原生路径）：`200 image/png` 返回确认后的选区（物理像素裁剪）；
`204` 用户取消；`409` 本 Host 没有原生截图窗（非 Windows，或调用方不在本机），页面转用自己的框选；`GET` → `405`，
未认证 / 跨站 → `401` / `403`。

`POST /screenshot-tool/capture`（页面内路径与旧协议）：`Accept: application/json` → 多屏 JSON（每屏几何信息 +
PNG data URL）；其他 `Accept` → 单屏 `image/png`；`GET` → `405`，未认证 / 跨站 → `401` / `403`。

### 开发

```powershell
node --check index.js
node --check client.js
node test/capture-check.mjs
node test/overlay-check.mjs   # 会真实弹出覆盖层并自动框选一次（约 2 秒）
```

## License

MIT — see [LICENSE](LICENSE).

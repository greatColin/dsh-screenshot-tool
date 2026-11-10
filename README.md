# dsh-screenshot-tool

> 为 DeepSeek Harness 的 Web 输入框补上聊天工具式的区域截图：点一下 `+` 旁边的按钮，抓取当前 / 全部显示器的画面，
> 在系统全屏里按 1:1 原生像素框选任意区域，回车确认后图片直接进入消息草稿。

Harness 本身就支持粘贴、拖拽图片，但截图要经过「系统截图 → 存文件 → 选文件」三步。
桌面聊天工具里，截图是一个快捷键就能框选发送的日常动作；这个插件把同样的手感搬进 Harness：
抓屏在 Host 进程里完成，不弹浏览器权限框，多显示器下按各自物理分辨率采集。

## 特性

- **聊天工具同款框选**：点按钮即抓屏，页面进入系统全屏，框选 / 确认 / 取消都有快捷键。
- **一键多屏**：一次抓取所有显示器，按左→右编号；默认显示鼠标所在那块，`Tab` 或底部数字切换。
- **1:1 原生像素**：框选坐标与屏幕物理像素一一对应（per-monitor DPI 感知，125% / 150% 缩放也不失真）。
- **确认即插入**：走输入框自己的草稿附件管线——缩略图、上传进度、失败重试、发送逻辑全部复用，不绕过 Harness 的输入流程。
- **键盘优先**：Enter / 双击确认，Esc / 右键取消；每块屏各自记住选区，切屏不丢。
- **本地优先**：截图像素只在 localhost 上传输，认证围栏与 Web GUI 一致；临时文件即用即删，不自动发送任何消息。

<!-- TODO(demo): 推荐补一张「全屏框选 + 输入框附件效果」的截图，例如 docs/demo.png 并在上方引用。 -->

## Overview (English)

A region-screenshot button for the DeepSeek Harness web composer. One click captures every display,
the page enters OS fullscreen and shows the active display's capture at native resolution, you drag a
region (or press `Tab` for another display), and the crop lands in the message draft as an attachment.

It brings the screenshot flow of a desktop chat app into Harness: capture runs in the Host process
(no browser permission prompt, per-monitor physical pixels, multi-monitor in one shot), and the
confirmed crop goes through the composer's own draft pipeline, so uploads, previews, retries and
sending stay native.

## 安装

这是一个 **Harness bundle 插件**（本地目录安装，不发布 npm），需要先拿到本仓库：

```powershell
git clone https://github.com/greatColin/dsh-screenshot-tool.git
```

然后在 Harness 里用 Plugin Manager 的安装能力把该目录作为 bundle 安装：

```text
plugin_manager install_bundle  target: <本仓库的绝对路径>
```

安装完成后，输入框左侧工具行、`+` 添加按钮旁边会出现截图按钮。
仓库名与 bundle 包名不同：包名沿用本地 bundle 惯例 `@local/screenshot-tool`，Loader 行 id 为 `screenshot-tool`。

## 使用

1. 点击输入框工具行里的截图按钮（转圈表示正在抓屏，约 2–3 秒）。
2. 页面进入全屏，显示鼠标所在显示器的截图（1:1）：
   - `1 2 …` 或 **Tab**：切换显示器，每块屏各自记住选区；
   - 拖动鼠标框选任意区域，实时显示「宽 × 高」；
   - **Enter / 双击 / 添加到输入框**：确认并插入草稿；
   - **Esc / 右键 / 取消**：放弃并退出全屏。
3. 确认后截图出现在输入框附件栏，光标回到原处，不会自动发送。

## 兼容性（重要）

- 面向 **DeepSeek Harness 0.2.x 桌面版 / Web GUI**；非官方插件，与 DeepSeek 无隶属关系。
- Client 半边依赖 Harness 内部的插槽与草稿接口（`conversation.input.left`、`createDrafts()` / `addAttachments()`），
  属于非公开契约；Harness 升级后可能需要适配。
- 多显示器抓取目前**仅 Windows**（PowerShell + GDI，per-monitor DPI 感知）；macOS / Linux 只有单屏回退
  （`screencapture` / `gnome-screenshot`）。
- 修改 `client.js` 刷新页面生效；修改 `index.js` 需要**重启 DSH 应用**（Host 端模块运行期不热更）。

## 已知限制

- **跨屏连续选区**：不能一条选区横跨两块显示器（网页只有一个覆盖层；桌面聊天工具通常是每块屏一个原生覆盖窗）。如需要，可扩展为「整桌面拼接 + 1:1 可平移」模式。
- **混合分辨率**：当前屏 1:1；分辨率不同于当前屏的显示器会等比缩放显示（切屏按钮 tooltip 标有各自分辨率）。
- **抓屏耗时**：一次 PowerShell 启动完成所有显示器采集，约 2–3 秒，按钮上有转圈提示。

## 协议

`POST /screenshot-tool/capture`

- 请求头 `Accept: application/json` → `200` JSON：

  ```json
  { "displays": [ { "index": 0, "x": 0, "y": 0, "width": 1920, "height": 1080,
                    "primary": true, "cursor": true,
                    "image": "data:image/png;base64,..." } ] }
  ```

- 其他 `Accept`（旧版页面）→ `200` `image/png`，只返回鼠标所在那块屏。
- `GET` → `405`；未认证 / 跨站请求 → `401` / `403`（复用 Harness 的 connection 认证围栏）。

## 项目结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：注册抓屏路由、认证围栏、多显示器采集（PowerShell + GDI）、双协议响应。 |
| `client.js` | Client 半边：工具栏按钮、全屏框选层、切屏、裁剪、插入草稿。 |
| `locale/{en,zh}.json` | 插件管理页的标题 / 描述。 |
| `icon.svg` | 插件图标（原创）。 |
| `cordis.patch.yml` | bundle 的 Loader patch。 |
| `test/capture-check.mjs` | Host 自检：真实抓屏并断言协议、PNG 有效性、认证围栏。 |

## 开发与验证

```powershell
node --check index.js
node --check client.js
node test/capture-check.mjs   # 会真实截屏一次，校验多屏协议、PNG 签名、405 / 403 围栏
```

更新已安装的插件（本地目录链接方式，改完源码需重启应用让 Host 端加载新代码）：

```text
plugin_manager install_bundle  target: <本仓库的绝对路径>
```

## License

MIT，见 [LICENSE](LICENSE)。

/**
 * Host half of the screenshot tool.
 *
 * The composer button runs in the browser, which cannot read the operating
 * system's displays. This half captures every display on demand and hands the
 * PNGs back to the page; the page owns the region picker and the draft
 * attachment, so nothing model-visible is produced here.
 *
 * The route asks the composition's `connection` service for a rejection first:
 * that fence defeats DNS rebinding and cross-site calls, and its browser
 * authentication gates every caller before any pixels are read.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Loader row name. */
export const name = 'screenshot-tool'

/** The route carrier and the trust fence guarding it. */
export const inject = ['webServer', 'connection']

/** Route the browser half posts to, relative to the Web origin root. */
const CAPTURE_PATH = '/screenshot-tool/capture'

/** A capture spawns one shell, grabs every display, encodes, and exits. */
const CAPTURE_TIMEOUT_MS = 30000

/** Marker the Windows script prints before its display manifest line. */
const MANIFEST_MARKER = '__DSH_SCREENS__'

/**
 * Windows capture: enumerate every monitor at its physical pixel size and copy
 * each one. The process switches to per-monitor DPI awareness first so a scaled
 * display is captured at native resolution instead of a virtualized size.
 */
const WINDOWS_CAPTURE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$signature = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class DshScreenCapture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct MONITORINFOEX {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }
  public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);

  public sealed class Monitor {
    public int Index;
    public int X;
    public int Y;
    public int Width;
    public int Height;
    public bool Primary;
    public string Device;
  }

  public static void SetAwareness() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch {}
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-3))) return; } catch {}
    try { if (SetProcessDpiAwareness(2) == 0) return; } catch {}
    try { SetProcessDPIAware(); } catch {}
  }

  public static Monitor[] All() {
    List<Monitor> list = new List<Monitor>();
    MonitorEnumProc proc = delegate(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data) {
      MONITORINFOEX info = new MONITORINFOEX();
      info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
      if (GetMonitorInfo(hMonitor, ref info)) {
        Monitor monitor = new Monitor();
        monitor.X = info.rcMonitor.Left;
        monitor.Y = info.rcMonitor.Top;
        monitor.Width = info.rcMonitor.Right - info.rcMonitor.Left;
        monitor.Height = info.rcMonitor.Bottom - info.rcMonitor.Top;
        monitor.Primary = (info.dwFlags & 1) == 1;
        monitor.Device = info.szDevice == null ? "" : info.szDevice;
        list.Add(monitor);
      }
      return true;
    };
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, proc, IntPtr.Zero);
    list.Sort(delegate(Monitor a, Monitor b) {
      int byX = a.X.CompareTo(b.X);
      return byX != 0 ? byX : a.Y.CompareTo(b.Y);
    });
    for (int i = 0; i < list.Count; i++) list[i].Index = i;
    return list.ToArray();
  }

  public static int CursorIndex(Monitor[] monitors) {
    POINT point;
    if (!GetCursorPos(out point)) return 0;
    for (int i = 0; i < monitors.Length; i++) {
      Monitor monitor = monitors[i];
      if (point.X >= monitor.X && point.X < monitor.X + monitor.Width &&
          point.Y >= monitor.Y && point.Y < monitor.Y + monitor.Height) return i;
    }
    return 0;
  }
}
'@
Add-Type -TypeDefinition $signature
[DshScreenCapture]::SetAwareness()

$monitors = [DshScreenCapture]::All()
if ($null -eq $monitors -or $monitors.Length -eq 0) { throw 'no display is available' }
$cursor = [DshScreenCapture]::CursorIndex($monitors)
$entries = @()
for ($i = 0; $i -lt $monitors.Length; $i++) {
  $monitor = $monitors[$i]
  $bitmap = New-Object System.Drawing.Bitmap($monitor.Width, $monitor.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($monitor.X, $monitor.Y, 0, 0, $bitmap.Size)
  } finally {
    $graphics.Dispose()
  }
  $file = Join-Path '__DIRECTORY__' ('display-' + $i + '.png')
  try {
    $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bitmap.Dispose()
  }
  $entries += [pscustomobject]@{
    index = $i
    x = $monitor.X
    y = $monitor.Y
    width = $monitor.Width
    height = $monitor.Height
    primary = $monitor.Primary
    cursor = ($i -eq $cursor)
    file = $file
  }
}
$manifest = [pscustomobject]@{ displays = @($entries) }
Write-Output ('__DSH_SCREENS__' + ($manifest | ConvertTo-Json -Compress -Depth 5))
`

/** Base64 UTF-16LE transport: no quoting, line ending, or policy parsing reaches the script. */
function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Run one child process to completion; reject on spawn failure, non-zero exit, or timeout. */
function runProcess(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolve(value)
      else reject(error)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error('screen capture timed out'))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 65536) stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString()
    })
    child.once('error', (error) => finish(error))
    child.once('close', (code) => {
      if (code === 0) return finish(undefined, stdout)
      const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
      const detail = lines.length === 0 ? '' : lines[lines.length - 1]
      finish(new Error(detail === '' ? `screen capture failed (exit ${String(code)})` : `screen capture failed: ${detail}`))
    })
  })
}

/** Pixel size from one PNG's IHDR, or undefined when the bytes are not a PNG. */
function pngDimensions(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** Read the display manifest one Windows capture printed, then collect each PNG. */
async function readWindowsCapture(directory, stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(MANIFEST_MARKER))
  if (lines.length === 0) throw new Error('the capture reported no displays')
  const manifest = JSON.parse(lines[lines.length - 1].slice(MANIFEST_MARKER.length))
  const entries = Array.isArray(manifest.displays) ? manifest.displays : [manifest.displays]
  const displays = []
  for (const entry of entries) {
    const bytes = await readFile(entry.file)
    displays.push({
      index: entry.index,
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height,
      primary: entry.primary === true,
      cursor: entry.cursor === true,
      png: bytes,
    })
  }
  if (displays.length === 0) throw new Error('the capture reported no displays')
  return displays
}

/** Capture every display as one ordered list of PNGs. */
async function captureDisplays(directory) {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot ?? 'C:\\Windows'
    const executable = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const script = WINDOWS_CAPTURE.replace('__DIRECTORY__', directory.replaceAll("'", "''"))
    const stdout = await runProcess(executable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      encodeCommand(script),
    ], CAPTURE_TIMEOUT_MS)
    return await readWindowsCapture(directory, stdout)
  }
  const target = join(directory, 'display-0.png')
  if (process.platform === 'darwin') {
    await runProcess('screencapture', ['-x', '-t', 'png', target], CAPTURE_TIMEOUT_MS)
  } else {
    await runProcess('gnome-screenshot', ['-f', target], CAPTURE_TIMEOUT_MS)
  }
  const bytes = await readFile(target)
  const size = pngDimensions(bytes)
  if (size === undefined) throw new Error('the capture produced no PNG')
  return [{
    index: 0,
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
    primary: true,
    cursor: true,
    png: bytes,
  }]
}

/** One capture session's payload: display geometry plus each PNG as a data URL. */
async function capturePayload() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-screenshot-'))
  try {
    const displays = await captureDisplays(directory)
    return {
      displays: displays.map((display) => ({
        index: display.index,
        x: display.x,
        y: display.y,
        width: display.width,
        height: display.height,
        primary: display.primary,
        cursor: display.cursor,
        image: `data:image/png;base64,${display.png.toString('base64')}`,
      })),
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

/** The display the pointer was on, as raw PNG bytes (the pre-multi-display protocol). */
function cursorDisplayPng(payload) {
  const displays = payload.displays
  const display = displays.find((candidate) => candidate.cursor) ?? displays[0]
  if (display === undefined) throw new Error('the capture reported no displays')
  return Buffer.from(display.image.slice(display.image.indexOf(',') + 1), 'base64')
}

/** JSON response for a failure the page shows verbatim. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Install the capture route. */
export function apply(ctx) {
  // One capture at a time keeps repeated clicks from spawning competing shells.
  let captureQueue = Promise.resolve()
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CAPTURE_PATH,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      req.resume()
      // A page that predates the multi-display protocol asks for one PNG; the
      // active picker asks for every display and their geometry.
      const wantsMultiDisplay = String(req.headers.accept ?? '').includes('application/json')
      const capture = captureQueue.then(capturePayload)
      captureQueue = capture.then(() => undefined, () => undefined)
      let payload
      try {
        payload = await capture
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      if (!wantsMultiDisplay) {
        let png
        try {
          png = cursorDisplayPng(payload)
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        res.statusCode = 200
        res.setHeader('content-type', 'image/png')
        res.setHeader('cache-control', 'no-store')
        res.setHeader('content-length', String(png.byteLength))
        res.end(png)
        return
      }
      sendJson(res, 200, payload)
    },
  }), `screenshot-tool: POST ${CAPTURE_PATH}`)
}

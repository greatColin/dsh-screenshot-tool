// Native picker self check. Runs the real overlay script in demo mode: every
// display briefly shows the frozen capture with the toolbar, a centered region
// is confirmed without user input, and the crop is written and read back.
// Usage: node test/overlay-check.mjs
//
// This opens windows on the machine running the Host, so run it on a desktop
// session and expect a short flash. A cancelled run (no display) fails here.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../overlay.ps1', import.meta.url))
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr })
      reject(new Error(`overlay.ps1 exited ${String(code)}: ${stderr.trim().split(/\r?\n/).pop() ?? ''}`))
    })
  })
}

function marker(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith('__DSH_PICK__'))
  assert.ok(lines.length > 0, 'the picker printed no result')
  return JSON.parse(lines[lines.length - 1].slice('__DSH_PICK__'.length))
}

function pngSize(bytes) {
  assert.ok(bytes.length > 24, 'no PNG bytes')
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

if (process.platform !== 'win32') {
  console.log('overlay-check: skipped (the native picker is Windows-only)')
  process.exit(0)
}

const directory = await mkdtemp(join(tmpdir(), 'dsh-overlay-check-'))
try {
  const output = join(directory, 'region.png')
  const result = join(directory, 'result.json')
  const config = join(directory, 'config.json')
  await writeFile(config, JSON.stringify({
    output,
    result,
    labels: { hint: 'drag to select', cancel: 'Cancel', confirm: 'Done' },
  }), 'utf8')

  // 1. Compile-only: the embedded C# builds without opening a window.
  const compiled = await run(['-File', script, '-Config', config, '-CompileOnly'])
  assert.equal(marker(compiled.stdout).compiled, true)
  console.log('compile: OK')

  // 2. Demo selection: real capture, real overlay, real crop.
  const started = Date.now()
  const runResult = await run(['-File', script, '-Config', config, '-Demo', '700'])
  const picked = marker(runResult.stdout)
  assert.equal(picked.cancelled, false, 'the demo selection was cancelled')
  assert.ok(picked.width > 0 && picked.height > 0, 'empty crop')
  const bytes = await readFile(picked.file ?? output)
  const size = pngSize(bytes)
  assert.equal(size.width, picked.width, 'reported width does not match the PNG')
  assert.equal(size.height, picked.height, 'reported height does not match the PNG')
  // The demo region is 480x320 layout pixels; physical pixels differ only when
  // DPI awareness could not be raised, and the aspect stays the same.
  const ratio = size.width / size.height
  assert.ok(Math.abs(ratio - 480 / 320) < 0.02, `unexpected crop aspect ${String(ratio)}`)
  assert.ok(size.width >= 300, 'crop unexpectedly small')
  const onDisk = JSON.parse(await readFile(result, 'utf8'))
  assert.deepEqual(onDisk, picked, 'stdout result and result file disagree')
  console.log(`demo pick: OK (${String(size.width)}x${String(size.height)} in ${String(Date.now() - started)}ms)`)
} finally {
  await mkdir(directory, { recursive: true }).catch(() => {})
  await rm(directory, { recursive: true, force: true }).catch(() => {})
}

console.log('overlay-check: PASS')

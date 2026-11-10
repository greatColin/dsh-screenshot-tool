// Host-half self check: mounts the plugin on a fake context and runs the real
// capture through the registered route, without the HTTP carrier.
// Usage: node test/capture-check.mjs
import assert from 'node:assert/strict'

const moduleUrl = new URL('../index.js', import.meta.url)
const mod = await import(moduleUrl.href)

function mount(rejection) {
  const routes = []
  mod.apply({
    effect(fn) {
      return fn()
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    connection: { requestRejection() { return rejection } },
  })
  return routes
}

function pendingResponse() {
  let settle
  const promise = new Promise((resolve) => { settle = resolve })
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(body) { settle({ statusCode: this.statusCode, headers: this.headers, body }) },
  }
  return { res, promise }
}

function isPng(bytes) {
  return bytes.length > 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
}

assert.equal(mod.name, 'screenshot-tool')
assert.deepEqual([...mod.inject].sort(), ['connection', 'webServer'])
const routes = mount(undefined)
assert.equal(routes.length, 1)
const route = routes[0]
assert.equal(route.kind, 'exact')
assert.equal(route.path, '/screenshot-tool/capture')

// 1. Multi-display protocol: one JSON payload with every display's PNG.
{
  const { res, promise } = pendingResponse()
  const started = Date.now()
  await route.handler({ method: 'POST', headers: { accept: 'application/json' }, resume() {} }, res)
  const result = await promise
  assert.equal(result.statusCode, 200)
  assert.match(result.headers['content-type'], /application\/json/)
  const payload = JSON.parse(result.body.toString('utf8'))
  assert.ok(Array.isArray(payload.displays) && payload.displays.length > 0, 'no displays captured')
  for (const display of payload.displays) {
    assert.ok(display.width > 0 && display.height > 0, 'display size')
    const bytes = Buffer.from(display.image.slice(display.image.indexOf(',') + 1), 'base64')
    assert.ok(isPng(bytes), `display #${display.index} is not a PNG`)
    console.log(`display #${display.index}: ${display.width}x${display.height} at (${display.x},${display.y})`,
      'primary:', display.primary, 'cursor:', display.cursor, bytes.byteLength + 'B')
  }
  assert.equal(payload.displays.filter((display) => display.cursor).length, 1, 'exactly one cursor display')
  console.log(`multi-display: OK (${payload.displays.length} displays, ${Date.now() - started}ms)`)
}

// 2. Legacy protocol: a page that predates multi-display gets one PNG.
{
  const { res, promise } = pendingResponse()
  await route.handler({ method: 'POST', headers: { accept: 'image/png' }, resume() {} }, res)
  const result = await promise
  assert.equal(result.statusCode, 200)
  assert.equal(result.headers['content-type'], 'image/png')
  assert.ok(isPng(result.body), 'legacy response is not a PNG')
  console.log('legacy png: OK (' + result.body.byteLength + 'B)')
}

// 3. Method and trust fences.
{
  const { res, promise } = pendingResponse()
  await route.handler({ method: 'GET', headers: {}, resume() {} }, res)
  const result = await promise
  assert.equal(result.statusCode, 405)
  assert.equal(result.headers.allow, 'POST')

  const rejected = mount(403)
  const { res: rejectedRes, promise: rejectedPromise } = pendingResponse()
  await rejected[0].handler({ method: 'POST', headers: { accept: 'application/json' }, resume() {} }, rejectedRes)
  const rejectedResult = await rejectedPromise
  assert.equal(rejectedResult.statusCode, 403)
  console.log('fences: OK (405 for GET, 403 for an untrusted caller)')
}

console.log('capture-check: PASS')

// Runs the built emulator on a spare port and checks it answers like Autoblow's API (per its docs).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = 20000 + Math.floor(Math.random() * 20000)
const base = `http://127.0.0.1:${port}`
let proc
const dir = mkdtempSync(join(tmpdir(), 'abemu-'))

function start(extraPort, data) {
  const p = spawn(process.execPath, ['dist/server.js', '--port', String(extraPort), '--data', data], { stdio: 'pipe' })
  return new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => String(d).includes('Autoblow emulator on') && resolve(p))
    p.on('exit', (c) => reject(new Error(`emulator exited ${c}`)))
  })
}

before(async () => {
  proc = await start(port, join(dir, 'devices.json'))
})
after(() => proc.kill())

async function call(method, path, token, body, extraHeaders = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { 'x-device-token': token } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }
}

const emu = (path, method = 'GET', body) =>
  fetch(`${base}/emu/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json())

async function newDevice(type) {
  return (await emu('devices', 'POST', { type })).token
}

const funscript = (actions) => JSON.stringify({ actions })
async function uploadFunscript(prefix, token, text, file = 'a.funscript') {
  const fd = new FormData()
  fd.append('file', new Blob([text]), file)
  const r = await fetch(`${base}/${prefix}/sync-script/upload-${file.endsWith('csv') ? 'csv' : 'funscript'}`, { method: 'PUT', headers: { 'x-device-token': token }, body: fd })
  return { status: r.status, body: await r.json() }
}

test('discovery: online names this server as the cluster, offline is just {connected:false}', async () => {
  const r = await call('GET', '/vacuglide/connected', 'emu-vacuglide')
  assert.deepEqual(r.body, { connected: true, cluster: base, deviceType: 'vacuglide' })
  const bad = await call('GET', '/vacuglide/connected', 'nope')
  assert.equal(bad.status, 401)
  assert.deepEqual(bad.body, { error: { code: 'Error', message: 'invalid device token' } }, 'errors use the documented shape')
  await emu('devices/emu-vacuglide', 'PATCH', { online: false })
  assert.deepEqual((await call('GET', '/vacuglide/connected', 'emu-vacuglide')).body, { connected: false })
  assert.equal((await call('PUT', '/vacuglide/target-speed/stop', 'emu-vacuglide')).status, 502)
  await emu('devices/emu-vacuglide', 'PATCH', { online: true })
})

test('VacuGlide: commands answer with the state; field names and modes are the documented ones', async () => {
  const t = await newDevice('vacuglide')
  const s0 = (await call('GET', `/vacuglide/state`, t)).body
  assert.equal(s0.operationalMode, 'ONLINE_CONNECTED')
  assert.deepEqual(Object.keys(s0).sort(), ['localScript', 'operationalMode', 'strokeMinusValve', 'strokePlusValve', 'syncScriptCurrentTime', 'syncScriptLoop', 'syncScriptOffsetTime', 'syncScriptToken', 'targetSpeed'])
  assert.equal(s0.syncScriptToken, '', 'an empty string when no script is loaded')
  const r = await call('PUT', '/vacuglide/target-speed', t, { targetSpeed: 40 })
  assert.equal(r.status, 200)
  assert.equal(r.body.operationalMode, 'TARGET_SPEED_PLAYING')
  assert.equal(r.body.targetSpeed, 40)
  assert.equal((await call('PUT', '/vacuglide/target-speed', t, { targetSpeed: 0 })).status, 200, '0 is valid')
  assert.equal((await call('PUT', '/vacuglide/target-speed', t, { targetSpeed: 101 })).status, 400)
  assert.equal((await call('PUT', '/vacuglide/target-speed', t, { targetSpeed: 'fast' })).status, 400)
  assert.equal((await call('PUT', '/vacuglide/target-speed/stop', t)).body.operationalMode, 'TARGET_SPEED_PAUSED')
  const v = await call('PUT', '/vacuglide/valve/stroke-plus', t, { valveState: true })
  assert.equal(v.body.strokePlusValve, true)
  // selecting a local script closes the valves; start/stop only act in the matching mode
  const l = await call('PUT', '/vacuglide/local-script', t, { localScriptIndex: 3 })
  assert.equal(l.body.operationalMode, 'LOCAL_SCRIPT_PLAYING')
  assert.equal(l.body.strokePlusValve, false)
  assert.equal((await call('PUT', '/vacuglide/local-script/start', t)).body.operationalMode, 'LOCAL_SCRIPT_PLAYING', 'unchanged')
  assert.equal((await call('PUT', '/vacuglide/local-script/stop', t)).body.operationalMode, 'LOCAL_SCRIPT_PAUSED')
  assert.equal((await call('PUT', '/vacuglide/local-script/start', t)).body.operationalMode, 'LOCAL_SCRIPT_PLAYING')
  assert.equal((await call('PUT', '/vacuglide/local-script', t, { localScriptIndex: 30 })).status, 400)
  assert.equal((await call('PUT', '/vacuglide/nonsense', t, {})).status, 404)
  const info = (await call('GET', '/vacuglide/info', t)).body
  assert.equal(typeof info.firmwareVersion, 'number')
  assert.equal(info.firmwareStatus, 'UP_TO_DATE')
})

test('VacuGlide sync script: upload loads it paused; start needs a script; speed is units/s ÷ 6', async () => {
  const t = await newDevice('vacuglide')
  const none = await call('PUT', '/vacuglide/sync-script/start', t, { startTimeMs: 0 })
  assert.equal(none.status, 400)
  assert.equal(none.body.error.message, 'SYNC_SCRIPT_NOT_LOADED')
  assert.equal((await call('PUT', '/vacuglide/sync-script/offset', t, { offsetTimeMs: 250 })).body.syncScriptOffsetTime, 250, 'offset works without a script')
  assert.equal((await call('PUT', '/vacuglide/sync-script/loop', t, { loop: true })).body.syncScriptLoop, true)
  const up = await uploadFunscript('vacuglide', t, funscript([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 60_000, pos: 100 }]))
  assert.equal(up.status, 200)
  assert.match(up.body.syncScriptToken, /^[0-9a-f-]{36}$/, 'a UUID')
  assert.equal(up.body.operationalMode, 'SYNC_SCRIPT_PAUSED')
  assert.equal(up.body.syncScriptLoop, false, 'loading turns looping off')
  assert.equal(up.body.syncScriptOffsetTime, 250, 'the offset persists across loads')
  await call('PUT', '/vacuglide/sync-script/offset', t, { offsetTimeMs: 0 })
  const st = await call('PUT', '/vacuglide/sync-script/start', t, { startTimeMs: 100 })
  assert.equal(st.body.operationalMode, 'SYNC_SCRIPT_PLAYING')
  assert.equal((await call('GET', '/vacuglide/state', t)).body.targetSpeed, 17) // 100 units in 1 s = 100 u/s ÷ 6
  assert.equal((await call('PUT', '/vacuglide/sync-script/stop', t)).body.operationalMode, 'SYNC_SCRIPT_PAUSED')
  const again = await call('PUT', '/vacuglide/sync-script/load-token', t, { scriptToken: up.body.syncScriptToken })
  assert.equal(again.body.syncScriptToken, up.body.syncScriptToken)
  assert.equal((await call('PUT', '/vacuglide/sync-script/load-token', t, { scriptToken: 'nope' })).status, 404)
})

test('scripts: limits and the CSV quirk', async () => {
  const t = await newDevice('vacuglide')
  const late = await uploadFunscript('vacuglide', t, funscript([{ at: 0, pos: 0 }, { at: 16_777_215, pos: 50 }]))
  assert.equal(late.status, 400)
  const notScript = await uploadFunscript('vacuglide', t, 'hello')
  assert.equal(notScript.status, 400)
  // "at,pos" per line; a last line with no newline after it is dropped
  const ok = await uploadFunscript('vacuglide', t, '0,0\n1000,100\n2000,0\n', 'a.csv')
  assert.equal(ok.status, 200)
  const partial = await uploadFunscript('vacuglide', t, '0,0\n1000,100', 'b.csv')
  assert.equal(partial.status, 200)
  await call('PUT', '/vacuglide/sync-script/start', t, { startTimeMs: 0 })
  assert.equal((await call('PUT', '/vacuglide/sync-script/start', t, { startTimeMs: -1 })).status, 400)
})

test('scripts by URL: downloaded, redirects refused', async () => {
  const t = await newDevice('vacuglide')
  const srv = createServer((req, res) => {
    if (req.url === '/redirect') return void res.writeHead(302, { Location: '/s.funscript' }).end()
    res.end(funscript([{ at: 0, pos: 0 }, { at: 500, pos: 80 }]))
  })
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  const u = `http://127.0.0.1:${srv.address().port}`
  try {
    const ok = await call('PUT', '/vacuglide/sync-script/upload-funscript-url', t, { url: u + '/s.funscript' })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.operationalMode, 'SYNC_SCRIPT_PAUSED')
    assert.equal((await call('PUT', '/vacuglide/sync-script/upload-funscript-url', t, { url: u + '/redirect' })).status, 400)
    assert.equal((await call('PUT', '/vacuglide/sync-script/upload-funscript-url', t, { url: 'file:///etc/passwd' })).status, 400)
  } finally {
    srv.close()
  }
})

test('AI Ultra: modes, go-to is the one command that answers {success:true}, local scripts', async () => {
  const t = await newDevice('autoblow-ultra')
  assert.equal((await call('GET', '/autoblow/state', t)).body.operationalMode, 'ONLINE_CONNECTED')
  assert.equal((await call('PUT', '/autoblow/oscillate', t, { speed: 50, minY: 0, maxY: 5 })).status, 400) // < 10 apart
  const o = await call('PUT', '/autoblow/oscillate', t, { speed: 50, minY: 10, maxY: 90 })
  assert.equal(o.body.operationalMode, 'OSCILLATOR_PLAYING')
  assert.equal(o.body.oscillatorHighPoint, 90)
  assert.equal((await call('PUT', '/autoblow/oscillate/stop', t)).body.operationalMode, 'OSCILLATOR_PAUSED')
  const g = await call('PUT', '/autoblow/goto', t, { position: 40, speed: 30 })
  assert.deepEqual(g.body, { success: true })
  assert.equal((await call('GET', '/autoblow/state', t)).body.operationalMode, 'GO_TO')
  const l = await call('PUT', '/autoblow/local-script', t, { localScriptIndex: 2, speedIndex: 4 })
  assert.equal(l.body.operationalMode, 'LOCAL_SCRIPT_PLAYING')
  assert.equal(l.body.localScriptSpeed, 4)
  assert.equal((await call('PUT', '/autoblow/local-script/stop', t)).body.operationalMode, 'LOCAL_SCRIPT_PAUSED')
  assert.equal((await call('PUT', '/autoblow/local-script', t, { localScriptIndex: 10, speedIndex: 0 })).status, 400)
  assert.equal((await call('PUT', '/vacuglide/target-speed', t, { targetSpeed: 5 })).status, 404, 'wrong device type')
})

test('VacuPump: modes, validation, vacuum builds gradually and manual/stop keeps it', async () => {
  const t = await newDevice('vacupump')
  assert.equal((await call('PUT', '/vacupump/manual/target', t, { targetVacuumKpa: -70 })).status, 400)
  assert.equal((await call('PUT', '/vacupump/stroke/config', t, { vacuumTargetKpa: -20, pressureTargetKpa: -20, speedPct: 50 })).status, 400)
  assert.equal((await call('PUT', '/vacupump/manual/target', t, { targetVacuumKpa: -20 })).body.targetVacuumKpa !== undefined, true, 'answers with the state')
  assert.equal((await call('PUT', '/vacupump/manual/start', t)).body.operationalMode, 'MANUAL')
  await new Promise((r) => setTimeout(r, 300))
  const v = (await call('GET', '/vacupump/state', t)).body.currentVacuumKpa
  assert.ok(v < -2 && v > -20, `vacuum builds up gradually, got ${v}`)
  assert.equal((await call('PUT', '/vacupump/manual/stop', t)).body.operationalMode, 'IDLE')
  const kept = (await call('GET', '/vacupump/state', t)).body.currentVacuumKpa
  await new Promise((r) => setTimeout(r, 200))
  assert.equal((await call('GET', '/vacupump/state', t)).body.currentVacuumKpa, kept, 'the vacuum is kept')
  assert.equal((await call('PUT', '/vacupump/pulse/start', t)).body.operationalMode, 'PULSE')
  assert.equal((await call('PUT', '/vacupump/pulse/pause', t)).body.operationalMode, 'PULSE_PAUSED')
  const s = (await call('GET', '/vacupump/state', t)).body
  for (const k of ['pulseTimerMs', 'pulseDirection', 'strokeDirection', 'workoutExerciseIndex', 'workoutRemainingMs', 'syncScriptDurationMs', 'syncScriptSectionIndex', 'syncScriptSectionCount', 'syncScriptLoaded'])
    assert.ok(k in s, `state has ${k}`)
})

test('VacuPump: info, settings, workouts, firmware, state-updates', async () => {
  const t = await newDevice('vacupump')
  const info = (await call('GET', '/vacupump/info', t)).body
  assert.deepEqual(info.capabilities, [{ key: 'sync_script', value: '1' }])
  assert.equal(typeof info.firmwareVersion, 'number')
  assert.deepEqual((await call('GET', '/vacupump/settings', t)).body, { units: 1, lcdBrightnessLevel: 5 })
  assert.equal((await call('PUT', '/vacupump/settings', t, { units: 2, lcdBrightnessLevel: 5 })).status, 400)
  assert.equal((await call('PUT', '/vacupump/settings', t, { units: 0, lcdBrightnessLevel: 11 })).status, 400)
  assert.deepEqual((await call('PUT', '/vacupump/settings', t, { units: 0, lcdBrightnessLevel: 8 })).body, { units: 0, lcdBrightnessLevel: 8 })
  const list = (await call('GET', '/vacupump/workout/list', t)).body
  assert.equal(list.totalSlots, 10)
  assert.equal(list.items.length, 10)
  assert.equal(list.items[0].exists, true)
  assert.equal(list.items[9].exists, false)
  assert.equal((await call('PUT', '/vacupump/workout/start', t, { slot: 10 })).status, 400, 'empty slot')
  const w = await call('PUT', '/vacupump/workout/start', t, { slot: 1 })
  assert.equal(w.body.operationalMode, 'WORKOUTS')
  assert.ok(w.body.workoutRemainingMs > 0)
  assert.equal((await call('PUT', '/vacupump/workout/pause', t)).body.operationalMode, 'WORKOUTS_PAUSED')
  assert.equal((await call('PUT', '/vacupump/workout/resume', t)).body.operationalMode, 'WORKOUTS')
  const fw = await call('GET', '/vacupump/firmware/update-info', t)
  assert.equal(fw.status, 400)
  assert.equal(fw.body.error.message, 'No firmware update version found for this device.')
  assert.equal((await call('PUT', '/vacupump/state-updates', t, {})).status, 400)
  assert.deepEqual((await call('PUT', '/vacupump/state-updates', t, { enabled: true })).body, { success: true })
})

test('VacuPump sync scripts are exercises: validated, loaded, played, vented on stop', async () => {
  const t = await newDevice('vacupump')
  const put = (path, body) => call('PUT', `/vacupump/${path}`, t, body)
  // funscript / csv uploads don't exist on the pump
  assert.equal((await put('sync-script/upload-funscript', { actions: [] })).status, 404)
  assert.equal((await put('sync-script/loop', { loop: true })).status, 404)
  // validation
  for (const bad of [
    { exercises: [] },
    { exercises: [{ type: 'HOLD', durationMs: 1000, vacuumKpa: 5 }] },
    { exercises: [{ type: 'HOLD', durationMs: 0, vacuumKpa: -10 }] },
    { exercises: [{ type: 'PULSE', durationMs: 1000, pulse1Kpa: -10, pulse1Ms: 10, pulse2Kpa: -20, pulse2Ms: 100 }] },
    { exercises: [{ type: 'STROKE', durationMs: 1000, vacuumTargetKpa: -20, pressureTargetKpa: -20, speedPct: 50 }] },
    { exercises: [{ type: 'STROKE', durationMs: 1000, vacuumTargetKpa: -20, pressureTargetKpa: 0, speedPct: 5 }] },
    { exercises: [{ type: 'WAVE', durationMs: 1000 }] },
    { exercises: 'hold' }
  ])
    assert.equal((await put('sync-script/upload-exercises', bad)).status, 400, JSON.stringify(bad))
  const up = await put('sync-script/upload-exercises', {
    exercises: [
      { type: 'HOLD', durationMs: 60_000, vacuumKpa: -30 },
      { type: 'REST', durationMs: 1000 }
    ]
  })
  assert.equal(up.status, 200)
  assert.equal(up.body.operationalMode, 'SYNC_PAUSED')
  assert.equal(up.body.syncScriptLoaded, true)
  assert.equal(up.body.syncScriptSectionCount, 2)
  assert.equal(up.body.syncScriptDurationMs, 61_000)
  const info = await call('GET', `/vacupump/sync-script/info/${up.body.syncScriptToken}`, t)
  assert.equal(info.body.exerciseCount, 2)
  assert.equal((await call('GET', '/vacupump/sync-script/info/nope', t)).status, 404)
  const play = await put('sync-script/start', { startTimeMs: 0 })
  assert.equal(play.body.operationalMode, 'SYNC_PLAYING')
  await new Promise((r) => setTimeout(r, 400))
  assert.ok((await call('GET', '/vacupump/state', t)).body.currentVacuumKpa < -3, 'the exercise drives the vacuum')
  const stop = await put('sync-script/stop')
  assert.equal(stop.body.operationalMode, 'SYNC_PAUSED')
  await new Promise((r) => setTimeout(r, 700))
  const after = (await call('GET', '/vacupump/state', t)).body.currentVacuumKpa
  assert.ok(after > -8, `stopping releases the vacuum, got ${after}`)
  // starting past the end completes at once and releases the vacuum
  const end = await put('sync-script/start', { startTimeMs: 70_000 })
  assert.equal(end.body.operationalMode, 'SYNC_PAUSED')
  assert.equal(end.body.syncScriptSectionIndex, 2)
  assert.equal((await put('sync-script/start', { startTimeMs: 0 })).body.operationalMode, 'SYNC_PLAYING')
  assert.equal((await put('manual/start')).body.operationalMode, 'MANUAL', 'another mode leaves sync')
  // a VacuGlide funscript token can't be loaded on the pump
  const g = await newDevice('vacuglide')
  const fs = await uploadFunscript('vacuglide', g, funscript([{ at: 0, pos: 0 }, { at: 1000, pos: 50 }]))
  assert.equal((await put('sync-script/load-token', { scriptToken: fs.body.syncScriptToken })).status, 404)
})

test('rate limit: 429 in the measured shape, x-ratelimit-* headers on every answer', async () => {
  const first = await call('GET', '/vacuglide/state', 'emu-vacuglide')
  assert.ok(first.headers.get('x-ratelimit-limit') && first.headers.get('x-ratelimit-remaining') && first.headers.get('x-ratelimit-reset'))
  await emu('settings', 'PUT', { rateLimitPerSec: 2 })
  const r = []
  for (let i = 0; i < 4; i++) r.push(await call('GET', '/vacuglide/state', 'emu-vacuglide'))
  await emu('settings', 'PUT', { rateLimitPerSec: 0 })
  const limited = r.find((x) => x.status === 429)
  assert.ok(limited, r.map((x) => x.status).join(' '))
  assert.equal(limited.body.error.message, 'Rate limit exceeded, retry in 1 seconds')
  assert.equal(limited.headers.get('x-ratelimit-limit'), '2')
  assert.equal(limited.headers.get('x-ratelimit-remaining'), '0')
})

test('browsers: CORS preflight is answered; the page API refuses other sites and odd Host names', async () => {
  const pre = await fetch(`${base}/vacuglide/target-speed`, { method: 'OPTIONS', headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-device-token,content-type' } })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('access-control-allow-origin'), '*')
  assert.match(pre.headers.get('access-control-allow-headers'), /x-device-token/)
  const api = await call('GET', '/vacuglide/state', 'emu-vacuglide', undefined, { Origin: 'https://app.example' })
  assert.equal(api.headers.get('access-control-allow-origin'), '*')
  const cross = await fetch(`${base}/emu/api/snapshot`, { headers: { Origin: 'https://evil.example' } })
  assert.equal(cross.status, 403, 'another website cannot read or change the emulator')
  const del = await fetch(`${base}/emu/api/devices/emu-vacuglide`, { method: 'DELETE', headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' } })
  assert.equal(del.status, 403)
  assert.equal((await fetch(`${base}/emu/api/snapshot`, { headers: { Origin: base } })).status, 200, 'the page itself is fine')
  // fetch won't let a script choose the Host header, so this one is a raw request (DNS rebinding)
  const status = await new Promise((resolve, reject) => {
    const q = request({ host: '127.0.0.1', port, path: '/emu/api/snapshot', headers: { Host: 'rebind.example' } }, (r) => {
      r.resume()
      resolve(r.statusCode)
    })
    q.on('error', reject)
    q.end()
  })
  assert.equal(status, 403)
})

test('token only goes in the header, except on the event stream', async () => {
  const r = await fetch(`${base}/vacuglide/state?deviceToken=emu-vacuglide`)
  assert.equal(r.status, 401)
  assert.equal((await fetch(`${base}/events/stream?deviceToken=wrong`)).status, 401)
})

test('event stream: connected, and the button presses you send from the emulator', async () => {
  const ac = new AbortController()
  const res = await fetch(`${base}/events/stream?deviceToken=emu-vacuglide`, { signal: ac.signal })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  const reader = res.body.getReader()
  let text = ''
  const until = async (re) => {
    const t0 = Date.now()
    while (!re.test(text) && Date.now() - t0 < 3000) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    assert.match(text, re)
  }
  await until(/event: connected\ndata: .*"subscribedDevice":"emu-vacuglide"/)
  assert.equal((await emu('devices/emu-vacuglide/button', 'POST', { type: 'speed-plus-button-pressed' })).error, undefined)
  await until(/event: speed-plus-button-pressed\ndata: .*"payload":\{"type":"speed-plus-button-pressed"/)
  assert.ok((await emu('devices/emu-vacuglide/button', 'POST', { type: 'pause-button-pressed' })).error, 'only this device\'s buttons')
  ac.abort()
})

test('bad input gets a 400, not a crash', async () => {
  const r = await fetch(`${base}/vacuglide/target-speed`, { method: 'PUT', headers: { 'x-device-token': 'emu-vacuglide', 'Content-Type': 'application/json' }, body: '{"targetSpeed": ' })
  assert.equal(r.status, 400)
  assert.equal((await fetch(`${base}/emu/api/settings`, { method: 'PUT', body: 'not json' })).status, 400)
  assert.equal((await call('GET', '/nothing/here', 'emu-vacuglide')).status, 404)
})

test('a damaged devices file is kept aside and the emulator still starts', async () => {
  const data = join(dir, 'bad.json')
  writeFileSync(data, '{"devices": [')
  const p2port = port + 1
  const p = await start(p2port, data)
  try {
    assert.ok(existsSync(data + '.bad'))
    const r = await fetch(`http://127.0.0.1:${p2port}/emu/api/snapshot`)
    assert.equal(r.status, 200)
  } finally {
    p.kill()
  }
})

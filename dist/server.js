// Autoblow emulator: answers Autoblow's cloud device API like the real thing, for
// apps under test, and serves a page that shows what each emulated device does.
//
//   autoblow-emulator [--port 8792] [--host 127.0.0.1] [--data FILE]
//
// Point the app's "latency"/discovery URL at http://127.0.0.1:8792 and use an
// emulator token. /connected answers with this server as the cluster, so every
// later call comes here too.
import { createServer,                                           } from 'node:http'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import {
  HttpError,
  makeDevice,
  prefixOf,
  Ultra,
  VacuGlide,
  VacuPump,
                    
                  
                
} from './devices.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))                       ).version

// Same folders other apps use for settings on each system.
function defaultDataFile()         {
  const home = homedir()
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? join(home, '.config'))
  return join(base, 'autoblow-emulator', 'devices.json')
}

const help = `Autoblow emulator ${version}: a fake of Autoblow's cloud device API.

Usage: autoblow-emulator [flags]
  --port N      port to listen on (default 8792)
  --host ADDR   address to listen on (default 127.0.0.1; 0.0.0.0 = reachable from your network, no password)
  --data FILE   where devices are saved (default ${defaultDataFile()})
  --version, -h
`

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '8792' },
    host: { type: 'string', default: '127.0.0.1' },
    data: { type: 'string', default: defaultDataFile() },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean' }
  }
})
if (args.help) {
  process.stdout.write(help)
  process.exit(0)
}
if (args.version) {
  console.log(version)
  process.exit(0)
}
const port = Number(args.port)
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('--port must be a whole number from 0 to 65535')
  process.exit(2)
}

const publicDir = join(root, 'public')
const maxBody = 60 << 20 // the real API takes uploads up to 60 MB

// ---------- state ----------

                    
                                                
                                                                     
 

const settings           = { latencyMs: 0, rateLimitPerSec: 0 }
const devices = new Map                   ()

                    
           
               
                
                
              
              
                
                
 
const log             = []

const isRecord = (r         )                    =>
  !!r &&
  typeof r === 'object' &&
  typeof (r                ).token === 'string' &&
  (r                ).token !== '' &&
  (r                ).type in prefixOf &&
  typeof (r                ).name === 'string' &&
  typeof (r                ).online === 'boolean'

function load()       {
  let records                 = []
  let text                    
  try {
    text = readFileSync(args.data , 'utf8')
  } catch {
    // first run
  }
  if (text !== undefined) {
    try {
      const list = (JSON.parse(text)                           ).devices
      if (!Array.isArray(list)) throw new Error('no devices list')
      records = list.filter(isRecord)
    } catch {
      // A damaged file is kept aside, not overwritten.
      try {
        renameSync(args.data , `${args.data}.bad`)
        console.error(`${args.data} was not valid; moved it to ${args.data}.bad and started fresh`)
      } catch {
        console.error(`${args.data} was not valid; started fresh`)
      }
    }
  }
  if (!records.length && text === undefined) records = [{ token: 'emu-vacuglide', type: 'vacuglide', name: 'Emulated VacuGlide', online: true }]
  for (const r of records) devices.set(r.token, makeDevice(r))
  save()
}

function save()       {
  try {
    mkdirSync(dirname(args.data ), { recursive: true })
    const tmp = `${args.data}.tmp`
    writeFileSync(tmp, JSON.stringify({ devices: [...devices.values()].map((d) => d.record()) }, null, 2) + '\n')
    renameSync(tmp, args.data )
  } catch (e) {
    console.error(`couldn't save devices to ${args.data}: ${(e         ).message}`)
  }
}

// ---------- live updates for the page (server-sent events) ----------

const listeners = new Set                ()

function broadcast(event        , data         )       {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of listeners) res.write(msg)
}

function view(d           )                          {
  const base = { token: d.token, type: d.type, name: d.name, online: d.online, state: d.state() }
  if (d instanceof VacuGlide) return { ...base, visual: { kind: 'speed', speed: d.speed(), valves: d.valves } }
  if (d instanceof Ultra) return { ...base, visual: { kind: 'position', position: d.position(), osc: d.osc, goto: d.goto } }
  if (d instanceof VacuPump) return { ...base, visual: { kind: 'vacuum', current: d.current, mode: d.mode } }
  return base
}

const snapshot = () => ({ settings, devices: [...devices.values()].map(view) })

// Push state a few times a second while anything changes (sync scripts, pump vacuum).
setInterval(() => {
  if (listeners.size) broadcast('snapshot', snapshot())
}, 250)

// ---------- the API's own event stream: GET /events/stream?deviceToken=... ----------

                  
                     
               
              
 
const streams = new Set        ()

function sse(res                , event        , data         )       {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function eventsStream(req                 , res                , url     )       {
  const token = url.searchParams.get('deviceToken') ?? ''
  if (!devices.has(token)) return errorJson(res, 401, 'invalid device token')
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' })
  const s         = { res, token, last: '' }
  streams.add(s)
  sse(res, 'connected', { connectionId: randomUUID(), subscribedDevice: token })
  req.on('close', () => streams.delete(s))
}

setInterval(() => {
  for (const s of streams) sse(s.res, 'heartbeat', { timestamp: Date.now() })
}, 30_000)

// VacuPump state-updates: a state-updated event when the state changes.
setInterval(() => {
  for (const s of streams) {
    const d = devices.get(s.token)
    if (!(d instanceof VacuPump) || !d.stateUpdates || !d.online) continue
    const st = JSON.stringify(d.state())
    if (st !== s.last) {
      s.last = st
      s.res.write(`event: state-updated\ndata: ${st}\n\n`)
    }
  }
}, 500)

const buttons                               = {
  vacuglide: ['speed-plus-button-pressed', 'speed-minus-button-pressed', 'mode-button-pressed'],
  'autoblow-ultra': ['mode-button-pressed', 'pause-button-pressed', 'speed-up-button-pressed', 'speed-down-button-pressed'],
  vacupump: []
}

// ---------- helpers ----------

async function readBody(req                 , limit = maxBody)                  {
  const chunks           = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new HttpError(413, 'body too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

function parseJson(raw                 , what = 'body')                          {
  const text = String(raw).trim()
  if (!text) return {}
  try {
    const v = JSON.parse(text)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error()
    return v                           
  } catch {
    throw new HttpError(400, `${what} is not a JSON object`)
  }
}

// CORS: the Autoblow API is for apps, browser apps included; the emulator's own page API is not.
const apiCors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset'
}

function json(res                , status        , body         , extra                                  = {})       {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extra })
  res.end(JSON.stringify(body))
}

// Errors in the shape the docs show for the firmware 400 (and the 429): {error: {code, message}}.
function errorJson(res                , status        , message        , code = 'Error', extra                                  = {})       {
  json(res, status, { error: { code, message } }, extra)
}

// First file part of a multipart/form-data body (the funscript/csv upload).
function multipartFile(body        , contentType        )         {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)
  if (!m) throw new HttpError(400, 'multipart body without boundary')
  const boundary = '--' + (m[1] ?? m[2])
  for (const part of body.toString('utf8').split(boundary)) {
    const i = part.indexOf('\r\n\r\n')
    if (i < 0 || !/name="file"/.test(part.slice(0, i))) continue
    return part.slice(i + 4).replace(/\r\n$/, '')
  }
  throw new HttpError(400, 'no "file" field in the upload')
}

// upload-*-url: the real API downloads the script itself. Redirects are not followed, as documented.
// (It also insists on https; this emulator accepts http so a local file server will do.)
async function downloadScript(u         )                  {
  if (typeof u !== 'string' || !/^https?:\/\//.test(u)) throw new HttpError(400, 'url must be an http(s) address')
  let r          
  try {
    r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  } catch (e) {
    throw new HttpError(400, `could not download the script (${(e         ).message})`)
  }
  if (r.status >= 300 && r.status < 400) throw new HttpError(400, 'the url redirects; redirects are not followed')
  if (!r.ok) throw new HttpError(400, `could not download the script (${r.status})`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length > maxBody) throw new HttpError(400, 'the script is larger than 60 MB')
  return buf.toString('utf8')
}

// Rate limit per token over a sliding second. Every answer carries the x-ratelimit-* headers; their
// exact units are UNDOCUMENTED (reset = seconds until a request is allowed again).
const hits = new Map                  ()
function rateInfo(token        , count         )                                                        {
  const limit = settings.rateLimitPerSec
  const now = Date.now()
  const h = (hits.get(token) ?? []).filter((t) => now - t < 1000)
  if (limit && count) h.push(now)
  if (h.length) hits.set(token, h)
  else hits.delete(token)
  const shown = limit || 1000 // with the limit off, a made-up generous number
  const remaining = Math.max(0, shown - h.length)
  const reset = h.length ? Math.max(1, Math.ceil((h[0] + 1000 - now) / 1000)) : 1
  return {
    limited: !!limit && h.length > limit,
    headers: { 'x-ratelimit-limit': String(shown), 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': String(reset) }
  }
}

// ---------- Autoblow API ----------

async function autoblowApi(req                 , res                , url     )                {
  const [, prefix, ...rest] = url.pathname.split('/')
  const path = rest.join('/')
  const type = (Object.keys(prefixOf)                ).find((t) => prefixOf[t] === prefix)
  const token = String(req.headers['x-device-token'] ?? '')
  const dev = devices.get(token)
  const raw = await readBody(req)
  const contentType = String(req.headers['content-type'] ?? '')
  const entry           = {
    t: Date.now(),
    token: token.slice(0, 16),
    device: dev?.name ?? '?',
    method: req.method ?? '',
    path: url.pathname,
    body: contentType.startsWith('multipart/') ? `(upload, ${raw.length} bytes)` : raw.toString('utf8').slice(0, 300),
    status: 0,
    answer: ''
  }
  const rate = dev ? rateInfo(token, true) : null
  const finish = (status        , body         ) => {
    entry.status = status
    entry.answer = JSON.stringify(body).slice(0, 300)
    log.push(entry)
    if (log.length > 500) log.shift()
    broadcast('log', entry)
    const send = () => json(res, status, body, { ...apiCors, ...(rate?.headers ?? {}) })
    if (settings.latencyMs > 0) setTimeout(send, settings.latencyMs)
    else send()
  }

  try {
    if (!type) throw new HttpError(404, 'not found')
    if (!dev) throw new HttpError(401, 'invalid device token')
    if (rate .limited) {
      // The message is what the real API says (measured); the docs only say a 429 means the limit was hit.
      return finish(429, { error: { code: 'Error', message: 'Rate limit exceeded, retry in 1 seconds' } })
    }
    if (path === 'connected') {
      // Real devices say which type they are even when the path is another type's. The cluster is this
      // server's address with its scheme, unlike the real API's bare host name, so that clients that
      // follow it keep talking to the emulator.
      return finish(200, dev.online ? { connected: true, cluster: `http://${req.headers.host}`, deviceType: dev.type } : { connected: false })
    }
    if (dev.type !== type) throw new HttpError(404, `this token is for a ${dev.type}`) // UNDOCUMENTED status
    if (!dev.online) throw new HttpError(502, 'DeviceNotConnectedError') // UNDOCUMENTED body

    let out         
    if (req.method === 'PUT' && path.startsWith('sync-script/upload-')) {
      const kind = path.slice('sync-script/upload-'.length)
      if (dev instanceof VacuPump) {
        if (kind !== 'exercises') throw new HttpError(404, 'the VacuPump takes upload-exercises, not funscripts')
        out = dev.uploadExercises(parseJson(raw), raw.length)
      } else {
        if (!['funscript', 'csv', 'funscript-url', 'csv-url'].includes(kind)) throw new HttpError(404, 'not found')
        let text        
        if (kind.endsWith('-url')) text = await downloadScript(parseJson(raw).url)
        else text = contentType.startsWith('multipart/') ? multipartFile(raw, contentType) : raw.toString('utf8')
        out = dev.upload(path, text)
      }
    } else {
      out = dev.handle(req.method ?? 'GET', path, req.method === 'GET' ? {} : parseJson(raw))
    }
    dev.touch()
    finish(200, out)
  } catch (e) {
    if (e instanceof HttpError) finish(e.status, { error: { code: e.code, message: e.message } })
    else finish(500, { error: { code: 'Error', message: (e         ).message } })
  }
}

// ---------- the emulator's own page and controls ----------

async function emuApi(req                 , res                , url     )                {
  const parts = url.pathname.split('/').slice(3) // /emu/api/...
  const body = req.method === 'GET' ? {} : parseJson(await readBody(req, 1 << 20))
  if (parts[0] === 'snapshot') return json(res, 200, { ...snapshot(), log })
  if (parts[0] === 'settings' && req.method === 'PUT') {
    if (typeof body.latencyMs === 'number') settings.latencyMs = Math.max(0, Math.min(10_000, body.latencyMs))
    if (typeof body.rateLimitPerSec === 'number') settings.rateLimitPerSec = Math.max(0, Math.min(100, body.rateLimitPerSec))
    return json(res, 200, settings)
  }
  if (parts[0] === 'devices' && req.method === 'POST' && !parts[1]) {
    const type = body.type              
    if (!(type in prefixOf)) return json(res, 400, { error: 'type must be vacuglide, autoblow-ultra or vacupump' })
    let token = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : ''
    if (!token) token = `emu-${prefixOf[type]}-${Math.random().toString(36).slice(2, 8)}`
    if (devices.has(token)) return json(res, 400, { error: 'token already in use' })
    const names = { vacuglide: 'Emulated VacuGlide', 'autoblow-ultra': 'Emulated AI Ultra', vacupump: 'Emulated VacuPump' }
    devices.set(token, makeDevice({ token, type, name: typeof body.name === 'string' && body.name ? body.name : names[type], online: true }))
    save()
    return json(res, 200, { token })
  }
  const dev = parts[0] === 'devices' ? devices.get(decodeURIComponent(parts[1] ?? '')) : undefined
  if (!dev) return json(res, 404, { error: 'no such device' })
  if (req.method === 'DELETE') {
    devices.delete(dev.token)
    save()
    return json(res, 200, {})
  }
  if (parts[2] === 'stop') {
    dev.stopAll()
    return json(res, 200, {})
  }
  if (parts[2] === 'button' && req.method === 'POST') {
    // A press of one of the device's physical buttons, sent to anyone on GET /events/stream.
    const kind = String(body.type ?? '')
    if (!buttons[dev.type].includes(kind)) return json(res, 400, { error: `type must be one of: ${buttons[dev.type].join(', ') || '(this device has none)'}` })
    for (const s of streams) if (s.token === dev.token) sse(s.res, kind, { deviceToken: dev.token, payload: { type: kind, rawData: '', args: [] }, timestamp: Date.now() })
    return json(res, 200, {})
  }
  if (req.method === 'PATCH') {
    if (typeof body.online === 'boolean') dev.online = body.online
    if (typeof body.name === 'string' && body.name.trim()) dev.name = body.name.trim()
    save()
    return json(res, 200, {})
  }
  json(res, 404, { error: 'not found' })
}

const statics                         = {
  '/': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css'
}
const types                         = { html: 'text/html', js: 'text/javascript', css: 'text/css' }

// The emulator's own page and controls are for the person running it. Another web page they have open
// must not be able to drive them (cross-site requests), nor a name pointed at 127.0.0.1 by someone
// else's DNS (rebinding). The Autoblow API paths don't need this: they are meant for apps.
const loopbackBind = /^(127\.|localhost$|::1$)/i.test(args.host )
function pageRequestAllowed(req                 )          {
  const host = req.headers.host ?? ''
  const origin = req.headers.origin
  if (origin) {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  if (loopbackBind && !/^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\]|localhost)(:\d+)?$/i.test(host)) return false
  return true
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  try {
    if (url.pathname.startsWith('/emu/') || statics[url.pathname]) {
      if (!pageRequestAllowed(req)) return void res.writeHead(403).end('Forbidden')
    } else if (req.method === 'OPTIONS') {
      // Browser apps ask first (CORS preflight) because of the x-device-token header.
      return void res
        .writeHead(204, {
          ...apiCors,
          'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'x-device-token, content-type',
          'Access-Control-Max-Age': '600'
        })
        .end()
    }
    if (url.pathname === '/emu/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`)
      listeners.add(res)
      req.on('close', () => listeners.delete(res))
      return
    }
    if (url.pathname.startsWith('/emu/api/')) return await emuApi(req, res, url)
    if (url.pathname === '/events/stream' && req.method === 'GET') return eventsStream(req, res, url)
    if (url.pathname === '/favicon.ico') return void res.writeHead(204).end()
    const file = statics[url.pathname]
    if (file && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': types[file.split('.').pop() ] + '; charset=utf-8' })
      return void res.end(readFileSync(join(publicDir, file)))
    }
    await autoblowApi(req, res, url)
  } catch (e) {
    if (res.headersSent) return void res.end()
    if (e instanceof HttpError) errorJson(res, e.status, e.message, e.code)
    else errorJson(res, 500, (e         ).message)
  }
})

server.on('error', (e                       ) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Try another with --port.` : `Could not start: ${e.message}`)
  process.exit(1)
})

const bye = () => {
  save()
  process.exit(0)
}
process.on('SIGINT', bye)
process.on('SIGTERM', bye)

load()
server.listen(port, args.host, () => {
  const bound = (server.address()                    ).port
  const base = `http://${args.host === '0.0.0.0' ? '127.0.0.1' : args.host}:${bound}`
  console.log(`Autoblow emulator on ${base}  (page: ${base}/)`)
  for (const d of devices.values()) console.log(`  ${d.name}: token ${d.token}`)
  if (!loopbackBind) console.log('Listening beyond this computer: anyone on your network can use it (there is no password).')
})

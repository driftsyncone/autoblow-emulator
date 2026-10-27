// Emulated Autoblow devices. Each one keeps the state its real counterpart reports and
// validates requests the way the API docs describe (out-of-range values are rejected with 400,
// not clamped). Physical motion is modelled only roughly, so a person can see what a device
// *would* do.
//
// Sources: developers.autoblow.com/reference/http-api-v1-{vacuglide,autoblow,vacupump}/
// plus measurements on a real VacuGlide 2 (sync-script speed = units/s ÷ 6).
// Where the docs are silent the code says UNDOCUMENTED: that is a guess.
import { randomUUID } from 'node:crypto'

export type DeviceType = 'vacuglide' | 'autoblow-ultra' | 'vacupump'

export const prefixOf: Record<DeviceType, string> = {
  vacuglide: 'vacuglide',
  'autoblow-ultra': 'autoblow',
  vacupump: 'vacupump'
}

export class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, message: string, code = 'Error') {
    super(message)
    this.status = status
    this.code = code
  }
}

const bad = (msg: string) => new HttpError(400, msg)

function num(body: Record<string, unknown>, key: string, lo: number, hi: number, int = false): number {
  const v = body[key]
  if (typeof v !== 'number' || Number.isNaN(v)) throw bad(`${key} must be a number`)
  if (int && !Number.isInteger(v)) throw bad(`${key} must be an integer`)
  if (v < lo || v > hi) throw bad(`${key} must be between ${lo} and ${hi}`)
  return v
}

function bool(body: Record<string, unknown>, key: string): boolean {
  if (typeof body[key] !== 'boolean') throw bad(`${key} must be true or false`)
  return body[key] as boolean
}

export interface Action {
  at: number // ms
  pos: number // 0-100
}

export type Exercise =
  | { type: 'HOLD'; durationMs: number; vacuumKpa: number }
  | { type: 'PULSE'; durationMs: number; pulse1Kpa: number; pulse1Ms: number; pulse2Kpa: number; pulse2Ms: number }
  | { type: 'STROKE'; durationMs: number; vacuumTargetKpa: number; pressureTargetKpa: number; speedPct: number }
  | { type: 'REST'; durationMs: number }

// ---------- uploaded scripts ----------

export interface StoredScript {
  token: string
  kind: 'funscript' | 'exercises'
  actions: Action[]
  exercises: Exercise[]
  durationMs: number
  expires: number
}

// The real API keeps a script 9 days. Here they also live only in memory, and no more than 200.
const scriptTtlMs = 9 * 24 * 3600 * 1000
const scripts = new Map<string, StoredScript>()

function keep(s: Omit<StoredScript, 'token' | 'expires'>): string {
  const now = Date.now()
  for (const [t, x] of scripts) if (x.expires < now) scripts.delete(t)
  while (scripts.size >= 200) scripts.delete(scripts.keys().next().value as string)
  const token = randomUUID()
  scripts.set(token, { ...s, token, expires: now + scriptTtlMs })
  return token
}

export function getScript(token: string): StoredScript | undefined {
  const s = scripts.get(token)
  if (s && s.expires < Date.now()) {
    scripts.delete(token)
    return undefined
  }
  return s
}

const maxScriptEndMs = 16_777_214 // the last action of a funscript can't be later than this

export function storeFunscript(actions: Action[]): string {
  if (!actions.length) throw bad('script has no actions')
  if (actions.length > 100_000) throw bad('more than 100000 actions')
  const last = actions[actions.length - 1].at
  if (last > maxScriptEndMs) throw bad(`the last action is at ${last} ms; the limit is ${maxScriptEndMs} ms`)
  return keep({ kind: 'funscript', actions, exercises: [], durationMs: Math.max(0, last) })
}

export function parseFunscript(text: string): Action[] {
  let j: { actions?: { at: number; pos: number }[] }
  try {
    j = JSON.parse(text)
  } catch {
    throw bad('not a funscript (bad JSON)')
  }
  if (!j || !Array.isArray(j.actions)) throw bad('not a funscript (no actions)')
  // UNDOCUMENTED: positions outside 0-100 are clamped here (the real API may reject them).
  return j.actions
    .filter((a) => a && typeof a.at === 'number' && typeof a.pos === 'number')
    .map((a) => ({ at: a.at, pos: Math.max(0, Math.min(100, a.pos)) }))
    .sort((x, y) => x.at - y.at)
}

// "at,pos" per line, no header. As documented, a last line without a newline after it is dropped.
export function parseCsv(text: string): Action[] {
  const lines = text.split(/\r?\n/)
  lines.pop() // after the final newline there is an empty string; without one, the unfinished last line
  return lines
    .map((l) => l.split(',').map(Number))
    .filter((r) => r.length >= 2 && r.every((n) => !Number.isNaN(n)))
    .map(([at, pos]) => ({ at, pos: Math.max(0, Math.min(100, pos)) }))
}

// VacuPump sync scripts are lists of exercises, validated as the docs list them.
export function validateExercises(list: unknown, rawBytes: number): { exercises: Exercise[]; durationMs: number } {
  if (!list || typeof list !== 'object' || !Array.isArray((list as { exercises?: unknown }).exercises)) throw bad('exercises must be a list')
  const arr = (list as { exercises: unknown[] }).exercises
  if (arr.length < 1 || arr.length > 1000) throw bad('exercises must have between 1 and 1000 items')
  if (rawBytes > 128 * 1024) throw bad('the exercises are larger than 128 KiB')
  let total = 0
  const out = arr.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw bad(`exercises[${i}] must be an object`)
    const e = raw as Record<string, unknown>
    const at = (k: string, lo: number, hi: number, int = false) => {
      try {
        return num(e, k, lo, hi, int)
      } catch (err) {
        throw bad(`exercises[${i}]: ${(err as Error).message}`)
      }
    }
    const durationMs = at('durationMs', 1, 24 * 3600 * 1000, true)
    total += durationMs
    switch (e.type) {
      case 'HOLD':
        return { type: 'HOLD', durationMs, vacuumKpa: at('vacuumKpa', -60, 0) } as Exercise
      case 'PULSE':
        return {
          type: 'PULSE',
          durationMs,
          pulse1Kpa: at('pulse1Kpa', -60, 0),
          pulse1Ms: at('pulse1Ms', 30, 600_000, true),
          pulse2Kpa: at('pulse2Kpa', -60, 0),
          pulse2Ms: at('pulse2Ms', 30, 600_000, true)
        } as Exercise
      case 'STROKE': {
        const v = at('vacuumTargetKpa', -60, 0)
        const p = at('pressureTargetKpa', -60, 60)
        if (p < v + 0.1) throw bad(`exercises[${i}]: pressureTargetKpa must be at least 0.1 above vacuumTargetKpa`)
        return { type: 'STROKE', durationMs, vacuumTargetKpa: v, pressureTargetKpa: p, speedPct: at('speedPct', 10, 100) } as Exercise
      }
      case 'REST':
        return { type: 'REST', durationMs } as Exercise
      default:
        throw bad(`exercises[${i}]: type must be HOLD, PULSE, STROKE or REST`)
    }
  })
  if (total > 24 * 3600 * 1000) throw bad('the exercises add up to more than 24 hours')
  return { exercises: out, durationMs: total }
}

export function storeExercises(exercises: Exercise[], durationMs: number): string {
  return keep({ kind: 'exercises', actions: [], exercises, durationMs })
}

// ---------- shared device behaviour ----------

export interface SyncScript {
  script: StoredScript
  playing: boolean
  startedAt: number // wall time when script time 0 would have been
  pausedAt: number // script time when stopped
}

export interface DeviceRecord {
  token: string
  type: DeviceType
  name: string
  online: boolean
}

export type SyncEvent = 'load' | 'start' | 'stop' | 'end'

export abstract class EmuDevice {
  token: string
  type: DeviceType
  name: string
  online: boolean
  sync: SyncScript | null = null
  syncOffset = 0 // ms; kept across loads until the emulator restarts
  syncLoop = false // reset to off whenever a script is loaded
  changedAt = Date.now()
  stateUpdates = false // VacuPump: GET state-updates subscribers get state-updated events

  protected syncKind: StoredScript['kind'] = 'funscript'
  protected hasLoop = true

  constructor(r: DeviceRecord) {
    this.token = r.token
    this.type = r.type
    this.name = r.name
    this.online = r.online
  }

  record(): DeviceRecord {
    return { token: this.token, type: this.type, name: this.name, online: this.online }
  }

  // handle runs one API call (path after the type prefix). Returns the JSON body. Most commands answer
  // with the device state, as the docs say.
  abstract handle(method: string, path: string, body: Record<string, unknown>): unknown
  abstract state(): Record<string, unknown>
  // stopAll: the emulator's own panic button.
  abstract stopAll(): void

  info(): Record<string, unknown> {
    return {
      firmwareStatus: 'UP_TO_DATE', // UNDOCUMENTED: values besides UP_TO_DATE / UPDATE_AVAILABLE / UPDATE_REQUIRED
      firmwareVersion: 1.01,
      firmwareBranch: 'prod',
      hardwareVersion: this.type === 'vacupump' ? 'vacupump' : 'emulator',
      mac: 'EM:UL:AT:OR:00:01',
      deviceType: this.type
    }
  }

  protected onSync(_event: SyncEvent): void {}

  // Common endpoints: info, state and the sync-script commands. undefined = not one of those.
  protected common(method: string, path: string, body: Record<string, unknown>): unknown {
    if (method === 'GET' && path === 'info') return this.info()
    if (method === 'GET' && path === 'state') return this.state()
    if (!path.startsWith('sync-script/')) return undefined
    const p = path.slice('sync-script/'.length)
    if (method === 'GET' && p.startsWith('info/') && this.syncKind === 'exercises') {
      const s = getScript(decodeURIComponent(p.slice(5)))
      if (!s || s.kind !== 'exercises') throw new HttpError(404, 'unknown or expired script token')
      return { token: s.token, durationMs: s.durationMs, exerciseCount: s.exercises.length, exercises: s.exercises }
    }
    if (method !== 'PUT') return undefined
    switch (p) {
      case 'load-token': {
        const t = body.scriptToken
        if (typeof t !== 'string' || !t) throw bad('scriptToken required')
        const s = getScript(t)
        // UNDOCUMENTED: the status for an unknown or expired token.
        if (!s || s.kind !== this.syncKind) throw new HttpError(404, 'unknown or expired script token')
        this.load(s)
        return this.state()
      }
      case 'start': {
        if (!this.sync) throw new HttpError(400, 'SYNC_SCRIPT_NOT_LOADED')
        const at = num(body, 'startTimeMs', 0, Number.MAX_SAFE_INTEGER)
        this.sync.playing = true
        this.sync.startedAt = Date.now() - at
        this.onSync('start')
        this.syncCheck()
        return this.state()
      }
      case 'stop':
        if (this.sync) {
          this.sync.pausedAt = this.syncTime()
          this.sync.playing = false
          this.onSync('stop')
        }
        return this.state()
      case 'offset':
        // Persists across loads. UNDOCUMENTED: no range is documented, so none is enforced.
        this.syncOffset = num(body, 'offsetTimeMs', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true)
        return this.state()
      case 'loop':
        if (!this.hasLoop) return undefined
        this.syncLoop = bool(body, 'loop')
        return this.state()
    }
    return undefined
  }

  load(s: StoredScript): void {
    this.sync = { script: s, playing: false, startedAt: 0, pausedAt: 0 }
    this.syncLoop = false
    this.onSync('load')
  }

  // Script time now (ms). The offset is applied for playback (positive offset = device runs ahead) but
  // not for the time the state reports.
  syncTime(withOffset = true): number {
    const s = this.sync
    if (!s) return 0
    if (!s.playing) return s.pausedAt
    let t = Date.now() - s.startedAt + (withOffset ? this.syncOffset : 0)
    const end = s.script.durationMs
    if (this.syncLoop && end > 0) t = ((t % end) + end) % end
    return Math.max(0, t)
  }

  // A script that has played to its end pauses there (unless it loops).
  protected syncCheck(): void {
    const s = this.sync
    if (!s || !s.playing || this.syncLoop) return
    const t = Date.now() - s.startedAt + this.syncOffset
    if (t >= s.script.durationMs) {
      s.playing = false
      s.pausedAt = s.script.durationMs
      this.onSync('end')
    }
  }

  protected syncState(): Record<string, unknown> {
    return {
      syncScriptCurrentTime: Math.round(this.syncTime(false)),
      syncScriptOffsetTime: this.syncOffset,
      syncScriptToken: this.sync?.script.token ?? '',
      syncScriptLoop: this.syncLoop
    }
  }

  // Upload endpoints (the server reads the body; this parses and loads it). The answer is the state,
  // with the new token in syncScriptToken.
  upload(path: string, text: string): unknown {
    if (this.syncKind !== 'funscript') throw new HttpError(404, 'not found')
    const csv = path.includes('csv')
    const token = storeFunscript(csv ? parseCsv(text) : parseFunscript(text))
    this.load(getScript(token)!)
    return this.state()
  }

  touch(): void {
    this.changedAt = Date.now()
  }
}

// ---------- VacuGlide 1/2 ----------

type GlideMode =
  | 'ONLINE_CONNECTED'
  | 'LOCAL_SCRIPT_PLAYING'
  | 'LOCAL_SCRIPT_PAUSED'
  | 'TARGET_SPEED_PLAYING'
  | 'TARGET_SPEED_PAUSED'
  | 'SYNC_SCRIPT_PLAYING'
  | 'SYNC_SCRIPT_PAUSED'

export class VacuGlide extends EmuDevice {
  mode: GlideMode = 'ONLINE_CONNECTED'
  targetSpeed = 0
  valves = { 'stroke-plus': false, 'stroke-minus': false }
  localScript = 0

  private closeValves(): void {
    this.valves = { 'stroke-plus': false, 'stroke-minus': false }
  }

  handle(method: string, path: string, body: Record<string, unknown>): unknown {
    const c = this.common(method, path, body)
    if (c !== undefined) return c
    if (method !== 'PUT') throw new HttpError(404, 'not found')
    switch (path) {
      case 'target-speed':
        this.targetSpeed = num(body, 'targetSpeed', 0, 100)
        this.pauseSync()
        this.mode = 'TARGET_SPEED_PLAYING'
        return this.state()
      case 'target-speed/stop':
        this.pauseSync()
        this.mode = 'TARGET_SPEED_PAUSED'
        return this.state()
      case 'valve/stroke-plus':
      case 'valve/stroke-minus':
        this.valves[path.slice(6) as 'stroke-plus'] = bool(body, 'valveState')
        return this.state()
      case 'local-script':
        this.localScript = num(body, 'localScriptIndex', 0, 29, true)
        this.pauseSync()
        this.closeValves() // selecting a local script closes both valves (docs)
        this.mode = 'LOCAL_SCRIPT_PLAYING'
        return this.state()
      case 'local-script/start':
        if (this.mode === 'LOCAL_SCRIPT_PAUSED') this.mode = 'LOCAL_SCRIPT_PLAYING'
        return this.state()
      case 'local-script/stop':
        if (this.mode === 'LOCAL_SCRIPT_PLAYING') this.mode = 'LOCAL_SCRIPT_PAUSED'
        return this.state()
    }
    throw new HttpError(404, 'not found')
  }

  private pauseSync(): void {
    if (this.sync?.playing) {
      this.sync.pausedAt = this.syncTime()
      this.sync.playing = false
    }
  }

  protected onSync(event: SyncEvent): void {
    if (event === 'load' || event === 'stop' || event === 'end') this.mode = 'SYNC_SCRIPT_PAUSED'
    if (event === 'start') {
      this.closeValves() // starting a sync script closes both valves (docs)
      this.mode = 'SYNC_SCRIPT_PLAYING'
    }
  }

  // Speed the sync script asks for right now: |Δpos| / Δt ÷ 6, as measured on a VacuGlide 2. 0 after the
  // last action (the real device pauses there).
  private syncSpeed(): number {
    this.syncCheck()
    const s = this.sync
    if (!s || !s.playing) return 0
    const t = this.syncTime()
    const a = s.script.actions
    const i = a.findIndex((x) => x.at > t)
    if (i <= 0) return 0
    const dt = (a[i].at - a[i - 1].at) / 1000
    return dt > 0 ? Math.min(100, Math.abs(a[i].pos - a[i - 1].pos) / dt / 6) : 0
  }

  // Speed the motor runs at now.
  speed(): number {
    if (this.mode === 'SYNC_SCRIPT_PLAYING') return Math.round(this.syncSpeed())
    if (this.mode === 'TARGET_SPEED_PLAYING') return this.targetSpeed
    return 0
  }

  state(): Record<string, unknown> {
    const speed = this.speed() // also notices a script that has just ended
    return {
      operationalMode: this.mode,
      localScript: this.localScript,
      targetSpeed: speed,
      strokePlusValve: this.valves['stroke-plus'],
      strokeMinusValve: this.valves['stroke-minus'],
      ...this.syncState()
    }
  }

  stopAll(): void {
    this.pauseSync()
    if (this.mode === 'TARGET_SPEED_PLAYING') this.mode = 'TARGET_SPEED_PAUSED'
    if (this.mode === 'LOCAL_SCRIPT_PLAYING') this.mode = 'LOCAL_SCRIPT_PAUSED'
    if (this.mode === 'SYNC_SCRIPT_PLAYING') this.mode = 'SYNC_SCRIPT_PAUSED'
  }
}

// ---------- AI Ultra ----------

type UltraMode =
  | 'ONLINE_CONNECTED'
  | 'OSCILLATOR_PLAYING'
  | 'OSCILLATOR_PAUSED'
  | 'GO_TO'
  | 'LOCAL_SCRIPT_PLAYING'
  | 'LOCAL_SCRIPT_PAUSED'
  | 'SYNC_SCRIPT_PLAYING'
  | 'SYNC_SCRIPT_PAUSED'

export class Ultra extends EmuDevice {
  mode: UltraMode = 'ONLINE_CONNECTED'
  osc = { speed: 0, minY: 0, maxY: 100, running: false }
  goto: { position: number; speed: number; from: number; at: number } | null = null
  localScript = 0
  localScriptSpeed = 0

  private pauseSync(): void {
    if (this.sync?.playing) {
      this.sync.pausedAt = this.syncTime()
      this.sync.playing = false
    }
  }

  handle(method: string, path: string, body: Record<string, unknown>): unknown {
    const c = this.common(method, path, body)
    if (c !== undefined) return c
    if (method !== 'PUT') throw new HttpError(404, 'not found')
    switch (path) {
      case 'oscillate': {
        const speed = num(body, 'speed', 0, 100)
        const minY = num(body, 'minY', 0, 100)
        const maxY = num(body, 'maxY', 0, 100)
        if (maxY - minY < 10) throw bad('maxY must be at least 10 above minY')
        this.osc = { speed, minY, maxY, running: true }
        this.goto = null
        this.pauseSync()
        this.mode = 'OSCILLATOR_PLAYING'
        return this.state()
      }
      case 'oscillate/start':
        this.osc.running = true
        this.goto = null
        this.pauseSync()
        this.mode = 'OSCILLATOR_PLAYING'
        return this.state()
      case 'oscillate/stop':
        this.osc.running = false
        this.mode = 'OSCILLATOR_PAUSED'
        return this.state()
      case 'goto': {
        const position = num(body, 'position', 0, 100)
        const speed = num(body, 'speed', 0, 100)
        this.goto = { position, speed, from: this.position(), at: Date.now() }
        this.osc.running = false
        this.pauseSync()
        this.mode = 'GO_TO'
        return { success: true } // the one command that doesn't answer with the state (docs)
      }
      case 'local-script':
        this.localScript = num(body, 'localScriptIndex', 0, 9, true)
        this.localScriptSpeed = num(body, 'speedIndex', 0, 9, true)
        this.pauseSync()
        this.mode = 'LOCAL_SCRIPT_PLAYING'
        return this.state()
      case 'local-script/start':
        if (this.mode === 'LOCAL_SCRIPT_PAUSED') this.mode = 'LOCAL_SCRIPT_PLAYING'
        return this.state()
      case 'local-script/stop':
        if (this.mode === 'LOCAL_SCRIPT_PLAYING') this.mode = 'LOCAL_SCRIPT_PAUSED'
        return this.state()
    }
    throw new HttpError(404, 'not found')
  }

  protected onSync(event: SyncEvent): void {
    if (event === 'load' || event === 'stop' || event === 'end') this.mode = 'SYNC_SCRIPT_PAUSED'
    if (event === 'start') this.mode = 'SYNC_SCRIPT_PLAYING'
  }

  // Rough current position (0-100) for display; speed % ≈ units/s ÷ 6 like the VacuGlide.
  position(): number {
    const now = Date.now()
    if (this.goto) {
      const rate = Math.max(1, this.goto.speed * 6) / 1000 // units per ms
      const dist = this.goto.position - this.goto.from
      const done = Math.min(1, ((now - this.goto.at) * rate) / Math.max(1, Math.abs(dist)))
      return this.goto.from + dist * done
    }
    if (this.osc.running && this.osc.speed > 0) {
      const span = this.osc.maxY - this.osc.minY
      const period = (2 * span) / (this.osc.speed * 6) // seconds per full stroke
      const phase = (now / 1000 / period) % 1
      return this.osc.minY + span * (1 - Math.abs(phase * 2 - 1))
    }
    return this.osc.minY
  }

  state(): Record<string, unknown> {
    this.syncCheck()
    return {
      operationalMode: this.mode,
      localScript: this.localScript,
      localScriptSpeed: this.localScriptSpeed,
      motorTemperature: 30,
      oscillatorTargetSpeed: this.osc.speed,
      oscillatorLowPoint: this.osc.minY,
      oscillatorHighPoint: this.osc.maxY,
      ...this.syncState()
    }
  }

  stopAll(): void {
    this.osc.running = false
    this.goto = null
    this.pauseSync()
    if (this.mode === 'OSCILLATOR_PLAYING') this.mode = 'OSCILLATOR_PAUSED'
    if (this.mode === 'LOCAL_SCRIPT_PLAYING') this.mode = 'LOCAL_SCRIPT_PAUSED'
    if (this.mode === 'SYNC_SCRIPT_PLAYING') this.mode = 'SYNC_SCRIPT_PAUSED'
    if (this.mode === 'GO_TO') this.mode = 'ONLINE_CONNECTED'
  }
}

// ---------- VacuPump ----------

type PumpMode =
  | 'IDLE'
  | 'MANUAL'
  | 'WORKOUTS'
  | 'WORKOUTS_PAUSED'
  | 'PULSE'
  | 'PULSE_PAUSED'
  | 'STROKE'
  | 'STROKE_PAUSED'
  | 'SYNC_PLAYING'
  | 'SYNC_PAUSED'
  | 'EMERGENCY_STOP'
  | 'FIRMWARE_UPDATING'

interface Workout {
  uuid: string
  name: string
  description: string
  exercises: Exercise[]
}

// Two workouts to try; the real ones are installed with the Autoblow app.
const sampleWorkouts: Workout[] = [
  { uuid: 'emu-workout-1', name: 'Gentle hold', description: 'A minute at -10 kPa', exercises: [{ type: 'HOLD', durationMs: 60_000, vacuumKpa: -10 }] },
  {
    uuid: 'emu-workout-2',
    name: 'Pulse and stroke',
    description: 'Pulses, a rest, then strokes',
    exercises: [
      { type: 'PULSE', durationMs: 20_000, pulse1Kpa: -10, pulse1Ms: 2000, pulse2Kpa: -25, pulse2Ms: 2000 },
      { type: 'REST', durationMs: 5000 },
      { type: 'STROKE', durationMs: 20_000, vacuumTargetKpa: -20, pressureTargetKpa: 0, speedPct: 40 }
    ]
  }
]

const exercisesLength = (ex: Exercise[]) => ex.reduce((t, e) => t + e.durationMs, 0)

// Which exercise is playing at time t, and how far into it.
function exerciseAt(ex: Exercise[], t: number): { e: Exercise; index: number; elapsed: number } | null {
  let start = 0
  for (let i = 0; i < ex.length; i++) {
    if (t < start + ex[i].durationMs) return { e: ex[i], index: i, elapsed: t - start }
    start += ex[i].durationMs
  }
  return null
}

// The vacuum an exercise drives towards (kPa, negative = vacuum). UNDOCUMENTED: REST vents to 0.
function exerciseTarget(e: Exercise, elapsed: number): number {
  switch (e.type) {
    case 'HOLD':
      return e.vacuumKpa
    case 'PULSE':
      return elapsed % (e.pulse1Ms + e.pulse2Ms) < e.pulse1Ms ? e.pulse1Kpa : e.pulse2Kpa
    case 'STROKE': {
      const period = 3000 - e.speedPct * 25 // 100 % ≈ 0.5 s per cycle (guess)
      return (elapsed % period) / period < 0.5 ? e.vacuumTargetKpa : e.pressureTargetKpa
    }
    case 'REST':
      return 0
  }
}

export class VacuPump extends EmuDevice {
  protected syncKind = 'exercises' as const
  protected hasLoop = false // the pump page documents no loop endpoint

  mode: PumpMode = 'IDLE'
  current = 0 // kPa, modelled
  lastStep = Date.now()
  manualTarget = 0
  manualStartedAt = 0
  modeSince = Date.now()
  venting = false // paused sync/workout that released its vacuum
  pulse = { pumpVacuumKpa: -20, restVacuumKpa: 0, holdPumpMs: 2000, holdRestMs: 2000 }
  stroke = { vacuumTargetKpa: -20, pressureTargetKpa: 0, speedPct: 50 }
  settings = { units: 1, lcdBrightnessLevel: 5 } // UNDOCUMENTED: the defaults
  workout: { slot: number; w: Workout; startedAt: number; pausedAt: number; playing: boolean } | null = null

  private setMode(m: PumpMode): void {
    // Starting any mode leaves sync and workouts.
    if (this.sync?.playing && m !== 'SYNC_PLAYING') {
      this.sync.pausedAt = this.syncTime()
      this.sync.playing = false
    }
    if (this.workout?.playing && m !== 'WORKOUTS') this.workout.playing = false
    this.mode = m
    this.modeSince = Date.now()
    this.venting = false
  }

  handle(method: string, path: string, body: Record<string, unknown>): unknown {
    this.step()
    const c = this.common(method, path, body)
    if (c !== undefined) return c
    if (method === 'GET') {
      if (path === 'workout/list') return this.workoutList()
      if (path === 'sync-script/supported') return { supported: true }
      if (path === 'settings') return this.settings
      if (path === 'firmware/update-info') throw new HttpError(400, 'No firmware update version found for this device.')
      throw new HttpError(404, 'not found')
    }
    if (method !== 'PUT') throw new HttpError(404, 'not found')
    switch (path) {
      case 'manual/target':
        this.manualTarget = num(body, 'targetVacuumKpa', -60, 0)
        return this.state()
      case 'manual/start':
        this.setMode('MANUAL')
        this.manualStartedAt = Date.now()
        return this.state()
      case 'manual/stop':
        // Motor off and valves closed: the current vacuum is KEPT (docs).
        this.setMode('IDLE')
        return this.state()
      case 'pulse/config':
        this.pulse = {
          pumpVacuumKpa: num(body, 'pumpVacuumKpa', -60, 0),
          restVacuumKpa: num(body, 'restVacuumKpa', -60, 0),
          holdPumpMs: num(body, 'holdPumpMs', 0, 600_000),
          holdRestMs: num(body, 'holdRestMs', 0, 600_000)
        }
        return this.state()
      case 'pulse/start':
        this.setMode('PULSE')
        return this.state()
      case 'pulse/pause':
      case 'pulse/stop':
        this.setMode('PULSE_PAUSED')
        return this.state()
      case 'stroke/config': {
        const v = num(body, 'vacuumTargetKpa', -60, 0)
        const p = num(body, 'pressureTargetKpa', -60, 60)
        if (p < v + 0.1) throw bad('pressureTargetKpa must be at least 0.1 above vacuumTargetKpa')
        this.stroke = { vacuumTargetKpa: v, pressureTargetKpa: p, speedPct: num(body, 'speedPct', 10, 100) }
        return this.state()
      }
      case 'stroke/start':
        this.setMode('STROKE')
        return this.state()
      case 'stroke/pause':
      case 'stroke/stop':
        this.setMode('STROKE_PAUSED')
        return this.state()
      case 'workout/start': {
        const slot = num(body, 'slot', 1, 10, true)
        const w = sampleWorkouts[slot - 1]
        if (!w) throw bad(`workout slot ${slot} is empty`) // UNDOCUMENTED: the status for an empty slot
        this.setMode('WORKOUTS')
        this.workout = { slot, w, startedAt: Date.now(), pausedAt: 0, playing: true }
        return this.state()
      }
      case 'workout/pause':
        if (this.mode === 'WORKOUTS' && this.workout) {
          this.workout.pausedAt = Date.now() - this.workout.startedAt
          this.workout.playing = false
          this.mode = 'WORKOUTS_PAUSED'
        }
        return this.state()
      case 'workout/resume':
        if (this.mode === 'WORKOUTS_PAUSED' && this.workout) {
          this.workout.startedAt = Date.now() - this.workout.pausedAt
          this.workout.playing = true
          this.mode = 'WORKOUTS'
        }
        return this.state()
      case 'settings': {
        const units = num(body, 'units', 0, 1, true)
        const lcd = num(body, 'lcdBrightnessLevel', 1, 10, true)
        this.settings = { units, lcdBrightnessLevel: lcd }
        return this.settings
      }
      case 'state-updates':
        this.stateUpdates = bool(body, 'enabled')
        return { success: true }
    }
    throw new HttpError(404, 'not found')
  }

  protected onSync(event: SyncEvent): void {
    if (event === 'load') {
      this.mode = 'SYNC_PAUSED'
      this.modeSince = Date.now()
      this.venting = false
    }
    if (event === 'start') {
      this.mode = 'SYNC_PLAYING'
      this.modeSince = Date.now()
      this.venting = false
    }
    // Stopping pauses and releases the vacuum; so does a script that has played to its end (docs).
    if (event === 'stop' || event === 'end') {
      this.mode = 'SYNC_PAUSED'
      this.venting = true
    }
  }

  upload(path: string, _text: string): unknown {
    throw new HttpError(404, `${path}: the VacuPump takes exercises (upload-exercises), not funscripts`)
  }

  // upload-exercises: a JSON body {exercises: [...]}.
  uploadExercises(body: unknown, rawBytes: number): unknown {
    const { exercises, durationMs } = validateExercises(body, rawBytes)
    this.load(getScript(storeExercises(exercises, durationMs))!)
    return this.state()
  }

  private workoutList(): Record<string, unknown> {
    const items = Array.from({ length: 10 }, (_, i) => {
      const w = sampleWorkouts[i]
      return w
        ? { slotIndex: i + 1, exists: true, workoutUuid: w.uuid, name: w.name, description: w.description, durationMs: exercisesLength(w.exercises), exerciseCount: w.exercises.length }
        : { slotIndex: i + 1, exists: false }
    })
    return { items, totalSlots: 10 }
  }

  private workoutTime(): number {
    const w = this.workout
    if (!w) return 0
    return w.playing ? Date.now() - w.startedAt : w.pausedAt
  }

  // Where the pump is driving the vacuum right now, by mode.
  private wanted(now: number): number | null {
    const t = now - this.modeSince
    switch (this.mode) {
      case 'MANUAL':
        return this.manualTarget
      case 'PULSE': {
        const cycle = this.pulse.holdPumpMs + this.pulse.holdRestMs || 1
        return t % cycle < this.pulse.holdPumpMs ? this.pulse.pumpVacuumKpa : this.pulse.restVacuumKpa
      }
      case 'STROKE': {
        const period = 3000 - this.stroke.speedPct * 25 // 100 % ≈ 0.5 s per cycle (guess)
        return (t % period) / period < 0.5 ? this.stroke.vacuumTargetKpa : this.stroke.pressureTargetKpa
      }
      case 'SYNC_PLAYING': {
        const s = this.sync
        const at = s && exerciseAt(s.script.exercises, this.syncTime())
        return at ? exerciseTarget(at.e, at.elapsed) : null
      }
      case 'WORKOUTS': {
        const at = this.workout && exerciseAt(this.workout.w.exercises, this.workoutTime())
        if (!at) {
          // The workout is over: back to idle with the valves closed. UNDOCUMENTED.
          this.mode = 'IDLE'
          return null
        }
        return exerciseTarget(at.e, at.elapsed)
      }
      case 'SYNC_PAUSED':
      case 'WORKOUTS_PAUSED':
        return this.venting ? 0 : null
      default:
        return null // idle/paused: valves closed, vacuum held
    }
  }

  // step advances the modelled vacuum (about 20 kPa/s towards the target).
  step(): void {
    this.syncCheck()
    const now = Date.now()
    const dt = (now - this.lastStep) / 1000
    this.lastStep = now
    const w = this.wanted(now)
    if (w === null) return
    const d = w - this.current
    const max = 20 * dt
    this.current += Math.abs(d) <= max ? d : Math.sign(d) * max
  }

  state(): Record<string, unknown> {
    this.step()
    const now = Date.now()
    const ex = this.sync?.script.exercises ?? []
    const syncPos = this.syncTime(false)
    const syncAt = exerciseAt(ex, this.syncTime())
    const wAt = this.workout && exerciseAt(this.workout.w.exercises, this.workoutTime())
    const wLen = this.workout ? exercisesLength(this.workout.w.exercises) : 0
    const inWorkout = this.mode === 'WORKOUTS' || this.mode === 'WORKOUTS_PAUSED'
    const pulseT = (now - this.modeSince) % (this.pulse.holdPumpMs + this.pulse.holdRestMs || 1)
    const strokePeriod = 3000 - this.stroke.speedPct * 25
    return {
      operationalMode: this.mode,
      targetVacuumKpa: this.wanted(now) ?? this.current,
      currentVacuumKpa: Math.round(this.current * 10) / 10,
      manualElapsedMs: this.mode === 'MANUAL' ? now - this.manualStartedAt : 0,
      pulsePumpVacuumKpa: this.pulse.pumpVacuumKpa,
      pulseRestVacuumKpa: this.pulse.restVacuumKpa,
      pulseHoldPumpMs: this.pulse.holdPumpMs,
      pulseHoldRestMs: this.pulse.holdRestMs,
      pulseTimerMs: this.mode === 'PULSE' ? Math.round(pulseT) : 0,
      pulseDirection: this.mode === 'PULSE' && pulseT < this.pulse.holdPumpMs,
      strokeVacuumTargetKpa: this.stroke.vacuumTargetKpa,
      strokePressureTargetKpa: this.stroke.pressureTargetKpa,
      strokeSpeedPct: this.stroke.speedPct,
      strokeDirection: this.mode === 'STROKE' && ((now - this.modeSince) % strokePeriod) / strokePeriod < 0.5,
      workoutExerciseIndex: inWorkout && wAt ? wAt.index : 0,
      workoutExerciseElapsedMs: inWorkout && wAt ? Math.round(wAt.elapsed) : 0,
      workoutExerciseRemainingMs: inWorkout && wAt ? Math.round(wAt.e.durationMs - wAt.elapsed) : 0,
      workoutElapsedMs: inWorkout ? Math.round(this.workoutTime()) : 0,
      workoutRemainingMs: inWorkout ? Math.max(0, Math.round(wLen - this.workoutTime())) : 0,
      syncScriptToken: this.sync?.script.token ?? '',
      syncScriptLoaded: !!this.sync,
      syncScriptPositionMs: Math.round(syncPos),
      syncScriptDurationMs: this.sync?.script.durationMs ?? 0,
      syncScriptSectionIndex: this.sync ? (syncAt ? syncAt.index : ex.length) : 0,
      syncScriptSectionCount: ex.length,
      syncScriptOffsetMs: this.syncOffset
    }
  }

  info(): Record<string, unknown> {
    // Video sync needs the sync_script capability (firmware 1.01 and later).
    return { ...super.info(), capabilities: [{ key: 'sync_script', value: '1' }] }
  }

  stopAll(): void {
    this.setMode('IDLE')
    this.current = 0 // the emulator's panic button also vents
  }
}

export function makeDevice(r: DeviceRecord): EmuDevice {
  if (r.type === 'vacuglide') return new VacuGlide(r)
  if (r.type === 'autoblow-ultra') return new Ultra(r)
  return new VacuPump(r)
}

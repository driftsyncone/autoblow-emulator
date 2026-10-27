// Autoblow emulator page: device cards with a live picture of what each device does,
// fault controls, and the API call log. Plain JS, no build step.
const $ = (s, el = document) => el.querySelector(s)
const api = (path, method = 'GET', body) =>
  fetch('/emu/api/' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json())
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

$('#base').textContent = location.origin
let devices = []
const anim = new Map() // token -> { phase, pos, vac }

// ---------- device cards ----------

function card(d) {
  const label = { vacuglide: 'VacuGlide', 'autoblow-ultra': 'AI Ultra', vacupump: 'VacuPump' }[d.type]
  const el = document.createElement('div')
  el.className = 'card device'
  el.dataset.token = d.token
  el.innerHTML = `
    <div class="row between">
      <div><b class="name"></b> <span class="badge">${label}</span></div>
      <label class="switch"><input type="checkbox" class="online"> online</label>
    </div>
    <div class="row token">token <code></code> <button class="ghost copy">Copy</button></div>
    <div class="row vis"><canvas width="120" height="160"></canvas><div class="info"><div class="big"></div><pre class="state"></pre></div></div>
    <div class="row"><button class="stop">Stop</button><button class="ghost remove">Remove</button></div>`
  $('.token code', el).textContent = d.token
  $('.copy', el).onclick = () => navigator.clipboard.writeText(d.token)
  $('.online', el).onchange = (e) => api('devices/' + encodeURIComponent(d.token), 'PATCH', { online: e.target.checked })
  $('.stop', el).onclick = () => api('devices/' + encodeURIComponent(d.token) + '/stop', 'POST', {})
  $('.remove', el).onclick = () => confirm(`Remove ${d.name}?`) && api('devices/' + encodeURIComponent(d.token), 'DELETE').then(refresh)
  return el
}

function render() {
  const box = $('#devices')
  const tokens = devices.map((d) => d.token)
  for (const el of [...box.children]) if (!tokens.includes(el.dataset.token)) el.remove()
  for (const d of devices) {
    let el = box.querySelector(`[data-token="${CSS.escape(d.token)}"]`)
    if (!el) box.append((el = card(d)))
    $('.name', el).textContent = d.name
    $('.online', el).checked = d.online
    el.classList.toggle('offline', !d.online)
    $('.state', el).textContent = JSON.stringify(d.state, null, 1).replace(/[{}"]/g, '').trim()
    $('.big', el).textContent = headline(d)
  }
}

function headline(d) {
  const v = d.visual
  if (v.kind === 'speed') {
    const valves = Object.entries(v.valves).filter(([, on]) => on).map(([k]) => k)
    return v.speed ? `${v.speed}% ≈ ${spm(v.speed)} strokes/min` + (valves.length ? ` · valve ${valves.join(', ')}` : '') : 'stopped'
  }
  if (v.kind === 'position') {
    if (v.goto) return `go to ${v.goto.position} at ${v.goto.speed}%`
    return v.osc.running && v.osc.speed ? `oscillate ${v.osc.speed}% between ${v.osc.minY} and ${v.osc.maxY}` : 'stopped'
  }
  return `${v.mode} · ${v.current.toFixed(1)} kPa`
}

// VacuGlide 2 spec range: 15 strokes/min at 1 %, 225 at 100 % (not measured).
const spm = (pct) => Math.round(15 + ((pct - 1) / 99) * 210)

// ---------- animation ----------

let last = performance.now()
function frame(now) {
  const dt = (now - last) / 1000
  last = now
  for (const d of devices) {
    const el = $(`[data-token="${CSS.escape(d.token)}"] canvas`)
    if (!el) continue
    const a = anim.get(d.token) ?? { phase: 0, pos: 0, vac: 0 }
    anim.set(d.token, a)
    const v = d.visual
    let pos = 0
    let vac = null
    if (v.kind === 'speed') {
      if (d.online && v.speed) a.phase += (dt * spm(v.speed)) / 60
      pos = 50 + 50 * Math.sin(a.phase * 2 * Math.PI)
    } else if (v.kind === 'position') {
      pos = ultraPos(v)
    } else {
      a.vac += (v.current - a.vac) * Math.min(1, dt * 6)
      vac = a.vac
    }
    draw(el, pos, vac)
  }
  requestAnimationFrame(frame)
}

// Same model as the server: speed % ≈ units/s ÷ 6.
function ultraPos(v) {
  const now = Date.now()
  if (v.goto) {
    const rate = Math.max(1, v.goto.speed * 6) / 1000
    const dist = v.goto.position - v.goto.from
    return v.goto.from + dist * Math.min(1, ((now - v.goto.at) * rate) / Math.max(1, Math.abs(dist)))
  }
  if (v.osc.running && v.osc.speed > 0) {
    const span = v.osc.maxY - v.osc.minY
    const phase = (now / 1000 / ((2 * span) / (v.osc.speed * 6))) % 1
    return v.osc.minY + span * (1 - Math.abs(phase * 2 - 1))
  }
  return v.osc.minY
}

function draw(c, pos, vac) {
  const g = c.getContext('2d')
  const css = getComputedStyle(document.body)
  const fg = css.getPropertyValue('--violet'), dim = css.getPropertyValue('--line'), pink = css.getPropertyValue('--pink')
  g.clearRect(0, 0, c.width, c.height)
  if (vac === null) {
    // stroker: a sleeve moving along a shaft; 100 = top
    g.fillStyle = dim
    g.fillRect(52, 10, 16, 140)
    const y = 10 + (1 - pos / 100) * 110
    g.fillStyle = pink
    g.beginPath()
    g.roundRect(30, y, 60, 30, 10)
    g.fill()
    g.fillStyle = css.getPropertyValue('--text')
    g.font = '12px system-ui'
    g.fillText(Math.round(pos), 4, 14)
  } else {
    // gauge: -60 (bottom, full vacuum) … +60 kPa
    g.fillStyle = dim
    g.fillRect(45, 10, 30, 140)
    const zero = 80
    const h = (vac / 60) * 70
    g.fillStyle = vac < 0 ? fg : pink
    g.fillRect(45, zero, 30, -h)
    g.fillStyle = css.getPropertyValue('--text')
    g.fillRect(40, zero, 40, 1)
    g.font = '11px system-ui'
    g.fillText('0', 84, zero + 4)
    g.fillText('-60', 84, 150)
    g.fillText('+60', 84, 16)
  }
}
requestAnimationFrame(frame)

// ---------- log ----------

function addLog(e) {
  const tb = $('#log tbody')
  const tr = document.createElement('tr')
  if (e.status >= 300) tr.className = 'err'
  tr.innerHTML = `<td>${new Date(e.t).toLocaleTimeString()}</td><td>${esc(e.device)}</td><td>${esc(e.method)} ${esc(e.path)}</td><td><code>${esc(e.body)}</code></td><td>${e.status}</td><td><code>${esc(e.answer)}</code></td>`
  tb.prepend(tr)
  while (tb.children.length > 300) tb.lastChild.remove()
}
$('#clear').onclick = () => ($('#log tbody').innerHTML = '')

// ---------- controls ----------

$('#add').onsubmit = async (e) => {
  e.preventDefault()
  const f = new FormData(e.target)
  const r = await api('devices', 'POST', { type: f.get('type'), token: f.get('token') })
  if (r.error) alert(r.error)
  e.target.reset()
  refresh()
}
const slider = (id, out, key) =>
  ($(id).oninput = (e) => {
    $(out).textContent = e.target.value
    api('settings', 'PUT', { [key]: Number(e.target.value) })
  })
slider('#latency', '#latv', 'latencyMs')
slider('#rate', '#ratev', 'rateLimitPerSec')

function applySnapshot(s) {
  devices = s.devices
  $('#latency').value = s.settings.latencyMs
  $('#latv').textContent = s.settings.latencyMs
  $('#rate').value = s.settings.rateLimitPerSec
  $('#ratev').textContent = s.settings.rateLimitPerSec
  render()
}

async function refresh() {
  const s = await api('snapshot')
  applySnapshot(s)
  $('#log tbody').innerHTML = ''
  s.log.forEach(addLog)
}

const es = new EventSource('/emu/events')
es.addEventListener('snapshot', (e) => {
  const s = JSON.parse(e.data)
  devices = s.devices
  render()
})
es.addEventListener('log', (e) => addLog(JSON.parse(e.data)))
es.onopen = () => (($('#conn').textContent = 'live'), $('#conn').classList.add('ok'))
es.onerror = () => (($('#conn').textContent = 'disconnected'), $('#conn').classList.remove('ok'))
refresh()

const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const DATA_PATH = path.join(__dirname, 'accounts.json')
const PUBLIC_DIR = path.join(__dirname, 'gui')

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str)
  } catch {
    return fallback
  }
}

function readData() {
  if (!fs.existsSync(DATA_PATH)) {
    return { password: '', usernames: [] }
  }
  const raw = fs.readFileSync(DATA_PATH, 'utf8')
  const data = safeJsonParse(raw, { password: '', usernames: [] })
  data.password = typeof data.password === 'string' ? data.password : ''
  data.usernames = Array.isArray(data.usernames) ? data.usernames.filter((u) => typeof u === 'string') : []
  return data
}

function writeData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8')
}

function sendJson(res, statusCode, obj) {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length
  })
  res.end(body)
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.isBuffer(text) ? text : Buffer.from(String(text))
  res.writeHead(statusCode, { 'content-type': contentType, 'content-length': body.length })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function normalizeUsername(u) {
  return String(u || '').trim()
}

let data = readData()
const runningByUser = new Map() // username -> { proc, startedAtMs }
const logsByUser = new Map() // username -> string[]
const stateByUser = new Map() // username -> { running, connected, pid, startedAtMs, lastLineAtMs }

function appendLog(username, line) {
  const maxLines = 250
  const arr = logsByUser.get(username) || []
  arr.push(line)
  if (arr.length > maxLines) arr.splice(0, arr.length - maxLines)
  logsByUser.set(username, arr)
  const st = stateByUser.get(username) || { running: false, connected: false }
  st.lastLineAtMs = Date.now()
  stateByUser.set(username, st)
}

function applyConnectionHints(username, line) {
  const st = stateByUser.get(username) || { running: false, connected: false }
  if (/^Spawned\./.test(line)) st.connected = true
  if (/^Disconnected\./.test(line)) st.connected = false
  if (/^Kicked:/.test(line)) st.connected = false
  if (/^Socket closed\b/i.test(line)) st.connected = false
  if (/^Bot error:/.test(line)) st.connected = false
  if (/^ShulkerCycle: (alive|started)/.test(line)) st.shulkerAliveAtMs = Date.now()
  if (!st.connected) st.shulkerAliveAtMs = null
  stateByUser.set(username, st)
}

function stopUser(username, reason = 'stop') {
  const entry = runningByUser.get(username)
  if (!entry) return
  appendLog(username, `[manager] stopping (${reason})`)
  try {
    entry.proc.kill()
  } catch {}
  runningByUser.delete(username)
  const st = stateByUser.get(username) || { running: false, connected: false }
  st.running = false
  st.connected = false
  st.pid = null
  st.shulkerAliveAtMs = null
  stateByUser.set(username, st)
}

function startUser(username) {
  if (runningByUser.has(username)) return
  if (!data.password) throw new Error('set password first')
  if (!username) throw new Error('missing username')
  if (!data.usernames.includes(username)) {
    data.usernames = [...new Set([...data.usernames, username])]
    writeData(data)
  }

  if (String(process.env.MANAGER_DRY_RUN || '').trim()) {
    const startedAtMs = Date.now()
    runningByUser.set(username, { proc: { pid: null, kill() {} }, startedAtMs })
    stateByUser.set(username, {
      running: true,
      connected: false,
      pid: null,
      startedAtMs,
      lastLineAtMs: Date.now(),
      shulkerAliveAtMs: null
    })
    appendLog(username, `[manager] dry-run started`)
    return
  }

  const env = {
    ...process.env,
    BOT_USERNAME: username,
    BOT_PASSWORD: data.password || '',
    // Avoid multiple webservers when running many accounts.
    BOT_ENABLE_VIEWER: '0'
  }

  const proc = spawn(process.execPath, [path.join(__dirname, 'bot.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const startedAtMs = Date.now()
  runningByUser.set(username, { proc, startedAtMs })
  stateByUser.set(username, {
    running: true,
    connected: false,
    pid: proc.pid,
    startedAtMs,
    lastLineAtMs: Date.now(),
    shulkerAliveAtMs: null
  })
  appendLog(username, `[manager] started pid=${proc.pid}`)

  proc.stdout.on('data', (buf) => {
    const s = buf.toString('utf8')
    for (const line of s.split(/\r?\n/)) {
      if (!line) continue
      appendLog(username, line)
      applyConnectionHints(username, line)
    }
  })
  proc.stderr.on('data', (buf) => {
    const s = buf.toString('utf8')
    for (const line of s.split(/\r?\n/)) {
      if (!line) continue
      appendLog(username, `[stderr] ${line}`)
    }
  })
  proc.on('exit', (code, signal) => {
    appendLog(username, `[manager] exited code=${code} signal=${signal || ''}`.trim())
    const entry = runningByUser.get(username)
    if (entry && entry.proc === proc) runningByUser.delete(username)
    const st = stateByUser.get(username) || { running: false, connected: false }
    st.running = false
    st.connected = false
    st.pid = null
    st.shulkerAliveAtMs = null
    stateByUser.set(username, st)
  })
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost')
  let p = url.pathname
  if (p === '/') p = '/index.html'
  if (p.includes('..')) {
    sendText(res, 400, 'bad path')
    return
  }
  const full = path.join(PUBLIC_DIR, p)
  if (!full.startsWith(PUBLIC_DIR)) {
    sendText(res, 400, 'bad path')
    return
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    sendText(res, 404, 'not found')
    return
  }
  const ext = path.extname(full).toLowerCase()
  const ct =
    ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.js'
        ? 'text/javascript; charset=utf-8'
        : ext === '.css'
          ? 'text/css; charset=utf-8'
          : 'application/octet-stream'
  sendText(res, 200, fs.readFileSync(full), ct)
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'GET' && url.pathname === '/api/state') {
    const allUsers = [...new Set([...(data.usernames || []), ...Array.from(runningByUser.keys())])].sort()
      const now = Date.now()
      const users = allUsers.map((u) => {
        const st = stateByUser.get(u) || { running: false, connected: false }
        const shulkerAliveAtMs = st.shulkerAliveAtMs || null
        const shulkerAliveRecently = shulkerAliveAtMs != null && now - shulkerAliveAtMs <= 15_000
        const color = !st.connected ? 'red' : shulkerAliveRecently ? 'green' : 'yellow'
        return {
          username: u,
          running: Boolean(st.running),
          connected: Boolean(st.connected),
          shulkerAliveRecently,
          color,
          pid: st.pid || null,
          startedAtMs: st.startedAtMs || null,
          lastLineAtMs: st.lastLineAtMs || null
        }
      })
      sendJson(res, 200, {
        users,
        data: { passwordSet: Boolean(data.password), usernames: data.usernames }
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/logs_all') {
      const out = {}
      for (const u of data.usernames || []) {
        out[u] = logsByUser.get(u) || []
      }
      for (const u of runningByUser.keys()) {
        out[u] = logsByUser.get(u) || []
      }
      sendJson(res, 200, { logs: out })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const u = normalizeUsername(url.searchParams.get('username') || '')
      const lines = u ? logsByUser.get(u) || [] : []
      sendJson(res, 200, { username: u, lines })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/save') {
      const body = await readBody(req)
      const obj = safeJsonParse(body, null)
      if (!obj || typeof obj !== 'object') {
        sendJson(res, 400, { ok: false, error: 'invalid json' })
        return
      }

      const password = typeof obj.password === 'string' ? obj.password : data.password
      const usernames = Array.isArray(obj.usernames)
        ? [...new Set(obj.usernames.map(normalizeUsername).filter(Boolean))]
        : data.usernames

      data = { password, usernames }
      writeData(data)
      sendJson(res, 200, { ok: true, data: { passwordSet: Boolean(data.password), usernames: data.usernames } })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/remove') {
      const body = await readBody(req)
      const obj = safeJsonParse(body || '{}', {})
      const username = normalizeUsername(obj.username || '')
      if (!username) {
        sendJson(res, 400, { ok: false, error: 'missing username' })
        return
      }
      if (runningByUser.has(username)) {
        sendJson(res, 400, { ok: false, error: 'stop the bot first' })
        return
      }
      data.usernames = (data.usernames || []).filter((u) => u !== username)
      writeData(data)
      sendJson(res, 200, { ok: true, data: { passwordSet: Boolean(data.password), usernames: data.usernames } })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/start') {
      const body = await readBody(req)
      const obj = safeJsonParse(body || '{}', {})
      const username = normalizeUsername(obj.username || '')
      const requestedUsernames = Array.isArray(obj.usernames)
        ? [...new Set(obj.usernames.map(normalizeUsername).filter(Boolean))]
        : null
      if (!data.password) {
        sendJson(res, 400, { ok: false, error: 'set password first' })
        return
      }
      if (username) {
        if (runningByUser.has(username)) {
          sendJson(res, 400, { ok: false, error: 'already running' })
          return
        }
        startUser(username)
        sendJson(res, 200, { ok: true })
        return
      }

      if (requestedUsernames && requestedUsernames.length) {
        for (const u of requestedUsernames) {
          if (!data.usernames.includes(u)) data.usernames.push(u)
          if (!runningByUser.has(u)) startUser(u)
        }
        data.usernames = [...new Set(data.usernames.map(normalizeUsername).filter(Boolean))]
        writeData(data)
        sendJson(res, 200, { ok: true })
        return
      }

      if (!data.usernames.length) {
        sendJson(res, 400, { ok: false, error: 'add at least one username' })
        return
      }
      for (const u of data.usernames) {
        if (!runningByUser.has(u)) startUser(u)
      }
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const body = await readBody(req)
      const obj = safeJsonParse(body || '{}', {})
      const username = normalizeUsername(obj.username || '')
      if (username) {
        stopUser(username, 'api stop')
        sendJson(res, 200, { ok: true })
        return
      }
      for (const u of Array.from(runningByUser.keys())) stopUser(u, 'api stop all')
      sendJson(res, 200, { ok: true })
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
    return
  }

  serveStatic(req, res)
}

const BASE_PORT = Number(process.env.MANAGER_PORT || 3333)
const MAX_TRIES = 25
let server = null

function startServer(port, attempt = 0) {
  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('Request handler error:', err?.message || err)
      sendJson(res, 500, { ok: false, error: 'internal error' })
    })
  })

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && attempt < MAX_TRIES) {
      const nextPort = port + 1
      console.warn(`Port ${port} in use. Trying ${nextPort}...`)
      server.close(() => startServer(nextPort, attempt + 1))
      return
    }
    console.error('Manager server error:', err?.message || err)
    process.exit(1)
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`Bot Manager GUI: http://127.0.0.1:${port}`)
  })
}

startServer(BASE_PORT)

process.on('SIGINT', () => {
  for (const u of Array.from(runningByUser.keys())) stopUser(u, 'sigint')
  process.exit(0)
})

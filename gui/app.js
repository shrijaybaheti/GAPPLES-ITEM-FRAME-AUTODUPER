async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) {
    const msg = (json && json.error) || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return json
}

function el(id) {
  return document.getElementById(id)
}

let usernames = []
let runningSet = new Set()
let userStates = new Map() // username -> { running, connected, color }
let logsAll = {} // username -> lines[]
let selectedUser = null

function getAllUsersSorted() {
  return [...new Set([...(usernames || []), ...Array.from(userStates.keys())])].sort()
}

function setSelectedUser(u) {
  selectedUser = u || null
  try {
    if (selectedUser) localStorage.setItem('selectedUser', selectedUser)
    else localStorage.removeItem('selectedUser')
  } catch (_) {}
  renderUsers()
  renderSelectedLog()
}

function renderUsers() {
  const usersEl = el('users')
  usersEl.innerHTML = ''
  const allUsers = getAllUsersSorted()

  if (!selectedUser) {
    try {
      selectedUser = localStorage.getItem('selectedUser') || null
    } catch (_) {
      selectedUser = null
    }
  }
  if (selectedUser && !allUsers.includes(selectedUser)) selectedUser = null
  if (!selectedUser && allUsers.length) selectedUser = allUsers[0]

  const metaEl = el('usersMeta')
  if (metaEl) metaEl.textContent = `${allUsers.length} total · ${runningSet.size} running`

  for (const u of allUsers) {
    const st = userStates.get(u) || { running: false, connected: false, color: 'red' }
    const row = document.createElement('div')
    row.className = `userRow${u === selectedUser ? ' selected' : ''}`
    row.setAttribute('role', 'listitem')
    row.onclick = () => setSelectedUser(u)

    const dot = document.createElement('span')
    dot.className = `dot ${st.color || (st.connected ? 'green' : 'red')}`
    row.appendChild(dot)

    const text = document.createElement('div')
    text.className = 'userText'
    const name = document.createElement('div')
    name.className = 'userName'
    name.textContent = u
    const meta = document.createElement('div')
    meta.className = 'userMeta'
    meta.textContent = st.running ? 'running' : 'stopped'
    text.appendChild(name)
    text.appendChild(meta)
    row.appendChild(text)

    const buttons = document.createElement('div')
    buttons.className = 'userButtons'

    const runBtn = document.createElement('button')
    runBtn.className = 'iconBtn run'
    runBtn.title = 'Run'
    runBtn.textContent = st.running ? '●' : '▶'
    runBtn.disabled = st.running
    runBtn.onclick = async (e) => {
      e.stopPropagation()
      if (st.running) return
      await api('/api/start', { method: 'POST', body: JSON.stringify({ username: u }) })
      setSelectedUser(u)
      await refreshAll()
    }

    const stopBtn = document.createElement('button')
    stopBtn.className = 'iconBtn stop'
    stopBtn.title = 'Stop'
    stopBtn.textContent = '■'
    stopBtn.disabled = !st.running
    stopBtn.onclick = async (e) => {
      e.stopPropagation()
      await api('/api/stop', { method: 'POST', body: JSON.stringify({ username: u }) })
      setSelectedUser(u)
      await refreshAll()
    }

    const removeBtn = document.createElement('button')
    removeBtn.className = 'iconBtn remove'
    removeBtn.title = 'Remove'
    removeBtn.textContent = '×'
    removeBtn.disabled = st.running
    removeBtn.onclick = async (e) => {
      e.stopPropagation()
      if (st.running) return
      await api('/api/remove', { method: 'POST', body: JSON.stringify({ username: u }) })
      if (u === selectedUser) selectedUser = null
      await refreshAll()
    }

    buttons.appendChild(runBtn)
    buttons.appendChild(stopBtn)
    buttons.appendChild(removeBtn)
    row.appendChild(buttons)

    usersEl.appendChild(row)
  }
}

function renderLogUserSelect() {
  // No-op (logs are shown per user now).
}

function renderSelectedLog() {
  const logUserEl = el('logUser')
  const logBoxEl = el('logBox')
  if (!logUserEl || !logBoxEl) return

  const allUsers = getAllUsersSorted()
  if (selectedUser && !allUsers.includes(selectedUser)) selectedUser = null
  if (!selectedUser && allUsers.length) selectedUser = allUsers[0]

  if (!selectedUser) {
    logUserEl.textContent = 'Select a user'
    logBoxEl.textContent = 'No user selected.'
    return
  }

  logUserEl.textContent = selectedUser
  const lines = logsAll[selectedUser] || []
  logBoxEl.textContent = lines.length ? lines.join('\n') : '(no logs yet)'
  logBoxEl.scrollTop = logBoxEl.scrollHeight
}

async function refreshState() {
  const st = await api('/api/state')
  if (st.data && Array.isArray(st.data.usernames)) {
    usernames = st.data.usernames
  }

  const users = Array.isArray(st.users) ? st.users : []
  userStates = new Map(
    users.map((u) => [
      u.username,
      { running: Boolean(u.running), connected: Boolean(u.connected), color: u.color || 'red' }
    ])
  )
  runningSet = new Set(users.filter((u) => u.running).map((u) => u.username))

  const statusEl = el('status')
  statusEl.textContent = `running=${runningSet.size}/${usernames.length}`
  renderUsers()
  renderSelectedLog()
  renderLogUserSelect()
}

async function refreshLogsAll() {
  const out = await api('/api/logs_all')
  logsAll = (out && out.logs) || {}
  renderSelectedLog()
}

el('addBtn').onclick = () => {
  const input = el('newUser')
  const u = (input.value || '').trim()
  if (!u) return
  if (!usernames.includes(u)) usernames.push(u)
  input.value = ''
  // Auto-save so the new username is immediately runnable.
  el('saveBtn').onclick().catch(() => {})
}

el('saveBtn').onclick = async () => {
  const password = el('password').value || ''
  await api('/api/save', { method: 'POST', body: JSON.stringify({ password, usernames }) })
  await refreshAll()
}

el('startBtn').onclick = async () => {
  try {
    const password = el('password').value || ''
    await api('/api/save', { method: 'POST', body: JSON.stringify({ password, usernames }) })
    await api('/api/start', { method: 'POST', body: JSON.stringify({ usernames }) })
    await refreshAll()
  } catch (e) {
    el('status').textContent = `error: ${e.message}`
  }
}

el('stopBtn').onclick = async () => {
  try {
    await api('/api/stop', { method: 'POST', body: '{}' })
    await refreshAll()
  } catch (e) {
    el('status').textContent = `error: ${e.message}`
  }
}

async function refreshAll() {
  await refreshLogsAll()
  await refreshState()
}

setInterval(() => {
  refreshAll().catch(() => {})
}, 1200)

refreshAll()
  .catch((e) => {
    el('status').textContent = `error: ${e.message}`
  })

const mineflayer = require('mineflayer')
const readline = require('readline')
const { Vec3 } = require('vec3')

function readBoolEnv(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const v = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false
  return fallback
}

function readNumEnv(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

// Local config (no .env)
// NOTE: Keeping credentials in plain text is risky; prefer a local config file you don't commit.
const config = {
  host: 'gapples.org',
  port: 25565,
  username: '',
  password: '',
  version: '1.20.1',
  auth: 'offline',

  // Send packets a bit slower (ms). Added to several interaction sleeps.
  packetDelayMs: 0,

  // Login behavior
  // - true: wait until server chat prompts you to /login
  // - false: send /login after the first spawn
  loginOnPrompt: true,
  loginDelayMs: 2500,

  // Optional movement: walk backwards to enter a portal / move off spawn.
  enablePortalWalkBack: true,
  // After a portal-triggered respawn/spawn event, do a short backwards nudge (ms).
  portalWalkBackDelayMs: 4000,
  // While waiting for a portal transition, keep walking backwards until timeout (ms).
  portalWalkBackTimeoutMs: 60_000,

  // Optional: Prismarine Viewer web server
  enableViewer: true,
  viewerPort: 3007,
  // Set false for a more "freecam"-like default camera.
  viewerFirstPerson: false,

  // Optional: auto-place an item frame after seeing the anarchy welcome message.
  autoPlaceFrameOnWelcome: true,
  autoPlaceFrameDelayMs: 1000,

  // Survival helpers (only enabled after the anarchy welcome message is detected)
  enableAutoTotem: true,
  autoTotemReplaceNonTotemOffhand: true,

  enableAutoGap: true,
  // 20 = full health; 12 = 6 hearts.
  autoGapHealthThreshold: 12,
  autoGapCooldownMs: 6500,
  autoGapPreferEnchanted: false,
  // Some servers allow eating at full hunger; when false we require bot.food < 20.
  autoGapAllowWhenFull: true,

  // Polling fallback for survival helpers (ms).
  survivalPollMs: 750,

  // Optional: auto-replace the tracked item frame when it's broken/removed.
  autoReplaceFrame: true,
  frameReplacePollMs: 1500,
  frameReplaceMaxDistance: 6,

  // After placing/replacing a frame, repeatedly insert + punch a shulker.
  shulkerCycleEnabled: true,

  // Connection behavior
  autoReconnect: true,
  reconnectBaseDelayMs: 5000,
  reconnectMaxDelayMs: 60_000
}

// Allow running multiple accounts by overriding a few config values via env vars.
config.username = process.env.BOT_USERNAME || config.username
config.password = process.env.BOT_PASSWORD || config.password
config.host = process.env.BOT_HOST || config.host
config.port = readNumEnv('BOT_PORT', config.port)
config.version = process.env.BOT_VERSION || config.version
config.auth = process.env.BOT_AUTH || config.auth
config.enableViewer = readBoolEnv('BOT_ENABLE_VIEWER', config.enableViewer)
config.viewerPort = readNumEnv('BOT_VIEWER_PORT', config.viewerPort)

console.log(
  `Connecting to ${config.host}:${config.port} as ${config.username}` +
    `${config.version ? ` (version ${config.version})` : ''}` +
    `${config.auth ? ` (auth ${config.auth})` : ''}...`
)

let currentBot = null
let reconnectTimer = null
let reconnectAttempt = 0
let quitting = false
let authState = 'unknown' // unknown | logging_in | authed
let awaitingPortalSpawn = false
let walkBackTimeout = null
let lobbyWalkTimeout = null
let frameMonitorInterval = null

let startViewer = null
let viewerLoadError = null
let viewerStartedOnce = false
if (config.enableViewer) {
  try {
    ;({ mineflayer: startViewer } = require('prismarine-viewer'))
  } catch (err) {
    viewerLoadError = err
  }
}

function stringifyReason(reason) {
  if (reason == null) return ''
  if (typeof reason === 'string') return reason
  try {
    return JSON.stringify(reason)
  } catch {
    return String(reason)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function immediate() {
  return new Promise((resolve) => setImmediate(resolve))
}

function getCardinalForwardOffset(yawRadians) {
  const x = -Math.sin(yawRadians)
  const z = -Math.cos(yawRadians)
  const ax = Math.abs(x)
  const az = Math.abs(z)
  if (ax > az) return { dx: Math.sign(x) || 1, dz: 0 }
  return { dx: 0, dz: Math.sign(z) || 1 }
}

function findPlaceableItemFrame(bot) {
  const items = bot?.inventory?.items?.() || []
  return (
    items.find((it) => it?.name === 'glow_item_frame') ||
    items.find((it) => it?.name === 'item_frame') ||
    null
  )
}

function isShulkerBoxItem(item) {
  const name = String(item?.name || '')
  return name === 'shulker_box' || name.endsWith('_shulker_box')
}

function findAnyShulkerBox(bot) {
  const items = bot?.inventory?.items?.() || []
  return items.find((it) => isShulkerBoxItem(it)) || null
}

function isTotemItem(item) {
  return String(item?.name || '') === 'totem_of_undying'
}

function findTotem(bot) {
  const items = bot?.inventory?.items?.() || []
  return items.find((it) => isTotemItem(it)) || null
}

function getOffhandItem(bot) {
  const slots = bot?.inventory?.slots
  if (!Array.isArray(slots)) return null
  // For modern Mineflayer/Prismarine inventory mapping, offhand is slot 45.
  return slots[45] || null
}

async function equipOffhand(bot, item) {
  if (!bot || !item) return
  try {
    await bot.equip(item, 'off-hand')
    return
  } catch {}
  // Some versions use a slightly different destination label.
  await bot.equip(item, 'offhand')
}

function isGappleItem(item) {
  const name = String(item?.name || '')
  return name === 'golden_apple' || name === 'enchanted_golden_apple'
}

function findGapple(bot, { preferEnchanted = false } = {}) {
  const items = bot?.inventory?.items?.() || []
  if (preferEnchanted) {
    return (
      items.find((it) => it?.name === 'enchanted_golden_apple') ||
      items.find((it) => it?.name === 'golden_apple') ||
      null
    )
  }
  return (
    items.find((it) => it?.name === 'golden_apple') ||
    items.find((it) => it?.name === 'enchanted_golden_apple') ||
    null
  )
}

function isItemFrameEntity(entity) {
  const name = String(entity?.name || '').toLowerCase()
  return name === 'item_frame' || name === 'glow_item_frame' || name === 'itemframe' || name === 'glowitemframe'
}

function findNearestItemFrameEntity(bot, expectedPos, maxDistance = 3) {
  const entities = bot?.entities || {}
  let best = null
  let bestDist = Infinity

  for (const id of Object.keys(entities)) {
    const entity = entities[id]
    if (!entity) continue
    if (!isItemFrameEntity(entity)) continue
    const dist = entity.position.distanceTo(expectedPos)
    if (dist < bestDist) {
      bestDist = dist
      best = entity
    }
  }

  if (best && bestDist <= maxDistance) return best
  return null
}
let monitoredFrame = null
let replaceInProgress = false
let lastReplaceAtMs = 0
let shulkerCycleTask = null
let shulkerCycleStopRequested = false
let shulkerCycleManuallyStopped = false
let shulkerCyclePaused = false
let lastManualPlaceFrameAtMs = 0
let survivalMonitorInterval = null

function expectedItemFramePos(referenceBlockPos, faceVec) {
  // Approx center of where the item frame entity will be.
  return referenceBlockPos.plus(faceVec).offset(0.5, 0.05, 0.5)
}

function countItemByName(bot, name) {
  const items = bot?.inventory?.items?.() || []
  return items.filter((it) => it?.name === name).reduce((sum, it) => sum + (it?.count || 0), 0)
}

async function waitForItemFrameEntityNear(bot, expectedPos, maxDistance = 3, timeoutMs = 2500) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const found = findNearestItemFrameEntity(bot, expectedPos, maxDistance)
    if (found) return found
    await immediate()
  }
  return null
}

async function rightClickEntity(bot, entity) {
  // 0 = interact (right-click). Using mouse=2 (interact_at) is unreliable for item frames on some servers/versions.
  if (typeof bot.useEntity === 'function') {
    await bot.useEntity(entity, { mouse: 0, hand: 0 })
    return
  }
  if (typeof bot.activateEntity === 'function') {
    await bot.activateEntity(entity)
    return
  }
  throw new Error('No bot.useEntity/bot.activateEntity available to interact with item frames')
}

async function leftClickEntity(bot, entity) {
  // Punch/attack (left-click). Prefer bot.attack() when available.
  if (typeof bot.attack === 'function') {
    bot.attack(entity)
    return
  }
  if (typeof bot.useEntity === 'function') {
    await bot.useEntity(entity, { mouse: 1, hand: 0 })
    return
  }
  throw new Error('No bot.attack/bot.useEntity available to punch item frames')
}

async function runShulkerCycle(bot, referenceBlockPos, faceVec) {
  const expectedPos = expectedItemFramePos(referenceBlockPos, faceVec)
  const packetDelayMs = Math.max(0, Number(config.packetDelayMs) || 0)
  let lastAliveLogAtMs = 0

  while (!shulkerCycleStopRequested) {
    if (shulkerCyclePaused) {
      await sleep(50)
      continue
    }

    const frameEntity = findNearestItemFrameEntity(bot, expectedPos, 2.25)
    if (!frameEntity) {
      await immediate()
      continue
    }

    if (bot?.entity?.position && bot.entity.position.distanceTo(frameEntity.position) > 4.75) {
      await immediate()
      continue
    }

    const shulker = findAnyShulkerBox(bot)
    if (!shulker) {
      await immediate()
      continue
    }

    // Fast loop: equip -> right click -> punch -> repeat.
    await bot.lookAt(expectedPos, true)
    if (packetDelayMs) await sleep(packetDelayMs)
    await bot.equip(shulker, 'hand')
    if (packetDelayMs) await sleep(packetDelayMs)
    await rightClickEntity(bot, frameEntity)
    await sleep(100 + packetDelayMs)
    await leftClickEntity(bot, frameEntity)
    await sleep(100 + packetDelayMs)

    const now = Date.now()
    if (now - lastAliveLogAtMs >= 10_000) {
      lastAliveLogAtMs = now
      console.log('ShulkerCycle: alive')
    }
  }
}

function startShulkerCycle(bot, referenceBlockPos, faceVec, { force = false } = {}) {
  if (!config.shulkerCycleEnabled) return
  if (shulkerCycleTask) return
  if (shulkerCycleManuallyStopped && !force) return

  if (force) shulkerCycleManuallyStopped = false
  shulkerCycleStopRequested = false
  console.log('ShulkerCycle: started')
  shulkerCycleTask = (async () => {
    try {
      await runShulkerCycle(bot, referenceBlockPos, faceVec)
    } catch (err) {
      console.warn('Shulker cycle stopped due to error:', err?.message || err)
    } finally {
      shulkerCycleTask = null
    }
  })()
}

function stopShulkerCycle({ manual = false } = {}) {
  shulkerCycleStopRequested = true
  if (manual) shulkerCycleManuallyStopped = true
  if (manual) console.log('ShulkerCycle: stop requested (manual)')
}

function clearSurvivalMonitor() {
  if (survivalMonitorInterval) {
    clearInterval(survivalMonitorInterval)
    survivalMonitorInterval = null
  }
  shulkerCyclePaused = false
}

async function placeItemFrameAt(bot, referenceBlockPos, faceVec) {
  const referenceBlock = bot.blockAt(referenceBlockPos)
  if (!referenceBlock || referenceBlock.name === 'air') {
    throw new Error(`Missing reference block at ${referenceBlockPos} (got: ${referenceBlock?.name})`)
  }

  const occupiedPos = referenceBlock.position.plus(faceVec)
  const occupiedBlock = bot.blockAt(occupiedPos)
  if (!occupiedBlock || occupiedBlock.name !== 'air') {
    throw new Error(`Target space not empty at ${occupiedPos} (got: ${occupiedBlock?.name})`)
  }

  const frameItem = findPlaceableItemFrame(bot)
  if (!frameItem) throw new Error('No item frame in inventory (item_frame / glow_item_frame)')

  const packetDelayMs = Math.max(0, Number(config.packetDelayMs) || 0)
  await bot.equip(frameItem, 'hand')
  await sleep(100 + packetDelayMs)
  if (typeof bot._genericPlace !== 'function') {
    throw new Error('mineflayer _genericPlace is missing; cannot place item frame')
  }
  await bot._genericPlace(referenceBlock, faceVec, { forceLook: true, swingArm: 'right' })
}

async function ensureMonitoredFramePresent(bot, why) {
  if (!monitoredFrame) return
  if (!config.autoReplaceFrame) return
  if (replaceInProgress) return
  if (!bot?.entity) return

  if (bot?.entity?.position && config.frameReplaceMaxDistance != null) {
    const dist = bot.entity.position.distanceTo(monitoredFrame.referencePos.offset(0.5, 0.5, 0.5))
    if (dist > config.frameReplaceMaxDistance) return
  }

  const now = Date.now()
  if (now - lastReplaceAtMs < 250) return

  const expectedPos = expectedItemFramePos(monitoredFrame.referencePos, monitoredFrame.faceVec)
  const frameEntity = findNearestItemFrameEntity(bot, expectedPos, 2.25)
  if (frameEntity) return

  replaceInProgress = true
  lastReplaceAtMs = now
  console.log(`Item frame missing (${why}); attempting to replace...`)

  try {
    await placeItemFrameAt(bot, monitoredFrame.referencePos, monitoredFrame.faceVec)
    try {
      startShulkerCycle(bot, monitoredFrame.referencePos, monitoredFrame.faceVec)
    } catch (err) {
      console.warn('Auto-insert shulker failed after replace:', err?.message || err)
    }
  } catch (err) {
    console.error('Auto-replace failed:', err?.message || err)
  } finally {
    replaceInProgress = false
  }
}

async function placeItemFrameOnStandingBlock(bot) {
  if (!bot) throw new Error('Bot is not connected')
  if (!bot.entity) throw new Error('Bot entity not ready yet (wait for spawn)')

  const now = Date.now()
  // Prevent spamming place attempts (matches the general pacing of the non-hopper path).
  if (now - lastManualPlaceFrameAtMs < 250) {
    const remaining = 250 - (now - lastManualPlaceFrameAtMs)
    throw new Error(`placeframe cooldown: wait ~${remaining}ms`)
  }
  lastManualPlaceFrameAtMs = now

  // If we already placed a frame once, keep placing at that locked location unless it's unreachable.
  if (monitoredFrame?.referencePos && monitoredFrame?.faceVec) {
    const maxDist = config.frameReplaceMaxDistance ?? 6
    const dist = bot.entity.position.distanceTo(monitoredFrame.referencePos.offset(0.5, 0.5, 0.5))
    if (dist <= maxDist) {
      const expectedPos = expectedItemFramePos(monitoredFrame.referencePos, monitoredFrame.faceVec)
      const existing = findNearestItemFrameEntity(bot, expectedPos, 2.25)
      if (existing) {
        try {
          startShulkerCycle(bot, monitoredFrame.referencePos, monitoredFrame.faceVec, { force: true })
        } catch (err) {
          console.warn('Auto-insert shulker failed after placing frame:', err?.message || err)
        }
        return
      }

      try {
        await placeItemFrameAt(bot, monitoredFrame.referencePos, monitoredFrame.faceVec)
        try {
          startShulkerCycle(bot, monitoredFrame.referencePos, monitoredFrame.faceVec, { force: true })
        } catch (err) {
          console.warn('Auto-insert shulker failed after placing frame:', err?.message || err)
        }
        return
      } catch {
        // Fall through to pick a new location (unreachable/invalid).
      }
    }
  }

  const feetBlockPos = bot.entity.position.floored()
  const standingOnPos = feetBlockPos.offset(0, -1, 0)
  const standingOnBlock = bot.blockAt(standingOnPos)
  if (
    !standingOnBlock ||
    standingOnBlock.name === 'air' ||
    (standingOnBlock.boundingBox !== 'block' && standingOnBlock.boundingBox !== 'slab')
  ) {
    throw new Error(`Not standing on a solid block at ${standingOnPos} (got: ${standingOnBlock?.name})`)
  }

  // Special case: if standing on a hopper, place the item frame on the side of a non-container
  // block adjacent to the bot (prefer "in front" of the bot based on yaw).
  if (standingOnBlock.name === 'hopper') {
    const isContainerBlockName = (name) => {
      const n = String(name || '')
      if (n === 'hopper') return true
      if (n === 'barrel') return true
      if (n === 'dispenser' || n === 'dropper') return true
      if (n === 'furnace' || n === 'blast_furnace' || n === 'smoker') return true
      if (n === 'brewing_stand') return true
      if (n === 'ender_chest') return true
      if (n === 'lectern') return true
      if (n === 'shulker_box' || n.endsWith('_shulker_box')) return true
      if (n.includes('chest')) return true
      return false
    }

    const forward = getCardinalForwardOffset(bot.entity.yaw)
    const candidates = [
      forward,
      { dx: -forward.dz, dz: forward.dx }, // right
      { dx: forward.dz, dz: -forward.dx }, // left
      { dx: -forward.dx, dz: -forward.dz } // back
    ]

    let chosen = null
    for (const { dx, dz } of candidates) {
      const referencePos = feetBlockPos.offset(dx, 0, dz)
      const referenceBlock = bot.blockAt(referencePos)
      if (!referenceBlock || referenceBlock.name === 'air') continue
      if (referenceBlock.boundingBox !== 'block' && referenceBlock.boundingBox !== 'slab') continue
      if (isContainerBlockName(referenceBlock.name)) continue
      chosen = { referenceBlock, dx, dz }
      break
    }

    if (!chosen) {
      throw new Error(
        'Standing on a hopper, but no adjacent non-container solid block found to place the item frame onto.'
      )
    }

    const faceVec = new Vec3(-chosen.dx, 0, -chosen.dz)
    await placeItemFrameAt(bot, chosen.referenceBlock.position, faceVec)
    try {
      startShulkerCycle(bot, chosen.referenceBlock.position, faceVec, { force: true })
    } catch (err) {
      console.warn('Auto-insert shulker failed after placing frame:', err?.message || err)
    }

    monitoredFrame = {
      referencePos: new Vec3(chosen.referenceBlock.position.x, chosen.referenceBlock.position.y, chosen.referenceBlock.position.z),
      faceVec: new Vec3(faceVec.x, faceVec.y, faceVec.z)
    }
    return
  }

  const faceVec = new Vec3(0, 1, 0)
  await placeItemFrameAt(bot, standingOnBlock.position, faceVec)
  try {
    startShulkerCycle(bot, standingOnBlock.position, faceVec, { force: true })
  } catch (err) {
    console.warn('Auto-insert shulker failed after placing frame:', err?.message || err)
  }

  // Track this location for auto-replacement.
  monitoredFrame = {
    referencePos: new Vec3(standingOnBlock.position.x, standingOnBlock.position.y, standingOnBlock.position.z),
    faceVec: new Vec3(faceVec.x, faceVec.y, faceVec.z)
  }
}

async function autoPlaceFrameAfterWelcome(bot) {
  if (!bot?.entity) throw new Error('Bot not ready yet (wait for spawn)')
  await bot.look(bot.entity.yaw, -Math.PI / 2, true)
  await sleep(250)
  await placeItemFrameOnStandingBlock(bot)
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function clearFrameMonitor() {
  if (frameMonitorInterval) {
    clearInterval(frameMonitorInterval)
    frameMonitorInterval = null
  }
}

function scheduleReconnect(why) {
  if (!config.autoReconnect || quitting) return
  if (reconnectTimer) return

  const expDelay = config.reconnectBaseDelayMs * Math.pow(2, reconnectAttempt)
  const capped = Math.min(expDelay, config.reconnectMaxDelayMs)
  const jitter = Math.floor(Math.random() * 500)
  const delay = capped + jitter

  reconnectAttempt += 1
  console.log(`Reconnecting in ${delay}ms (${why})...`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    startBot()
  }, delay)
}

function stopWalkingBack() {
  if (!currentBot) return
  currentBot.clearControlStates()
  awaitingPortalSpawn = false
  if (walkBackTimeout) {
    clearTimeout(walkBackTimeout)
    walkBackTimeout = null
  }
  if (lobbyWalkTimeout) {
    clearTimeout(lobbyWalkTimeout)
    lobbyWalkTimeout = null
  }
}

function walkBackForMs(ms, why) {
  if (!currentBot) return

  if (lobbyWalkTimeout) {
    clearTimeout(lobbyWalkTimeout)
    lobbyWalkTimeout = null
  }

  console.log(`Walking backwards for ${ms}ms (${why})...`)
  currentBot.clearControlStates()
  currentBot.setControlState('back', true)
  currentBot.setControlState('sprint', false)

  lobbyWalkTimeout = setTimeout(() => {
    lobbyWalkTimeout = null
    if (!currentBot) return
    currentBot.clearControlStates()
  }, ms)
}

function startWalkingBackUntilNextSpawn() {
  if (!currentBot) return
  if (awaitingPortalSpawn) return

  console.log(`Walking backwards until anarchy chat is detected, timeout ${config.portalWalkBackTimeoutMs}ms...`)
  awaitingPortalSpawn = true

  currentBot.clearControlStates()
  currentBot.setControlState('back', true)
  currentBot.setControlState('sprint', false)

  if (walkBackTimeout) clearTimeout(walkBackTimeout)
  walkBackTimeout = setTimeout(() => {
    if (!currentBot) return
    console.warn(
      `No anarchy message detected within ${config.portalWalkBackTimeoutMs}ms. Stopping movement.`
    )
    stopWalkingBack()
  }, config.portalWalkBackTimeoutMs)
}

function formatLoginCommand(password) {
  if (!password) return null
  const needsQuotes = /\s/.test(password) || password.includes('"')
  if (!needsQuotes) return `/login ${password}`
  const escaped = password.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return `/login "${escaped}"`
}

function looksLikeLoginPrompt(message) {
  const lower = normalizeMessage(message).toLowerCase()
  return (
    lower.includes('please login') ||
    lower.includes('please log in') ||
    lower.includes('use /login') ||
    lower.includes('command: /login') ||
    lower.includes('/login <password>') ||
    lower.includes('welcome back! please login using /login <password>') ||
    lower.includes('register using /register') ||
    lower.includes('please register')
  )
}

function looksLikeLoginSuccess(message) {
  const lower = normalizeMessage(message).toLowerCase()
  return (
    lower.includes('successfully logged in') ||
    lower.includes('successfully login') ||
    lower.includes('logged in successfully') ||
    lower.includes('login successful') ||
    lower.includes('you are already logged in') ||
    lower.includes('already logged in')
  )
}

function normalizeMessage(message) {
  return String(message || '')
    .replace(/§[0-9a-fk-or]/gi, '') // strip Minecraft formatting codes
    .replace(/\s+/g, ' ')
    .trim()
}

function isAnarchyWelcomeText(text) {
  const lower = normalizeMessage(text).toLowerCase()
  return lower.includes('welcome to gapples.org anarchy server')
}

async function doLogin({ delayBeforeLoginMs, trigger }) {
  const loginCmd = formatLoginCommand(config.password)
  if (!loginCmd) {
    console.warn(`Skipping /login (no password set). Trigger: ${trigger}`)
    return
  }

  if (delayBeforeLoginMs) await sleep(delayBeforeLoginMs)
  if (!currentBot) return

  authState = 'logging_in'
  console.log(`Sending login command (trigger: ${trigger})...`)
  currentBot.chat(loginCmd)
}

function startBot() {
  clearReconnectTimer()
  clearFrameMonitor()
  clearSurvivalMonitor()
  stopShulkerCycle()
  shulkerCycleManuallyStopped = false
  shulkerCycleTask = null

  if (currentBot) {
    try {
      currentBot.removeAllListeners()
      if (currentBot._client) currentBot._client.removeAllListeners()
      currentBot.quit('restarting')
    } catch {
      // ignore
    }
    currentBot = null
  }

  const bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version,
    auth: config.auth
  })

  // Mineflayer does not expose a public bot.useEntity() helper in all versions.
  // Add a small wrapper so code (and user scripts) can call bot.useEntity() consistently.
  if (typeof bot.useEntity !== 'function') {
    bot.useEntity = async (entity, { mouse = 2, position = null, hand = 0 } = {}) => {
      if (!entity?.id) throw new Error('useEntity: missing entity id')
      const sneaking = bot.getControlState?.('sneak') || false
      const packet = { target: entity.id, mouse, sneaking, hand }
      if (position) {
        packet.x = position.x - entity.position.x
        packet.y = position.y - entity.position.y
        packet.z = position.z - entity.position.z
      }
      bot._client.write('use_entity', packet)
    }
  }

  currentBot = bot
  authState = 'unknown'
  let sentLogin = false
  let placedFrameOnWelcome = false
  let autoPlaceAttempt = 0
  let anarchyFeaturesActive = false
  let survivalBusy = false
  let lastAutoGapAtMs = 0

  function startSurvivalMonitor() {
    if (survivalMonitorInterval) return
    const pollMs = Math.max(100, Number(config.survivalPollMs) || 750)
    survivalMonitorInterval = setInterval(() => {
      if (!currentBot || currentBot !== bot) return
      tickSurvival('poll').catch(() => {})
    }, pollMs)
  }

  async function tickSurvival(trigger) {
    if (!anarchyFeaturesActive) return
    if (!config.enableAutoTotem && !config.enableAutoGap) return
    if (!currentBot || currentBot !== bot) return
    if (survivalBusy) return

    survivalBusy = true
    const packetDelayMs = Math.max(0, Number(config.packetDelayMs) || 0)

    try {
      if (config.enableAutoTotem) {
        const offhand = getOffhandItem(bot)
        const needsTotem =
          !isTotemItem(offhand) &&
          (!offhand || Boolean(config.autoTotemReplaceNonTotemOffhand))

        if (needsTotem) {
          const totem = findTotem(bot)
          if (totem) {
            await equipOffhand(bot, totem)
            if (packetDelayMs) await sleep(packetDelayMs)
          }
        }
      }

      if (config.enableAutoGap) {
        const threshold = Number(config.autoGapHealthThreshold) || 0
        const cooldownMs = Math.max(0, Number(config.autoGapCooldownMs) || 0)
        const now = Date.now()

        if (bot.health != null && bot.health <= threshold && now - lastAutoGapAtMs >= cooldownMs) {
          const canEat = Boolean(config.autoGapAllowWhenFull) || (bot.food != null && bot.food < 20)
          if (!canEat) return

          const gapple = findGapple(bot, { preferEnchanted: Boolean(config.autoGapPreferEnchanted) })
          if (!gapple) return

          const prevHeld = bot.heldItem || null
          shulkerCyclePaused = true

          try {
            await bot.equip(gapple, 'hand')
            if (packetDelayMs) await sleep(packetDelayMs)

            if (typeof bot.consume === 'function') {
              await bot.consume()
            } else if (typeof bot.activateItem === 'function') {
              bot.activateItem()
              await sleep(1600 + packetDelayMs)
              if (typeof bot.deactivateItem === 'function') bot.deactivateItem()
            } else {
              throw new Error('No bot.consume/bot.activateItem available to eat')
            }

            lastAutoGapAtMs = now
            console.log(`AutoGap: ate (${gapple.name}), trigger=${trigger || 'unknown'}`)
          } finally {
            // Best-effort restore previously held item.
            if (prevHeld && prevHeld.name && prevHeld.name !== gapple.name) {
              const candidate =
                (bot?.inventory?.items?.() || []).find((it) => it?.name === prevHeld.name) || null
              if (candidate) {
                try {
                  await bot.equip(candidate, 'hand')
                } catch {
                  // ignore
                }
              }
            }
            shulkerCyclePaused = false
          }
        }
      }
    } catch (err) {
      const msg = err?.message || String(err)
      console.warn(`Survival tick failed (${trigger || 'unknown'}):`, msg)
      shulkerCyclePaused = false
    } finally {
      survivalBusy = false
    }
  }

  bot.on('entityGone', (entity) => {
    if (!entity || !monitoredFrame) return
    if (!isItemFrameEntity(entity)) return

    const expectedPos = expectedItemFramePos(monitoredFrame.referencePos, monitoredFrame.faceVec)
    const dist = entity.position ? entity.position.distanceTo(expectedPos) : Infinity
    if (dist > 2.5) return

    ensureMonitoredFramePresent(bot, 'entityGone').catch(() => {})
  })

  frameMonitorInterval = setInterval(() => {
    if (!currentBot || currentBot !== bot) return
    ensureMonitoredFramePresent(bot, 'poll').catch(() => {})
  }, config.frameReplacePollMs)

  if (config.enableViewer) {
    if (viewerStartedOnce) {
      console.log('Viewer already started; skipping viewer restart on reconnect.')
    } else {
      viewerStartedOnce = true
      if (!startViewer) {
        console.warn('Viewer enabled but prismarine-viewer failed to load.')
        if (viewerLoadError) {
          const msg = viewerLoadError?.message || String(viewerLoadError)
          console.warn(`Viewer load error: ${msg}`)
          if (
            viewerLoadError?.code === 'MODULE_NOT_FOUND' &&
            typeof msg === 'string' &&
            msg.includes("'canvas'")
          ) {
            console.warn('Fix: npm install canvas')
            console.warn('If canvas fails to install on Node 22, try Node 20 LTS.')
          }
        } else {
          console.warn('Fix: npm install prismarine-viewer')
        }
      } else {
        try {
          startViewer(bot, {
            port: config.viewerPort,
            firstPerson: config.viewerFirstPerson
          })
          console.log(`Viewer: http://localhost:${config.viewerPort}`)
        } catch (err) {
          console.error('Failed to start viewer:', err?.message || err)
        }
      }
    }
  }

  if (bot._client) {
    bot._client.on('kick_disconnect', (packet) => {
      const reason = packet && packet.reason ? stringifyReason(packet.reason) : stringifyReason(packet)
      console.log(`Kick disconnect packet: ${reason}`)
    })
    bot._client.on('disconnect', (packet) => {
      const reason = packet && packet.reason ? stringifyReason(packet.reason) : stringifyReason(packet)
      console.log(`Server disconnect packet: ${reason}`)
    })
    bot._client.on('close', (hadError) => console.log(`Socket closed (hadError: ${hadError})`))
  }

  bot.on('spawn', () => {
    console.log('Spawned.')
    tickSurvival('spawn').catch(() => {})

    if (config.enablePortalWalkBack && awaitingPortalSpawn) {
      console.log('Detected portal spawn. Stopping movement.')
      stopWalkingBack()
      setTimeout(() => {
        if (!currentBot || currentBot !== bot) return
        walkBackForMs(config.portalWalkBackDelayMs, 'post-portal nudge')
      }, 250)
    }

    if (config.loginOnPrompt) return
    if (sentLogin) return
    if (!config.password) return

    sentLogin = true
    doLogin({ delayBeforeLoginMs: config.loginDelayMs, trigger: 'spawn' }).catch((err) =>
      console.error('spawn login failed:', err)
    )
  })

  function scheduleAutoPlaceFrame(text) {
    if (!config.autoPlaceFrameOnWelcome) return
    if (placedFrameOnWelcome) return
    if (!isAnarchyWelcomeText(text)) return

    placedFrameOnWelcome = true
    console.log('Anarchy welcome detected; scheduling auto item-frame placement...')

    const tryOnce = () => {
      if (!currentBot || currentBot !== bot) return
      autoPlaceAttempt += 1
      autoPlaceFrameAfterWelcome(bot)
        .then(() => console.log('Auto-placed item frame.'))
        .catch((err) => {
          const msg = err?.message || String(err)
          console.error(`Auto-place attempt ${autoPlaceAttempt} failed:`, msg)
          if (autoPlaceAttempt < 5) setTimeout(tryOnce, 1250)
        })
    }

    setTimeout(tryOnce, config.autoPlaceFrameDelayMs)
  }

  function handleServerText(tag, text) {
    if (text == null) return
    const str = typeof text === 'string' ? text : text?.toString?.() || String(text)
    if (!str) return

    console.log(`[${tag}] ${str}`)
    scheduleAutoPlaceFrame(str)

    if (!anarchyFeaturesActive && isAnarchyWelcomeText(str)) {
      anarchyFeaturesActive = true
      console.log('Anarchy welcome detected; enabling AutoTotem/AutoGap...')
      startSurvivalMonitor()
      tickSurvival('welcome').catch(() => {})
      if (monitoredFrame && config.shulkerCycleEnabled) {
        startShulkerCycle(bot, monitoredFrame.referencePos, monitoredFrame.faceVec, { force: true })
      }
    }

    const normalizedLower = normalizeMessage(str).toLowerCase()

    if (config.enablePortalWalkBack) {
      const sawAnarchyTransition =
        isAnarchyWelcomeText(str) ||
        /sending you to the anarchy server/i.test(normalizeMessage(str)) ||
        (normalizedLower.includes('sending you') && normalizedLower.includes('anarchy'))

      if (sawAnarchyTransition && (awaitingPortalSpawn || lobbyWalkTimeout)) {
        console.log('Anarchy transition detected. Stopping walk-back.')
        stopWalkingBack()
      }

      if (
        normalizedLower.includes('welcome to the lobby.') &&
        normalizedLower.includes('you were teleported to your skyblock island')
      ) {
        if (!awaitingPortalSpawn) {
          setTimeout(() => {
            if (!currentBot || currentBot !== bot) return
            if (awaitingPortalSpawn) return
            startWalkingBackUntilNextSpawn()
          }, 500)
        }
        return
      }
    }

    if (looksLikeLoginSuccess(str)) {
      authState = 'authed'
      return
    }

    if (!config.loginOnPrompt) return
    if (sentLogin) return
    if (!config.password) return
    if (!looksLikeLoginPrompt(str)) return

    sentLogin = true
    doLogin({ delayBeforeLoginMs: config.loginDelayMs, trigger: 'prompt' }).catch((err) =>
      console.error('prompt login failed:', err)
    )
  }

  bot.on('messagestr', (message) => handleServerText('MC', message))
  bot.on('title', (title, type) => handleServerText(`TITLE:${type}`, title))
  bot.on('actionBar', (jsonMsg) => handleServerText('ACTIONBAR', jsonMsg))
  bot.on('health', () => tickSurvival('health').catch(() => {}))

  bot.on('chat', (player, message) => {
    console.log(`[CHAT] <${player}> ${message}`)
  })

  bot.on('kicked', (reason, loggedIn) => {
    console.log('Kicked:', reason, 'loggedIn:', loggedIn)
    clearSurvivalMonitor()
    clearFrameMonitor()
    scheduleReconnect('kicked')
  })

  bot.on('error', (err) => {
    if (err && err.code === 'ECONNREFUSED') {
      console.error(
        `Bot error: connection refused to ${config.host}:${config.port}. Make sure the server is online.`
      )
      scheduleReconnect('connection refused')
      return
    }
    console.error('Bot error:', err)
    scheduleReconnect('error')
  })

  bot.on('end', () => {
    console.log('Disconnected.')
    clearSurvivalMonitor()
    clearFrameMonitor()
    scheduleReconnect('end')
  })
}

startBot()

// Console -> Minecraft chat
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  if (trimmed === 'exit' || trimmed === 'quit') {
    quitting = true
    clearReconnectTimer()
    rl.close()
    if (currentBot) currentBot.quit('Console quit')
    return
  }
  if (!currentBot) {
    console.log('Not connected yet; command ignored:', trimmed)
    return
  }

  // Local console commands (not sent to Minecraft chat)
  if (trimmed === '.help') {
    console.log('Local commands: .help, .placeframe, .stop')
    return
  }
  if (trimmed === '.stop') {
    stopShulkerCycle({ manual: true })
    console.log('Stop requested for shulker cycle.')
    return
  }
  if (trimmed === '.placeframe') {
    placeItemFrameOnStandingBlock(currentBot)
      .then(() => console.log('Placed item frame on top of the block you are standing on.'))
      .catch((err) => console.error('placeframe failed:', err?.message || err))
    return
  }

  currentBot.chat(trimmed)
})

// dsh-live2d 的 Electron 助手（主进程，多窗口池版）
//
// 职责：
//   1. 一个进程里管理最多 N 个无边框 / 透明 / 置顶小窗口（instanceId → BrowserWindow）；
//   2. 与插件宿主用一条 TCP 控制通道通信（127.0.0.1:0），每条命令按 instanceId 路由；
//   3. 把 `live2d-asset://<instanceId>/<相对路径>` 映射到该实例的模型目录（只读、限扩展名）；
//   4. 把宿主的命令转给对应窗口的渲染层，把渲染层的事件带上 instanceId 回报宿主。
//
// 注意：
//   · 本文件是 CommonJS（.cjs），因为插件 package.json 是 "type": "module"；
//   · userData 指到用户本地缓存目录（D 盘中文路径下 Chromium 建缓存会被拒）；
//   · 不加载任何远程内容，只 loadFile 本地 index.html；
//   · 实测必须带 --no-sandbox（由宿主 spawn 时传入），否则本机启动即 0x80000003。

const { app, BrowserWindow, ipcMain, protocol, screen } = require('electron')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const userDataDir = process.env.LIVE2D_PROBE_USERDATA
  || (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'dsh-live2d', 'userdata')
    : path.join(os.homedir(), 'AppData', 'Local', 'dsh-live2d', 'userdata'))
app.setPath('userData', userDataDir)

/** instanceId -> { win, modelDir, pageReady, queued[], title, pinned, ignoreMouse, bounds } */
const pool = new Map()
let windowSeq = 0

function log(message) {
  // 人类可读日志走 stdout（宿主会把它放进 logTail，不进协议通道）
  process.stdout.write(`[live2d-window] ${message}\n`)
}

// 控制通道：本机 TCP（127.0.0.1:0 随机端口）。
// 为什么不用 stdin：Electron 在 Windows GUI 模式下 stdin 启动后立刻 EOF，
// 宿主写的任何一行都收不到（实测 30ms 内触发 'end'，随后进程 0xC0000005 退出）。
let controlServer = null
let controlClient = null
const outbox = []

function writePayload(payload) {
  let line
  try {
    line = `${JSON.stringify({ __live2d: 1, ...payload })}\n`
  } catch (error) {
    log(`report serialize failed: ${error && error.message}`)
    return false
  }
  if (controlClient && !controlClient.destroyed) {
    try {
      controlClient.write(line)
      return true
    } catch { /* 落到 outbox */ }
  }
  outbox.push(line)
  while (outbox.length > 40) outbox.shift()
  return false
}

function report(payload) {
  // 协议行：宿主侧 windowManager 通过 TCP 收到后交给 onProtocol
  writePayload(payload)
}

const MIME = {
  '.json': 'application/json',
  '.moc3': 'application/octet-stream',
  '.png': 'image/png',
  '.webp': 'image/webp',
}
const ALLOWED_EXT = new Set(Object.keys(MIME))

// 必须在 app ready 之前声明
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'live2d-asset',
    // corsEnabled 必须开：页面是 file://，pixi 用 XHR 取 model3.json，
    // 没有它会被 CORS 拦成 Status 0 / Network error（实测）。
    // 不开 bypassCSP：页面 CSP 已经显式放行 live2d-asset:，不需要整页绕过。
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
])

function entryOf(instanceId) {
  return instanceId ? pool.get(instanceId) ?? null : null
}

/** 从 webContents 反查它属于哪个实例（IPC 里没有 instanceId）。 */
function entryByWebContents(webContents) {
  for (const [id, entry] of pool) {
    if (entry.win && !entry.win.isDestroyed() && entry.win.webContents === webContents) return { id, entry }
  }
  return null
}

function sendToRenderer(entry, command) {
  // 页面没加载完时 webContents.send 不报错但消息会丢（实测 init 就这样丢了），
  // 所以先攒着，等 did-finish-load 再按序发。
  if (!entry?.win || entry.win.isDestroyed() || !entry.pageReady) {
    entry?.queued?.push(command)
    return false
  }
  try {
    entry.win.webContents.send('live2d:command', command)
    return true
  } catch (error) {
    log(`send command failed: ${error && error.message}`)
    entry.queued.push(command)
    return false
  }
}

function ensureWindowSize(entry, config = {}) {
  if (!entry?.win) return
  entry.config = { ...(entry.config ?? {}), ...config }
  const width = Number.isInteger(config.windowWidth) ? config.windowWidth : 320
  const height = Number.isInteger(config.windowHeight) ? config.windowHeight : 420
  const bounds = entry.win.getBounds()
  const hasX = Number.isInteger(config.windowX)
  const hasY = Number.isInteger(config.windowY)
  const next = clampBoundsToWorkArea({
    // 没配位置就保持当前坐标（首次位置在 createInstanceWindow 里按序号错开）
    x: hasX ? config.windowX : bounds.x,
    y: hasY ? config.windowY : bounds.y,
    width,
    height,
  })
  try {
    entry.win.setBounds(next)
    entry.bounds = entry.win.getBounds()
    // 尺寸多半是设置页改的：把落地后的真实几何回传，宿主「刷新坐标」才有值
    report({ type: 'bounds', instanceId: entry.instanceId, bounds: entry.bounds })
    scheduleTransparentRepaint(entry, 'ensure-window-size')
  } catch (error) {
    log(`setBounds failed: ${error && error.message}`)
  }
}

const numIn = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function overlapArea(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return width * height
}

/**
 * 透明窗口跨两块显示器/两种 DPI 时，Windows 的部分合成路径不会重绘透明区域，
 * 表现为整块白色，切换前台窗口后才消失。这里不要只相信 getDisplayMatching：
 * 先按最大交叠面积选屏，保证窗口最终完整落在一块显示器的工作区内。
 */
function displayForBounds(bounds) {
  const displays = screen.getAllDisplays()
  let best = null
  let bestArea = 0
  for (const display of displays) {
    const area = overlapArea(bounds, display.bounds)
    if (area > bestArea) {
      best = display
      bestArea = area
    }
  }
  if (best) return best
  try {
    return screen.getDisplayNearestPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    })
  } catch {
    return screen.getPrimaryDisplay()
  }
}

function clampBoundsToWorkArea(wanted) {
  const display = displayForBounds(wanted)
  const area = display?.workArea ?? display?.bounds
  if (!area) return wanted
  const width = Math.max(1, Math.min(Math.round(wanted.width), area.width))
  const height = Math.max(1, Math.min(Math.round(wanted.height), area.height))
  return {
    x: Math.max(area.x, Math.min(Math.round(wanted.x), area.x + area.width - width)),
    y: Math.max(area.y, Math.min(Math.round(wanted.y), area.y + area.height - height)),
    width,
    height,
  }
}

function paintTransparentNow(entry, reason = '') {
  if (!entry?.win || entry.win.isDestroyed()) return
  try { entry.win.setBackgroundColor('#00000000') } catch { /* ignore */ }
  try { entry.win.webContents.invalidate() } catch { /* ignore */ }
  if (entry.pageReady) {
    try {
      entry.win.webContents.send('live2d:command', {
        __live2d: 1,
        type: 'repaint',
        instanceId: entry.instanceId,
      })
    } catch { /* renderer 正在重载，下一轮重绘会补上 */ }
  }
  if (reason) log(`${entry.instanceId} transparent repaint: ${reason}`)
}

function scheduleTransparentRepaint(entry, reason = '', burst = false) {
  if (!entry?.win || entry.win.isDestroyed()) return
  for (const timer of entry.repaintTimers ?? []) clearTimeout(timer)
  // Windows 对未聚焦透明窗口的首帧合成有时会晚一拍；就绪时做一次短促重绘，
  // 后续移动/缩放只做一次防抖重绘。
  const delays = burst ? [0, 80, 240, 700] : [80]
  entry.repaintTimers = delays.map((delay) => {
    const timer = setTimeout(() => paintTransparentNow(entry, reason), delay)
    if (typeof timer.unref === 'function') timer.unref()
    return timer
  })
}

/**
 * AI/设置页要求改窗口几何时的安全边界（0.13.0）：
 * 工作区内、尺寸夹取、单次位移不超过半屏、左上角工具栏区必须留在屏内。
 */
function computeSafeBounds(win, wanted = {}) {
  const cur = win.getBounds()
  const display = screen.getDisplayMatching(cur)
  const area = display.workArea ?? display.bounds
  const width = numIn(wanted.width, 160, 800, cur.width)
  const height = numIn(wanted.height, 200, 1000, cur.height)
  const maxDx = Math.round(area.width / 2)
  const maxDy = Math.round(area.height / 2)
  // center：复位用，水平居中、贴工作区底部（和首次出现的习惯位置一致）
  const wantX = wanted.center === true
    ? Math.round(area.x + (area.width - width) / 2)
    : numIn(wanted.x, cur.x - maxDx, cur.x + maxDx, cur.x)
  const wantY = wanted.center === true
    ? Math.round(area.y + area.height - height - 24)
    : numIn(wanted.y, cur.y - maxDy, cur.y + maxDy, cur.y)
  // 左上角 40×40（工具栏/关闭按钮所在）必须留在工作区内，否则用户找不到窗口
  const x = numIn(wantX, area.x, area.x + area.width - 40, cur.x)
  const y = numIn(wantY, area.y, area.y + area.height - 40, cur.y)
  return clampBoundsToWorkArea({ x, y, width, height })
}

function applySafeBounds(win, wanted = {}) {
  const cur = win.getBounds()
  const safe = computeSafeBounds(win, wanted)
  try {
    win.setBounds(safe)
  } catch (error) {
    log(`setBounds(safe) failed: ${error && error.message}`)
    return cur
  }
  return win.getBounds()
}

/**
 * 平滑移动：按 ~60fps 逐帧 setBounds，走 easeOutCubic。
 * 直接瞬移会像「传送」，用户要求像拖动一样挪过去（2026-11-05）。
 */
function animateBounds(win, target, durationMs = 700, done = null) {
  const start = win.getBounds()
  const span = Math.max(120, Math.min(1600, Number(durationMs) || 700))
  const t0 = Date.now()
  let timer = null
  const step = () => {
    if (!win || win.isDestroyed()) { if (timer) clearInterval(timer); return }
    const k = Math.min(1, (Date.now() - t0) / span)
    const e = 1 - Math.pow(1 - k, 3)
    const next = {
      x: Math.round(start.x + (target.x - start.x) * e),
      y: Math.round(start.y + (target.y - start.y) * e),
      width: Math.round(start.width + (target.width - start.width) * e),
      height: Math.round(start.height + (target.height - start.height) * e),
    }
    try { win.setBounds(next) } catch { /* 窗口在动画中被关掉 */ }
    if (k >= 1) {
      if (timer) clearInterval(timer)
      timer = null
      const final = win.isDestroyed() ? target : win.getBounds()
      if (typeof done === 'function') done(final)
    }
  }
  step()
  timer = setInterval(step, 16)
  timer.unref?.()
}

/**
 * 把整窗夹进当前显示器的工作区。
 * 换分辨率/改 DPI 后旧坐标会超屏，超出去的那一截 Windows 会留白底且不重绘
 * （用户看到「模型1 有白色背景，切换一下界面才消失」）。
 */
function clampWindowIntoWorkArea(win) {
  const cur = win.getBounds()
  let safe
  try { safe = clampBoundsToWorkArea(cur) } catch { return cur }
  if (safe.x === cur.x && safe.y === cur.y && safe.width === cur.width && safe.height === cur.height) {
    return cur
  }
  try {
    win.setBounds(safe)
    log(`clamp bounds ${JSON.stringify(cur)} → ${JSON.stringify(win.getBounds())}`)
  } catch (error) {
    log(`clamp bounds failed: ${error && error.message}`)
    return cur
  }
  return win.getBounds()
}

function reclampAllWindows(reason) {
  for (const entry of pool.values()) {
    if (!entry?.win || entry.win.isDestroyed()) continue
    try {
      clampWindowIntoWorkArea(entry.win)
      entry.bounds = entry.win.getBounds()
      scheduleTransparentRepaint(entry, reason)
    } catch (error) {
      log(`re-clamp ${entry.instanceId ?? ''} failed: ${error && error.message}`)
    }
  }
}

function defaultPosition(width, height) {  const workArea = screen.getPrimaryDisplay().workAreaSize
  const offset = windowSeq * (width + 16)
  windowSeq += 1
  return {
    x: Math.max(0, workArea.width - width - 24 - offset),
    y: Math.max(0, workArea.height - height - 24),
  }
}

function createInstanceWindow(instanceId, config = {}, title = '') {
  if (pool.has(instanceId)) {
    const existing = pool.get(instanceId)
    if (existing.win && !existing.win.isDestroyed()) {
      existing.title = title
      ensureWindowSize(existing, config)
      return { ok: true, alreadyExists: true, instanceId }
    }
    pool.delete(instanceId)
  }

  const width = Number.isInteger(config.windowWidth) ? config.windowWidth : 320
  const height = Number.isInteger(config.windowHeight) ? config.windowHeight : 420
  const pos = defaultPosition(width, height)
  const hasX = Number.isInteger(config.windowX)
  const hasY = Number.isInteger(config.windowY)
  const initial = clampBoundsToWorkArea({
    x: hasX ? config.windowX : pos.x,
    y: hasY ? config.windowY : pos.y,
    width,
    height,
  })

  let win
  try {
    win = new BrowserWindow({
      width: initial.width,
      height: initial.height,
      x: initial.x,
      y: initial.y,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      // 部分 Windows DWM 组合会在厚边框 + 透明窗口跨屏时留下白色合成块。
      // 本窗口本来就是 frameless + 自绘工具区，去掉 WS_THICKFRAME 不影响功能。
      thickFrame: false,
      show: false,
      // 置顶状态由配置决定（用户可在窗口里切换，持久到 config.pinned）
      alwaysOnTop: config?.pinned !== false,
      backgroundColor: '#00000000',
      title: title || 'Live2D',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        // 挂件常在后台/不聚焦，被节流会停止画帧（多窗口下第二个窗口会整片空白）
        backgroundThrottling: false,
      },
    })
  } catch (error) {
    report({ type: 'error', instanceId, code: 'window-create-failed', error: error && error.message })
    return { ok: false, error: error && error.message }
  }

  const entry = {
    instanceId,
    win,
    config: { ...config },
    modelDir: null,
    pageReady: false,
    queued: [],
    title: title || '',
    pinned: config?.pinned !== false,
    dragging: false,
    ignoreMouse: false,
    repaintTimers: [],
    // 旧坐标可能超出当前屏幕（换分辨率/DPI 后常见）：超界部分 Windows 不重绘、呈白底
    bounds: clampWindowIntoWorkArea(win),
  }
  pool.set(instanceId, entry)
  // 窗口进池了：把创建期间先到的 init/config 补发掉
  flushEarlyCommands(instanceId)

  // 穿透兜底：setIgnoreMouseEvents(true,{forward:true}) 在部分 Windows 环境下不转发 mousemove，
  // 窗口会「永久点不动」。这里每 150ms 看一次光标是否在窗口内（只在穿透状态），
  // 把窗口内坐标喂给渲染层，让它按 模型 / 输入栏 / 按钮 的命中结果重新接管鼠标。
  entry.pointerTimer = setInterval(() => {
    if (!entry.win || entry.win.isDestroyed()) return
    let point
    try { point = screen.getCursorScreenPoint() } catch { return }
    const b = entry.win.getBounds()
    const inside = point.x >= b.x - 2 && point.x <= b.x + b.width + 2 && point.y >= b.y - 2 && point.y <= b.y + b.height + 2
    // 拖动兜底：拖动中鼠标被拖出窗口，渲染层收不到 mouseup 会卡在 dragging 状态，
    // 这里一旦发现光标出了窗口（±24px 容差）就让它结束拖动。
    if (entry.dragging && !inside) {
      const out = point.x < b.x - 24 || point.x > b.x + b.width + 24 || point.y < b.y - 24 || point.y > b.y + b.height + 24
      if (out) {
        entry.dragging = false
        try {
          entry.win.webContents.send('live2d:command', { __live2d: 1, type: 'cancel-drag', instanceId, reason: 'pointer-left-window' })
        } catch { /* 页面忙，下一轮再不行就靠渲染层超时 */ }
        return
      }
    }
    if (!entry.ignoreMouse) return
    if (!inside) return
    try {
      entry.win.webContents.send('live2d:command', {
        __live2d: 1,
        type: 'pointer-probe',
        instanceId,
        x: point.x - b.x,
        y: point.y - b.y,
      })
    } catch { /* 页面还没加载好，下一轮再试 */ }
  }, 150)
  if (typeof entry.pointerTimer.unref === 'function') entry.pointerTimer.unref()

  if (entry.pinned) win.setAlwaysOnTop(true, 'floating')
  win.loadFile(path.join(__dirname, 'index.html'))

  win.webContents.on('did-finish-load', () => {
    entry.pageReady = true
    log(`${instanceId} did-finish-load queued=${entry.queued.length}`)
    for (const command of entry.queued.splice(0)) {
      if (!sendToRenderer(entry, command)) break
    }
    scheduleTransparentRepaint(entry, 'did-finish-load')
  })

  win.webContents.on('did-start-loading', () => {
    entry.pageReady = false
  })

  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return
    win.showInactive()
    if (entry.pinned) win.setAlwaysOnTop(true, 'floating')
    entry.bounds = win.getBounds()
    const display = displayForBounds(entry.bounds)
    log(
      `${instanceId} ready pid=${process.pid} alwaysOnTop=${win.isAlwaysOnTop()} visible=${win.isVisible()}`
      + ` bounds=${JSON.stringify(entry.bounds)} display=${display?.id ?? 'unknown'}`
      + ` workArea=${JSON.stringify(display?.workArea ?? null)} scale=${display?.scaleFactor ?? 'unknown'}`,
    )
    report({ type: 'ready', instanceId, pid: process.pid, bounds: entry.bounds, title: entry.title })
    scheduleTransparentRepaint(entry, 'ready-show', true)
  })

  win.on('closed', () => {
    for (const timer of entry.repaintTimers ?? []) clearTimeout(timer)
    entry.repaintTimers = []
    if (entry.pointerTimer) {
      clearInterval(entry.pointerTimer)
      entry.pointerTimer = null
    }
    if (pool.get(instanceId)?.win === win) pool.delete(instanceId)
    log(`${instanceId} closed (pool=${pool.size})`)
    report({ type: 'closed', instanceId })
  })

  win.on('move', () => {
    if (win && !win.isDestroyed()) entry.bounds = win.getBounds()
    scheduleTransparentRepaint(entry, 'move')
  })
  win.on('resize', () => {
    if (win && !win.isDestroyed()) entry.bounds = win.getBounds()
    scheduleTransparentRepaint(entry, 'resize')
  })
  win.on('show', () => scheduleTransparentRepaint(entry, 'show', true))
  win.on('focus', () => scheduleTransparentRepaint(entry, 'focus', true))
  win.on('blur', () => scheduleTransparentRepaint(entry, 'blur', true))

  // 调整框拖完/用户改大小：松手后把最终几何回传（拖动过程中不上报，免得刷屏）
  win.on('resize', () => {
    if (win && !win.isDestroyed()) entry.bounds = win.getBounds()
  })
  win.on('resized', () => {
    if (win && !win.isDestroyed()) {
      entry.bounds = win.getBounds()
      report({ type: 'bounds', instanceId, bounds: entry.bounds })
    }
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    log(`${instanceId} render-process-gone reason=${details?.reason}`)
    report({ type: 'error', instanceId, code: 'renderer-crash', error: `render-process-gone: ${details?.reason}` })
  })

  win.webContents.on('console-message', (...args) => {
    // Electron 43 是 (event)，老版本是 (event, level, message) —— 两种都接住，
    // 通过控制通道回传给宿主，排查渲染层问题时就靠它。
    const first = args[0]
    let level = 0
    let message = ''
    if (first && typeof first === 'object' && ('message' in first || 'level' in first)) {
      level = Number(first.level ?? 0)
      message = String(first.message ?? '')
    } else {
      level = Number(args[1] ?? 0)
      message = String(args[2] ?? '')
    }
    if (!message) return
    log(`${instanceId} renderer[${level}] ${message.slice(0, 400)}`)
    report({ type: 'console', instanceId, level, message: message.slice(0, 600) })
  })

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    report({ type: 'error', instanceId, code: 'preload-error', error: `preload-error ${preloadPath}: ${error && error.message}` })
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    report({ type: 'error', instanceId, error: `did-fail-load ${errorCode} ${errorDescription} ${validatedURL}` })
  })

  return { ok: true, instanceId, bounds: entry.bounds }
}

function closeInstanceWindow(instanceId, quitIfEmpty = false) {
  const entry = entryOf(instanceId)
  if (!entry?.win || entry.win.isDestroyed()) {
    report({ type: 'closed', instanceId })
    if (quitIfEmpty && pool.size === 0) app.quit()
    return { ok: true, alreadyClosed: true, instanceId }
  }
  try {
    entry.win.close()
  } catch (error) {
    log(`${instanceId} close failed: ${error && error.message}`)
  }
  if (quitIfEmpty && pool.size === 0) app.quit()
  return { ok: true, instanceId }
}

// 窗口还没建好就先到的命令（开第二个窗口时很常见）：暂存起来，等窗口进池后重放。
const earlyCommands = new Map()
const EARLY_WAIT_MS = 3000
const EARLY_LIMIT = 6

function queueEarlyCommand(command) {
  const id = command.instanceId
  if (!id) return
  let slot = earlyCommands.get(id)
  if (!slot) {
    slot = { commands: [], timer: null }
    earlyCommands.set(id, slot)
    slot.timer = setTimeout(() => {
      const waiting = earlyCommands.get(id)
      earlyCommands.delete(id)
      if (waiting?.commands.length) log(`${id} 窗口未就绪，丢弃 ${waiting.commands.length} 条早到命令`)
    }, EARLY_WAIT_MS)
  }
  if (slot.commands.length < EARLY_LIMIT) slot.commands.push(command)
}

function flushEarlyCommands(instanceId) {
  const slot = earlyCommands.get(instanceId)
  if (!slot) return
  earlyCommands.delete(instanceId)
  if (slot.timer) clearTimeout(slot.timer)
  for (const command of slot.commands) {
    try {
      handleCommand(command)
    } catch (error) {
      log(`重放早到命令失败：${error && error.message}`)
    }
  }
}

function handleCommand(command) {
  if (!command || typeof command !== 'object') return
  const instanceId = typeof command.instanceId === 'string' ? command.instanceId : null
  const entry = instanceId ? entryOf(instanceId) : null
  if (command.type === 'pool:create') {
    createInstanceWindow(instanceId, command.config ?? {}, command.title ?? '')
    return
  }
  if (command.type === 'pool:close') {
    closeInstanceWindow(instanceId, true)
    return
  }
  if (command.type === 'screenshot') {
    const id = command.id ?? null
    if (!entry?.win || entry.win.isDestroyed()) {
      report({ type: 'screenshot', instanceId, id, ok: false, error: 'window not ready' })
      return
    }
    // 后台窗口（不聚焦）有时合成器还没画出第一帧，先唤到前台再截
    try {
      if (!entry.win.isVisible()) entry.win.showInactive()
      entry.win.webContents.invalidate()
    } catch { /* ignore */ }
    setTimeout(() => {
      entry.win.webContents
        .capturePage()
        .then((image) => report({ type: 'screenshot', instanceId, id, ok: true, base64: image.toPNG().toString('base64') }))
        .catch((error) => report({ type: 'screenshot', instanceId, id, ok: false, error: error && error.message }))
    }, 250)
    return
  }
  if (command.type === 'query-bounds') {
    if (entry?.win && !entry.win.isDestroyed()) {
      report({ type: 'bounds', instanceId, bounds: entry.win.getBounds() })
    }
    return
  }
  if (command.type === 'set-bounds') {
    if (!entry?.win || entry.win.isDestroyed()) {
      report({ type: 'error', instanceId, code: 'no-such-window', error: '窗口不存在' })
      return
    }
    const wanted = computeSafeBounds(entry.win, command.bounds ?? {})
    if (command.animate === false) {
      entry.bounds = applySafeBounds(entry.win, command.bounds ?? {})
      report({ type: 'bounds', instanceId, bounds: entry.bounds })
      return
    }
    // 默认走动画：像被拖过去一样挪，而不是瞬移
    animateBounds(entry.win, wanted, command.durationMs, (final) => {
      entry.bounds = final
      report({ type: 'bounds', instanceId, bounds: final })
    })
    return
  }
  if (!entry) {
    // 窗口还没建好时命令先到（开第二个窗口时很常见）：排队等 ready 再重放。
    // 超过 3 秒还没等到就丢弃并记一行日志 —— 不要每次都往控制通道报错误刷屏。
    if (instanceId) {
      queueEarlyCommand(command)
      return
    }
    report({ type: 'error', instanceId, code: 'no-such-window', error: `没有这个窗口：${instanceId}` })
    return
  }
  if (command.type === 'init') {
    entry.modelDir = command.model?.modelDir ?? null
    entry.title = command.title ?? entry.title
    entry.config = { ...(entry.config ?? {}), ...(command.config ?? {}) }
    ensureWindowSize(entry, entry.config)
    log(`${instanceId} init modelDir=${entry.modelDir ?? 'null'} modelOk=${command.model?.ok === true}`)
  }
  if (command.type === 'reload') {
    // 换模型时宿主会带新的 model 信息；协议层按 entry.modelDir 取文件，
    // 这里不同步的话会继续从旧目录读 —— 表现就是「改了路径但窗口还是旧模型」。
    if (command.model && typeof command.model.modelDir === 'string' && command.model.modelDir) {
      entry.modelDir = command.model.modelDir
      log(`${instanceId} reload modelDir=${entry.modelDir}`)
    } else if (command.model && command.model.ok === false) {
      entry.modelDir = null
      log(`${instanceId} reload modelDir=null (model not ok)`)
    }
  }
  if (command.type === 'config') {
    const patch = command.patch ?? {}
    entry.config = { ...(entry.config ?? {}), ...patch }
    // 设置页保存的几何字段是 windowX/windowY/windowWidth/windowHeight。
    // 任何几何变更都合并到当前 config 后重新夹取，不能用局部 patch 回落成 320×420。
    if (
      patch.windowX !== undefined || patch.windowY !== undefined
      || patch.windowWidth !== undefined || patch.windowHeight !== undefined
    ) {
      ensureWindowSize(entry, entry.config)
    }
  }
  sendToRenderer(entry, command)
}

// 宿主 → 窗口：监听本机端口，接受一条控制连接，逐行读 JSON 命令
let hasConnected = false
let orphanTimer = null

function cancelOrphanExit() {
  if (orphanTimer) {
    clearTimeout(orphanTimer)
    orphanTimer = null
  }
}

// 断开后 5 秒没有重连就退出：DSH 崩溃/被强杀时宿主侧清理跑不到，
// 这里靠连接断开兜底，避免留下一堆孤儿窗口。
function scheduleOrphanExit() {
  if (!hasConnected) return
  cancelOrphanExit()
  orphanTimer = setTimeout(() => {
    orphanTimer = null
    if (controlClient) return
    log('control channel lost for 5s, quitting to avoid orphan window')
    app.quit()
  }, 5000)
}

function startControlServer() {
  controlServer = net.createServer((socket) => {
    controlClient = socket
    hasConnected = true
    cancelOrphanExit()
    socket.setEncoding('utf8')
    let buffer = ''

    socket.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '').trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        let command = null
        try {
          command = JSON.parse(line)
        } catch {
          log(`control line not json: ${line.slice(0, 120)}`)
          continue
        }
        if (!command || command.__live2d !== 1) continue
        handleCommand(command)
      }
    })

    socket.on('close', () => {
      if (controlClient === socket) controlClient = null
      log('control disconnected')
      scheduleOrphanExit()
    })
    socket.on('error', (error) => log(`control socket error: ${error && error.message}`))

    // 把窗口启动早期缓存的消息补发（ready 等）
    for (const line of outbox.splice(0)) {
      try { socket.write(line) } catch { /* ignore */ }
    }
    log('control connected')
  })

  controlServer.on('error', (error) => log(`control server error: ${error && error.message}`))
  controlServer.listen(0, '127.0.0.1', () => {
    const port = controlServer.address().port
    // 这一行必须保持 `[live2d-window] port=NNNNN` 的形状：宿主用它找端口
    log(`port=${port}`)
    report({ type: 'listening', port })
  })
}

// 语音是用户主动开的自动朗读，不需要再要一次点击手势（否则 autoplay 被拦、气泡永远挂着）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

app.whenReady().then(() => {
  protocol.handle('live2d-asset', async (request) => {
    try {
      const url = new URL(request.url)
      const instanceId = url.host || 'model'
      const relative = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      // 兼容老版本（host 固定是 model）：只有实例 0 时也能取到模型
      const entry = pool.get(instanceId) ?? (instanceId === 'model' ? pool.values().next().value : null)
      const base = entry?.modelDir ?? null
      if (!base) return new Response('model dir not set', { status: 404 })
      const resolvedBase = path.resolve(base)
      const target = path.resolve(resolvedBase, relative)
      if (target !== resolvedBase && !target.startsWith(resolvedBase + path.sep)) {
        return new Response('forbidden', { status: 403 })
      }
      const ext = path.extname(target).toLowerCase()
      if (!ALLOWED_EXT.has(ext)) return new Response('unsupported extension', { status: 403 })
      const data = await fs.promises.readFile(target)
      return new Response(data, {
        headers: {
          'content-type': MIME[ext],
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        },
      })
    } catch (error) {
      log(`asset failed: ${error && error.message}`)
      return new Response(String(error && error.message), { status: 500 })
    }
  })

  ipcMain.handle('live2d:state', (event) => {
    const hit = entryByWebContents(event.sender)
    const entry = hit?.entry
    const win = entry?.win
    return {
      instanceId: hit?.id ?? null,
      title: entry?.title ?? null,
      pinned: entry?.pinned ?? true,
      ready: Boolean(entry?.pageReady),
      alwaysOnTop: win && !win.isDestroyed() ? win.isAlwaysOnTop() : false,
      visible: win && !win.isDestroyed() ? win.isVisible() : false,
      bounds: win && !win.isDestroyed() ? win.getBounds() : null,
      ignoreMouse: entry?.ignoreMouse ?? false,
      windowCount: pool.size,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome },
    }
  })

  ipcMain.handle('live2d:pin', (event, pinned) => {
    const hit = entryByWebContents(event.sender)
    if (hit?.entry) {
      hit.entry.pinned = Boolean(pinned)
      if (hit.entry.win && !hit.entry.win.isDestroyed()) hit.entry.win.setAlwaysOnTop(hit.entry.pinned, 'floating')
      // 持久化：宿主把 pinned 写进实例配置，重开窗口/重启 DSH 后保持
      report({ type: 'pin', instanceId: hit.entry.instanceId, pinned: hit.entry.pinned })
      return { pinned: hit.entry.pinned, alwaysOnTop: hit.entry.win ? hit.entry.win.isAlwaysOnTop() : false }
    }
    return { pinned: false, alwaysOnTop: false }
  })

  ipcMain.handle('live2d:ignore-mouse', (event, ignore) => {
    const hit = entryByWebContents(event.sender)
    if (hit?.entry?.win && !hit.entry.win.isDestroyed()) {
      hit.entry.ignoreMouse = Boolean(ignore)
      // forward:true 让鼠标事件仍能传给页面（页面自己判断是否在模型身上）
      hit.entry.win.setIgnoreMouseEvents(hit.entry.ignoreMouse, { forward: true })
      return { ignoreMouse: hit.entry.ignoreMouse }
    }
    return { ignoreMouse: false }
  })

  // 阶段 1.5：调整框拖动时由渲染层算好 bounds，主进程只负责真正 setBounds。
  ipcMain.handle('live2d:set-bounds', (event, bounds) => {
    const hit = entryByWebContents(event.sender)
    const win = hit?.entry?.win
    if (!hit || !win || win.isDestroyed() || !bounds) return { ok: false, error: 'window not ready' }
    const next = {
      x: Math.round(Number(bounds.x)),
      y: Math.round(Number(bounds.y)),
      width: Math.round(Number(bounds.width)),
      height: Math.round(Number(bounds.height)),
    }
    if (![next.x, next.y, next.width, next.height].every((n) => Number.isFinite(n))) {
      return { ok: false, error: 'bounds 不是四个有限数字' }
    }
    // 下限给到宿主 LIMITS 之下一点点，宿主再做一次 clamp 并写盘
    if (next.width < 120 || next.height < 150) return { ok: false, error: 'bounds 太小' }
    try {
      win.setBounds(next)
      hit.entry.bounds = win.getBounds()
      return { ok: true, bounds: hit.entry.bounds }
    } catch (error) {
      log(`set-bounds failed: ${error && error.message}`)
      return { ok: false, error: error && error.message }
    }
  })

  ipcMain.handle('live2d:close', (event) => {
    const hit = entryByWebContents(event.sender)
    if (hit) {
      log(`${hit.id} close requested by renderer`)
      closeInstanceWindow(hit.id, true)
      return true
    }
    return false
  })

  ipcMain.on('live2d:report', (event, payload) => {
    if (!payload || typeof payload !== 'object') return
    const hit = entryByWebContents(event.sender)
    // 拖动状态只给主进程的兜底计时器用，不上报给宿主
    if (payload.type === 'drag' && hit?.entry) {
      hit.entry.dragging = payload.active === true
      return
    }
    // 渲染层不该知道 instanceId —— 由主进程补上，保证不会串窗
    report({ ...payload, instanceId: hit?.id ?? payload.instanceId ?? null })
  })

  const onDisplayLayoutChanged = () => {
    // DPI/分辨率变化后延迟一帧再量，等 Chromium 更新缩放与 workArea。
    const timer = setTimeout(() => reclampAllWindows('display-layout-changed'), 120)
    if (typeof timer.unref === 'function') timer.unref()
  }
  screen.on('display-added', onDisplayLayoutChanged)
  screen.on('display-removed', onDisplayLayoutChanged)
  screen.on('display-metrics-changed', onDisplayLayoutChanged)

  startControlServer()
  // 窗口由宿主通过 pool:create 创建（数量、顺序由实例列表决定）
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  try { controlServer?.close() } catch { /* ignore */ }
  try { controlClient?.destroy() } catch { /* ignore */ }
})

process.on('uncaughtException', (error) => {
  process.stderr.write(`[live2d-window] uncaught: ${error?.message}\n`)
  report({ type: 'error', error: `uncaught: ${error?.message}` })
})
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[live2d-window] unhandledRejection: ${String(reason)}\n`)
})

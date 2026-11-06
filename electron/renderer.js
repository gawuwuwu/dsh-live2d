// 渲染层：加载 vendor runtime → 渲染模型 → 气泡队列 → 占位降级。
//
// 所有失败都必须落到「占位卡片 + 上报 error」，绝不让页面白屏或抛到无人接的 Promise。
// 与宿主的唯一通道：window.live2dWindow.onCommand / report（preload 包好）。

const api = window.live2dWindow
const els = {
  stage: document.getElementById('stage'),
  placeholder: document.getElementById('placeholder'),
  placeholderTitle: document.getElementById('placeholder-title'),
  placeholderDetail: document.getElementById('placeholder-detail'),
  reply: document.getElementById('reply'),
  chatInput: document.getElementById('chat-input'),
  chatSend: document.getElementById('chat-send'),
  adjust: document.getElementById('adjust'),
  adjustMove: document.getElementById('adjust-move'),
  adjustToggle: document.getElementById('adjust-toggle'),
  modeCycle: document.getElementById('mode-cycle'),
  modeMenu: document.getElementById('mode-menu'),
  passthrough: document.getElementById('passthrough'),
  wake: document.getElementById('wake'),
  pin: document.getElementById('pin'),
  close: document.getElementById('close'),
  instanceTitle: document.getElementById('instance-title'),
  presetMenu: document.getElementById('preset-menu'),
}

const settings = {
  durationMs: 5000,
  queueLimit: 3,
  maxChars: 120,
  clickThrough: true,
  modelPassthrough: false,
  rendererEnabled: true,
  adjustMode: false,
  replyStyle: 'bubble',
  // 预设动作（宿主下发）：{ actions: [...], sequences: [...], activeSequence }
  presets: { actions: [], sequences: [], activeSequence: null },
  chatTimeoutMs: 90000,
  replyFontSize: 15,
  replyMaxHeightPct: 45,
  // 气泡最大高度 = 模型高度 × replyHeightRatio%（模型大一倍，气泡也大一倍）
  replyHeightRatio: 50,
  // 固定气泡大小：开启后气泡高度锁死为 bubbleHeightPx，上下拖调整框不再改变
  bubbleFixedSize: false,
  bubbleHeightPx: 200,
  // 模型缩放：基础适配大小 × pct%；zoom-overlay = 允许超出占位区、回答区用独立高度
  modelScalePct: 100,
  modelLayoutMode: 'fit',
  // 动态效果：待机浮动 / 视线跟随 / 拖拽惯性（1~100 控幅度）
  idleFloat: true,
  lookFollow: true,
  dragInertia: true,
  motionStrength: 60,
  // 自动模式预设交互：点模型/摸头有反应（点击由用户触发，不算 AI 主动控制）
  autoInteract: true,
  // 0.13.0：模式（manual/semi/auto）与主动唤醒状态
  mode: 'auto',
  wakeEnabled: false,
  wakeBusy: false,
  // 置顶状态（工具栏 📌 的 active 常亮由它驱动）
  pinned: true,
}

// 动态效果状态：指针位置（喂视线）、模型基准 y（浮动锚点）、拖拽惯性角度
let pointer = { x: 0, y: 0, at: 0 }
let baseModelY = 0
let look = { x: 0, y: 0 }
let inertiaAngle = 0
let dragVelocity = 0
let lastDragMoveAt = 0
// 当前布局：气泡实际可用高度 / 模型实际高度（设置页「刷新坐标」时读这个）
const state = { bubblePx: 0, modelPx: 0 }

let app = null
let model = null
let vendorLoaded = false
let ignoringMouse = false
// 多实例：资产 URL 的 host 段就是 instanceId，由宿主在每条命令里带下来
let currentInstanceId = 'inst-1'
// 有没有绑定会话 ≠ 标题有没有解析到：刚启动时会话还没加载，不能显示成「未绑定会话」
let currentSessionId = ''

function report(payload) {
  try {
    api?.report?.(payload)
  } catch { /* 上报失败不影响渲染 */ }
}

function clampPct(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function clampNum(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/** 动态效果幅度：1~100 → 0.01~1 */
function motionK() {
  return clampNum(settings.motionStrength ?? 60, 1, 100) / 100
}

/**
 * 待机浮动 / 视线跟随 / 拖拽惯性（阶段 4 最后一项）。
 * 视线与惯性都写 Cubism 参数，必须挂在 core.update 之前才同帧生效；
 * 有动作（animState）在跑时让位给动作，避免两套参数互相打架。
 */
function applyMotionParams(core) {
  const now = performance.now()
  const k = motionK()
  let tx = 0
  let ty = 0
  if (settings.lookFollow && pointer.at && now - pointer.at < 4000 && model) {
    const w = model.width || 300
    const h = model.height || 400
    const cx = model.x + w / 2
    const cy = model.y + h * 0.16
    tx = clampNum((pointer.x - cx) / Math.max(60, w * 0.55), -1, 1)
    ty = clampNum((pointer.y - cy) / Math.max(60, h * 0.45), -1, 1)
  }
  // 平滑跟随，指针离开后缓慢回中（不要瞬跳）
  look.x += (tx - look.x) * 0.14
  look.y += (ty - look.y) * 0.14
  try {
    // 角度乘数给足：7°/5° 在 320 宽的小窗里几乎看不出转头（实测截图对比才发现）
    core.setParameterValueById('ParamEyeBallX', look.x * 0.95 * k)
    core.setParameterValueById('ParamEyeBallY', look.y * 0.8 * k)
    core.setParameterValueById('ParamAngleX', look.x * 22 * k)
    core.setParameterValueById('ParamAngleY', look.y * 14 * k)
  } catch { /* 模型没有眼球参数就只跟头 */ }
  if (settings.dragInertia && Math.abs(inertiaAngle) > 0.02) {
    inertiaAngle *= 0.9
    try { core.setParameterValueById('ParamAngleZ', inertiaAngle * k) } catch { /* 无此参数 */ }
  }
  // 挪窗口时轻轻摆头，配合窗口的平滑位移（宿主在 move 前发 walk 命令）
  if (performance.now() < walkUntil) {
    try { core.setParameterValueById('ParamAngleZ', Math.sin(performance.now() / 90) * 6) } catch { /* 无此参数 */ }
  }
}

// 待机浮动：只动 model.y（渲染层位移），不写参数，所以不会和物理/动作抢
let floatPhase = 0
let walkUntil = 0
let walkPhase = 0
function tickFloat(ticker) {
  if (!model) return
  const k = motionK()
  const walking = performance.now() < walkUntil
  if (walking) walkPhase += (ticker?.deltaTime ?? 1) / 60
  // 「挪窗口」时加一点上下起伏，像被拖着走，而不是整体平移
  const walkBob = walking ? Math.sin(walkPhase * 12) * 5 : 0
  if (settings.idleFloat || walking) {
    floatPhase += (ticker?.deltaTime ?? 1) / 60
    model.y = baseModelY + Math.sin(floatPhase * 1.15) * (2 + 4 * k) + walkBob
  } else if (model.y !== baseModelY) {
    model.y = baseModelY
  }
}


/** 左上角会话标题；未绑定时常显，并提示先绑定。 */
function setInstanceTitle(title) {
  const text = typeof title === 'string' ? title.trim() : ''
  const bound = Boolean(text || currentSessionId)
  // 有会话但标题还没解析到时不显示编号（「会话 75aa3a4b」会让人以为绑错了），
  // 给一个明确的过渡文案；宿主随后会补推真实标题。
  const label = text || (currentSessionId ? '已绑定 · 加载标题…' : '未绑定会话')
  els.instanceTitle.textContent = label
  els.instanceTitle.classList.toggle('unbound', !bound)
  els.chatInput.placeholder = bound ? '和她说点什么…' : '先绑定会话再输入…'
}

function showPlaceholder(title, detail) {
  els.placeholderTitle.textContent = title
  els.placeholderDetail.textContent = detail
  els.placeholder.classList.remove('hidden')
  syncReplyBottom()
}

function hidePlaceholder() {
  els.placeholder.classList.add('hidden')
}

function reasonText(model) {
  if (!model) return '还没有收到模型信息'
  switch (model.reason) {
    case 'missing-dir': return '模型路径不存在（去设置页改 modelPath）'
    case 'missing-model3': return '目录里没找到 *.model3.json'
    case 'cubism2-only': return '检测到 Cubism 2 模型，阶段 1 只支持 Cubism 4'
    case 'bad-json': return 'model3.json 解析失败'
    case 'not-probed': return '模型还没探测'
    default: return model.message || '模型不可用'
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`加载失败：${src}`))
    document.head.appendChild(script)
  })
}

async function ensureVendor() {
  if (vendorLoaded) return
  await loadScript('./assets/vendor/pixi.min.js')
  report({ type: 'state', phase: 'vendor-pixi' })
  await loadScript('./assets/vendor/live2dcubismcore.min.js')
  report({ type: 'state', phase: 'vendor-core' })
  await loadScript('./assets/vendor/cubism4.min.js')
  report({ type: 'state', phase: 'vendor-cubism4' })
  await loadScript('./assets/vendor/cubism4-color-compat.js')
  const colorCompatibility = window.PIXI?.live2d?.CubismShader_WebGL?.__multiplyScreenPatched === true
  window.__live2dColorCompatibility = colorCompatibility
  report({ type: 'state', phase: 'vendor-cubism4-color-compat', active: colorCompatibility })
  if (!colorCompatibility) {
    report({
      type: 'error',
      code: 'cubism-color-compat-failed',
      error: 'Cubism 4.2 MultiplyColor/ScreenColor 兼容层没有生效',
    })
  }
  if (!window.PIXI || !window.PIXI.live2d) {
    throw new Error('pixi-live2d-display 没有挂到 PIXI.live2d（vendor 文件不完整？）')
  }
  vendorLoaded = true
}

// 顶部留出回答区的空间：模型按「窗口高 - 预留」缩放并底部对齐，
// 回答只出现在模型上方的空白里，不再压住角色。
const REPLY_MIN_HEIGHT = 220

/** 回答区至少留这么高（窗口太小时退化为半窗），否则多行回答会被模型挤成一两行。 */
function replyMinHeight() {
  const H = app?.renderer?.height || window.innerHeight || 420
  return Math.min(REPLY_MIN_HEIGHT, Math.round(H * 0.5))
}

// 短气泡不预留大空间（否则模型白白缩一圈、上方一大片空白）；
// 只有长回答才按 replyMaxHeightPct 把模型压小、把空间让给文字。
let replyMode = 'short'
const LONG_REPLY_CHARS = 140

function setReplyMode(text) {
  const long = String(text ?? '').length > LONG_REPLY_CHARS || String(text ?? '').split('\n').length > 4
  const next = long ? 'long' : 'short'
  if (next === replyMode) return
  replyMode = next
  fitModel()
}

function replyReservedHeight() {
  const H = app?.renderer?.height || window.innerHeight || 420
  // 模型不再因为「回答区占窗口几成」被挤小：只给底部输入栏留 52px，
  // 气泡大小改由「模型高度 × replyHeightRatio」决定（见 applyReplyStyle）。
  return Math.min(Math.round(H * 0.3), 52)
}

// 回答区的底边固定在模型顶部上方 6px：
// 短回答贴底、长回答向上生长，不论长短都不压模型。
let audioEl = null
// 说话口型：播放期间每帧驱动 ParamMouthOpenY
let speaking = { active: false, startedAt: 0 }

/** 播放宿主下发的语音（base64 data URI；自动播放被拦时静默失败）。返回 audio 元素供调用方挂事件。 */
function playAudio(base64, mime = 'audio/wav') {
  if (typeof base64 !== 'string' || !base64) return null
  try {
    if (audioEl) { audioEl.pause(); audioEl = null }
    audioEl = new Audio(`data:${mime};base64,${base64}`)
    const current = audioEl
    current.addEventListener('ended', () => { if (audioEl === current) audioEl = null })
    speaking = { active: true, startedAt: performance.now() }
    const played = current.play()
    if (played && typeof played.catch === 'function') {
      played.catch(() => {
        speaking.active = false
        if (audioEl === current) audioEl = null
      })
    }
    return current
  } catch {
    audioEl = null
    speaking.active = false
    return null
  }
}

/** 说话时嘴巴开合（正弦近似，跟随播放时长自然停止）。 */
function applyTalkingParams(core) {
  if (!speaking.active) return
  const t = (performance.now() - speaking.startedAt) / 1000
  // 2π ≈ 每秒一个开合周期（真人说话节奏）；正弦本身带缓动，张合不发抖。
  // 0.15~0.9：小窗口也能看出张嘴（0.12~0.62 幅度偏小，实测几乎看不出）
  const value = 0.15 + 0.75 * (0.5 + 0.5 * Math.sin(t * 6.283 - Math.PI / 2))
  try { core.setParameterValueById('ParamMouthOpenY', value) } catch { /* 参数不存在 */ }
}

function syncReplyBottom() {
  if (!els.reply) return
  const H = app?.renderer?.height || window.innerHeight || 420
  const BAR = 52
  // 气泡底边 = 模型头顶 + 6（模型贴底站、气泡向上长，两者不重叠）；
  // zoom-overlay 模式允许覆盖模型，底边就固定在输入栏上方。
  let bottom = BAR
  if (model && settings.modelLayoutMode !== 'zoom-overlay') {
    bottom = Math.max(BAR, Math.round(H - model.y + 6))
  }
  document.documentElement.style.setProperty('--reply-bottom', `${bottom}px`)
  applyReplyStyle()
}

function fitModel() {
  if (!model || !app) return
  const W = app.renderer.width
  const H = app.renderer.height
  const reserved = replyReservedHeight()
  model.scale.set(1)
  const bounds = model.getLocalBounds()
  if (!bounds.width || !bounds.height) return
  const pct = Math.min(200, Math.max(50, Number(settings.modelScalePct) || 100)) / 100
  const zoomOverlay = settings.modelLayoutMode === 'zoom-overlay'
  let scale
  let bubblePx
  if (zoomOverlay) {
    // 覆盖模式：气泡高度独立（固定值或按窗口比例），模型铺满可用高度、允许被气泡盖住。
    // 这样放大模型不会把气泡越压越小（审查 P1-4）。
    const ratio = Math.min(100, Math.max(20, Number(settings.replyHeightRatio) || 50))
    bubblePx = settings.bubbleFixedSize
      ? Math.max(80, Math.min(H - reserved - 80, Number(settings.bubbleHeightPx) || 200))
      : Math.max(80, Math.min(Math.round(H * 0.7), Math.round(H * ratio / 100)))
    const availH = Math.max(80, H - reserved)
    scale = Math.min(W / bounds.width, availH / bounds.height) * 0.96 * pct
  } else if (settings.bubbleFixedSize) {
    // 固定气泡：气泡高度锁定为设置值（上下拖调整框不再改变它），模型装进剩余空间
    bubblePx = Math.max(80, Math.min(H - reserved - 80, Number(settings.bubbleHeightPx) || 200))
    const availH = Math.max(80, H - reserved - bubblePx - 6)
    scale = Math.min(W / bounds.width, availH / bounds.height) * 0.96 * pct
  } else {
    // 动态：模型按「窗口宽度」定大小（左右拖调整框＝调模型），
    // 剩余高度全部给气泡（上下拖调整框＝调气泡）。
    scale = (W / bounds.width) * 0.96 * pct
    const maxModelH = Math.max(80, H - reserved - 80 - 6)
    if (bounds.height * scale > maxModelH) scale = maxModelH / bounds.height
    bubblePx = Math.max(80, H - reserved - bounds.height * scale - 6)
  }
  model.scale.set(scale)
  // 底部居中锚定：脚底站在输入栏上方（不再压到输入框），超出部分由 canvas 裁切
  model.x = (W - bounds.width * scale) / 2 - bounds.x * scale
  model.y = H - reserved - bounds.height * scale - bounds.y * scale
  // 待机浮动的锚点：浮动只做 y 方向的小偏移，不破坏上面算好的站位
  baseModelY = model.y
  state.bubblePx = Math.round(bubblePx)
  state.modelPx = Math.round(bounds.height * scale)
  report({ type: 'state', phase: 'layout', bubblePx: state.bubblePx, modelPx: state.modelPx, windowWidth: W, windowHeight: H, fixedBubble: Boolean(settings.bubbleFixedSize) })
  syncReplyBottom()
  syncAdjustMoveRect()
}

// 「拖动移动窗口」的热区只覆盖模型身体（+8px 余量），不要占满整窗：
// 占满时鼠标到处都显示成 move，还会挡住右上角的置顶/关闭按钮。
function syncAdjustMoveRect() {
  if (!els.adjustMove) return
  if (!model || !app) {
    els.adjustMove.style.left = '16px'
    els.adjustMove.style.right = '16px'
    els.adjustMove.style.top = '40px'
    els.adjustMove.style.bottom = '20px'
    els.adjustMove.style.width = ''
    els.adjustMove.style.height = ''
    return
  }
  let bounds = null
  try { bounds = model.getBounds() } catch { bounds = null }
  if (!bounds || !bounds.width) return
  const pad = 8
  const left = Math.max(0, Math.round(bounds.x - pad))
  const top = Math.max(40, Math.round(bounds.y - pad)) // 顶部让出工具栏
  const right = Math.min(window.innerWidth, Math.round(bounds.x + bounds.width + pad))
  const bottom = Math.min(window.innerHeight, Math.round(bounds.y + bounds.height + pad))
  els.adjustMove.style.left = `${left}px`
  els.adjustMove.style.top = `${top}px`
  els.adjustMove.style.width = `${Math.max(40, right - left)}px`
  els.adjustMove.style.height = `${Math.max(40, bottom - top)}px`
  els.adjustMove.style.right = 'auto'
  els.adjustMove.style.bottom = 'auto'
}

function destroyModel() {
  try {
    if (model) {
      app?.stage?.removeChild(model)
      model.destroy()
    }
  } catch { /* 销毁失败不影响重载 */ }
  model = null
  animState = null
  paramHookInstalled = false
}

// --- 动作（阶段 4）----------------------------------------------------------
// 示例模型的 model3.json 没注册 Motions / Expressions（EXP 里是 exp3 参数表），
// 所以动作不用库的 motion，而是每帧往 Cubism 参数上写关键帧值：
//   写参数 → coreModel.update() 立即按新参数算顶点。
const ANIMS = {
  idle: { duration: 0, tracks: [] },
  // 点头：单次 0.73s，连点 3 次（用户 m13615：要「多次」而不是「更长」）
  nod: { duration: 2200, repeat: 3, tracks: [{ id: 'ParamAngleY', keys: [[0, 0], [0.2, -26], [0.6, -24], [1, 0]] }] },
  // 摇头：左右两次
  shake: { duration: 2000, repeat: 2, tracks: [{ id: 'ParamAngleX', keys: [[0, 0], [0.22, 24], [0.62, -22], [1, 0]] }] },
  tilt: {
    // 歪头：0.15 进入、保持到 0.8（约 1.2s 明显歪着），再慢慢回正
    duration: 2000,
    tracks: [
      { id: 'ParamAngleZ', keys: [[0, 0], [0.15, 18], [0.8, 16], [1, 0]] },
      { id: 'ParamAngleX', keys: [[0, 0], [0.15, 8], [0.8, 6], [1, 0]] },
    ],
  },
  happy: {
    duration: 2000,
    // 不再用 PARAM_EXP5：那是「O_O 圆眼」，和 surprised 撞表情，用户会分不清
    tracks: [
      { id: 'ParamEyeSmile', keys: [[0, 0], [0.18, 1.2], [0.82, 1], [1, 0]] },
      { id: 'ParamMouthForm', keys: [[0, 0], [0.18, 1], [0.82, 0.9], [1, 0]] },
      { id: 'ParamMouthOpenY', keys: [[0, 0], [0.18, 0.55], [0.82, 0.45], [1, 0]] },
    ],
  },
  shy: {
    duration: 3200,
    // 满值段 0.12~0.86（约 2.4s）：之前 1.5s 只闪一下，小窗口根本注意不到
    tracks: [
      { id: 'PARAM_EXP4', keys: [[0, 0], [0.12, 1], [0.86, 1], [1, 0]] }, // 脸红（来自 EXP/04）
      { id: 'ParamAngleX', keys: [[0, 0], [0.12, 16], [0.86, 13], [1, 0]] },
      { id: 'ParamAngleY', keys: [[0, 0], [0.12, -15], [0.86, -12], [1, 0]] },
      { id: 'ParamEyeSmile', keys: [[0, 0], [0.12, 1], [0.86, 1], [1, 0]] },
      { id: 'ParamMouthForm', keys: [[0, 0], [0.12, -0.4], [0.86, -0.3], [1, 0]] },
    ],
  },
  surprised: {
    duration: 1600,
    tracks: [
      { id: 'ParamEyeLOpen', keys: [[0, 1], [0.18, 1.5], [0.75, 1.35], [1, 1]] },
      { id: 'ParamEyeROpen', keys: [[0, 1], [0.18, 1.5], [0.75, 1.35], [1, 1]] },
      { id: 'ParamMouthOpenY', keys: [[0, 0], [0.18, 0.85], [0.75, 0.7], [1, 0]] },
      { id: 'PARAM_EXP5', keys: [[0, 0], [0.18, 1], [0.75, 1], [1, 0]] }, // >v< O_O
    ],
  },
  blink: {
    // 连眨 3 次（每 0.3s 一次），比一次长闭眼更像活人
    duration: 900,
    repeat: 3,
    tracks: [
      { id: 'ParamEyeLOpen', keys: [[0, 1], [0.3, 0.02], [0.6, 0.02], [1, 1]] },
      { id: 'ParamEyeROpen', keys: [[0, 1], [0.3, 0.02], [0.6, 0.02], [1, 1]] },
    ],
  },
  // --- 表情扩展（模型的 EXP 参数带专属贴图，幅度比调 Param 明显得多） ---
  angry: {
    duration: 2400,
    tracks: [
      { id: 'PARAM_EXP3', keys: [[0, 0], [0.15, 1], [0.85, 1], [1, 0]] }, // 脸黑
      { id: 'ParamEyeAnger', keys: [[0, 0], [0.15, 1], [0.85, 0.8], [1, 0]] },
      { id: 'ParamAngleY', keys: [[0, 0], [0.15, 6], [0.85, 5], [1, 0]] },
      { id: 'ParamMouthForm', keys: [[0, 0], [0.15, -0.8], [0.85, -0.7], [1, 0]] },
    ],
  },
  drool: {
    duration: 2600,
    tracks: [
      { id: 'PARAM_EXP7', keys: [[0, 0], [0.2, 1], [0.85, 1], [1, 0]] }, // 流口水
      { id: 'ParamAngleY', keys: [[0, 0], [0.2, 8], [0.85, 7], [1, 0]] },
    ],
  },
  xx: {
    duration: 1400,
    tracks: [
      { id: 'PARAM_EXP6', keys: [[0, 0], [0.2, 1], [0.75, 1], [1, 0]] }, // X X 眼
      { id: 'ParamAngleZ', keys: [[0, 0], [0.2, -9], [0.75, -6], [1, 0]] },
    ],
  },
  puff: {
    duration: 2200,
    tracks: [
      { id: 'PARAM_EXP8', keys: [[0, 0], [0.2, 1], [0.8, 1], [1, 0]] }, // 栗子嘴
      { id: 'ParamMouthForm', keys: [[0, 0], [0.2, -0.6], [0.8, -0.5], [1, 0]] },
    ],
  },
}

// 别名：外面（AI/设置页）说 blush，内部就是 shy
const ANIM_ALIASES = { blush: 'shy', embarrassed: 'shy', stare: 'xx' }

// 逻辑参数 → 各模型常见的真实参数名。
// 自定义动作可以写逻辑名（换模型也能用），也可以直接写真实参数名（只对这一只模型有效）。
const PARAM_ALIASES = {
  headX: ['ParamAngleX'],
  headY: ['ParamAngleY'],
  headZ: ['ParamAngleZ'],
  bodyX: ['ParamBodyAngleX'],
  eyeOpenL: ['ParamEyeLOpen'],
  eyeOpenR: ['ParamEyeROpen'],
  eyeBallX: ['ParamEyeBallX'],
  eyeBallY: ['ParamEyeBallY'],
  mouthOpen: ['ParamMouthOpenY'],
  mouthForm: ['ParamMouthForm'],
  browLY: ['ParamBrowLY'],
  browRY: ['ParamBrowRY'],
}

let modelParams = new Set()
let customActions = new Map()

function detectModelParams() {
  const core = model?.internalModel?.coreModel
  const out = new Set()
  if (core) {
    try {
      const ids = core._parameterIds ?? []
      for (const id of ids) out.add(String(id))
    } catch { /* 私有字段变了就算了 */ }
    try {
      const count = typeof core.getParameterCount === 'function' ? core.getParameterCount() : 0
      for (let i = 0; i < count; i += 1) {
        const id = core.getParameterId?.(i)
        if (id) out.add(String(id))
      }
    } catch { /* 没有这组 API */ }
  }
  modelParams = out
  // 把这只模型真实有的参数报给宿主：AI 设计新动作前先看它，别写不存在的参数名
  report({ type: 'state', phase: 'model-params', count: out.size, params: [...out].slice(0, 300) })
  // 每个动作在这个模型上能落到几轨（缺的全跳），设置页据此把「做不了」的试玩按钮置灰
  try {
    report({ type: 'state', phase: 'model-capability', actions: computeActionSupport() })
  } catch { /* 只影响提示 */ }
  // 纹理健康：多纹理模型（如 5×4096）某张上传失败时，对应区域会渲染成黑色。
  // pixi-live2d-display 的纹理挂在 model.textures（internalModel.textures 这个版本没有）。
  try {
    const raw = model?.textures ?? []
    const list = []
    for (let i = 0; i < (raw?.length ?? 0); i += 1) {
      const tex = raw[i]
      const base = tex?.baseTexture ?? tex
      list.push({
        i,
        valid: base?.valid === true,
        failed: base?.valid === false,
        w: base?.width ?? 0,
        h: base?.height ?? 0,
      })
    }
    const manager = model?.internalModel?.textureManager
    const managerCount = Array.isArray(manager?.textures) ? manager.textures.length : null
    const gl = app?.renderer?.gl
    const maxTextureSize = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : null
    report({
      type: 'state',
      phase: 'model-textures',
      count: list.length,
      managerCount,
      maxTextureSize,
      list,
    })
  } catch { /* 只影响诊断 */ }
  return out
}

function computeActionSupport() {
  const collect = (id, tracks) => {
    const list = Array.isArray(tracks) ? tracks : []
    const known = list.filter((track) => resolveParam(track?.id ?? track?.param))
    return { id, total: list.length, usable: known.length, missing: list.length - known.length }
  }
  const out = []
  for (const [id, anim] of Object.entries(ANIMS)) out.push(collect(id, anim?.tracks))
  for (const [id, def] of customActions) out.push(collect(id, def?.tracks))
  return out
}

function resolveParam(name) {
  const raw = String(name ?? '')
  if (!raw) return null
  if (modelParams.has(raw)) return raw
  for (const candidate of PARAM_ALIASES[raw] ?? []) {
    if (modelParams.has(candidate)) return candidate
  }
  return null
}

function compileCustomAction(def) {
  const tracks = []
  for (const track of def?.tracks ?? []) {
    const id = resolveParam(track?.param)
    if (!id) continue // 这只模型没有这个参数：静默跳过，不影响其它轨道
    tracks.push({ id, keys: track.keys })
  }
  return { duration: Math.max(200, Number(def?.durationMs) || 1000), tracks }
}

let animState = null
let paramHookInstalled = false

function sampleKeys(keys, t) {
  if (!keys.length) return 0
  if (t <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i += 1) {
    const [t1, v1] = keys[i]
    const [t0, v0] = keys[i - 1]
    if (t <= t1) {
      const span = t1 - t0 || 1
      const k = (t - t0) / span
      // smoothstep：起点终点都停一下，看起来不像机器人在抽
      const e = k * k * (3 - 2 * k)
      return v0 + (v1 - v0) * e
    }
  }
  return keys[keys.length - 1][1]
}

function applyAnimParams() {
  if (!animState) return
  const { core, tracks, duration, startedAt } = animState
  const t = duration > 0 ? Math.min(1, (performance.now() - startedAt) / duration) : 1
  for (const track of tracks) {
    try { core.setParameterValueById(track.id, sampleKeys(track.keys, t)) } catch { /* 参数不存在 */ }
  }
  if (t >= 1) {
    const done = animState.action
    animState = null
    report({ type: 'anim-done', action: done })
  }
}

/** 挂到 coreModel.update 前：保证写的参数在同一帧生效。 */
function installParamHook() {
  if (paramHookInstalled) return
  const core = model?.internalModel?.coreModel
  if (!core || typeof core.update !== 'function') return
  const original = core.update.bind(core)
  let frames = 0
  let lastReport = 0
  core.update = (...args) => {
    frames += 1
    let writeOk = null
    let readBack = null
    try { applyAnimParams() } catch { /* 参数写失败不影响出画 */ }
    try { if (!animState) applyMotionParams(core) } catch { /* 动态效果失败不影响出画 */ }
    try {
      applyTalkingParams(core)
      if (speaking.active) {
        writeOk = true
        try { readBack = core.getParameterValueById('ParamMouthOpenY') } catch { readBack = 'read-failed' }
      }
    } catch (error) {
      writeOk = String(error && error.message)
    }
    // 每 500ms 报一次口型诊断：active / 帧数 / 写入是否抛错 / 写后读回值
    if (speaking.active && performance.now() - lastReport > 500) {
      lastReport = performance.now()
      report({
        type: 'state', phase: 'talking',
        active: speaking.active, frames, writeOk, readBack,
        hookInstalled: paramHookInstalled,
        sameCore: model?.internalModel?.coreModel === core,
      })
    }
    return original(...args)
  }
  paramHookInstalled = true
}

/**
 * 把一条动作按 repeat 展开成多次：第 i 段的 t ∈ [0,1] 映射到 i/n ~ (i+1)/n。
 * 关键帧末尾都回到 0，所以段与段之间天然衔接。
 */
function expandAnimTracks(tracks, repeat) {
  const n = Math.max(1, Math.min(6, Math.round(Number(repeat) || 1)))
  if (n === 1) return tracks
  const out = []
  for (const track of tracks) {
    const keys = []
    for (let i = 0; i < n; i += 1) {
      for (const [t, v] of track.keys) {
        keys.push([Math.min(1, (i + t) / n), v])
      }
    }
    out.push({ id: track.id, keys })
  }
  return out
}

function playAnimation(action, override = null) {
  const custom = customActions.get(action)
  const anim = override ?? ANIMS[action] ?? (custom ? compileCustomAction(custom) : null)
  const core = model?.internalModel?.coreModel
  if (!anim || !core) return false
  if (action === 'idle' || anim.duration === 0) {
    animState = null
    report({ type: 'anim-done', action })
    return true
  }
  animState = {
    action,
    core,
    tracks: expandAnimTracks(anim.tracks, anim.repeat),
    duration: anim.duration,
    startedAt: performance.now(),
  }
  return true
}

async function renderModel(modelInfo) {
  await ensureVendor()
  destroyModel()

  const W = window.innerWidth || 320
  const H = window.innerHeight || 420
  if (!app) {
    app = new window.PIXI.Application({
      view: els.stage,
      width: W,
      height: H,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: false,
      resolution: 1,
    })
  } else {
    app.renderer.resize(W, H)
  }

  const entryFile = modelInfo.entryFile || (modelInfo.entry ? modelInfo.entry.split(/[\\/]/).pop() : null)
  if (!entryFile) throw new Error('init 里没有 model.entryFile')
  const url = `live2d-asset://${currentInstanceId}/${encodeURIComponent(entryFile)}`
  report({ type: 'state', phase: 'loading-asset', url })

  model = await window.PIXI.live2d.Live2DModel.from(url, { autoInteract: false })
  app.stage.addChild(model)
  fitModel()
  hidePlaceholder()
  installParamHook()
  detectModelParams()
  // 待机浮动挂一次即可（app 复用；tickFloat 内部自己判断 model 是否存在）
  if (!app.ticker._live2dFloat) {
    app.ticker._live2dFloat = true
    app.ticker.add(tickFloat)
  }

  report({
    type: 'state',
    phase: 'rendering',
    model: {
      entry: modelInfo.entry ?? null,
      entryFile,
      width: Math.round(model.width),
      height: Math.round(model.height),
      format: modelInfo.format ?? 'cubism4',
    },
  })
}

// --- 预设动作：右键菜单（动作立刻播放 / 循环开关）---------------------------

let menuOpen = false

function applyPresets(presets) {
  const value = presets ?? {}
  settings.presets = value
  customActions = new Map()
  for (const item of value.actions ?? []) {
    if (item?.kind === 'custom' && item.id && Array.isArray(item.tracks)) customActions.set(item.id, item)
  }
  renderPresetMenu()
}

function menuRow(dataset, label, tag) {
  const row = document.createElement('div')
  row.className = 'menu-item'
  Object.assign(row.dataset, dataset)
  const text = document.createElement('span')
  text.textContent = label
  row.appendChild(text)
  if (tag) {
    const hint = document.createElement('span')
    hint.className = 'tag'
    hint.textContent = tag
    row.appendChild(hint)
  }
  return row
}

function renderPresetMenu() {
  const menu = els.presetMenu
  if (!menu) return
  const actions = settings.presets?.actions ?? []
  const sequences = settings.presets?.sequences ?? []
  const active = settings.presets?.activeSequence ?? null
  menu.textContent = ''
  if (!actions.length && !sequences.length) {
    const empty = document.createElement('div')
    empty.className = 'menu-title'
    empty.textContent = '还没有预设动作（设置页可添加）'
    menu.appendChild(empty)
    return
  }
  if (actions.length) {
    const title = document.createElement('div')
    title.className = 'menu-title'
    title.textContent = '动作'
    menu.appendChild(title)
    for (const item of actions) {
      menu.appendChild(menuRow({ action: item.id }, item.label || item.id, item.kind === 'custom' ? '自定义' : ''))
    }
  }
  if (sequences.length) {
    const sep = document.createElement('div')
    sep.className = 'menu-sep'
    menu.appendChild(sep)
    const title = document.createElement('div')
    title.className = 'menu-title'
    title.textContent = '循环'
    menu.appendChild(title)
    for (const seq of sequences) {
      const running = active === seq.id
      menu.appendChild(menuRow({ sequence: seq.id }, seq.label || seq.id, running ? '停止' : `${(seq.steps ?? []).length} 步`))
    }
  }
}

function openPresetMenu(x, y) {
  const menu = els.presetMenu
  if (!menu) return
  renderPresetMenu()
  menu.classList.remove('hidden')
  menu.style.left = '0px'
  menu.style.top = '0px'
  const rect = menu.getBoundingClientRect()
  const maxX = Math.max(4, window.innerWidth - rect.width - 4)
  const maxY = Math.max(4, window.innerHeight - rect.height - 4)
  menu.style.left = `${Math.max(4, Math.min(x, maxX))}px`
  menu.style.top = `${Math.max(4, Math.min(y, maxY))}px`
  menuOpen = true
  // 菜单要能点：菜单打开期间强制关闭穿透，收起后再交回原来的判定
  api.setIgnoreMouse(false)
}

function closePresetMenu() {
  const menu = els.presetMenu
  if (!menu || menu.classList.contains('hidden')) return
  menu.classList.add('hidden')
  menuOpen = false
}

function bindPresetMenu() {
  document.addEventListener('contextmenu', (event) => {
    const target = event.target
    if (target?.closest?.('#composer, #reply, input, textarea')) return // 输入框保留系统菜单
    event.preventDefault()
    openPresetMenu(event.clientX, event.clientY)
  })
  document.addEventListener('mousedown', (event) => {
    if (!menuOpen) return
    if (event.target?.closest?.('#preset-menu')) return
    closePresetMenu()
  })
  els.presetMenu?.addEventListener('click', (event) => {
    const row = event.target?.closest?.('.menu-item')
    if (!row) return
    const action = row.dataset.action
    const sequence = row.dataset.sequence
    closePresetMenu()
    if (action) report({ type: 'preset-play', action })
    if (sequence) report({ type: 'preset-sequence', id: sequence })
  })
}

async function handleInit(command) {  const config = command.config ?? {}
  settings.durationMs = Number(config.bubbleDurationMs) || 5000
  settings.queueLimit = Number(config.bubbleQueueLimit) || 3
  settings.maxChars = Number(config.bubbleMaxChars) || 120
  settings.clickThrough = config.clickThrough !== false
  settings.modelPassthrough = config.modelPassthrough === true
  syncPassthroughButton()
  settings.rendererEnabled = command.model?.ok === true && config.rendererEnabled !== false
  settings.replyStyle = config.replyStyle === 'card' ? 'card' : 'bubble'
  settings.chatTimeoutMs = Number(config.chatTimeoutMs) || 90000
  settings.replyFontSize = Number(config.replyFontSize) || 15
  settings.replyMaxHeightPct = Number(config.replyMaxHeightPct) || 45
  settings.replyHeightRatio = clampPct(config.replyHeightRatio, 20, 100, 50)
  settings.bubbleFixedSize = config.bubbleFixedSize === true
  settings.bubbleHeightPx = clampPct(config.bubbleHeightPx, 80, 900, 200)
  settings.modelScalePct = clampPct(config.modelScalePct, 50, 200, 100)
  settings.modelLayoutMode = config.modelLayoutMode === 'zoom-overlay' ? 'zoom-overlay' : 'fit'
  settings.idleFloat = config.idleFloat !== false
  settings.lookFollow = config.lookFollow !== false
  settings.dragInertia = config.dragInertia !== false
  settings.motionStrength = clampPct(config.motionStrength, 1, 100, 60)
  settings.autoInteract = config.autoInteract !== false
  settings.idlePresets = config.idlePresets !== false
  // 0.13.0：模式与唤醒状态（工具栏按钮）
  settings.mode = MODE_ORDER.includes(config.mode) ? config.mode : 'auto'
  settings.wakeEnabled = config.wakeEnabled === true
  settings.wakeBusy = config.wakeBusy === true
  applyPresets(config.presets)
  applyReplyOpacity(config.replyOpacity)
  applyReplyStyle()
  setAdjustMode(config.adjustMode === true)
  syncModeButton()
  syncPinButton(config.pinned !== false)

  if (command.model?.ok !== true) {
    const detail = reasonText(command.model)
    showPlaceholder('模型不可用', detail)
    report({ type: 'state', phase: 'placeholder', error: detail })
    return
  }
  if (config.rendererEnabled === false) {
    showPlaceholder('渲染已关闭', 'rendererEnabled=false（设置页可打开）')
    report({ type: 'state', phase: 'placeholder', error: 'renderer-disabled' })
    return
  }

  try {
    await renderModel(command.model)
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    showPlaceholder('渲染失败', message)
    report({ type: 'state', phase: 'placeholder', error: message })
  }
}

// --- 气泡（阶段 2 起统一走顶部回答区，和窗口对话同一条路）-----------------

let lastSeq = 0

function showBubble(command) {
  const seq = Number(command.seq) || 0
  if (seq && seq <= lastSeq) return
  if (seq) lastSeq = seq

  // 长度由宿主统一负责（cleanBubbleText 已按 2000 字清洗）；渲染层只保留一个安全上限，
  // 不能再复用面向短测试气泡的 bubbleMaxChars——那会把自动长回复截成 120 字，永远不溢出。
  const text = String(command.text ?? '').slice(0, MAX_RENDERED_BUBBLE_CHARS)
  if (!text) return

  const durationMs = Number(command.durationMs)
  const speechPending = command.speechPending === true
  // 语音待合成：durationMs 传 0，气泡先上屏但先不消失，等 speech/speech-failed 接管
  const autoHideMs = speechPending ? 0 : (durationMs || settings.durationMs)
  // 和「窗口对话」的回复完全同一条渲染路径：模型头顶上方、底边固定、到点淡出
  const item = showReply(text, {
    style: settings.replyStyle,
    autoHideMs,
    seq: seq || null,
    format: command.format === 'markdown' ? 'markdown' : 'text',
  })
  // 语音还在合成：给气泡一个小标记，用户知道马上会说话
  if (speechPending && item) item.classList.add('speech-pending')
  report({ type: 'bubble-shown', seq })
}

// --- 命令分发 -------------------------------------------------------------

async function handleCommand(command) {
  if (!command || typeof command !== 'object') return
  if (typeof command.instanceId === 'string' && command.instanceId) currentInstanceId = command.instanceId
  // 诊断用：让探针能直接打开菜单（生产里只有宿主能发命令，不对外暴露）
  if (command.type === 'debug-menu') {
    if (command.which === 'mode') openModeMenu()
    else if (command.which === 'preset') openPresetMenu(Number(command.x) || 40, Number(command.y) || 40)
    return
  }
  // sessionId 显式给了就更新（null / 空串 = 解绑）；没给则保持上一次的值
  if (Object.prototype.hasOwnProperty.call(command, 'sessionId')) {
    currentSessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
  }
  // title 只在非空时覆盖已知标题；空 title 往往是「宿主还没解析到」，
  // 不能把上一个标题冲掉，更不能退化成「会话 <编号>」。
  const hasTitle = typeof command.title === 'string' && command.title.trim() !== ''
  if (hasTitle) {
    setInstanceTitle(command.title)
  } else if (!els.instanceTitle.textContent.trim() || els.instanceTitle.textContent.includes('未绑定')) {
    // 还没有任何可用标题（或之前是未绑定）才用过渡文案
    setInstanceTitle(undefined)
  } else if (currentSessionId) {
    els.chatInput.placeholder = '和她说点什么…'
  }
  // 主进程在「窗口穿透」时按光标位置喂坐标：穿透状态下页面的 mousemove 不一定能到，
  // 靠这条通道保证鼠标移进模型/输入栏时能立刻接管。
  if (command.type === 'pointer-probe') {
    if (!drag) handlePointerMove(Number(command.x) || 0, Number(command.y) || 0)
    return
  }
  // 主进程发现鼠标被拖出窗口（收不到 mouseup）：结束拖动，避免卡在 dragging
  if (command.type === 'cancel-drag') {
    if (drag) {
      const final = drag.last ?? drag.start
      drag = null
      els.adjustMove?.classList.remove('dragging')
      try { api.report({ type: 'drag', active: false }) } catch { /* 忽略 */ }
      if (final) report({ type: 'bounds', bounds: final })
      scheduleHideAdjust()
    }
    return
  }
  if (command.type === 'init') {
    await handleInit(command)
    return
  }
  if (command.type === 'bubble') {
    showBubble(command)
    return
  }
  if (command.type === 'repaint') {
    try {
      if (app) {
        app.renderer.resize(window.innerWidth || 1, window.innerHeight || 1)
        app.renderer.render(app.stage)
      }
    } catch { /* 设备丢失时由下一帧 ticker 继续尝试 */ }
    return
  }
  if (command.type === 'reply') {
    handleReply(command)
    return
  }
  if (command.type === 'chat-ack') {
    handleChatAck(command)
    return
  }
  if (command.type === 'walk') {
    // 宿主在平滑移动窗口前发这条：让模型点个头、上下起伏一下，像被拖着走
    walkUntil = performance.now() + Math.max(120, Math.min(1200, Number(command.ms) || 360))
    walkPhase = 0
    return
  }
  if (command.type === 'thinking') {
    showThinking(command.on === true)
    return
  }
  if (command.type === 'chat-status') {
    handleChatStatus(command)
    return
  }
  if (command.type === 'anim') {
    const raw = String(command.action || 'idle').toLowerCase()
    playAnimation(ANIM_ALIASES[raw] || raw)
    return
  }
  if (command.type === 'say') {
    playAudio(command.audioBase64, command.mime)
    return
  }
  if (command.type === 'speech') {
    handleSpeech(command)
    return
  }
  if (command.type === 'speech-failed') {
    handleSpeechFailed(command)
    return
  }
  if (command.type === 'debug-rects') {
    // 诊断：谁盖住了置顶/关闭按钮？把各层矩形与命中的元素报回去。
    const rect = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        z: cs.zIndex,
        pe: cs.pointerEvents,
        display: cs.display,
        opacity: cs.opacity,
      }
    }
    const hitAt = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return target ? { tag: target.tagName, id: target.id || null, cls: target.className || null } : null
    }
    report({
      type: 'debug-rects',
      id: command.id ?? null,
      info: {
        adjustMode: settings.adjustMode,
        ignore: ignoringMouse,
        inner: { w: window.innerWidth, h: window.innerHeight },
        toolbar: rect(els.pin ? els.pin.parentElement : null),
        pin: rect(els.pin),
        close: rect(els.close),
        adjust: rect(els.adjust),
        adjustMove: rect(els.adjustMove),
        hitPinCenter: hitAt(els.pin),
        hitCloseCenter: hitAt(els.close),
        modelRect: (() => {
          if (!model) return null
          try {
            const b = model.getBounds()
            return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
          } catch { return null }
        })(),
      },
    })
    return
  }
  if (command.type === 'config') {
    const patch = command.patch ?? {}
    if (Number.isFinite(patch.bubbleDurationMs)) settings.durationMs = patch.bubbleDurationMs
    if (Number.isFinite(patch.bubbleQueueLimit)) settings.queueLimit = patch.bubbleQueueLimit
    if (Number.isFinite(patch.bubbleMaxChars)) settings.maxChars = patch.bubbleMaxChars
    if (typeof patch.clickThrough === 'boolean') settings.clickThrough = patch.clickThrough
    if (typeof patch.modelPassthrough === 'boolean') {
      settings.modelPassthrough = patch.modelPassthrough
      syncPassthroughButton()
      setIgnore(!isInteractiveAt(pointer.x, pointer.y))
    }
    if (typeof patch.adjustMode === 'boolean') setAdjustMode(patch.adjustMode)
    if (patch.presets && typeof patch.presets === 'object') applyPresets(patch.presets)
    if (patch.replyStyle === 'card' || patch.replyStyle === 'bubble') settings.replyStyle = patch.replyStyle
    if (Number.isFinite(patch.replyOpacity)) applyReplyOpacity(patch.replyOpacity)
    if (Number.isFinite(patch.chatTimeoutMs)) settings.chatTimeoutMs = patch.chatTimeoutMs
    if (Number.isFinite(patch.replyFontSize) || Number.isFinite(patch.replyMaxHeightPct) || Number.isFinite(patch.replyHeightRatio) ||
        typeof patch.bubbleFixedSize === 'boolean' || Number.isFinite(patch.bubbleHeightPx)) {
      if (Number.isFinite(patch.replyFontSize)) settings.replyFontSize = patch.replyFontSize
      if (Number.isFinite(patch.replyMaxHeightPct)) settings.replyMaxHeightPct = patch.replyMaxHeightPct
      if (Number.isFinite(patch.replyHeightRatio)) settings.replyHeightRatio = clampPct(patch.replyHeightRatio, 20, 100, 50)
      if (typeof patch.bubbleFixedSize === 'boolean') settings.bubbleFixedSize = patch.bubbleFixedSize
      if (Number.isFinite(patch.bubbleHeightPx)) settings.bubbleHeightPx = clampPct(patch.bubbleHeightPx, 80, 900, 200)
      fitModel() // 固定气泡会改变模型可用空间，需要重排
      applyReplyStyle()
    }
    // 0.13.0：模式 / 唤醒状态变化（宿主 patch 后回推）
    if (patch.mode === 'manual' || patch.mode === 'semi' || patch.mode === 'auto') {
      settings.mode = patch.mode
      syncModeButton()
    }
    if (typeof patch.wakeEnabled === 'boolean' || typeof patch.wakeBusy === 'boolean') {
      if (typeof patch.wakeEnabled === 'boolean') settings.wakeEnabled = patch.wakeEnabled
      if (typeof patch.wakeBusy === 'boolean') settings.wakeBusy = patch.wakeBusy
      syncModeButton()
    }
    if (typeof patch.pinned === 'boolean') syncPinButton(patch.pinned)
    // 模型缩放 / 布局模式：改完立即重排（不需要关窗重开）
    if (Number.isFinite(patch.modelScalePct) || patch.modelLayoutMode === 'fit' || patch.modelLayoutMode === 'zoom-overlay') {
      if (Number.isFinite(patch.modelScalePct)) settings.modelScalePct = clampPct(patch.modelScalePct, 50, 200, 100)
      if (patch.modelLayoutMode === 'fit' || patch.modelLayoutMode === 'zoom-overlay') settings.modelLayoutMode = patch.modelLayoutMode
      fitModel()
    }
    // 动态效果开关/幅度：立即生效（浮动由 ticker 读，视线与惯性由 paramHook 读）
    if (typeof patch.idleFloat === 'boolean') settings.idleFloat = patch.idleFloat
    if (typeof patch.lookFollow === 'boolean') settings.lookFollow = patch.lookFollow
    if (typeof patch.dragInertia === 'boolean') settings.dragInertia = patch.dragInertia
    if (Number.isFinite(patch.motionStrength)) settings.motionStrength = clampPct(patch.motionStrength, 1, 100, 60)
    if (typeof patch.idleFloat === 'boolean' && !patch.idleFloat && model) model.y = baseModelY
    if (Number.isFinite(patch.windowWidth) && Number.isFinite(patch.windowHeight)) {
      app?.renderer?.resize(patch.windowWidth, patch.windowHeight)
      fitModel()
    }
    return
  }
  if (command.type === 'reload') {
    if (!command.model || command.model.ok !== true) {
      destroyModel()
      const detail = reasonText(command.model)
      showPlaceholder('模型不可用', detail)
      report({ type: 'state', phase: 'placeholder', error: detail })
      return
    }
    try {
      await renderModel(command.model)
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      showPlaceholder('渲染失败', message)
      report({ type: 'state', phase: 'placeholder', error: message })
    }
  }
}

// --- 阶段 2：窗口内对话 ---------------------------------------------------

let chatBusy = false
let chatRequestId = null
let chatTimer = null
let loadingEl = null
// 渲染层兜底上限：宿主已按 2000 字清洗，这里只防异常大包，不参与业务截断
const MAX_RENDERED_BUBBLE_CHARS = 2000

function clearLoading() {
  if (loadingEl) {
    loadingEl.remove()
    loadingEl = null
  }
}

function setChatBusy(busy) {
  chatBusy = busy
  if (els.chatSend) els.chatSend.disabled = busy
  if (els.chatInput) els.chatInput.disabled = busy
}

let replyOpacity = 0.9

function applyReplyOpacity(value) {
  const next = Number(value)
  replyOpacity = Number.isFinite(next) ? Math.min(1, Math.max(0.3, next)) : 0.9
  document.documentElement.style.setProperty('--reply-opacity', String(replyOpacity))
}

/** 字号与回答区最大高度（超过就在气泡内部滚动）。 */
function applyReplyStyle() {
  const size = Math.min(24, Math.max(12, Number(settings.replyFontSize) || 15))
  // 气泡最大高度 = 模型高度 × replyHeightRatio%（不再是「窗口高度的百分之几」）：
  // 模型多大，气泡就按比例多大；拖动窗口把模型放大时，气泡跟着按比例放大。
  const ratio = Math.min(100, Math.max(20, Number(settings.replyHeightRatio) || 50)) / 100
  // 用像素而不是 vh：可用高度由「气泡底边到窗口顶部」决定。
  // 注意不能用 els.reply.clientHeight —— 它是内容高度（已被 max-height 卡住）。
  const H = window.innerHeight || 420
  const bottom = Number.parseInt(
    getComputedStyle(document.documentElement).getPropertyValue('--reply-bottom'),
    10,
  ) || Math.round(H * 0.6)
  const available = Math.max(80, H - bottom - 8)
  // 气泡实际可用高度：固定模式取设置值，动态模式取「窗口剩余高度」（fitModel 已算好）
  const wanted = settings.bubbleFixedSize
    ? clampNum(settings.bubbleHeightPx ?? 200, 80, 900)
    : (state.bubblePx || Math.round(H * 0.45))
  const maxPx = Math.max(80, Math.min(Math.round(wanted), available))
  document.documentElement.style.setProperty('--reply-font-size', `${size}px`)
  document.documentElement.style.setProperty('--reply-max-height', `${maxPx}px`)
  state.bubblePx = maxPx
  report({ type: 'state', phase: 'reply-style', fontSize: size, maxHeightPx: maxPx, availableHeight: available, fixed: Boolean(settings.bubbleFixedSize) })
}

const replyBySeq = new Map()

/** 按 seq 收起对应气泡（语音读完 / 合成失败 / 兜底定时器都走这里）。 */
function hideReply(seq, delayMs = 0) {
  if (seq === undefined || seq === null) return
  const el = replyBySeq.get(seq)
  if (!el) return
  const remove = () => {
    if (replyBySeq.get(seq) === el) replyBySeq.delete(seq)
    if (!el.isConnected) return
    el.classList.add('leaving')
    setTimeout(() => el.remove(), 280)
  }
  if (delayMs > 0) setTimeout(remove, delayMs)
  else remove()
}

// ---- 唯一的滚动所有者：#reply（容器级）----
// 0.12.4：气泡自身不再滚动（去掉 item 级 max-height/overflow 与 item 级自绘条），
// 角标、滚动条、溢出判定全部读同一个容器，避免「气泡里能滚但角标不显示」。
let replyScroller = null
function ensureReplyScroller() {
  if (replyScroller) return replyScroller
  const bar = document.createElement('div')
  bar.className = 'scrollbar reply-scroller'
  const thumb = document.createElement('div')
  thumb.className = 'thumb'
  bar.appendChild(thumb)
  document.body.appendChild(bar)
  replyScroller = { bar, thumb }
  els.reply?.addEventListener('scroll', () => syncReplyScroller(), { passive: true })
  window.addEventListener('resize', () => syncReplyScroller())
  try { new ResizeObserver(() => syncReplyScroller()).observe(els.reply) } catch { /* 老内核 */ }
  return replyScroller
}

function syncReplyScroller() {
  const s = replyScroller
  if (!s || !els.reply) return
  const el = els.reply
  const max = el.scrollHeight - el.clientHeight
  if (max <= 4) { s.bar.style.display = 'none'; return }
  s.bar.style.display = 'block'
  const rect = el.getBoundingClientRect()
  const trackH = Math.max(60, rect.height - 16)
  s.bar.style.top = `${Math.round(rect.top + 8)}px`
  s.bar.style.height = `${Math.round(trackH)}px`
  s.bar.style.left = `${Math.round(rect.right - 8)}px`
  const h = Math.max(20, Math.round((el.clientHeight / Math.max(1, el.scrollHeight)) * trackH))
  s.thumb.style.height = `${h}px`
  const top = Math.round((el.scrollTop / max) * Math.max(0, trackH - h))
  s.thumb.style.transform = `translateY(${top}px)`
}

/** 右下角「↕ 还有约 N 字」：唯一来源是 #reply 的溢出口径 */
/**
 * 极简 Markdown → DOM：只用 createElement / textContent，绝不拼 innerHTML，
 * 因此原始 HTML（<script>、onerror 等）天然只会显示成文字，不存在注入面。
 * 支持：标题(h1~h3)、段落、有序/无序列表、引用、代码块、行内代码、加粗、斜体、分隔线。
 * 解析失败/空内容 → 回退成纯文本，不会显示空白气泡。
 */
function renderMarkdown(container, text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n')
  container.textContent = ''
  const lines = source.split('\n')
  let list = null
  let listType = ''
  let inFence = false
  let fenceLines = []

  const flushList = () => { list = null; listType = '' }

  const appendInline = (parent, rawText) => {
    // 链接只显示文字（外链不加载）；图片标记直接丢掉
    const raw = String(rawText)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g
    let last = 0
    let m
    while ((m = re.exec(raw))) {
      if (m.index > last) parent.appendChild(document.createTextNode(raw.slice(last, m.index)))
      const token = m[0]
      if (token.startsWith('`')) {
        const code = document.createElement('code')
        code.textContent = token.slice(1, -1)
        parent.appendChild(code)
      } else if (token.startsWith('**')) {
        const strong = document.createElement('strong')
        strong.textContent = token.slice(2, -2)
        parent.appendChild(strong)
      } else {
        const em = document.createElement('em')
        em.textContent = token.slice(1, -1)
        parent.appendChild(em)
      }
      last = m.index + token.length
    }
    if (last < raw.length) parent.appendChild(document.createTextNode(raw.slice(last)))
  }

  try {
    for (const line of lines) {
      if (line.trim().startsWith('```')) {
        if (inFence) {
          const pre = document.createElement('pre')
          const code = document.createElement('code')
          code.textContent = fenceLines.join('\n')
          pre.appendChild(code)
          container.appendChild(pre)
          fenceLines = []
          inFence = false
        } else {
          flushList()
          inFence = true
        }
        continue
      }
      if (inFence) { fenceLines.push(line); continue }

      const trimmed = line.trim()
      if (!trimmed) { flushList(); continue }

      const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
      if (heading) {
        flushList()
        // 小窗口里 H1 也不能太大，最多到 h3
        const el = document.createElement(`h${Math.min(3, heading[1].length)}`)
        appendInline(el, heading[2])
        container.appendChild(el)
        continue
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        flushList()
        container.appendChild(document.createElement('hr'))
        continue
      }
      const quote = /^>\s?(.*)$/.exec(trimmed)
      if (quote) {
        flushList()
        const el = document.createElement('blockquote')
        appendInline(el, quote[1])
        container.appendChild(el)
        continue
      }
      const ul = /^[-*+]\s+(.*)$/.exec(trimmed)
      const ol = /^\d+[.)]\s+(.*)$/.exec(trimmed)
      if (ul || ol) {
        const type = ul ? 'ul' : 'ol'
        if (!list || listType !== type) {
          list = document.createElement(type)
          listType = type
          container.appendChild(list)
        }
        const li = document.createElement('li')
        appendInline(li, (ul || ol)[1])
        list.appendChild(li)
        continue
      }
      flushList()
      const p = document.createElement('p')
      appendInline(p, trimmed)
      container.appendChild(p)
    }
    // 未闭合的围栏也要显示出来，不能吞内容
    if (inFence && fenceLines.length) {
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      code.textContent = fenceLines.join('\n')
      pre.appendChild(code)
      container.appendChild(pre)
    }
  } catch {
    container.textContent = source
    return
  }
  if (!container.firstChild) container.textContent = source
}

function updateMoreBadge(text, overflow) {  if (!els.reply) return
  let badge = els.reply.querySelector('.more-badge')
  if (overflow <= 4) { badge?.remove(); return }
  if (!badge) {
    badge = document.createElement('div')
    badge.className = 'more-badge'
    els.reply.appendChild(badge)
  }
  const ratio = els.reply.clientHeight / Math.max(1, els.reply.scrollHeight)
  const more = Math.max(1, Math.round(String(text).length * (1 - ratio)))
  badge.textContent = `↕ 还有约 ${more} 字`
  els.reply.appendChild(badge) // sticky 需要它是滚动容器的最后一个子元素
}

function showReply(text, { style = 'bubble', error = false, loading = false, autoHideMs = 0, seq = null, format = 'text' } = {}) {
  if (!els.reply) return null
  // 长回答才把模型压小让出空间；短气泡不预留，模型保持大
  setReplyMode(text)
  const item = document.createElement('div')
  item.className = `reply-item ${style === 'card' ? 'card' : 'bubble-style'}${error ? ' error' : ''}${loading ? ' loading' : ''}`
  if (format === 'markdown') renderMarkdown(item, text)
  else item.textContent = text
  const wrap = document.createElement('div')
  wrap.className = 'reply-wrap'
  wrap.appendChild(item)
  els.reply.appendChild(wrap)
  if (seq !== null && seq !== undefined) replyBySeq.set(seq, wrap)
  // 只保留最近几条（用设置里的 bubbleQueueLimit，别再硬编码）
  const keep = Math.min(10, Math.max(1, Number(settings.queueLimit) || 3))
  while (els.reply.querySelectorAll('.reply-wrap').length > keep) {
    els.reply.querySelector('.reply-wrap')?.remove()
  }
  // 长文从开头读，别一上来就滚到结尾
  els.reply.scrollTop = 0
  // 唯一滚动所有者是 #reply：气泡自身不滚动，角标/滚动条/溢出判定都读同一个容器。
  // 元素刚插入时布局还没算完，同步读 scrollHeight/clientHeight 会拿到 0 → 必须双 rAF 再量。
  const measure = () => {
    try {
      if (!item.isConnected) return
      let overflow = els.reply.scrollHeight - els.reply.clientHeight
      // 预判是 short 但实际溢出了（富文本的标题/列表/代码块高度和字符数不成正比）：
      // 切到 long 让模型让出空间，再量一次。
      if (overflow > 4 && replyMode === 'short') {
        setReplyMode('long')
        requestAnimationFrame(() => requestAnimationFrame(measure))
        return
      }
      updateMoreBadge(item.textContent, overflow)
      const scroller = ensureReplyScroller()
      syncReplyScroller()
      const computed = getComputedStyle(item)
      report({
        type: 'state',
        phase: 'reply-metrics',
        mode: replyMode,
        chars: String(text).length,
        renderedChars: item.textContent.length,
        maxHeight: computed.maxHeight,
        height: els.reply.clientHeight,
        scrollHeight: els.reply.scrollHeight,
        overflowing: overflow > 4,
        scrollbarVisible: !!scroller && scroller.bar.style.display === 'block',
        fontSize: computed.fontSize,
      })
    } catch { /* 只影响诊断 */ }
  }
  requestAnimationFrame(() => requestAnimationFrame(measure))
  // 和底部短气泡一致：按 bubbleDurationMs 自动淡出（有 seq 的走 hideReply，语音读完也能收）
  if (autoHideMs > 0) {
    setTimeout(() => {
      if (seq !== null && seq !== undefined) { hideReply(seq); return }
      if (!wrap.isConnected) return
      wrap.classList.add('leaving')
      setTimeout(() => wrap.remove(), 280)
    }, autoHideMs)
  }
  return item
}

/** 语音到了：播放；读完/出错/兜底超时 → 收起同 seq 的气泡（长文留着让人继续读）。 */
function handleSpeech(command) {
  const seq = command.seq
  const el = replyBySeq.get(seq)
  if (el) {
    el.querySelector('.reply-item')?.classList.remove('speech-pending')
    // 只朗读前 500 字：在角标上直接说清楚，别让用户以为整段都有声
    if (command.truncated === true) {
      const badge = document.createElement('div')
      badge.className = 'more-badge speech-truncated'
      badge.textContent = `语音仅前 ${Number(command.spokenChars) || 500} 字`
      el.appendChild(badge)
    }
  }
  const audio = playAudio(command.audioBase64, command.mime)
  if (!audio) { hideReply(seq, settings.durationMs); return }
  const keepMs = Number(command.keepReadingMs) || 0
  const finish = () => {
    speaking.active = false
    // 长回答读完后不要立刻删：留一段时间让用户自己滚着看完
    hideReply(seq, keepMs > 0 ? keepMs : 0)
  }
  audio.addEventListener('ended', finish, { once: true })
  audio.addEventListener('error', finish, { once: true })
  const fallbackMs = Number(command.durationMs) || 0
  if (fallbackMs > 0) setTimeout(() => { speaking.active = false; hideReply(seq, keepMs > 0 ? keepMs : 0) }, fallbackMs + 1500)
}

/** 合成失败：气泡退回固定时长，别让它永远挂着。 */
function handleSpeechFailed(command) {
  const el = replyBySeq.get(command.seq)
  if (el) el.querySelector('.reply-item')?.classList.remove('speech-pending')
  hideReply(command.seq, settings.durationMs)
}

function finishChat() {
  clearLoading()
  setChatBusy(false)
  chatRequestId = null
  if (chatTimer) { clearTimeout(chatTimer); chatTimer = null }
}

/**
 * 「思考中…」提示：DSH 主窗口发消息时也会显示（宿主在 agent/status 里推）。
 * 与窗口输入栏自己的 loadingEl 互不干扰：已有 loading 就不再叠一条。
 */
let thinkingEl = null
// 兜底：不管引用还在不在，把带 .thinking 的节点全部摘掉（实测出现过「思考中」一直挂着）
function clearThinkingNodes() {
  try {
    for (const node of document.querySelectorAll('.reply-item.thinking')) {
      const wrap = node.closest('.reply-wrap')
      if (wrap) wrap.remove()
      else node.remove()
    }
  } catch { /* 忽略 */ }
  thinkingEl = null
}
function showThinking(on) {
  if (on === true) {
    clearThinkingNodes()
    if (loadingEl) return
    thinkingEl = showReply('思考中…', { style: settings.replyStyle, loading: true })
    if (thinkingEl) thinkingEl.classList.add('thinking')
    return
  }
  clearThinkingNodes()
}

function submitChatFromWindow() {
  const input = els.chatInput
  if (!input || chatBusy) return
  const text = String(input.value || '').trim()
  if (!text) return
  setChatBusy(true)
  input.value = ''
  loadingEl = showReply('思考中…', { style: settings.replyStyle, loading: true })
  report({ type: 'chat', text })
  if (chatTimer) clearTimeout(chatTimer)
  // 本地兜底比宿主多 10 秒：正常超时由宿主的 chat-ack / reply 决定，
  // 这里只防「宿主没回话」把输入框一直卡住。
  chatTimer = setTimeout(() => {
    clearLoading()
    showReply('等回复超时了，去 DSH 看看会话是不是卡住了', { style: settings.replyStyle, error: true })
    finishChat()
  }, settings.chatTimeoutMs + 10_000)
}

/** 宿主通知「思考超时但还在等」：保留 loading，只换文案。 */
function handleChatStatus(command) {
  if (command.requestId && chatRequestId && command.requestId !== chatRequestId) return
  if (command.phase === 'late' && loadingEl) {
    loadingEl.textContent = '还在思考…（已超过设定时间，等它说完）'
    if (chatTimer) { clearTimeout(chatTimer); chatTimer = null }
  }
  if (command.phase === 'queued-sent') {
    // 排队的那条已经发出：换到新 requestId 继续等回复
    chatRequestId = command.requestId ?? chatRequestId
    if (loadingEl) loadingEl.textContent = '已发出排队的消息，等回复…'
    else loadingEl = showReply('已发出排队的消息，等回复…', { style: settings.replyStyle, loading: true })
  }
  // 宿主判定这一轮结束（气泡可能已由自动/唤醒路径显示）：只负责收掉「思考中」
  if (command.phase === 'done') {
    clearLoading()
    finishChat()
  }
}

function handleChatAck(command) {
  if (command.ok) {
    if (command.queued) {
      // 绑定会话还没打开：不进入 loading，给一条提示；激活后由宿主自动发出
      clearLoading()
      showReply(command.text || '消息已排队：等这个对话打开后自动发出', { style: settings.replyStyle, autoHideMs: 6000 })
      finishChat()
      return
    }
    chatRequestId = command.requestId ?? null
    return
  }
  clearLoading()
  showReply(command.error || '发送失败', { style: settings.replyStyle, error: true })
  finishChat()
}

function handleReply(command) {
  if (command.requestId && chatRequestId && command.requestId !== chatRequestId) return
  clearLoading()
  if (Number.isFinite(command.opacity)) applyReplyOpacity(command.opacity)
  const autoHideMs = Number(command.durationMs) || settings.durationMs
  if (command.ok === false) {
    showReply(command.error || '回复失败', { style: settings.replyStyle, error: true, autoHideMs })
  } else {
    showReply(String(command.text ?? ''), {
      style: command.style === 'card' ? 'card' : settings.replyStyle,
      autoHideMs,
      format: command.format === 'markdown' ? 'markdown' : 'text',
    })
  }
  finishChat()
}

els.chatSend?.addEventListener('click', submitChatFromWindow)
els.chatInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submitChatFromWindow()
  }
})

// --- 鼠标穿透（透明区不挡下面的窗口）-------------------------------------

function isInteractiveAt(x, y) {
  const element = document.elementFromPoint(x, y)
  if (element && element.closest('#toolbar, #placeholder, .bubble, #adjust, #composer, #reply, .reply-item, #mode-menu, #preset-menu')) return true
  // 0.13.0：允许「模型区域也穿透」——置顶时不再挡住下面的按钮；代价是此时摸不到模型
  if (settings.modelPassthrough === true) return false
  if (model) {
    try {
      const bounds = model.getBounds()
      if (x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height) {
        return true
      }
    } catch { /* 模型还没起来 */ }
  }
  return false
}

async function setIgnore(next) {
  if (next === ignoringMouse) return
  ignoringMouse = next
  try {
    await api?.setIgnoreMouse?.(next)
  } catch { /* IPC 失败保持原状 */ }
}

// --- 阶段 1.5：调整框（拖四边/四角改大小，拖中间改位置）--------------------

const MIN_ADJUST_W = 160
const MIN_ADJUST_H = 200
let drag = null
// 调整框视觉状态（不持久化）：disabled / idle / hover / dragging / cooldown
// adjustMode 只表示「允许调整」，不再等于「一直显示边框」。
let adjustState = 'disabled'
let adjustHideTimer = null
const ADJUST_HIDE_DELAY_MS = 900
const ADJUST_HOVER_PAD = 16

function setAdjustVisual(visible) {
  els.adjust?.classList.toggle('hidden', !visible)
}

function clearAdjustTimer() {
  if (adjustHideTimer) {
    clearTimeout(adjustHideTimer)
    adjustHideTimer = null
  }
}

function setAdjustState(next) {
  if (!settings.adjustMode) {
    adjustState = 'disabled'
    setAdjustVisual(false)
    return
  }
  adjustState = next
  setAdjustVisual(next === 'hover' || next === 'dragging' || next === 'cooldown')
}

/** 鼠标是否停在「可调整热区」：模型外扩 16px 或窗口四边 10px 内。 */
function adjustHoverHit(x, y) {
  const W = window.innerWidth
  const H = window.innerHeight
  if (x < 10 || y < 10 || x > W - 10 || y > H - 10) return true
  if (!model) return false
  try {
    const b = model.getBounds()
    return x >= b.x - ADJUST_HOVER_PAD && x <= b.x + b.width + ADJUST_HOVER_PAD
      && y >= b.y - ADJUST_HOVER_PAD && y <= b.y + b.height + ADJUST_HOVER_PAD
  } catch {
    return false
  }
}

function scheduleHideAdjust(delay = ADJUST_HIDE_DELAY_MS) {
  if (!settings.adjustMode || drag) return
  clearAdjustTimer()
  setAdjustState('cooldown')
  adjustHideTimer = setTimeout(() => {
    adjustHideTimer = null
    if (drag) return
    setAdjustState('idle')
    // 回到 idle 立刻交回穿透；下一次 mousemove 会重新判定
    setIgnore(true)
  }, delay)
}

function setAdjustMode(on) {
  const next = on === true
  settings.adjustMode = next
  clearAdjustTimer()
  drag = null
  els.adjustMove?.classList.remove('dragging')
  // 工具栏按钮高亮：开着时鼠标在拖窗口，不是摸模型
  els.adjustToggle?.classList.toggle('active', next)
  if (next) {
    // 能力开启后先 idle（不能先闪一下边框），鼠标移入热区才 hover
    setAdjustState('idle')
    syncAdjustMoveRect()
  } else {
    setAdjustState('disabled')
    setIgnore(true)
  }
}

function currentBounds() {
  return {
    x: Math.round(window.screenX ?? window.screenLeft ?? 0),
    y: Math.round(window.screenY ?? window.screenTop ?? 0),
    width: Math.round(window.outerWidth),
    height: Math.round(window.outerHeight),
  }
}

function computeBounds(mode, start, dx, dy) {
  let { x, y, width, height } = start
  if (mode === 'move') {
    x += dx
    y += dy
  } else {
    if (mode.includes('e')) width += dx
    if (mode.includes('w')) { width -= dx; x += dx }
    if (mode.includes('s')) height += dy
    if (mode.includes('n')) { height -= dy; y += dy }
  }
  // 拖动中的下限（宿主侧还有正式的 160×200 ~ 800×1000 clamp）
  width = Math.max(MIN_ADJUST_W, Math.round(width))
  height = Math.max(MIN_ADJUST_H, Math.round(height))
  return { x: Math.round(x), y: Math.round(y), width, height }
}

function beginDrag(event, mode) {
  if (!settings.adjustMode) return
  event.preventDefault()
  event.stopPropagation()
  clearAdjustTimer()
  drag = {
    mode,
    start: currentBounds(),
    startX: event.screenX,
    startY: event.screenY,
    // 记下按下的屏幕内坐标：松手时没移动就当成「点模型」（调整模式下也要能摸头）
    clientX: event.clientX,
    clientY: event.clientY,
    at: performance.now(),
    last: null,
  }
  adjustState = 'dragging'
  setAdjustVisual(true)
  setIgnore(false)
  els.adjustMove?.classList.add('dragging')
  // 告诉主进程「正在拖」：鼠标被拖出窗口时由主进程兜底结束拖动（审查 P1-6）
  try { api.report({ type: 'drag', active: true }) } catch { /* 上报失败不影响拖动 */ }
}

document.querySelectorAll('#adjust .handle').forEach((handle) => {
  handle.addEventListener('mousedown', (event) => beginDrag(event, handle.getAttribute('data-dir') || 'se'))
})
els.adjustMove?.addEventListener('mousedown', (event) => beginDrag(event, 'move'))

/**
 * 统一的指针判定：mousemove 与主进程的 pointer-probe（穿透状态下光标进入窗口）都走这里。
 * 穿透时页面可能收不到 mousemove（Electron 的 forward 并不可靠），所以主进程会主动喂坐标。
 */
function handlePointerMove(x, y) {
  // 视线跟随需要知道指针位置（穿透时由主进程 pointer-probe 喂进来）
  pointer = { x, y, at: performance.now() }
  // 右键菜单 / 模式下拉开着就别穿透：菜单项要能点
  if (menuOpen || modeMenuOpen) {
    setIgnore(false)
    return
  }
  if (settings.adjustMode) {
    const hit = adjustHoverHit(x, y)
    if (hit) {
      if (adjustState !== 'hover') {
        clearAdjustTimer()
        setAdjustState('hover')
        setIgnore(false)
      }
      return
    }
    if (adjustState === 'hover' || adjustState === 'cooldown') {
      scheduleHideAdjust(500)
      return
    }
    // idle：继续往下按命中判定，保证输入栏/按钮可点
  }
  if (!settings.clickThrough) {
    setIgnore(false)
    return
  }
  setIgnore(!isInteractiveAt(x, y))
}

document.addEventListener('mousemove', (event) => {
  if (drag) {
    // 记录拖动速度（px/ms），松手时转成惯性倾斜；坐标是屏幕坐标，窗口跟着动也不影响
    const now = performance.now()
    const dt = Math.max(8, now - (drag.sampleAt || now - 16))
    if (typeof drag.sampleX === 'number') dragVelocity = (event.screenX - drag.sampleX) / dt
    drag.sampleX = event.screenX
    drag.sampleAt = now
    // 记录「按下的位置到现在移动了多远」：松手时 ≤6px 视为点击而不是拖动
    drag.moved = Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY)
    drag.lastClientX = event.clientX
    drag.lastClientY = event.clientY
    const dx = event.screenX - drag.startX
    const dy = event.screenY - drag.startY
    const next = computeBounds(drag.mode, drag.start, dx, dy)
    const last = drag.last
    if (last && last.x === next.x && last.y === next.y && last.width === next.width && last.height === next.height) return
    drag.last = next
    api?.setBounds?.(next)
    return
  }
  handlePointerMove(event.clientX, event.clientY)
})

// 光标离开窗口：交回穿透（拖动中除外，否则拖到窗口外会断）
document.addEventListener('mouseleave', () => {
  if (drag) return
  if (settings.adjustMode) scheduleHideAdjust(300)
  else setIgnore(true)
})

// --- 自动模式预设交互：点模型身体 / 摸头（用户自己点，不算 AI 主动控制） ---
// 命中只在模型可视范围内；头顶 32% 算「摸头」，其余算「戳一下」。
let tapStart = null
function modelHitAt(x, y) {
  if (!model || !app) return null
  const b = model.getBounds()
  if (!b.width || !b.height) return null
  if (x < b.x || x > b.x + b.width || y < b.y || y > b.y + b.height) return null
  return { zone: y <= b.y + b.height * 0.32 ? 'head' : 'body' }
}

document.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || drag) return
  if (event.target.closest('#toolbar, #composer, #reply, #adjust, #instance-title')) return
  const hit = modelHitAt(event.clientX, event.clientY)
  if (!hit) return
  tapStart = { x: event.clientX, y: event.clientY, at: performance.now(), zone: hit.zone }
})

document.addEventListener('pointerup', (event) => {
  if (!tapStart) return
  const start = tapStart
  tapStart = null
  if (drag) return
  if (!settings.autoInteract) return
  const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y)
  if (moved > 6 || performance.now() - start.at > 600) return
  report({ type: 'tap', zone: start.zone })
})

document.addEventListener('mouseup', () => {
  if (!drag) return
  const final = drag.last ?? drag.start
  // 「按下就松手、几乎没移动」= 点模型：调整模式开着也要能把摸头/点击传下去
  const startX = drag.clientX
  const startY = drag.clientY
  const moved = Math.hypot((drag.lastClientX ?? startX) - startX, (drag.lastClientY ?? startY) - startY)
  const isTap = moved <= 6 && performance.now() - (drag.at ?? 0) <= 600
  // 松手瞬间把拖动速度转成头部惯性倾斜（之后指数衰减回中）
  if (settings.dragInertia) inertiaAngle = clampNum(-dragVelocity * 6, -12, 12)
  dragVelocity = 0
  drag = null
  els.adjustMove?.classList.remove('dragging')
  try { api.report({ type: 'drag', active: false }) } catch { /* 忽略 */ }
  if (isTap) {
    const hit = modelHitAt(startX, startY)
    if (hit && settings.autoInteract) report({ type: 'tap', zone: hit.zone })
    // 点一下不改几何，也不写盘；边框照常按空闲规则隐藏
    scheduleHideAdjust()
    return
  }
  // 松手才落盘：窗口把最终几何回传宿主，宿主 clamp 后写 config.json
  report({ type: 'bounds', bounds: final })
  // 松手后延迟隐藏（拖动期间不会被计时器打断）
  scheduleHideAdjust()
})

// 失焦 / Esc：立即取消拖动并隐藏边框
function cancelAdjust() {
  if (!settings.adjustMode) return
  if (drag) { try { api.report({ type: 'drag', active: false }) } catch { /* 忽略 */ } }
  drag = null
  els.adjustMove?.classList.remove('dragging')
  clearAdjustTimer()
  setAdjustState('idle')
  setIgnore(true)
}
window.addEventListener('blur', cancelAdjust)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') cancelAdjust()
})

window.addEventListener('resize', () => {
  if (app) {
    app.renderer.resize(window.innerWidth, window.innerHeight)
    fitModel()
  }
})

els.pin?.addEventListener('click', async () => {
  try {
    const state = await api.state()
    const next = !state.pinned
    await api.pin(next)
    syncPinButton(next)
  } catch { /* 忽略 */ }
})
// 移动/调整开关：开着才能拖窗口/缩放，关着时鼠标完全交给模型（可摸头、可点）
els.adjustToggle?.addEventListener('click', () => {
  const next = !settings.adjustMode
  setAdjustMode(next)
  report({ type: 'adjust-mode', on: next })
})

// 0.13.0：模式选择（下拉菜单，不再循环切换）与主动唤醒
const MODE_ORDER = ['auto', 'semi', 'manual']
// 显示名按用户 2026-11-05 的要求对调：内部键不变，只改叫法。
// 原 manual（AI 很主动）→ 现在叫「AI 自动」；原 auto（不主动）→ 现在叫「手动」。
const MODE_LABELS = { manual: 'AI 自动', semi: 'AI 半自动', auto: '手动' }
const MODE_HINTS = {
  manual: 'AI 自动：允许 AI 主动做动作/气泡；开启「交给 AI 移动窗口」后还能挪窗口',
  semi: 'AI 半自动：自动上气泡 + 思考/回答时自动做动作；可配定时唤醒',
  auto: '手动：AI 不自动冒气泡、不自动做动作，只有你点 ⚡ 或摸模型才回应',
}

let modeMenuOpen = false

// 置顶按钮：和「移动/穿透」一样用 active 常亮表示当前开启，点一下立刻能看到变化
function syncPinButton(pinned) {
  if (typeof pinned === 'boolean') settings.pinned = pinned
  if (!els.pin) return
  const on = settings.pinned !== false
  els.pin.classList.toggle('active', on)
  els.pin.title = on ? '已置顶（点击取消，让别的窗口能盖住它）' : '置顶（让窗口始终在最前）'
  els.pin.setAttribute('aria-pressed', on ? 'true' : 'false')
}

function syncModeButton() {
  const mode = MODE_ORDER.includes(settings.mode) ? settings.mode : 'auto'
  if (els.modeCycle) {
    els.modeCycle.textContent = `${MODE_LABELS[mode]} ▾`
    els.modeCycle.title = `当前：${MODE_LABELS[mode]}（点开选择模式）`
    els.modeCycle.classList.toggle('active', mode !== 'manual')
  }
  if (els.wake) {
    els.wake.classList.toggle('busy', settings.wakeBusy === true)
    els.wake.title = settings.wakeBusy
      ? '正在唤醒（等它回话）…'
      : (settings.wakeEnabled ? '主动唤醒（定时已开）' : '主动唤醒：看一眼屏幕后主动说句话')
  }
}

function renderModeMenu() {
  const menu = els.modeMenu
  if (!menu) return
  menu.textContent = ''
  const title = document.createElement('div')
  title.className = 'menu-title'
  title.textContent = '模式'
  menu.appendChild(title)
  for (const mode of MODE_ORDER) {
    const row = document.createElement('div')
    row.className = `menu-item${settings.mode === mode ? ' chosen' : ''}`
    const name = document.createElement('span')
    name.textContent = `${settings.mode === mode ? '✓ ' : ''}${MODE_LABELS[mode]}`
    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.textContent = mode === 'auto' ? '默认' : ''
    row.appendChild(name)
    row.appendChild(tag)
    row.title = MODE_HINTS[mode]
    row.addEventListener('click', () => chooseMode(mode))
    menu.appendChild(row)
  }
}

function openModeMenu() {
  const menu = els.modeMenu
  const button = els.modeCycle
  if (!menu || !button) return
  renderModeMenu()
  menu.classList.remove('hidden')
  // 先渲染再量，夹在窗口内
  const rect = button.getBoundingClientRect()
  const box = menu.getBoundingClientRect()
  const left = Math.max(4, Math.min(window.innerWidth - box.width - 4, rect.right - box.width))
  const top = Math.min(window.innerHeight - box.height - 4, rect.bottom + 4)
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  modeMenuOpen = true
  setIgnore(false)
}

function closeModeMenu() {
  const menu = els.modeMenu
  if (!menu) return
  menu.classList.add('hidden')
  modeMenuOpen = false
  // 菜单关掉后按当前状态恢复穿透（调整模式/预设菜单仍需要交互）
  if (!menuOpen && !settings.adjustMode) setIgnore(!isInteractiveAt(pointer.x, pointer.y))
}

function chooseMode(mode) {
  if (!MODE_ORDER.includes(mode)) return
  settings.mode = mode
  syncModeButton()
  closeModeMenu()
  report({ type: 'set-mode', mode })
}

function syncPassthroughButton() {
  if (!els.passthrough) return
  const on = settings.modelPassthrough === true
  els.passthrough.classList.toggle('active', on)
  els.passthrough.title = on
    ? '模型区穿透：开（模型不拦鼠标，摸不到模型；点这里关闭）'
    : '模型区穿透：关（模型可点；开启后点击穿透到下层）'
}

if (els.passthrough) {
  syncPassthroughButton()
  els.passthrough.addEventListener('click', () => {
    settings.modelPassthrough = !settings.modelPassthrough
    syncPassthroughButton()
    setIgnore(!isInteractiveAt(pointer.x, pointer.y))
    report({ type: 'set-passthrough', on: settings.modelPassthrough })
  })
}

els.modeCycle?.addEventListener('click', (event) => {
  event.stopPropagation()
  if (modeMenuOpen) closeModeMenu()
  else openModeMenu()
})

document.addEventListener('mousedown', (event) => {
  if (!modeMenuOpen) return
  if (event.target === els.modeCycle || els.modeMenu?.contains(event.target)) return
  closeModeMenu()
})

els.wake?.addEventListener('click', () => {
  // 只是请求；宿主会判模式/额度/是否在忙，结果通过气泡与 config 回推。
  // busy 状态完全由宿主下发（wakeBusy 字段），窗口不再自己定时清除——
  // 宿主最长可等 120 秒，本地 6 秒清掉会让人点到一个必被拒的按钮。
  if (settings.wakeBusy === true) return
  settings.wakeBusy = true
  syncModeButton()
  report({ type: 'wake-request' })
})

els.close?.addEventListener('click', () => api?.close?.())

// 启动：先设为穿透（窗口默认不挡鼠标），等 init
setIgnore(true)
bindPresetMenu()
api?.onCommand?.((command) => {
  handleCommand(command).catch((error) => {
    report({ type: 'state', phase: 'placeholder', error: String(error && error.message ? error.message : error) })
  })
})
report({ type: 'state', phase: 'boot' })

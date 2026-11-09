// dsh-live2d —— DSH Live2D 模型接入插件
//
// ===========================================================================
// 阶段 0D：P5 独立置顶窗口（0B/0C 已真机通过）
// ===========================================================================
// 0B：inject 为 sessions/agents/sessionTitle 后服务就绪；P1 读会话、P3 收事件已通。
// 0C：P2 注入已真机通过（POST /live2d/inject，默认 dryRun，读回验证）。
//
// 0D 只加**一件事**：用现成的 `$DSH_HOME/electron/electron.exe` 起一个
// 无边框 / 透明 / 置顶 / 可拖动 / 不抢焦点的助手窗口，并由插件宿主侧控制开关。
//   · POST /live2d/window { action: "open" | "close" }、GET /live2d/window
//   · 窗口内容是占位卡片，不是 Live2D 渲染（渲染在阶段 1）
//   · 不新增 npm 依赖：electron.exe 是 DSH 自己下载的，这里只 spawn 它
//   · 独立 userData（插件目录 .userdata），不碰 DSH 本体的 profile
// 证据入口：POST /live2d/window、GET /live2d/window（含 logTail）、GET /live2d/diag 的 window 段。
//
// 仍然**不做**：读屏、模型渲染、网页 UI 改动。
//
// 工程约束（不变）：
//   · 不 import 任何 @deepseek-ai/* 宿主包；
//   · 不新增 npm 依赖；
//   · apply 全包 try/catch + 超时，任何失败只降级本插件；
//   · 参数越界回落 + 告警（设置页 / /live2d/health / 日志 三处同源）。
// ===========================================================================

import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'live2d'

// 0B 的关键假设：Cordis 的服务是**懒初始化**的，只有写进 inject 才保证就绪。
// 0A 只 inject 了 webServer，结果 health 里 sessions/agents/sessionTitle 全 false。
// 这一版把它们补进 inject（与 dsh-speak-up 的 inject 子集一致，名字已验证存在），
// 并用 /live2d/diag 同时记录「ctx.<name> 与 ctx.get(name) 各自拿到什么」，把结论坐实。
export const inject = ['webServer', 'sessions', 'agents', 'sessionTitle', 'tools']

export const VERSION = '0.2.0'
export const STAGE = 'P2-P3'

// 插件自身目录：用来定位 electron/main.cjs（不依赖宿主包的 dsh-home-paths）
export const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))

// /live2d/models 的默认扫描根（用户可改 config.modelRoots）
export const DEFAULT_MODEL_ROOT = 'D:\\Live2D'

export const DEFAULT_INSTANCE = {
  id: 'inst-1',
  // 关闭后不加载窗口、不参与唤醒/空闲动作（设置页「启用模型」开关）
  enabled: true,
  // 绑定的会话（空 = 自动解析）
  sessionId: '',
  modelPath: '',
  // /live2d/models 的扫描根（空 = 用 DEFAULT_MODEL_ROOT）；换机器 / 换模型库时改这里
  modelRoots: [],
  windowWidth: 320,
  windowHeight: 420,
  windowX: null,
  windowY: null,
  rendererEnabled: true,
  clickThrough: true,
  modelPassthrough: false,
  adjustMode: false,
  // 置顶开关（窗口里可切换；持久化，重开/重启后保持）
  pinned: true,
  replyStyle: 'bubble',
  // 气泡外观：classic / cloud / signboard / note
  bubbleSkin: 'classic',
  replyOpacity: 0.9,
  // 阶段 4：回答区字号与最大高度（%），超长回答在气泡内部滚动
  replyFontSize: 15,
  replyMaxHeightPct: 45,
  // 气泡最大高度 = 模型高度 × ratio%（20~100）。改成相对模型后，放大模型气泡同步放大，
  // 也不会再出现「回答一长就把模型挤小」。
  replyHeightRatio: 50,
  // 固定气泡大小：开启后气泡高度锁死为 bubbleHeightPx（上下拖调整框不再改变气泡）
  bubbleFixedSize: false,
  bubbleHeightPx: 200,
  // 模型缩放：基础适配大小 × pct%；zoom-overlay 时允许超出模型占位区（靠 canvas 裁切），  // 回答区改用独立高度，不再随模型顶部反推，否则放大后气泡会被越压越小。
  modelScalePct: 100,
  modelLayoutMode: 'fit',
  // 阶段 4：动态效果（待机浮动 / 视线跟随 / 拖拽惯性），幅度 1~100
  idleFloat: true,
  lookFollow: true,
  dragInertia: true,
  motionStrength: 60,
  // 自动模式预设交互：用户点模型/摸头有反应（用户主动点，不是 AI 控制）
  autoInteract: true,
  // 空闲小动作：没人理的时候偶尔眨眼/歪头（auto 模式的「有生气」部分）
  idlePresets: true,
  // P2：观众在场判断；没有观众时只做低幅度动作。
  audienceAwareEnabled: true,
  // P2：本地陪伴记忆。代码默认开；存量 profile 迁移时默认关，避免和已有记忆插件冲突。
  memoryEnabled: true,
  memoryMaxEntries: 100,
  // P3：双模型关系互动（互相看、点头、偶尔吃醋）。
  dualRelationEnabled: true,
  // 预设动作：自定义动作 + 循环序列（实例级）
  customActions: [],
  presetSequences: [],
  // 阶段 4：读屏第一层（只读前台窗口标题，不截图）
  // 0.13.9：模式功能默认可用——半自动/主动唤醒要读标题才「知道你在干什么」，
  // 关掉会让「切模式」看起来毫无区别（用户反馈）。想关可在「模式设置」里关。
  screenReadEnabled: true,
  // 定时感知：后台每隔 N 秒读一次前台标题（只读标题、不落盘；auto 模式跳过）
  screenWatchEnabled: false,
  screenWatchIntervalMs: 30000,
  // 读屏第二层：允许截图 + 免确认子开关（默认关，开启后每次截图不再问）+ 最短间隔
  // 0.13.9：默认开（模式功能优先）；切换模式时会弹风险提示，「模式设置」里可单独关。
  screenCaptureEnabled: true,
  screenCaptureAutoConfirm: false,
  screenCaptureIntervalMs: 30000,
  // 阶段 4：语音（CosyVoice2 本地 HTTP），默认关
  ttsEnabled: false,
  ttsAutoSpeak: false,
  ttsUrl: 'http://127.0.0.1:7890/tts',
  // 参考音留空 = 用 TTS 服务端默认音色（换机器时不会指向不存在的文件）
  ttsPrompt: '',
  ttsPromptText: '',
  // 每个实例一套气泡/开窗参数（早先漏了，导致设置页保存后跳回全局默认）
  bubbleDurationMs: 5000,
  bubbleQueueLimit: 3,
  bubbleMaxChars: 120,
  autoOpenWindow: true,
  // 阶段 4：思考超时后是否仍把迟到的回答推出来（默认不推，超时即判失败）
  showLateReply: false,
  // 阶段 4：三模式（manual = 只由接口/按钮驱动；auto = 回复自动上气泡；
  // semi = 回复自动上气泡 + 思考/回答时自动播动作）
  // 默认「手动」（内部 auto）：不自动冒气泡、不自动做动作，只有 ⚡/摸模型才回应
  mode: 'auto',
  autoBubble: true,
  // 0.13.0：主动唤醒（定时/按钮都能叫醒 AI，让它看屏幕后主动回话）
  //  - 必须显式开启，不随模式切换自动开
  //  - 定时器与按钮唤醒共用一套额度（滚动 60 分钟）
  // 主动感知方式：off / timer / event。timer 与 event 互斥，按钮唤醒不受它限制。
  wakeDriver: 'off',
  wakeEnabled: false,
  wakeIntervalMs: 30_000,
  // 唤醒时截图：不打开的话唤醒只能读到窗口标题（用户实测后要求默认开）
  wakeCaptureEnabled: true,
  wakeMaxPerHour: 60,
  wakeTimeoutMs: 120_000,
  // P1 陪伴行为：宿主持续维护的“生命感”状态。
  // 非语言回应默认开启（不调用模型）；事件主动说话默认关闭，避免升级后突然打扰。
  lifeEnabled: true,
  lifeNonverbalEnabled: true,
  lifeNonverbalCooldownMs: 12_000,
  eventWakeEnabled: false,
  eventWakeFocusMs: 2_700_000,
  eventWakeAwayMs: 600_000,
  eventWakeTitleIntervalMs: 30_000,
  eventWakeCooldownMs: 180_000,
  eventWakeMaxPerHour: 8,
  lifeShareBudgetPerDay: 5,
  lifeImportantBudgetPerDay: 3,
  eventQuietEnabled: false,
  eventQuietStart: '23:00',
  eventQuietEnd: '08:00',
  lifeFarewellEnabled: true,
  // 0.13.0：AI 自主移动/缩放窗口（仅 manual 模式生效）
  // 0.13.9：默认开——否则「AI 自动」和普通模式看不出区别（用户反馈）
  aiMoveEnabled: true,
}

export const DEFAULT_CONFIG = {
  enabled: true,
  shellSelfTest: true,
  selfTestTimeoutMs: 3000,
  crashOnLoad: false,
  // 0B：事件观测只记录、不动作。关掉只是省一点内存。
  watchEvents: true,
  // 诊断里最多列几个会话
  diagSessionLimit: 8,

  // --- 全局（跨实例共用）---
  bubbleDurationMs: 5000,
  bubbleQueueLimit: 3,
  bubbleMaxChars: 120,
  // 插件加载后自动开窗（关掉就只留接口，手动开）
  autoOpenWindow: true,
  // 阶段 2：等一次回复的最长时间
  chatTimeoutMs: 90_000,
  // 阶段 4：动作指令冷却与执行超时
  animCooldownMs: 3000,
  animTimeoutMs: 2000,

  // --- 实例（对话 ↔ 模型一一对应，上限 2）---
  instances: [{ ...DEFAULT_INSTANCE }],

  // --- 兼容字段：永远是 instances[0] 的镜像，老代码/老配置都靠它 ---
  modelPath: DEFAULT_INSTANCE.modelPath,
  windowWidth: DEFAULT_INSTANCE.windowWidth,
  windowHeight: DEFAULT_INSTANCE.windowHeight,
  windowX: null,
  windowY: null,
  rendererEnabled: true,
  clickThrough: true,
  modelPassthrough: false,
  adjustMode: false,
  replyStyle: 'bubble',
  bubbleSkin: 'classic',
  replyOpacity: 0.9,
  modelScalePct: 100,
  modelLayoutMode: 'fit',
  idleFloat: true,
  lookFollow: true,
  dragInertia: true,
  motionStrength: 60,
  autoInteract: true,
  idlePresets: true,
  audienceAwareEnabled: true,
  memoryEnabled: true,
  memoryMaxEntries: 100,
  dualRelationEnabled: true,
  // 预设动作：自定义动作（AI 设计，跨模型通用：写逻辑参数名，模型缺参数就跳过该轨道）
  customActions: [],
  // 预设循环：{ id, label, steps:[动作id], intervalMs, loop }
  presetSequences: [],
  boundSessionId: '',
}

const LIMITS = {
  selfTestTimeoutMs: { min: 1000, max: 10_000, fallback: 3000 },
  diagSessionLimit: { min: 1, max: 20, fallback: 8 },
  windowWidth: { min: 160, max: 800, fallback: 320 },
  windowHeight: { min: 200, max: 1000, fallback: 420 },
  windowPosition: { min: -10_000, max: 10_000, fallback: null },
  bubbleDurationMs: { min: 1000, max: 120_000, fallback: 5000 },
  bubbleQueueLimit: { min: 1, max: 10, fallback: 3 },
  bubbleMaxChars: { min: 40, max: 400, fallback: 120 },
  replyOpacity: { min: 0.3, max: 1, fallback: 0.9 },
  replyFontSize: { min: 12, max: 24, fallback: 15 },
  replyMaxHeightPct: { min: 20, max: 70, fallback: 45 },
  replyHeightRatio: { min: 20, max: 100, fallback: 50 },
  // 固定气泡大小（px）：开启后气泡锁死这个高度，上下拖调整框不再改变气泡
  bubbleHeightPx: { min: 80, max: 900, fallback: 200 },
  modelScalePct: { min: 50, max: 200, fallback: 100 },
  motionStrength: { min: 1, max: 100, fallback: 60 },
  memoryMaxEntries: { min: 20, max: 500, fallback: 100 },
  chatTimeoutMs: { min: 10_000, max: 300_000, fallback: 90_000 },
  animCooldownMs: { min: 0, max: 10_000, fallback: 3000 },
  animTimeoutMs: { min: 1000, max: 5000, fallback: 2000 },
  screenCaptureIntervalMs: { min: 5000, max: 300_000, fallback: 30_000 },
  screenWatchIntervalMs: { min: 15_000, max: 300_000, fallback: 30_000 },
  // 0.13.0：定时主动唤醒
  wakeIntervalMs: { min: 15_000, max: 600_000, fallback: 30_000 },
  wakeMaxPerHour: { min: 1, max: 360, fallback: 60 },
  wakeTimeoutMs: { min: 30_000, max: 600_000, fallback: 120_000 },
  lifeNonverbalCooldownMs: { min: 3000, max: 300_000, fallback: 12_000 },
  eventWakeFocusMs: { min: 60_000, max: 7_200_000, fallback: 2_700_000 },
  eventWakeAwayMs: { min: 60_000, max: 7_200_000, fallback: 600_000 },
  eventWakeTitleIntervalMs: { min: 10_000, max: 300_000, fallback: 30_000 },
  eventWakeCooldownMs: { min: 30_000, max: 3_600_000, fallback: 180_000 },
  eventWakeMaxPerHour: { min: 1, max: 120, fallback: 8 },
  lifeShareBudgetPerDay: { min: 0, max: 50, fallback: 5 },
  lifeImportantBudgetPerDay: { min: 0, max: 30, fallback: 3 },
  maxInstances: 2,
}

// 配置文件放 DSH 的 home 下，不塞插件目录（卸载插件不丢用户配置）
export const CONFIG_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-live2d')
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

const EVENT_BUFFER_SIZE = 60

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function safeLogger(ctx) {
  const logger = ctx && ctx.logger
  return {
    info(message) { try { logger?.info?.(message) } catch { /* 日志失败绝不影响主流程 */ } },
    warn(message) { try { logger?.warn?.(message) } catch { /* 同上 */ } },
    error(message) { try { logger?.error?.(message) } catch { /* 同上 */ } },
  }
}

function errorText(error) {
  return String(error?.message || error)
}

function clampInt(value, { min, max, fallback }, label, warnings) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < min || number > max) {
    warnings.push(`${label} 取值 ${JSON.stringify(value)} 越界（合法 ${min}~${max} 整数），已回落 ${fallback}`)
    return fallback
  }
  return number
}

function clampNullableInt(value, { min, max, fallback }, label, warnings) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < min || number > max) {
    warnings.push(`${label} 取值 ${JSON.stringify(value)} 越界（合法 ${min}~${max} 整数或 null），已回落 ${fallback}`)
    return fallback
  }
  return number
}

function normalizeClock(value, fallback, label, warnings) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return value
  warnings.push(`${label} 必须是 HH:mm（收到 ${JSON.stringify(value)}），已回落 ${fallback}`)
  return fallback
}

// 拖动窗口时用「夹到边界」而不是「回落默认值」：
// 拖到 900 应停在 800，而不是突然跳回 320。
function clampRange(value, { min, max }, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** 小数参数（如不透明度 0.3~1）：越界回落 + 告警，保留两位。 */
function clampNumber(value, { min, max, fallback }, label, warnings) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) {
    warnings.push(`${label} 取值 ${JSON.stringify(value)} 越界（合法 ${min}~${max}），已回落 ${fallback}`)
    return fallback
  }
  return Math.round(number * 100) / 100
}

function boolOr(value, fallback, label, warnings) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    warnings.push(`${label} 不是布尔值（收到 ${JSON.stringify(value)}），已回落 ${fallback}`)
    return fallback
  }
  return value
}

function normalizeModelPath(value, warnings) {
  if (value === undefined || value === null) return DEFAULT_CONFIG.modelPath
  if (typeof value !== 'string') {
    warnings.push(`modelPath 不是字符串（收到 ${JSON.stringify(value)}），已回落默认路径`)
    return DEFAULT_CONFIG.modelPath
  }
  const trimmed = value.trim()
  return trimmed || DEFAULT_CONFIG.modelPath
}

/** 模型扫描根：数组、去空、去重、最多 5 个；空数组表示用平台默认根。 */
export function normalizeModelRoots(value, warnings = []) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    warnings.push(`modelRoots 不是数组（收到 ${JSON.stringify(value)}），已忽略`)
    return []
  }
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) continue
    const trimmed = item.trim()
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  if (out.length > 5) {
    warnings.push(`modelRoots 最多 5 个（收到 ${out.length} 个），多余的已忽略`)
    out.length = 5
  }
  return out
}

/** 阶段 4：三模式。 */
export const MODES = ['manual', 'auto', 'semi']

function normalizeMode(value, warnings) {
  if (value === undefined || value === null) return DEFAULT_INSTANCE.mode
  if (typeof value === 'string' && MODES.includes(value)) return value
  warnings.push(`mode 只能是 ${MODES.join(' / ')}（收到 ${JSON.stringify(value)}），已回落 ${DEFAULT_INSTANCE.mode}`)
  return DEFAULT_INSTANCE.mode
}

function normalizeString(value, fallback, label, max = 500) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return trimmed.slice(0, max)
}

function normalizeBoundSession(value, warnings) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    warnings.push(`boundSessionId 不是字符串（收到 ${JSON.stringify(value)}），已清空（改为自动解析）`)
    return ''
  }
  return value.trim()
}

/** 一个「对话 ↔ 模型」实例的参数（窗口、位置、样式都按实例独立）。 */
// 自定义动作的通用校验：动作定义只描述「参数 → 关键帧」，不绑定某一只模型。
// 参数可以写逻辑名（headX / eyeOpenL / mouthOpen…），渲染层按模型实际参数解析，缺了就跳轨。
const ACTION_ID_RE = /^[a-z][a-z0-9_-]{1,23}$/
const ACTION_LIMIT = 20
const TRACK_LIMIT = 8
const KEY_LIMIT = 12

export function normalizeCustomActions(raw, warnings = []) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    warnings.push('customActions 不是数组，已忽略')
    return []
  }
  const out = []
  for (const item of raw.slice(0, ACTION_LIMIT)) {
    const id = typeof item?.id === 'string' ? item.id : ''
    if (!ACTION_ID_RE.test(id)) {
      warnings.push(`自定义动作 id 不合法（${id || '空'}），已跳过`)
      continue
    }
    if (BUILTIN_ACTION_IDS.has(id)) {
      warnings.push(`自定义动作 id「${id}」与内置动作重名，已跳过`)
      continue
    }
    const label = typeof item?.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 24) : id
    const durationMs = Math.min(10_000, Math.max(200, Math.round(Number(item?.durationMs) || 1000)))
    const tracks = []
    for (const track of Array.isArray(item?.tracks) ? item.tracks.slice(0, TRACK_LIMIT) : []) {
      const param = typeof track?.param === 'string' ? track.param.trim().slice(0, 40) : ''
      if (!param) continue
      const keys = []
      for (const pair of Array.isArray(track?.keys) ? track.keys.slice(0, KEY_LIMIT) : []) {
        if (!Array.isArray(pair) || pair.length < 2) continue
        const t = Number(pair[0])
        // 'current' = 播放时取模型当前值（换装/开关类动作的起点，不能写死 0）
        const raw = pair[1] === 'current' ? 'current' : Number(pair[1])
        if (!Number.isFinite(t)) continue
        if (raw !== 'current' && !Number.isFinite(raw)) continue
        keys.push([Math.min(1, Math.max(0, t)), raw === 'current' ? 'current' : Math.min(40, Math.max(-40, raw))])
      }
      if (!keys.length) continue
      keys.sort((a, b) => a[0] - b[0])
      tracks.push({ param, keys })
    }
    if (!tracks.length) {
      warnings.push(`自定义动作「${id}」没有任何有效轨道，已跳过`)
      continue
    }
    out.push({
      id,
      label,
      durationMs,
      // hold：设完保持不回到原值（换装、开关类）；再点一次由渲染层取消
      hold: item?.hold === true,
      desc: typeof item?.desc === 'string' ? item.desc.slice(0, 40) : '',
      group: typeof item?.group === 'string' ? item.group.slice(0, 16) : '',
      auto: item?.auto === true,
      tracks,
    })
  }
  return out
}

export function normalizePresetSequences(raw, warnings = []) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    warnings.push('presetSequences 不是数组，已忽略')
    return []
  }
  const out = []
  for (const item of raw.slice(0, 10)) {
    const id = typeof item?.id === 'string' ? item.id : ''
    if (!ACTION_ID_RE.test(id)) {
      warnings.push(`预设循环 id 不合法（${id || '空'}），已跳过`)
      continue
    }
    const steps = (Array.isArray(item?.steps) ? item.steps : [])
      .filter((step) => typeof step === 'string' && step.trim())
      .map((step) => step.trim().slice(0, 40))
      .slice(0, 20)
    if (!steps.length) {
      warnings.push(`预设循环「${id}」没有步骤，已跳过`)
      continue
    }
    const entry = {
      id,
      label: typeof item?.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 24) : id,
      steps,
      intervalMs: Math.min(60_000, Math.max(300, Math.round(Number(item?.intervalMs) || 2500))),
      loop: item?.loop !== false,
    }
    // 0.3.2：循环属于「模型档案」，不再绑定实例 id。
    // 旧配置里的 targets 只留档（legacyTargets）供迁移报告核对，不参与运行。
    const legacy = (Array.isArray(item?.targets) ? item.targets : [])
      .filter((target) => typeof target === 'string' && /^[\w-]{1,32}$/.test(target))
      .slice(0, 2)
    if (legacy.length) entry.legacyTargets = legacy
    out.push(entry)
  }
  return out
}

function normalizeInstance(raw, index, warnings) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const id = typeof source.id === 'string' && /^[\w-]{1,32}$/.test(source.id) ? source.id : `inst-${index + 1}`
  const wakeDriver = normalizeWakeDriver(source, warnings)
  return {
    id,
    sessionId: normalizeBoundSession(source.sessionId ?? source.boundSessionId, warnings),
    modelPath: normalizeModelPath(source.modelPath, warnings),
    modelRoots: normalizeModelRoots(source.modelRoots, warnings),
    windowWidth: clampInt(source.windowWidth, LIMITS.windowWidth, 'windowWidth', warnings),
    windowHeight: clampInt(source.windowHeight, LIMITS.windowHeight, 'windowHeight', warnings),
    windowX: clampNullableInt(source.windowX, LIMITS.windowPosition, 'windowX', warnings),    windowY: clampNullableInt(source.windowY, LIMITS.windowPosition, 'windowY', warnings),
    rendererEnabled: boolOr(source.rendererEnabled, DEFAULT_INSTANCE.rendererEnabled, 'rendererEnabled', warnings),
    clickThrough: boolOr(source.clickThrough, DEFAULT_INSTANCE.clickThrough, 'clickThrough', warnings),
    modelPassthrough: boolOr(source.modelPassthrough, DEFAULT_INSTANCE.modelPassthrough, 'modelPassthrough', warnings),
    adjustMode: boolOr(source.adjustMode, DEFAULT_INSTANCE.adjustMode, 'adjustMode', warnings),
    replyStyle: normalizeReplyStyle(source.replyStyle, warnings),
    bubbleSkin: normalizeBubbleSkin(source.bubbleSkin, warnings),
    replyOpacity: clampNumber(source.replyOpacity, LIMITS.replyOpacity, 'replyOpacity', warnings),
    replyFontSize: clampInt(source.replyFontSize, LIMITS.replyFontSize, 'replyFontSize', warnings),
    replyMaxHeightPct: clampInt(source.replyMaxHeightPct, LIMITS.replyMaxHeightPct, 'replyMaxHeightPct', warnings),
    replyHeightRatio: clampInt(source.replyHeightRatio, LIMITS.replyHeightRatio, 'replyHeightRatio', warnings),
    bubbleFixedSize: boolOr(source.bubbleFixedSize, DEFAULT_INSTANCE.bubbleFixedSize, 'bubbleFixedSize', warnings),
    bubbleHeightPx: clampInt(source.bubbleHeightPx, LIMITS.bubbleHeightPx, 'bubbleHeightPx', warnings),
    pinned: boolOr(source.pinned, DEFAULT_INSTANCE.pinned, 'pinned', warnings),
    modelScalePct: clampInt(source.modelScalePct, LIMITS.modelScalePct, 'modelScalePct', warnings),
    modelLayoutMode: normalizeLayoutMode(source.modelLayoutMode, warnings),
    idleFloat: boolOr(source.idleFloat, DEFAULT_INSTANCE.idleFloat, 'idleFloat', warnings),
    lookFollow: boolOr(source.lookFollow, DEFAULT_INSTANCE.lookFollow, 'lookFollow', warnings),
    dragInertia: boolOr(source.dragInertia, DEFAULT_INSTANCE.dragInertia, 'dragInertia', warnings),
    motionStrength: clampInt(source.motionStrength, LIMITS.motionStrength, 'motionStrength', warnings),
    autoInteract: boolOr(source.autoInteract, DEFAULT_INSTANCE.autoInteract, 'autoInteract', warnings),
    idlePresets: boolOr(source.idlePresets, DEFAULT_INSTANCE.idlePresets, 'idlePresets', warnings),
    audienceAwareEnabled: boolOr(source.audienceAwareEnabled, DEFAULT_INSTANCE.audienceAwareEnabled, 'audienceAwareEnabled', warnings),
    memoryEnabled: boolOr(source.memoryEnabled, DEFAULT_INSTANCE.memoryEnabled, 'memoryEnabled', warnings),
    memoryMaxEntries: clampInt(source.memoryMaxEntries, LIMITS.memoryMaxEntries, 'memoryMaxEntries', warnings),
    dualRelationEnabled: boolOr(source.dualRelationEnabled, DEFAULT_INSTANCE.dualRelationEnabled, 'dualRelationEnabled', warnings),
    // 气泡参数是「每个实例各一套」：早先没放进实例字段，设置页保存后会被丢回全局默认（5 秒）
    bubbleDurationMs: clampInt(source.bubbleDurationMs, LIMITS.bubbleDurationMs, 'bubbleDurationMs', warnings),
    bubbleQueueLimit: clampInt(source.bubbleQueueLimit, LIMITS.bubbleQueueLimit, 'bubbleQueueLimit', warnings),
    bubbleMaxChars: clampInt(source.bubbleMaxChars, LIMITS.bubbleMaxChars, 'bubbleMaxChars', warnings),
    autoOpenWindow: boolOr(source.autoOpenWindow, DEFAULT_INSTANCE.autoOpenWindow, 'autoOpenWindow', warnings),
    enabled: boolOr(source.enabled, DEFAULT_INSTANCE.enabled, 'enabled', warnings),
    screenReadEnabled: boolOr(source.screenReadEnabled, DEFAULT_INSTANCE.screenReadEnabled, 'screenReadEnabled', warnings),
    screenCaptureEnabled: boolOr(source.screenCaptureEnabled, DEFAULT_INSTANCE.screenCaptureEnabled, 'screenCaptureEnabled', warnings),
    screenCaptureAutoConfirm: boolOr(source.screenCaptureAutoConfirm, DEFAULT_INSTANCE.screenCaptureAutoConfirm, 'screenCaptureAutoConfirm', warnings),
    screenCaptureIntervalMs: clampInt(source.screenCaptureIntervalMs, LIMITS.screenCaptureIntervalMs, 'screenCaptureIntervalMs', warnings),
    screenWatchEnabled: boolOr(source.screenWatchEnabled, DEFAULT_INSTANCE.screenWatchEnabled, 'screenWatchEnabled', warnings),
    screenWatchIntervalMs: clampInt(source.screenWatchIntervalMs, LIMITS.screenWatchIntervalMs, 'screenWatchIntervalMs', warnings),
    // 阶段 4：语音
    ttsEnabled: boolOr(source.ttsEnabled, DEFAULT_INSTANCE.ttsEnabled, 'ttsEnabled', warnings),
    ttsAutoSpeak: boolOr(source.ttsAutoSpeak, DEFAULT_INSTANCE.ttsAutoSpeak, 'ttsAutoSpeak', warnings),
    ttsUrl: normalizeString(source.ttsUrl, DEFAULT_INSTANCE.ttsUrl, 'ttsUrl'),
    ttsPrompt: normalizeString(source.ttsPrompt, DEFAULT_INSTANCE.ttsPrompt, 'ttsPrompt'),
    ttsPromptText: normalizeString(source.ttsPromptText, DEFAULT_INSTANCE.ttsPromptText, 'ttsPromptText'),
    // 阶段 4：思考超时行为（不输出 / 仍输出迟到回答）
    showLateReply: boolOr(source.showLateReply, DEFAULT_INSTANCE.showLateReply, 'showLateReply', warnings),
    chatTimeoutMs: clampInt(source.chatTimeoutMs, LIMITS.chatTimeoutMs, 'chatTimeoutMs', warnings),
    // 预设动作：自定义动作定义 + 循环序列（用户/AI 都可增删）
    customActions: normalizeCustomActions(source.customActions, warnings),
    presetSequences: normalizePresetSequences(source.presetSequences, warnings),
    mode: normalizeMode(source.mode, warnings),
    autoBubble: boolOr(source.autoBubble, DEFAULT_INSTANCE.autoBubble, 'autoBubble', warnings),
    // 0.13.0：主动唤醒
    wakeDriver,
    wakeEnabled: wakeDriver === 'timer',
    wakeIntervalMs: clampInt(source.wakeIntervalMs, LIMITS.wakeIntervalMs, 'wakeIntervalMs', warnings),
    wakeCaptureEnabled: boolOr(source.wakeCaptureEnabled, DEFAULT_INSTANCE.wakeCaptureEnabled, 'wakeCaptureEnabled', warnings),
    wakeMaxPerHour: clampInt(source.wakeMaxPerHour, LIMITS.wakeMaxPerHour, 'wakeMaxPerHour', warnings),
    wakeTimeoutMs: clampInt(source.wakeTimeoutMs, LIMITS.wakeTimeoutMs, 'wakeTimeoutMs', warnings),
    lifeEnabled: boolOr(source.lifeEnabled, DEFAULT_INSTANCE.lifeEnabled, 'lifeEnabled', warnings),
    lifeNonverbalEnabled: boolOr(source.lifeNonverbalEnabled, DEFAULT_INSTANCE.lifeNonverbalEnabled, 'lifeNonverbalEnabled', warnings),
    lifeNonverbalCooldownMs: clampInt(source.lifeNonverbalCooldownMs, LIMITS.lifeNonverbalCooldownMs, 'lifeNonverbalCooldownMs', warnings),
    eventWakeEnabled: wakeDriver === 'event',
    eventWakeFocusMs: clampInt(source.eventWakeFocusMs, LIMITS.eventWakeFocusMs, 'eventWakeFocusMs', warnings),
    eventWakeAwayMs: clampInt(source.eventWakeAwayMs, LIMITS.eventWakeAwayMs, 'eventWakeAwayMs', warnings),
    eventWakeTitleIntervalMs: clampInt(source.eventWakeTitleIntervalMs, LIMITS.eventWakeTitleIntervalMs, 'eventWakeTitleIntervalMs', warnings),
    eventWakeCooldownMs: clampInt(source.eventWakeCooldownMs, LIMITS.eventWakeCooldownMs, 'eventWakeCooldownMs', warnings),
    eventWakeMaxPerHour: clampInt(source.eventWakeMaxPerHour, LIMITS.eventWakeMaxPerHour, 'eventWakeMaxPerHour', warnings),
    lifeShareBudgetPerDay: clampInt(source.lifeShareBudgetPerDay, LIMITS.lifeShareBudgetPerDay, 'lifeShareBudgetPerDay', warnings),
    lifeImportantBudgetPerDay: clampInt(source.lifeImportantBudgetPerDay, LIMITS.lifeImportantBudgetPerDay, 'lifeImportantBudgetPerDay', warnings),
    eventQuietEnabled: boolOr(source.eventQuietEnabled, DEFAULT_INSTANCE.eventQuietEnabled, 'eventQuietEnabled', warnings),
    eventQuietStart: normalizeClock(source.eventQuietStart, DEFAULT_INSTANCE.eventQuietStart, 'eventQuietStart', warnings),
    eventQuietEnd: normalizeClock(source.eventQuietEnd, DEFAULT_INSTANCE.eventQuietEnd, 'eventQuietEnd', warnings),
    lifeFarewellEnabled: boolOr(source.lifeFarewellEnabled, DEFAULT_INSTANCE.lifeFarewellEnabled, 'lifeFarewellEnabled', warnings),
    aiMoveEnabled: boolOr(source.aiMoveEnabled, DEFAULT_INSTANCE.aiMoveEnabled, 'aiMoveEnabled', warnings),
  }
}

const INSTANCE_KEYS = [
  'enabled', 'modelPath', 'modelRoots', 'windowWidth', 'windowHeight', 'windowX', 'windowY',
  'rendererEnabled', 'clickThrough', 'modelPassthrough', 'adjustMode', 'pinned', 'replyStyle', 'bubbleSkin', 'replyOpacity', 'sessionId', 'boundSessionId',
  'replyFontSize', 'replyMaxHeightPct', 'replyHeightRatio', 'bubbleFixedSize', 'bubbleHeightPx',
  'modelScalePct', 'modelLayoutMode',
  'idleFloat', 'lookFollow', 'dragInertia', 'motionStrength', 'autoInteract', 'idlePresets',
  'audienceAwareEnabled', 'memoryEnabled', 'memoryMaxEntries', 'dualRelationEnabled',
  'customActions', 'presetSequences',
  'bubbleDurationMs', 'bubbleQueueLimit', 'bubbleMaxChars', 'autoOpenWindow',
  'screenReadEnabled',
  'screenWatchEnabled', 'screenWatchIntervalMs',
  'screenCaptureEnabled', 'screenCaptureAutoConfirm', 'screenCaptureIntervalMs',
  'ttsEnabled', 'ttsAutoSpeak', 'ttsUrl', 'ttsPrompt', 'ttsPromptText',
  'showLateReply', 'chatTimeoutMs', 'mode', 'autoBubble',
  'wakeDriver', 'wakeEnabled', 'wakeIntervalMs', 'wakeCaptureEnabled', 'wakeMaxPerHour', 'wakeTimeoutMs',
  'lifeEnabled', 'lifeNonverbalEnabled', 'lifeNonverbalCooldownMs',
  'eventWakeEnabled', 'eventWakeFocusMs', 'eventWakeAwayMs', 'eventWakeTitleIntervalMs',
  'eventWakeCooldownMs', 'eventWakeMaxPerHour',
  'lifeShareBudgetPerDay', 'lifeImportantBudgetPerDay',
  'eventQuietEnabled', 'eventQuietStart', 'eventQuietEnd',
  'lifeFarewellEnabled',
  'aiMoveEnabled',
]

export function normalizeConfig(raw) {
  const warnings = []
  const source = raw && typeof raw === 'object' ? raw : {}
  const rawInstances = Array.isArray(source.instances) ? source.instances : []
  let instances = []
  if (rawInstances.length > 0) {
    if (rawInstances.length > LIMITS.maxInstances) {
      warnings.push(`instances 最多 ${LIMITS.maxInstances} 个，多余的 ${rawInstances.length - LIMITS.maxInstances} 个已忽略`)
    }
    instances = rawInstances
      .slice(0, LIMITS.maxInstances)
      .map((item, index) => normalizeInstance(item, index, warnings))
  } else {
    // 老配置（扁平字段）迁移成第一个实例
    instances = [normalizeInstance({ ...source, id: source.instanceId ?? 'inst-1' }, 0, warnings)]
  }
  // id 去重：重复的补后缀，保证前端能按 id 定位
  const seen = new Set()
  for (const instance of instances) {
    let id = instance.id
    let suffix = 2
    while (seen.has(id)) id = `${instance.id}-${suffix++}`
    seen.add(id)
    instance.id = id
  }

  // 0.3.2：模型档案 + 路径绑定（动作/循环按模型共享，不按实例）
  const modelProfiles = normalizeModelProfiles(source.modelProfiles, warnings)
  const modelPathBindings = normalizeModelPathBindings(source.modelPathBindings, modelProfiles)

  const first = instances[0]
  return {
    config: {
      // 0.3.2 起配置带 schema 版本，便于以后迁移判断
      schemaVersion: 2,
      modelProfiles,
      modelPathBindings,
      enabled: source.enabled === undefined ? DEFAULT_CONFIG.enabled : source.enabled !== false,
      shellSelfTest: source.shellSelfTest === undefined ? DEFAULT_CONFIG.shellSelfTest : source.shellSelfTest !== false,
      selfTestTimeoutMs: clampInt(source.selfTestTimeoutMs, LIMITS.selfTestTimeoutMs, 'selfTestTimeoutMs', warnings),
      crashOnLoad: source.crashOnLoad === true,
      watchEvents: source.watchEvents === undefined ? DEFAULT_CONFIG.watchEvents : source.watchEvents !== false,
      diagSessionLimit: clampInt(source.diagSessionLimit, LIMITS.diagSessionLimit, 'diagSessionLimit', warnings),

      // 全局
      bubbleDurationMs: clampInt(source.bubbleDurationMs, LIMITS.bubbleDurationMs, 'bubbleDurationMs', warnings),
      bubbleQueueLimit: clampInt(source.bubbleQueueLimit, LIMITS.bubbleQueueLimit, 'bubbleQueueLimit', warnings),
      bubbleMaxChars: clampInt(source.bubbleMaxChars, LIMITS.bubbleMaxChars, 'bubbleMaxChars', warnings),
      autoOpenWindow: boolOr(source.autoOpenWindow, DEFAULT_CONFIG.autoOpenWindow, 'autoOpenWindow', warnings),
      chatTimeoutMs: clampInt(source.chatTimeoutMs, LIMITS.chatTimeoutMs, 'chatTimeoutMs', warnings),
      animCooldownMs: clampInt(source.animCooldownMs, LIMITS.animCooldownMs, 'animCooldownMs', warnings),
      animTimeoutMs: clampInt(source.animTimeoutMs, LIMITS.animTimeoutMs, 'animTimeoutMs', warnings),

      // 实例
      instances,

      // 兼容镜像：永远等于 instances[0]（老代码/老路由/@1 直读这些字段）
      modelPath: first.modelPath,
      windowWidth: first.windowWidth,
      windowHeight: first.windowHeight,
      windowX: first.windowX,
      windowY: first.windowY,
      rendererEnabled: first.rendererEnabled,
      clickThrough: first.clickThrough,
      modelPassthrough: first.modelPassthrough,
      adjustMode: first.adjustMode,
      replyStyle: first.replyStyle,
      bubbleSkin: first.bubbleSkin,
      replyOpacity: first.replyOpacity,
      audienceAwareEnabled: first.audienceAwareEnabled,
      memoryEnabled: first.memoryEnabled,
      memoryMaxEntries: first.memoryMaxEntries,
      dualRelationEnabled: first.dualRelationEnabled,
      boundSessionId: first.sessionId,
    },
    warnings,
  }
}

// ---------------------------------------------------------------------------
// 实例池（多窗口：一个会话 ↔ 一个模型 ↔ 一个窗口）
// ---------------------------------------------------------------------------

/** 模型路径的唯一性键：Windows 大小写不敏感，尾斜杠/相对路径都要归一。 */
export function normalizeModelKey(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  try {
    return path.resolve(raw).replace(/[\\/]+$/, '').toLowerCase()
  } catch {
    return raw.toLowerCase()
  }
}

/**
 * 校验实例列表的唯一性/上限。返回 { ok, code, error, conflictWith }。
 * 规则（用户 2026-11-02 拍板）：sessionId 只在非空时查重；modelPath 规范化后查重。
 */
export function validateInstances(config) {
  const list = Array.isArray(config?.instances) ? config.instances : []
  if (list.length > LIMITS.maxInstances) {
    return { ok: false, code: 'too-many-instances', error: `最多 ${LIMITS.maxInstances} 个实例（现在 ${list.length} 个）` }
  }
  const sessions = new Map()
  const models = new Map()
  for (const item of list) {
    if (item?.sessionId) {
      const key = String(item.sessionId)
      if (sessions.has(key)) {
        return { ok: false, code: 'duplicate-session', error: `会话 ${key} 已经被实例 ${sessions.get(key)} 绑定`, conflictWith: sessions.get(key) }
      }
      sessions.set(key, item.id)
    }
    const modelKey = normalizeModelKey(item?.modelPath)
    if (modelKey) {
      if (models.has(modelKey)) {
        return { ok: false, code: 'duplicate-model', error: `模型 ${item.modelPath} 已经被实例 ${models.get(modelKey)} 占用`, conflictWith: models.get(modelKey) }
      }
      models.set(modelKey, item.id)
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 模型档案（0.3.2）：动作/循环跟着「模型」走，不跟着「实例」走
//   modelProfiles[profileId]      = { id, label, pathKey, modelEntry, fingerprint, customActions, presetSequences, createdAt, updatedAt }
//   modelPathBindings[pathKey]    = profileId
// 路径只是「绑定键」，档案 ID 独立存在：换目录、重新绑定、进历史档案都不会改 ID。
// ---------------------------------------------------------------------------

export const PROFILE_ID_RE = /^mp_[a-z0-9]{4,16}$/
export const PROFILE_LIMIT = 40

/** 由规范化路径派生一个确定性档案 id（同路径永远同 id，迁移可重入）。 */
export function profileIdForKey(pathKey) {
  const key = String(pathKey ?? '')
  return `mp_${createHash('sha1').update(key).digest('hex').slice(0, 10)}`
}

export function normalizeModelProfiles(raw, warnings = []) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {}
  let count = 0
  for (const [key, item] of Object.entries(source)) {
    if (count >= PROFILE_LIMIT) {
      warnings.push(`模型档案最多 ${PROFILE_LIMIT} 个，多余的已忽略`)
      break
    }
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' && PROFILE_ID_RE.test(item.id)
      ? item.id
      : (PROFILE_ID_RE.test(key) ? key : '')
    if (!id) {
      warnings.push('模型档案 id 不合法，已跳过')
      continue
    }
    if (out[id]) {
      warnings.push(`模型档案 id「${id}」重复，已跳过`)
      continue
    }
    const pathKey = normalizeModelKey(item.pathKey)
    const label = typeof item.label === 'string' && item.label.trim()
      ? item.label.trim().slice(0, 32)
      : (pathKey ? path.basename(pathKey) : '未命名模型')
    out[id] = {
      id,
      label,
      pathKey,
      modelEntry: typeof item.modelEntry === 'string' ? item.modelEntry.slice(0, 120) : '',
      fingerprint: typeof item.fingerprint === 'string' ? item.fingerprint.slice(0, 80) : '',
      customActions: normalizeCustomActions(item.customActions, warnings),
      presetSequences: normalizePresetSequences(item.presetSequences, warnings),
      // 按模型能力自动挑的默认动作（0.4.0）：与用户自定义动作分开存，重挑时只覆盖这一份
      autoActions: normalizeCustomActions(item.autoActions, warnings),
      autoActionsHash: typeof item.autoActionsHash === 'string' ? item.autoActionsHash.slice(0, 40) : '',
      // 0.5.0：模型目录扫描结果（表情/换装/动作文件）与生成的动作
      capabilities: normalizeCapabilities(item.capabilities, warnings),
      capabilityHash: typeof item.capabilityHash === 'string' ? item.capabilityHash.slice(0, 40) : '',
      capabilityActions: normalizeCustomActions(item.capabilityActions, warnings),
      createdAt: Number(item.createdAt) || Date.now(),
      updatedAt: Number(item.updatedAt) || Date.now(),
    }
    count += 1
  }
  return out
}

/** 能力扫描结果的落盘形态（0.5.0）：只留能复用的字段，避免把整个 model3.json 塞进配置。 */
export function normalizeCapabilities(raw, warnings = []) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const expressions = []
  for (const item of Array.isArray(raw.expressions) ? raw.expressions.slice(0, 120) : []) {
    const label = typeof item?.label === 'string' ? item.label.trim().slice(0, 32) : ''
    const params = []
    for (const p of Array.isArray(item?.params) ? item.params.slice(0, 16) : []) {
      const param = typeof p?.param === 'string' ? p.param.trim().slice(0, 40) : ''
      if (!param) continue
      const value = Number(p?.value)
      if (!Number.isFinite(value)) continue
      params.push({
        param,
        value: Math.min(40, Math.max(-40, value)),
        blend: ['Add', 'Multiply', 'Overwrite'].includes(p?.blend) ? p.blend : 'Add',
      })
    }
    if (!label || !params.length) continue
    expressions.push({
      id: typeof item?.id === 'string' ? item.id.slice(0, 40) : '',
      label,
      file: typeof item?.file === 'string' ? item.file.slice(0, 120) : '',
      group: typeof item?.group === 'string' ? item.group.slice(0, 12) : 'other',
      params,
      registered: item?.registered === true,
    })
  }
  const motions = []
  for (const item of Array.isArray(raw.motions) ? raw.motions.slice(0, 60) : []) {
    const label = typeof item?.label === 'string' ? item.label.trim().slice(0, 32) : ''
    if (!label) continue
    motions.push({
      label,
      file: typeof item?.file === 'string' ? item.file.slice(0, 120) : '',
      registered: item?.registered === true,
    })
  }
  if (!expressions.length && !motions.length) {
    warnings.push('能力扫描没有发现表情/动作文件')
    return null
  }
  return {
    scannedAt: Number(raw.scannedAt) || Date.now(),
    root: typeof raw.root === 'string' ? raw.root.slice(0, 260) : '',
    expressions,
    motions,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.slice(0, 6).map((w) => String(w).slice(0, 120)) : [],
  }
}

/** 绑定表只保留「指向存在的档案」的项；路径与档案 id 都归一化。 */
export function normalizeModelPathBindings(raw, profiles) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {}
  for (const [key, value] of Object.entries(source)) {
    const pathKey = normalizeModelKey(key)
    if (!pathKey || typeof value !== 'string' || !profiles || !profiles[value]) continue
    out[pathKey] = value
  }
  return out
}

/** 找实例当前模型对应的档案（只看绑定表，不创建）。 */
export function profileFor(state, inst) {
  const key = normalizeModelKey(inst?.config?.modelPath ?? inst?.modelPath)
  if (!key) return null
  const id = state?.config?.modelPathBindings?.[key]
  return id ? state.config.modelProfiles?.[id] ?? null : null
}

/** 找或建档案（只改内存；写盘由调用方负责）。返回 { ok, profile, created }。 */
export function ensureProfileFor(state, inst) {
  const key = normalizeModelKey(inst?.config?.modelPath ?? inst?.modelPath)
  if (!key) return { ok: false, code: 'no-model-path' }
  const existing = profileFor(state, inst)
  if (existing) return { ok: true, profile: existing, created: false }
  const id = profileIdForKey(key)
  const profiles = { ...(state.config.modelProfiles ?? {}) }
  if (profiles[id]) {
    state.config.modelProfiles = profiles
    state.config.modelPathBindings = { ...(state.config.modelPathBindings ?? {}), [key]: id }
    return { ok: true, profile: profiles[id], created: false }
  }
  const now = Date.now()
  const profile = {
    id,
    label: path.basename(key) || key,
    pathKey: key,
    modelEntry: '',
    fingerprint: '',
    customActions: [],
    presetSequences: [],
    autoActions: [],
    autoActionsHash: '',
    capabilities: null,
    capabilityHash: '',
    capabilityActions: [],
    createdAt: now,
    updatedAt: now,
  }
  profiles[id] = profile
  state.config.modelProfiles = profiles
  state.config.modelPathBindings = { ...(state.config.modelPathBindings ?? {}), [key]: id }
  return { ok: true, profile, created: true }
}

/** 改档案（只归一化 + 替换内存，不写盘）。 */
export function patchProfile(state, profileId, patch) {
  const profiles = { ...(state.config.modelProfiles ?? {}) }
  const current = profiles[profileId]
  if (!current) return { ok: false, code: 'no-such-profile', status: 404 }
  const merged = { ...current, ...(patch ?? {}) }
  const warnings = []
  const normalized = normalizeModelProfiles({ [profileId]: merged }, warnings)
  const next = normalized[profileId]
  if (!next) return { ok: false, code: 'bad-profile', status: 400, warnings }
  next.updatedAt = Date.now()
  profiles[profileId] = next
  state.config.modelProfiles = profiles
  return { ok: true, profile: next, warnings }
}

/** 把动作/循环写进「当前模型档案」并落盘（工具与 HTTP 共用）。 */
export function savePresetsToProfile(state, inst, patch, log = null) {
  const ensured = ensureProfileFor(state, inst)
  if (!ensured.ok) {
    return { ok: false, code: ensured.code, error: '当前实例没有模型路径，无法建立模型档案' }
  }
  const result = patchProfile(state, ensured.profile.id, patch)
  if (!result.ok) {
    return { ok: false, code: result.code || 'bad-profile', error: `保存模型档案失败：${result.code ?? '未知'}` }
  }
  const saved = writeConfigFile(state.config, state.configFile ?? CONFIG_FILE)
  if (!saved.ok) {
    return { ok: false, code: 'save-failed', error: `写配置失败：${saved.error}` }
  }
  try {
    pushPresetsToWindow(state.root ?? state, inst)
  } catch (error) {
    logged(log, `live2d: 推送预设失败：${errorText(error)}`)
  }
  return { ok: true, profile: result.profile, warnings: result.warnings ?? [] }
}

/**
 * 按模型真实参数挑 10 个「能完整做出来」的动作，写进该模型的档案（0.4.0）。
 * 触发时机：渲染层上报 model-params 后；参数集没变就跳过，换模型/资源变了才重挑。
 * 不动 customActions——用户/AI 自定义的动作永远优先保留。
 */
export function ensureAutoActions(state, inst, log = null, options = {}) {
  const root = state?.root ?? state
  const target = inst ?? state
  if (!root?.config || !target) return { ok: false, code: 'no-state' }
  // 参数集可能挂在：实例对象（渲染层上报时写的 rendererParams）/ 窗口状态 / 根状态
  const params = target?.rendererParams?.params
    ?? target?.renderer?.params?.params
    ?? root.renderer?.params?.params
  if (!Array.isArray(params) || params.length < 5) return { ok: false, code: 'no-params' }
  const ensured = ensureProfileFor(root, target)
  if (!ensured.ok) return { ok: false, code: ensured.code }
  const profile = ensured.profile
  const hash = libraryParamsHash(params)
  // 0.5.0：顺带扫模型目录，把 Exp3/Animation 里的表情、换装、动作文件找出来
  const modelPath = target?.config?.modelPath ?? target?.modelPath
  let scan = null
  try {
    scan = options.capabilities ?? (modelPath ? scanModelCapability(modelPath) : null)
  } catch (error) {
    logged(log, `live2d: 能力扫描失败（${modelPath}）：${errorText(error)}`)
  }
  const capHash = scan
    ? createHash('sha1').update(JSON.stringify({ e: scan.expressions, m: scan.motions })).digest('hex').slice(0, 12)
    : ''
  const needAuto = options.force === true || profile.autoActionsHash !== hash
  // 扫描失败（目录不存在/没有 model3.json）不算「能力变化」，避免每帧重扫重写
  const needCap = Boolean(scan?.ok) && (options.force === true || profile.capabilityHash !== capHash)
  if (!needAuto && !needCap) {
    return {
      ok: true, changed: false, profileId: profile.id, hash,
      count: profile.autoActions?.length ?? 0,
      capabilityCount: profile.capabilityActions?.length ?? 0,
      capabilities: profile.capabilities ?? null,
    }
  }
  const patch = {}
  if (needAuto) {
    const picked = pickDefaultActions(params, 10)
    patch.autoActions = picked
    patch.autoActionsHash = hash
  }
  if (needCap) {
    patch.capabilities = scan
    patch.capabilityHash = capHash
    patch.capabilityActions = pickCapabilityActions(scan, params)
  }
  const result = patchProfile(root, profile.id, patch)
  if (!result.ok) return { ok: false, code: result.code || 'bad-profile' }
  const saved = writeConfigFile(root.config, root.configFile ?? CONFIG_FILE)
  if (!saved.ok) return { ok: false, code: 'save-failed', error: saved.error }
  try {
    pushPresetsToWindow(root, target)
  } catch (error) {
    logged(log, `live2d: 推送默认动作失败：${errorText(error)}`)
  }
  const profileNow = result.profile
  // 接入/换模型后主动告诉用户「这只模型能做什么」（每只模型只提示一次，按档案 + 扫描指纹）
  try {
    const caps = profileNow.capabilities
    if (caps) {
      const notifyKey = `${profileNow.id}:${profileNow.capabilityHash}`
      if (root.renderer?.capabilityNotified !== notifyKey) {
        root.renderer = { ...(root.renderer ?? {}), capabilityNotified: notifyKey }
        const by = (group) => caps.expressions.filter((item) => item.group === group).length
        const bits = []
        if (by('face')) bits.push(`${by('face')} 个表情`)
        if (by('clothes')) bits.push(`${by('clothes')} 套换装`)
        if (by('gesture')) bits.push(`${by('gesture')} 个手势`)
        const playable = (profileNow.capabilityActions ?? []).length
        const lines = [`这只模型我摸过了：${bits.join('、') || '没找到表情/换装'}。`]
        if (playable) lines.push(`其中 ${playable} 个能直接用，已经放进右键菜单——点一次开，再点一次关。`)
        if (caps.motions.length) lines.push(`另外有 ${caps.motions.length} 个动画文件（${caps.motions.slice(0, 3).map((item) => item.label).join('、')}…），模型没登记，暂时播不了。`)
        instanceView(root, target).windows.send({
          type: 'bubble',
          text: lines.join(' '),
          format: 'markdown',
          seq: Date.now() % 100000,
          durationMs: 7000,
        })
      }
    }
  } catch { /* 提示失败不影响主流程 */ }
  logged(log, `live2d: 模型能力生成 —— 默认动作 ${profileNow.autoActions?.length ?? 0} 个 / 表情换装 ${profileNow.capabilityActions?.length ?? 0} 个`)
  return {
    ok: true,
    changed: true,
    profileId: profile.id,
    hash,
    count: profileNow.autoActions?.length ?? 0,
    capabilityCount: profileNow.capabilityActions?.length ?? 0,
    capabilities: profileNow.capabilities ?? null,
  }
}

export function createLifeRuntime(seed = {}, now = Date.now()) {
  const numberIn = (value, min, max, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
  }
  return {
    attention: typeof seed.attention === 'string' ? seed.attention : 'unknown',
    previousAttention: null,
    audience: typeof seed.audience === 'string' ? seed.audience : 'unknown',
    lastUserActivityAt: numberIn(seed.lastUserActivityAt, 0, now, now),
    lastModelInteractionAt: numberIn(seed.lastModelInteractionAt, 0, now, now),
    lastAgentStartAt: numberIn(seed.lastAgentStartAt, 0, now, 0),
    lastAgentFinishAt: numberIn(seed.lastAgentFinishAt, 0, now, 0),
    lastForegroundTitle: null,
    lastForegroundProcess: null,
    foregroundSince: numberIn(seed.foregroundSince, 0, now, now),
    lastForegroundReadAt: now,
    systemIdleSec: null,
    systemIdleAt: 0,
    energy: numberIn(seed.energy, 0, 1, 0.72),
    mood: numberIn(seed.mood, -1, 1, 0.08),
    boredom: numberIn(seed.boredom, 0, 1, 0.1),
    closeness: numberIn(seed.closeness, 0, 1, 0),
    lastTickAt: now,
    lastNonverbalAt: numberIn(seed.lastNonverbalAt, 0, now, 0),
    lastEventAt: numberIn(seed.lastEventAt, 0, now, 0),
    lastEvent: typeof seed.lastEvent === 'string' ? seed.lastEvent : 'boot',
    lastVerbalAt: numberIn(seed.lastVerbalAt, 0, now, 0),
    proactiveSinceUser: numberIn(seed.proactiveSinceUser, 0, 100, 0),
    dailyKey: typeof seed.dailyKey === 'string' ? seed.dailyKey : '',
    dailyShare: numberIn(seed.dailyShare, 0, 1000, 0),
    dailyImportant: numberIn(seed.dailyImportant, 0, 1000, 0),
    willingness: typeof seed.willingness === 'string' ? seed.willingness : 'social',
    peerAffinity: numberIn(seed.peerAffinity, 0, 1, 0.2),
    lastPeerInteractionAt: numberIn(seed.lastPeerInteractionAt, 0, now, 0),
    verbalTimes: Array.isArray(seed.verbalTimes)
      ? seed.verbalTimes.map(Number).filter((t) => Number.isFinite(t) && t > now - 60 * 60 * 1000)
      : [],
    focusFiredFor: null,
    eventCounts: seed.eventCounts && typeof seed.eventCounts === 'object' ? { ...seed.eventCounts } : {},
    lastDecision: null,
  }
}

function clockMinutes(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''))
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

export function quietHoursActive(config, now = Date.now()) {
  if (config?.eventQuietEnabled !== true) return false
  const start = clockMinutes(config.eventQuietStart)
  const end = clockMinutes(config.eventQuietEnd)
  if (start === null || end === null || start === end) return false
  const date = new Date(now)
  const minute = date.getHours() * 60 + date.getMinutes()
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end
}

export function lifeDayKey(now = Date.now()) {
  const date = new Date(now)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function lifeDailyBudget(inst, kind = 'share', now = Date.now()) {
  const life = inst?.life ?? {}
  const key = lifeDayKey(now)
  const used = life.dailyKey === key ? Number(kind === 'important' ? life.dailyImportant : life.dailyShare) || 0 : 0
  const max = Math.max(0, Number(kind === 'important' ? inst?.config?.lifeImportantBudgetPerDay : inst?.config?.lifeShareBudgetPerDay) || 0)
  return { ok: used < max, used, max, remaining: Math.max(0, max - used), dayKey: key }
}

export function lifeWillingness(inst) {
  const life = inst?.life ?? {}
  const energy = Number(life.energy) || 0
  const mood = Number(life.mood) || 0
  const boredom = Number(life.boredom) || 0
  const reserve = energy * 0.55 + ((mood + 1) / 2) * 0.25 + (1 - boredom) * 0.2
  if (reserve < 0.3) return { state: 'withdrawn', reserve, nonverbal: false, speak: false, move: false }
  if (reserve < 0.46 || Number(life.proactiveSinceUser) >= 2) {
    return { state: 'tired', reserve, nonverbal: true, speak: false, move: false }
  }
  if (Number(life.proactiveSinceUser) >= 1) {
    return { state: 'reserved', reserve, nonverbal: true, speak: true, move: false }
  }
  return { state: 'social', reserve, nonverbal: true, speak: true, move: true }
}

export function deriveLifeAttention(runtime, config, now = Date.now()) {
  const idleSec = Number(runtime?.systemIdleSec)
  const idleFresh = now - Number(runtime?.systemIdleAt ?? 0) < 20_000
  if (idleFresh && Number.isFinite(idleSec)) {
    if (idleSec * 1000 >= Math.max(60_000, Number(config?.eventWakeAwayMs) || 600_000)) return 'away'
    if (idleSec <= 90) {
      const focusedMs = now - Number(runtime?.foregroundSince ?? now)
      if (runtime?.lastForegroundTitle && focusedMs >= Math.max(60_000, Number(config?.eventWakeFocusMs) || 2_700_000)) return 'focused'
      return 'active'
    }
  }
  const sinceUser = now - Number(runtime?.lastUserActivityAt ?? now)
  if (sinceUser >= Math.max(60_000, Number(config?.eventWakeAwayMs) || 600_000)) return 'away'
  if (sinceUser <= 90_000) {
    const focusedMs = now - Number(runtime?.foregroundSince ?? now)
    if (runtime?.lastForegroundTitle && focusedMs >= Math.max(60_000, Number(config?.eventWakeFocusMs) || 2_700_000)) return 'focused'
    return 'active'
  }
  return 'idle'
}

export function deriveAudience(runtime, config, attention, now = Date.now()) {
  if (config?.audienceAwareEnabled === false) return 'present'
  if (attention === 'away') return 'absent'
  const idleSec = Number(runtime?.systemIdleSec)
  const idleFresh = now - Number(runtime?.systemIdleAt ?? 0) < 20_000
  if (idleFresh && Number.isFinite(idleSec) && idleSec * 1000 >= Math.max(60_000, Number(config?.eventWakeAwayMs) || 600_000)) {
    return 'absent'
  }
  if (attention === 'active' || attention === 'focused') return 'attentive'
  return 'ambient'
}

export function lifeSpeakQuota(inst, now = Date.now()) {
  const max = Math.max(1, Number(inst?.config?.eventWakeMaxPerHour) || 8)
  const times = (inst?.life?.verbalTimes ?? [])
    .map(Number)
    .filter((t) => Number.isFinite(t) && t > now - 60 * 60 * 1000)
    .sort((a, b) => a - b)
  return {
    ok: times.length < max,
    used: times.length,
    max,
    remaining: Math.max(0, max - times.length),
    nextAt: times.length < max ? null : new Date(times[0] + 60 * 60 * 1000).toISOString(),
  }
}

export function lifeStateFile(state) {
  return path.join(path.dirname(state?.configFile || CONFIG_FILE), 'life-state.json')
}

function persistedLife(runtime) {
  return {
    attention: runtime.attention,
    audience: runtime.audience,
    lastUserActivityAt: runtime.lastUserActivityAt,
    lastModelInteractionAt: runtime.lastModelInteractionAt,
    lastAgentStartAt: runtime.lastAgentStartAt,
    lastAgentFinishAt: runtime.lastAgentFinishAt,
    foregroundSince: runtime.foregroundSince,
    energy: runtime.energy,
    mood: runtime.mood,
    boredom: runtime.boredom,
    closeness: runtime.closeness,
    lastNonverbalAt: runtime.lastNonverbalAt,
    lastEventAt: runtime.lastEventAt,
    lastEvent: runtime.lastEvent,
    lastVerbalAt: runtime.lastVerbalAt,
    proactiveSinceUser: runtime.proactiveSinceUser,
    dailyKey: runtime.dailyKey,
    dailyShare: runtime.dailyShare,
    dailyImportant: runtime.dailyImportant,
    willingness: runtime.willingness,
    peerAffinity: runtime.peerAffinity,
    lastPeerInteractionAt: runtime.lastPeerInteractionAt,
    verbalTimes: runtime.verbalTimes,
    eventCounts: runtime.eventCounts,
  }
}

export function restoreLifeState(state, file = lifeStateFile(state)) {
  let doc = null
  try { doc = JSON.parse(readFileSync(file, 'utf8')) } catch { return { ok: false, restored: 0 } }
  const rows = doc?.instances && typeof doc.instances === 'object' ? doc.instances : {}
  let restored = 0
  for (const inst of state.instances ?? []) {
    if (!rows[inst.id]) continue
    inst.life = createLifeRuntime(rows[inst.id])
    restored += 1
  }
  return { ok: true, restored }
}

export function saveLifeState(state, file = lifeStateFile(state)) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const instances = {}
    for (const inst of state.instances ?? []) {
      if (inst.life) instances[inst.id] = persistedLife(inst.life)
    }
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(temp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), instances }, null, 2), 'utf8')
    renameSync(temp, file)
    return { ok: true, file }
  } catch (error) {
    return { ok: false, file, error: errorText(error) }
  }
}

// ---------------------------------------------------------------------------
// P2：陪伴记忆（本地 JSON，与主会话分离）
// ---------------------------------------------------------------------------

export const MEMORY_KINDS = ['preference', 'fact', 'event', 'promise', 'relationship']

export function memoryStateFile(state) {
  const configFile = state?.configFile || CONFIG_FILE
  const dir = path.dirname(configFile)
  const base = path.basename(configFile, '.json')
  return path.join(dir, base === 'config' ? 'memory.json' : `${base}.memory.json`)
}

function emptyMemoryStore() {
  return { version: 1, sessions: {} }
}

function cleanMemoryText(value, max = 500) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max)
}

function cleanMemoryTags(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,，\s]+/)
  return [...new Set(raw.map((item) => cleanMemoryText(item, 24)).filter(Boolean))].slice(0, 8)
}

function normalizeMemoryEntry(raw, sessionId, now = Date.now()) {
  const text = cleanMemoryText(raw?.text)
  if (!text) return null
  const kind = MEMORY_KINDS.includes(raw?.kind) ? raw.kind : 'fact'
  return {
    id: typeof raw?.id === 'string' && /^[\w-]{1,64}$/.test(raw.id) ? raw.id : `mem-${randomUUID()}`,
    sessionId,
    kind,
    text,
    tags: cleanMemoryTags(raw?.tags),
    importance: Math.min(5, Math.max(1, Math.round(Number(raw?.importance) || 3))),
    createdAt: Number(raw?.createdAt) > 0 ? Number(raw.createdAt) : now,
    updatedAt: Number(raw?.updatedAt) > 0 ? Number(raw.updatedAt) : now,
    dormant: raw?.dormant === true,
    dormantAt: Number(raw?.dormantAt) > 0 ? Number(raw.dormantAt) : 0,
    recalledAt: Number(raw?.recalledAt) > 0 ? Number(raw.recalledAt) : 0,
    recallCount: Math.max(0, Math.round(Number(raw?.recallCount) || 0)),
  }
}

export function loadMemoryStore(state, file = memoryStateFile(state)) {
  let doc
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return emptyMemoryStore()
  }
  const source = doc?.sessions && typeof doc.sessions === 'object' ? doc.sessions : {}
  const sessions = {}
  for (const [sessionId, rows] of Object.entries(source)) {
    if (!Array.isArray(rows)) continue
    sessions[sessionId] = rows
      .map((row) => normalizeMemoryEntry(row, sessionId))
      .filter(Boolean)
  }
  return { version: 1, sessions }
}

export function saveMemoryStore(state, store = state?.memory, file = memoryStateFile(state)) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(temp, JSON.stringify(store ?? emptyMemoryStore(), null, 2), 'utf8')
    renameSync(temp, file)
    return { ok: true, file }
  } catch (error) {
    return { ok: false, file, error: errorText(error) }
  }
}

function ensureMemoryStore(state) {
  if (!state.memory || typeof state.memory !== 'object') state.memory = loadMemoryStore(state)
  if (!state.memory.sessions || typeof state.memory.sessions !== 'object') state.memory.sessions = {}
  return state.memory
}

export function listMemories(state, sessionId) {
  if (!sessionId) return []
  const rows = ensureMemoryStore(state).sessions[sessionId]
  return Array.isArray(rows) ? rows.map((row) => ({ ...row, tags: [...(row.tags ?? [])] })) : []
}

function memoryScore(entry, query) {
  const q = cleanMemoryText(query, 120).toLowerCase()
  if (!q) return Number(entry.importance) * 10 + Number(entry.updatedAt) / 1e12
  const haystack = `${entry.text} ${entry.kind} ${(entry.tags ?? []).join(' ')}`.toLowerCase()
  let score = haystack.includes(q) ? 50 : 0
  for (const term of q.split(/\s+/).filter(Boolean)) {
    if (haystack.includes(term)) score += 12
  }
  for (const tag of entry.tags ?? []) {
    if (tag && q.includes(String(tag).toLowerCase())) score += 18
  }
  // 中文用户常把记忆夹在长句里（“今天又喝桂花茶了”）。
  // 用二元片段找稳定共同词，避免必须整句完全包含。
  const qGrams = new Set()
  for (let i = 0; i < q.length - 1; i += 1) qGrams.add(q.slice(i, i + 2))
  const eText = String(entry.text).toLowerCase()
  let commonGrams = 0
  for (let i = 0; i < eText.length - 1; i += 1) {
    if (qGrams.has(eText.slice(i, i + 2))) commonGrams += 1
  }
  score += Math.min(30, commonGrams * 7)
  return score + Number(entry.importance) * 2
}

export function searchMemories(state, sessionId, query = '', limit = 6, options = {}) {
  const q = cleanMemoryText(query, 120)
  const scored = listMemories(state, sessionId)
    .map((entry) => ({ entry, score: memoryScore(entry, query) }))
    .filter((item) => !q || item.score > Number(item.entry.importance) * 2)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
  let changed = false
  const now = Date.now()
  if (q && options.recallDormant !== false) {
    for (const item of scored) {
      if (item.entry.dormant && item.score >= 12) {
        item.entry.dormant = false
        item.entry.dormantAt = 0
        item.entry.recalledAt = now
        item.entry.recallCount = Number(item.entry.recallCount || 0) + 1
        changed = true
      }
    }
  }
  if (changed) {
    const rows = ensureMemoryStore(state).sessions[sessionId]
    if (Array.isArray(rows)) {
      const updates = new Map(scored.map((item) => [item.entry.id, item.entry]))
      state.memory.sessions[sessionId] = rows.map((row) => updates.get(row.id) ?? row)
      saveMemoryStore(state)
    }
  }
  return scored
    .filter((item) => !item.entry.dormant)
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 6)))
    .map((item) => item.entry)
}

function trimMemoryEntries(state, inst, sessionId) {
  const store = ensureMemoryStore(state)
  const max = Math.max(20, Math.min(500, Number(inst?.config?.memoryMaxEntries) || 100))
  const rows = store.sessions[sessionId] ?? []
  store.sessions[sessionId] = rows
    .sort((a, b) => Number(b.importance) - Number(a.importance) || Number(b.updatedAt) - Number(a.updatedAt))
    .slice(0, max)
}

export function memoryMutation(state, inst, sessionId, op, payload = {}, now = Date.now()) {
  if (!inst) return { ok: false, code: 'no-instance', error: '没有这个实例' }
  if (!sessionId) return { ok: false, code: 'memory-no-session', error: '这个模型还没有绑定会话，记忆无法归属' }
  if (inst.config?.memoryEnabled !== true) {
    return { ok: false, code: 'memory-disabled', error: '这个实例的陪伴记忆未启用' }
  }
  const store = ensureMemoryStore(state)
  const rows = store.sessions[sessionId] ?? (store.sessions[sessionId] = [])
  if (op === 'remember' || op === 'add') {
    const entry = normalizeMemoryEntry(payload, sessionId, now)
    if (!entry) return { ok: false, code: 'empty-memory', error: '记忆内容不能为空' }
    const duplicate = rows.find((item) => item.text === entry.text && item.kind === entry.kind)
    if (duplicate) {
      duplicate.tags = [...new Set([...(duplicate.tags ?? []), ...entry.tags])].slice(0, 8)
      duplicate.importance = Math.max(Number(duplicate.importance) || 1, entry.importance)
      duplicate.updatedAt = now
      if (duplicate.dormant) {
        duplicate.dormant = false
        duplicate.dormantAt = 0
        duplicate.recalledAt = now
        duplicate.recallCount = Number(duplicate.recallCount || 0) + 1
      }
      trimMemoryEntries(state, inst, sessionId)
      return { ok: true, entry: { ...duplicate, tags: [...duplicate.tags] }, saved: saveMemoryStore(state) }
    }
    rows.unshift(entry)
    trimMemoryEntries(state, inst, sessionId)
    return { ok: true, entry, saved: saveMemoryStore(state) }
  }
  if (op === 'update') {
    const id = cleanMemoryText(payload?.id, 64)
    const index = rows.findIndex((item) => item.id === id)
    if (index < 0) return { ok: false, code: 'no-such-memory', error: `没有记忆 ${id || '(空)'}` }
    const current = rows[index]
    const next = normalizeMemoryEntry({ ...current, ...payload, id: current.id, createdAt: current.createdAt, updatedAt: now }, sessionId, now)
    if (!next) return { ok: false, code: 'empty-memory', error: '记忆内容不能为空' }
    rows[index] = next
    trimMemoryEntries(state, inst, sessionId)
    return { ok: true, entry: next, saved: saveMemoryStore(state) }
  }
  if (op === 'forget') {
    const id = cleanMemoryText(payload?.id, 64)
    const entry = rows.find((item) => item.id === id)
    if (!entry) return { ok: false, code: 'no-such-memory', error: `没有记忆 ${id || '(空)'}` }
    entry.dormant = true
    entry.dormantAt = now
    entry.updatedAt = now
    return { ok: true, entry: { ...entry, tags: [...(entry.tags ?? [])] }, dormant: true, saved: saveMemoryStore(state) }
  }
  if (op === 'recall') {
    const id = cleanMemoryText(payload?.id, 64)
    const entry = rows.find((item) => item.id === id)
    if (!entry) return { ok: false, code: 'no-such-memory', error: `没有记忆 ${id || '(空)'}` }
    entry.dormant = false
    entry.dormantAt = 0
    entry.recalledAt = now
    entry.recallCount = Number(entry.recallCount || 0) + 1
    entry.updatedAt = now
    return { ok: true, entry: { ...entry, tags: [...(entry.tags ?? [])] }, dormant: false, saved: saveMemoryStore(state) }
  }
  if (op === 'forget-old') {
    const days = Math.max(1, Math.min(3650, Math.round(Number(payload?.olderThanDays) || 90)))
    const cutoff = now - days * 24 * 60 * 60 * 1000
    let dormantCount = 0
    for (const row of rows) {
      if (!row.dormant && Number(row.updatedAt) < cutoff) {
        row.dormant = true
        row.dormantAt = now
        dormantCount += 1
      }
    }
    return { ok: true, dormantCount, olderThanDays: days, saved: saveMemoryStore(state) }
  }
  return { ok: false, code: 'bad-memory-op', error: `不支持的记忆操作：${op}` }
}

export function memoryPromptLines(state, inst, query = '', limit = 4) {
  if (inst?.config?.memoryEnabled !== true) return []
  const sessionId = String(inst.config?.sessionId ?? '')
  if (!sessionId) return []
  const rows = searchMemories(state, sessionId, query, limit)
  if (!rows.length) return []
  return [
    '陪伴记忆（只作为背景，不要逐字复述，也不要声称记得没有列出的内容）：',
    ...rows.map((entry) => `- [${entry.kind}] ${entry.text}`),
  ]
}

function updateLifeNeeds(runtime, config, attention, now, interacted = false) {
  const dtHours = Math.min(1, Math.max(0, (now - Number(runtime.lastTickAt ?? now)) / 3_600_000))
  if (attention === 'active' || attention === 'focused') {
    runtime.energy = Math.max(0, runtime.energy - dtHours * 0.08)
    runtime.boredom = Math.min(1, runtime.boredom + dtHours * 0.04)
  } else {
    runtime.energy = Math.min(1, runtime.energy + dtHours * 0.14)
    runtime.boredom = Math.min(1, runtime.boredom + dtHours * 0.09)
  }
  if (interacted) {
    runtime.energy = Math.min(1, runtime.energy + 0.025)
    runtime.mood = Math.min(1, runtime.mood + 0.08)
    runtime.boredom = Math.max(0, runtime.boredom - 0.22)
    runtime.closeness = Math.min(1, runtime.closeness + 0.01)
  } else {
    runtime.mood += (0 - runtime.mood) * Math.min(1, dtHours * 1.5)
  }
  runtime.lastTickAt = now
}

function createInstanceState(item, root) {
  return {
    id: item.id,
    config: item,
    root,
    model: null,
    renderer: { state: 'stopped', lastError: null, model: null, initQueued: false },
    bubble: { seq: 0, bubbleCount: 0, lastIdentity: null, lastMessageId: null, lastAt: 0, lastShown: null },
    chat: { pending: null, lastReply: null, lastError: null, history: [], queue: [], finishTimer: null, timeoutTimer: null, replySource: null },
    // 动作指令台账（阶段 4）：冷却、最近动作、超时确认
    anim: { lastAt: 0, lastAction: null, count: 0, timeout: false, ackedAt: null },
    // 读屏台账（标题缓存 + 截图限速）。必须落在实例上——视图每次请求新建，
    // 写视图会随请求丢弃（0.12.4 限速失效就是这么来的）。
    screen: {
      lastAt: 0,
      lastTitle: null,
      lastProcess: null,
      lastCaptureAt: 0,
      count: 0,
      captureCount: 0,
      lastSize: null,
      inFlight: false,
    },
    // 窗口运行状态（由 ready/closed/error 协议消息维护）
    window: { state: 'stopped', bounds: null, ready: false, error: null, title: '', pushedTitle: null, pinned: null },
    // 主动唤醒台账（0.13.0）：滚动额度、上一轮结果、pending 截图
    wake: {
      state: 'idle',
      at: null,
      source: null,
      times: [],
      count: 0,
      lastResult: null,
      shots: [],
    },
    life: createLifeRuntime(),
    windowBounds: null,
    recentSessionId: null,
    resolvedBy: null,
  }
}

/** 让 state.instances 与 state.config.instances 对齐（新增/删除/更新引用，实例对象本身尽量保持稳定）。 */
export function syncInstances(state) {
  const list = Array.isArray(state.config?.instances) ? state.config.instances : []
  const existing = new Map((state.instances ?? []).map((inst) => [inst.id, inst]))
  const next = []
  for (const item of list) {
    const inst = existing.get(item.id) ?? createInstanceState(item, state)
    inst.id = item.id
    inst.config = item
    inst.root = state
    next.push(inst)
    existing.delete(item.id)
  }
  state.instances = next
  return next
}

/** 默认实例 = instances 数组第一个（用户拍板）；删掉第一个后下一个顶上来。 */
export function defaultInstance(state) {
  return state.instances?.[0] ?? null
}

export function findInstance(state, instanceId) {
  if (!instanceId) return defaultInstance(state)
  return state.instances?.find((inst) => inst.id === instanceId) ?? null
}

/**
 * 严格解析目标实例（给路由/AI 工具用）：
 * - 传了 id 但不存在 → `{ ok:false, code:'no-such-instance' }`，**不回落默认实例**；
 * - 没传 id → 默认实例（instances[0]），并在返回值里标明 resolvedBy='default'，方便审计。
 */
export function resolveInstanceStrict(state, instanceId) {
  const raw = typeof instanceId === 'string' ? instanceId.trim() : ''
  if (!raw) {
    const inst = defaultInstance(state)
    if (!inst) return { ok: false, code: 'no-instance', status: 503, error: '当前没有任何实例' }
    return { ok: true, instance: inst, resolvedBy: 'default' }
  }
  const inst = state.instances?.find((item) => item.id === raw) ?? null
  if (!inst) {
    return {
      ok: false,
      code: 'no-such-instance',
      status: 404,
      error: `实例不存在：${raw}`,
      available: (state.instances ?? []).map((item) => item.id),
    }
  }
  return { ok: true, instance: inst, resolvedBy: 'explicit' }
}

/**
 * 模式权限（报告 P0-3）：auto 模式下对话不主动控制模型。
 * capability: 'anim' | 'bubble' | 'screen' | 'capture'
 */
export function modeAllows(inst, capability) {
  // 只有 auto 是「对话完全不控制」；manual / semi 都允许 AI 主动动作。
  // semi 的差异在「自动上气泡 + 思考期自动动作」，不是「禁止 AI」——
  // 用户亲口说「点个头」却被 403，是体验硬伤（0.12.10 首版踩到）。
  return canControl(inst, capability, { source: 'tool' })
}

export const CONTROL_SOURCES = ['ui', 'wake-button', 'wake-timer', 'wake-event', 'window-chat', 'external-chat', 'preset-tap', 'tool']

const normalMode = (inst) => {
  const mode = inst?.config?.mode
  return mode === 'auto' || mode === 'semi' ? mode : 'manual'
}

/**
 * 四维权限（0.13.0）：同一能力在不同触发来源下结论不同。
 * 例：auto 不允许 AI 主动推气泡，但用户点 ⚡ 后那一轮必须能回气泡。
 */
export function canControl(inst, capability, ctx = {}) {
  const mode = normalMode(inst)
  const source = CONTROL_SOURCES.includes(ctx.source) ? ctx.source : 'tool'

  // 用户亲手点模型/摸头：不是 AI 控制，只看开关（调用方查 autoInteract）
  if (capability === 'preset-tap') return true

  switch (capability) {
    case 'anim':
    case 'action':
      // source='ui' = 用户在设置页/右键菜单亲手点，不受模式限制；
      // 用户在 auto 里点 ⚡ 也不放开 AI 动作（用户确认）
      if (source === 'ui') return true
      return mode !== 'auto'
    case 'bubble':
      if (source === 'window-chat') return true // 用户在窗口里说话，auto 也要回
      if (source === 'wake-button') return true // 用户主动唤醒，auto 也要回
      if (source === 'wake-timer') return mode !== 'auto'
      return mode !== 'auto' // external-chat / tool
    case 'screen':
    case 'capture':
      if (source === 'wake-button') return true // 按钮 = 本次授权
      return mode !== 'auto'
    case 'window':
      // 移动/缩放窗口：只有手动 + 显式开启 aiMoveEnabled
      return mode === 'manual' && inst?.config?.aiMoveEnabled === true
    case 'wake':
      if (source === 'wake-button') return true
      return mode !== 'auto'
    default:
      return false
  }
}

/** 等窗口回报一次新的几何（set-bounds 之后用；at 是回报时间戳）。 */
export async function waitForBounds(inst, beforeAt = 0, timeoutMs = 1800) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const at = inst?.windowBounds?.at ?? 0
    if (at && at > beforeAt) return inst.windowBounds
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  return null
}

export function modeForbidden(inst, capability) {  return {
    ok: false,
    status: 403,
    code: 'mode-forbidden',
    mode: inst?.config?.mode ?? 'auto',
    capability,
    error: `当前是「手动」模式，AI 不会主动${
      capability === 'anim' ? '播放动作' : capability === 'bubble' ? '推送气泡' : '读屏'
    }（想让它主动，可在设置页或窗口模式菜单里切到「AI 半自动 / AI 自动」）`,
  }
}

/**
 * 实例视图：给既有单实例代码（气泡/对话/协议处理）一个「像旧 state 一样」的对象。
 * config 是「全局 + 该实例」的合并视图（只读），写回一律走 patchInstance。
 */
export function instanceView(state, inst) {
  if (!inst) return null
  const root = state
  const view = {
    id: inst.id,
    warnings: root.warnings,
    warningSources: root.warningSources,
    configFile: root.configFile,
    root,
    windows: {
      send: (command) => root.windows?.send?.(command, inst.id) ?? { ok: false, error: '窗口管理器不可用' },
      status: () => {
        const base = root.windows?.status?.() ?? {}
        return { ...base, ready: Boolean(inst.window?.ready), instanceReady: Boolean(inst.window?.ready) }
      },
      open: () => openInstanceWindow(root, inst.id),
      close: () => closeInstanceWindow(root, inst.id),
    },
    applyBounds: (bounds) => applyInstanceBounds(root, inst, bounds),
  }
  // 这几个字段会被整体赋值（state.chat = {...} / state.model = probe(...)），
  // 视图上直接赋值会丢，所以全部写回实例对象。
  for (const key of ['model', 'renderer', 'bubble', 'chat', 'anim', 'window', 'windowBounds', 'recentSessionId', 'resolvedBy', 'screen', 'wake', 'life']) {
    Object.defineProperty(view, key, {
      get: () => inst[key],
      set: (value) => { inst[key] = value },
      enumerable: true,
      configurable: true,
    })
  }
  // 全局字段（P2 台账 / 事件订阅 / 阶段）挂在 root 上，视图只读转发
  for (const key of ['p2', 'eventSubscription', 'selfTest', 'phase', 'routesRegistered']) {
    Object.defineProperty(view, key, {
      get: () => root[key],
      set: (value) => { root[key] = value },
      enumerable: true,
      configurable: true,
    })
  }
  // config / instances 动态合并：patch 之后旧视图也要看到新值
  // 0.3.2：customActions / presetSequences 来自「模型档案」（按 modelPath 绑定），不再来自实例
  Object.defineProperty(view, 'config', {
    get: () => {
      const profile = profileFor(root, inst)
      return {
        ...root.config,
        ...inst.config,
        customActions: profile?.customActions ?? [],
        presetSequences: profile?.presetSequences ?? [],
        autoActions: profile?.autoActions ?? [],
        capabilityActions: profile?.capabilityActions ?? [],
        capabilities: profile?.capabilities ?? null,
      }
    },
    enumerable: true,
    configurable: true,
  })
  // 当前模型档案（没绑定就是 null）
  Object.defineProperty(view, 'profile', {
    get: () => profileFor(root, inst),
    enumerable: true,
    configurable: true,
  })
  Object.defineProperty(view, 'instances', {
    get: () => root.config.instances,
    enumerable: true,
    configurable: true,
  })
  return view
}

/** 改一个实例的参数 → 归一化 → 唯一性校验 → 同步 state.config 与 state.instances。 */
export function patchInstance(state, instanceId, patch) {
  const before = state.config
  if (!(before.instances ?? []).some((item) => item.id === instanceId)) {
    return { ok: false, status: 404, error: `没有实例 ${instanceId}` }
  }
  // 兼容旧调用方：只传 wakeEnabled/eventWakeEnabled 时也映射到唯一的 wakeDriver。
  const effectivePatch = { ...(patch ?? {}) }
  if (!Object.prototype.hasOwnProperty.call(effectivePatch, 'wakeDriver')) {
    const current = (before.instances ?? []).find((item) => item.id === instanceId)
    if (effectivePatch.wakeEnabled === true) effectivePatch.wakeDriver = 'timer'
    else if (effectivePatch.eventWakeEnabled === true) effectivePatch.wakeDriver = 'event'
    else if (effectivePatch.wakeEnabled === false && current?.wakeDriver === 'timer') effectivePatch.wakeDriver = 'off'
    else if (effectivePatch.eventWakeEnabled === false && current?.wakeDriver === 'event') effectivePatch.wakeDriver = 'off'
  }
  // 记下改之前是否启用：false → true 要自动开窗（和「停用即关窗」对称）
  const wasEnabled = (before.instances ?? []).find((item) => item.id === instanceId)?.enabled !== false
  const list = (before.instances ?? []).map((item) => (item.id === instanceId ? { ...item, ...effectivePatch } : item))
  const normalized = normalizeConfig({ ...before, instances: list })
  const check = validateInstances(normalized.config)
  if (!check.ok) return { ok: false, ...check, config: normalized.config, warnings: normalized.warnings }
  state.config = normalized.config
  setWarningSource(state, 'config', normalized.warnings)
  syncInstances(state)
  // 由窗口自己发起的开关（置顶/调整模式）也要回推一次，保证多端配置一致
  try {
    const inst = (state.instances ?? []).find((item) => item.id === instanceId)
    if (inst) state.windows?.send?.({ type: 'config', patch: effectivePatch }, inst.id)
  } catch { /* 窗口没开就只落盘 */ }
  // 取消「启用模型」= 真的停用（停循环/停动作/关窗）；反之从关到开就把窗口拉起来，两端对称
  try {
    const live = (state.instances ?? []).find((item) => item.id === instanceId)
    if (live && live.config?.enabled === false) {
      deactivateInstance(state, live)
    } else if (live && wasEnabled === false && live.config?.enabled !== false && live.config?.rendererEnabled !== false) {
      const opened = openInstanceWindow(state, live.id)
      if (opened && opened.ok === false) pushRuntimeWarning(state, `启用实例后开窗失败：${opened.error ?? '未知原因'}`)
    }
  } catch (error) {
    pushRuntimeWarning(state, `停用实例失败：${errorText(error)}`)
  }
  return { ok: true, config: normalized.config, warnings: normalized.warnings }
}

/** 停用一个实例：停循环 → 复位动作/唤醒/对话 → 关窗（幂等，窗口没开也安全）。 */
export function deactivateInstance(state, inst) {
  if (!inst) return { ok: false, code: 'no-instance' }
  const farewell = sendFarewell(state, inst, 'disabled')
  try { stopPresetSequence(state, inst) } catch { /* 没在跑就算了 */ }
  try {
    instanceView(state, inst).windows?.send?.({ type: 'anim', action: 'idle', timeoutMs: 1200 }, inst.id)
  } catch { /* 窗口可能已关 */ }
  if (inst.wake) inst.wake.state = 'idle'
  if (inst.chat) {
    inst.chat.pending = null
    inst.chat.replySource = null
    inst.chat.resolvedBy = null
  }
  instanceView(state, inst).windows?.send?.({ type: 'thinking', on: false }, inst.id)
  let closed = null
  const isolated = state.configFile && state.configFile !== CONFIG_FILE
  if (farewell.ok && !isolated) {
    const timer = setTimeout(() => {
      try { closeInstanceWindow(state, inst.id) } catch { /* 已关闭 */ }
    }, 1400)
    if (typeof timer.unref === 'function') timer.unref()
  } else {
    closed = closeInstanceWindow(state, inst.id)
  }
  return { ok: true, instanceId: inst.id, sent: closed?.sent ?? null, farewell }
}

export function farewellText(inst, now = Date.now()) {
  const hour = new Date(now).getHours()
  const will = lifeWillingness(inst)
  if (will.state === 'withdrawn') return '今天有点没精神，我先安静休息了。'
  if (hour >= 22 || hour < 5) return '不早啦，我先去休息，晚安。'
  if (will.state === 'tired') return '有点累了，我先去歇一会儿，下次见。'
  if (Number(inst?.life?.mood) < -0.15) return '我先安静一会儿，回头再找你。'
  return '那我先休息啦，下次见。'
}

export function sendFarewell(state, inst, reason = 'shutdown', now = Date.now()) {
  if (!inst || inst.config?.lifeFarewellEnabled === false) return { ok: false, code: 'farewell-disabled' }
  if (inst.window?.ready !== true) return { ok: false, code: 'window-not-ready' }
  const text = farewellText(inst, now)
  const seq = (inst.bubble?.seq ?? 0) + 1
  inst.bubble = {
    ...(inst.bubble ?? {}),
    seq,
    bubbleCount: (inst.bubble?.bubbleCount ?? 0) + 1,
    lastIdentity: textIdentity(text),
    lastAt: now,
    lastShown: new Date(now).toISOString(),
  }
  let sent = null
  try {
    const view = instanceView(state, inst)
    view.windows.send({ type: 'anim', action: 'nod', timeoutMs: 1800 })
    view.windows.send({ type: 'look-at', mode: 'user', durationMs: 1800 })
    sent = view.windows.send({
      type: 'bubble',
      text,
      format: 'text',
      seq,
      durationMs: 1200,
      source: `farewell-${reason}`,
    })
  } catch (error) {
    return { ok: false, code: 'farewell-send-failed', error: errorText(error) }
  }
  inst.life = {
    ...(inst.life ?? createLifeRuntime({}, now)),
    lastEventAt: now,
    lastEvent: `farewell-${reason}`,
  }
  return { ok: sent?.ok !== false, text, sent: sent ?? null }
}

/** 调整框松手：把窗口真实几何写回该实例的配置（夹到边界，不回落默认）。 */
function applyInstanceBounds(state, inst, bounds) {
  if (!bounds || typeof bounds !== 'object') return { ok: false, error: 'bounds 缺失' }
  const patch = {
    windowWidth: clampRange(bounds.width, LIMITS.windowWidth, inst.config.windowWidth),
    windowHeight: clampRange(bounds.height, LIMITS.windowHeight, inst.config.windowHeight),
    windowX: clampRange(bounds.x, LIMITS.windowPosition, inst.config.windowX ?? 0),
    windowY: clampRange(bounds.y, LIMITS.windowPosition, inst.config.windowY ?? 0),
  }
  inst.windowBounds = { x: patch.windowX, y: patch.windowY, width: patch.windowWidth, height: patch.windowHeight }
  const keys = Object.keys(patch)
  const changed = keys.some((key) => inst.config[key] !== patch[key])
  if (!changed) return { ok: true, saved: false, config: inst.config }
  const result = patchInstance(state, inst.id, patch)
  if (!result.ok) {
    pushRuntimeWarning(state, `窗口几何未保存：${result.error}`)
    return { ok: false, error: result.error }
  }
  const saved = writeConfigFile(state.config, state.configFile ?? CONFIG_FILE)
  if (!saved.ok) pushRuntimeWarning(state, `窗口尺寸/位置写盘失败：${saved.error}`)
  return { ok: true, saved: saved.ok, config: result.config }
}

// ---------------------------------------------------------------------------
// 告警（按来源分组，可整体替换）
// ---------------------------------------------------------------------------

const WARNING_LIMIT = 20

function normalizeReplyStyle(value, warnings) {
  if (value === undefined || value === null) return DEFAULT_CONFIG.replyStyle
  if (value === 'bubble' || value === 'card') return value
  warnings.push(`replyStyle 取值 ${JSON.stringify(value)} 非法（合法 bubble / card），已回落 bubble`)
  return 'bubble'
}

export const BUBBLE_SKINS = ['classic', 'cloud', 'signboard', 'note']

function normalizeBubbleSkin(value, warnings) {
  if (value === undefined || value === null) return DEFAULT_INSTANCE.bubbleSkin
  if (BUBBLE_SKINS.includes(value)) return value
  warnings.push(`bubbleSkin 取值 ${JSON.stringify(value)} 非法（合法 ${BUBBLE_SKINS.join(' / ')}），已回落 classic`)
  return 'classic'
}

export const WAKE_DRIVERS = ['off', 'timer', 'event']

/**
 * 定时唤醒与事件唤醒只允许选一个。旧配置里两个布尔值同时为 true 时，
 * 保留更早、更可预测的定时唤醒，并给出告警。
 */
export function normalizeWakeDriver(source = {}, warnings = []) {
  if (WAKE_DRIVERS.includes(source.wakeDriver)) return source.wakeDriver
  if (source.wakeDriver !== undefined && source.wakeDriver !== null) {
    warnings.push(`wakeDriver 取值 ${JSON.stringify(source.wakeDriver)} 非法（合法 off / timer / event），已按旧开关推断`)
  }
  if (source.wakeEnabled === true && source.eventWakeEnabled === true) {
    warnings.push('定时唤醒与事件唤醒不能同时启用，已保留定时唤醒')
    return 'timer'
  }
  if (source.eventWakeEnabled === true) return 'event'
  if (source.wakeEnabled === true) return 'timer'
  return 'off'
}

export function lifeStatusSnapshot(inst) {
  const life = inst?.life ?? {}
  const config = inst?.config ?? {}
  return {
    enabled: config.lifeEnabled !== false,
    nonverbalEnabled: config.lifeNonverbalEnabled !== false,
    audienceAwareEnabled: config.audienceAwareEnabled !== false,
    memoryEnabled: config.memoryEnabled === true,
    dualRelationEnabled: config.dualRelationEnabled !== false,
    wakeDriver: config.wakeDriver ?? 'off',
    attention: life.attention ?? 'unknown',
    audience: life.audience ?? 'unknown',
    willingness: life.willingness ?? 'social',
    energy: Number(life.energy) || 0,
    mood: Number(life.mood) || 0,
    boredom: Number(life.boredom) || 0,
    closeness: Number(life.closeness) || 0,
    peerAffinity: Number(life.peerAffinity) || 0,
    proactiveSinceUser: Number(life.proactiveSinceUser) || 0,
    dailyShare: Number(life.dailyShare) || 0,
    dailyShareMax: Number(config.lifeShareBudgetPerDay) || 0,
    dailyImportant: Number(life.dailyImportant) || 0,
    dailyImportantMax: Number(config.lifeImportantBudgetPerDay) || 0,
    lastUserActivityAt: Number(life.lastUserActivityAt) || 0,
    lastEvent: typeof life.lastEvent === 'string' ? life.lastEvent : 'boot',
    lastDecision: life.lastDecision ?? null,
  }
}

function pushLifeStatus(root, inst) {
  if (!inst || inst.window?.ready !== true) return
  try {
    root?.windows?.send?.({ type: 'life-status', status: lifeStatusSnapshot(inst) }, inst.id)
  } catch { /* 窗口正在关闭时忽略 */ }
}

function normalizeLayoutMode(value, warnings) {
  if (value === undefined || value === null) return DEFAULT_INSTANCE.modelLayoutMode
  if (value === 'fit' || value === 'zoom-overlay') return value
  warnings.push(`modelLayoutMode 取值 ${JSON.stringify(value)} 非法（合法 fit / zoom-overlay），已回落 fit`)
  return 'fit'
}

/**
 * 替换某个来源的告警并重算 state.warnings。
 * config / model 每次重新归一化、重新探测都会整体替换 ——
 * 这样「把路径改对了、刷新后旧告警还挂着」的问题不会出现。
 */
export function setWarningSource(state, source, list) {
  if (!state.warningSources) state.warningSources = { config: [], model: [], runtime: [] }
  const next = (Array.isArray(list) ? list : []).filter((item) => typeof item === 'string' && item.trim())
  state.warningSources[source] = next
  const merged = [
    ...state.warningSources.config,
    ...state.warningSources.model,
    ...state.warningSources.runtime,
  ]
  // 原地更新：实例视图拿的是同一个数组引用，整体赋值会让视图里的 warnings 变成旧快照
  if (Array.isArray(state.warnings)) {
    state.warnings.length = 0
    state.warnings.push(...merged)
  } else {
    state.warnings = merged
  }
  return state.warnings
}

/** 追加一条运行期告警（去重、上限 20）。用于渲染失败 / 服务缺失这类一次性事件。 */
export function pushRuntimeWarning(state, message) {
  if (typeof message !== 'string' || !message.trim()) return state.warnings
  const list = [...(state.warningSources?.runtime ?? [])]
  if (!list.includes(message)) list.push(message)
  while (list.length > WARNING_LIMIT) list.shift()
  return setWarningSource(state, 'runtime', list)
}

/** 清掉以某个前缀开头的运行期告警（渲染成功后清「渲染失败：…」）。 */
export function clearRuntimeWarnings(state, prefix) {
  const list = (state.warningSources?.runtime ?? []).filter((item) => !item.startsWith(prefix))
  return setWarningSource(state, 'runtime', list)
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer) })
}

function jsonResponse(res, statusCode, value) {
  const body = JSON.stringify(value, null, 2)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

function htmlResponse(res, html) {
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'")
  res.end(html)
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function preview(text, max = 90) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * 只取「模型真正说出来的话」。
 * assistant 消息的 content 里可能同时有 reasoning（思考链）和 text 块；
 * 早先这里把每个 part 的 text 都拼上，结果气泡/窗口回复开头是思考链内容。
 */
function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => {
        if (typeof part === 'string') return true
        if (!part || typeof part !== 'object') return false
        const type = String(part.type ?? '').toLowerCase()
        if (!type) return typeof part.text === 'string'
        return type === 'text' || type === 'output_text'
      })
      .map((part) => (typeof part === 'string' ? part : part.text ?? ''))
      .filter(Boolean)
      // 多个 text 块之间用空行连接：保留原回答的段落边界（用空格会把多段粘成一段）
      .join('\n\n')
  }
  return ''
}

// ---------------------------------------------------------------------------
// 阶段 1：配置持久化（原子写：tmp + rename）
// ---------------------------------------------------------------------------

export function readConfigFile(file = CONFIG_FILE) {
  try {
    if (!existsSync(file)) return { ok: true, exists: false, data: {} }
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return { ok: true, exists: true, data: data && typeof data === 'object' && !Array.isArray(data) ? data : {} }
  } catch (error) {
    return { ok: false, exists: existsSync(file), error: errorText(error), data: {} }
  }
}

// 只有「用户在设置页能调」的字段才落盘。
// 落盘全部字段会把 crashOnLoad / shellSelfTest 这类验收开关也写进文件，
// 之后 patch 里的同名配置就永远被文件覆盖（实测导致验收开关失效）。
export const PERSISTED_KEYS = [
  // 0.3.2：模型档案（动作/循环按模型共享）+ 路径绑定表 + schema 版本
  'schemaVersion',
  'modelProfiles',
  'modelPathBindings',
  // 多实例：所有实例参数都在这里，镜像字段只用于兼容读取
  'instances',
  'bubbleDurationMs',
  'bubbleQueueLimit',
  'bubbleMaxChars',
  'autoOpenWindow',
  'modelPath',
  'windowWidth',
  'windowHeight',
  'windowX',
  'windowY',
  'rendererEnabled',
  'clickThrough',
  'modelPassthrough',
  'adjustMode',
  'replyStyle',
  'replyOpacity',
  'boundSessionId',
  // 0.13.9：一次性迁移标记（记录哪些版本级迁移跑过），避免每次启动都把用户关掉的开关又打开
  'migrated',
]

/** 模式功能开关：关掉会让「切模式」看不出区别，故决定默认开（用户反馈）。 */
export const MODE_SWITCH_KEYS = ['screenReadEnabled', 'screenCaptureEnabled', 'wakeCaptureEnabled', 'wakeEnabled', 'aiMoveEnabled']

/**
 * 0.13.9 一次性迁移：把存量配置里的模式开关打开，并写入标记。
 * 只跑一次——之后用户在「模式设置」里关掉就保持关闭。
 */
export function migrateModeSwitches(state, marker = '0.13.9-mode-switches') {
  const done = Array.isArray(state?.config?.migrated) ? state.config.migrated : []
  if (done.includes(marker)) return []
  const changed = []
  for (const inst of state?.config?.instances ?? []) {
    for (const key of MODE_SWITCH_KEYS) {
      if (inst[key] !== true) {
        inst[key] = true
        changed.push(`${inst.id}.${key}`)
      }
    }
    if (inst.wakeDriver === 'off') {
      inst.wakeDriver = 'timer'
      changed.push(`${inst.id}.wakeDriver`)
    }
  }
  if (state?.config) state.config.migrated = [...done, marker]
  return changed
}

/**
 * 0.3.2 一次性迁移：把实例上的 customActions / presetSequences 搬进「模型档案」。
 * 流程（用户要求）：备份 → 创建/合并档案 → 校验 → 原子写盘 → 确认成功后再清空实例字段 → 迁移报告。
 * 这个函数只做「计算 + 改内存」，写盘与清空交给调用方（apply），保证「先写盘成功再清空」。
 */
export function migrateModelProfiles(state, marker = '0.3.2-model-profiles') {
  const done = Array.isArray(state?.config?.migrated) ? state.config.migrated : []
  if (done.includes(marker)) return { changed: false, report: null }
  const report = { created: [], merged: [], conflicts: [], cleared: [], legacyTargets: [], skipped: [] }
  const profiles = { ...(state.config.modelProfiles ?? {}) }
  const bindings = { ...(state.config.modelPathBindings ?? {}) }

  const uniqueId = (base, taken) => {
    let suffix = 2
    let next = `${base}-${suffix}`
    while (taken(next)) {
      suffix += 1
      next = `${base}-${suffix}`
    }
    return next
  }

  for (const inst of state.config.instances ?? []) {
    const key = normalizeModelKey(inst.modelPath)
    const actions = Array.isArray(inst.customActions) ? inst.customActions : []
    const seqs = Array.isArray(inst.presetSequences) ? inst.presetSequences : []
    if (!key || (!actions.length && !seqs.length)) continue
    const id = bindings[key] ?? profileIdForKey(key)
    const now = Date.now()
    let profile = profiles[id]
    if (!profile) {
      profile = {
        id,
        label: path.basename(key) || key,
        pathKey: key,
        modelEntry: '',
        fingerprint: '',
        customActions: [],
        presetSequences: [],
        createdAt: now,
        updatedAt: now,
      }
      profiles[id] = profile
      report.created.push(id)
    }
    const actionIds = () => new Set(profile.customActions.map((item) => item.id))
    const seqIds = () => new Set(profile.presetSequences.map((item) => item.id))
    // 动作：同 id 同内容去重；同 id 不同内容 → 保留两份，后到的加后缀并改写循环步骤引用
    const renamed = new Map()
    for (const action of actions) {
      const norm = normalizeCustomActions([action], [])[0]
      if (!norm) {
        report.skipped.push(`${inst.id}:${action?.id ?? '?'}`)
        continue
      }
      const exist = profile.customActions.find((item) => item.id === norm.id)
      if (!exist) {
        profile.customActions.push(norm)
        report.merged.push(`${id}:${norm.id}`)
        continue
      }
      if (JSON.stringify(exist) === JSON.stringify(norm)) continue
      const nextId = uniqueId(norm.id, (candidate) => actionIds().has(candidate) || BUILTIN_ACTION_IDS.has(candidate))
      profile.customActions.push({ ...norm, id: nextId })
      renamed.set(norm.id, nextId)
      report.conflicts.push({ profileId: id, kind: 'action', from: norm.id, to: nextId })
    }
    // 循环：同 id 同内容去重；不同内容加后缀；步骤里被改名的动作同步改写
    for (const seq of seqs) {
      const remapped = {
        ...seq,
        steps: (Array.isArray(seq.steps) ? seq.steps : []).map((step) => renamed.get(step) ?? step),
      }
      const norm = normalizePresetSequences([remapped], [])[0]
      if (!norm) {
        report.skipped.push(`${inst.id}:${seq?.id ?? '?'}`)
        continue
      }
      if (Array.isArray(seq.targets) && seq.targets.length) {
        report.legacyTargets.push({ profileId: id, sequenceId: norm.id, targets: seq.targets })
      }
      const exist = profile.presetSequences.find((item) => item.id === norm.id)
      if (!exist) {
        profile.presetSequences.push(norm)
        report.merged.push(`${id}:${norm.id}`)
        continue
      }
      if (JSON.stringify(exist) === JSON.stringify(norm)) continue
      const nextId = uniqueId(norm.id, (candidate) => seqIds().has(candidate))
      profile.presetSequences.push({ ...norm, id: nextId })
      report.conflicts.push({ profileId: id, kind: 'sequence', from: norm.id, to: nextId })
    }
    bindings[key] = id
    profile.updatedAt = now
  }

  const normalized = normalizeModelProfiles(profiles, [])
  state.config.modelProfiles = normalized
  state.config.modelPathBindings = normalizeModelPathBindings(bindings, normalized)
  state.config.migrated = [...done, marker]
  // 校验：每个绑定都要指向存在的档案
  for (const [key, id] of Object.entries(state.config.modelPathBindings)) {
    if (!normalized[id]) report.skipped.push(`binding:${key}`)
  }
  return { changed: true, report, profiles: normalized, bindings: state.config.modelPathBindings }
}

/** 迁移写盘成功后调用：清空实例上的旧动作/循环字段（此时档案已落盘，丢了也能重建）。 */
export function clearLegacyInstancePresets(state) {
  const cleared = []
  for (const inst of state.config.instances ?? []) {
    if (Array.isArray(inst.customActions) && inst.customActions.length) {
      inst.customActions = []
      cleared.push(`${inst.id}.customActions`)
    }
    if (Array.isArray(inst.presetSequences) && inst.presetSequences.length) {
      inst.presetSequences = []
      cleared.push(`${inst.id}.presetSequences`)
    }
  }
  return cleared
}

export function pickPersisted(config) {
  const out = {}
  for (const key of PERSISTED_KEYS) {
    if (config && config[key] !== undefined) out[key] = config[key]
  }
  // 模式属于「本次运行」状态，不跨重启保留：写盘前把每个实例的 mode 剥掉，
  // 下次加载统一回到默认「手动」（见 apply 里的强制复位）。
  if (Array.isArray(out.instances)) {
    out.instances = out.instances.map((item) => {
      if (!item || typeof item !== 'object') return item
      const { mode, ...rest } = item
      return rest
    })
  }
  return out
}

export function writeConfigFile(config, file = CONFIG_FILE) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(pickPersisted(config), null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return { ok: true, file }
  } catch (error) {
    return { ok: false, file, error: errorText(error) }
  }
}

// ---------------------------------------------------------------------------
// 阶段 1：模型探测（只读，不渲染）
// ---------------------------------------------------------------------------

export function modelProbe(modelPath, io = {}) {
  const existsImpl = io.existsImpl ?? existsSync
  const readFileImpl = io.readFileImpl ?? readFileSync
  const readdirImpl = io.readdirImpl ?? readdirSync
  const warnings = []

  try {
    if (!modelPath || typeof modelPath !== 'string') {
      return { ok: false, reason: 'missing-path', message: 'modelPath 为空', warnings }
    }
    if (!existsImpl(modelPath)) {
      return { ok: false, reason: 'missing-dir', message: `模型目录不存在：${modelPath}`, warnings }
    }
    let entries
    try {
      entries = readdirImpl(modelPath)
    } catch (error) {
      return { ok: false, reason: 'read-dir-failed', message: errorText(error), warnings }
    }

    const model3Files = entries.filter((item) => /\.model3\.json$/i.test(item))
    const model2Files = entries.filter((item) => /\.model\.json$/i.test(item))
    if (model3Files.length === 0) {
      if (model2Files.length > 0) {
        warnings.push('检测到 Cubism 2 模型（*.model.json）：阶段 1 只支持 Cubism 4，不会渲染')
        return { ok: false, reason: 'cubism2-only', modelDir: modelPath, cubism2: model2Files, warnings }
      }
      return {
        ok: false,
        reason: 'missing-model3',
        message: `${modelPath} 下没有 *.model3.json`,
        entries: entries.slice(0, 20),
        warnings,
      }
    }
    if (model3Files.length > 1) warnings.push(`目录里有 ${model3Files.length} 个 model3.json，取第一个：${model3Files[0]}`)

    const entry = path.join(modelPath, model3Files[0])
    let doc
    try {
      doc = JSON.parse(readFileImpl(entry, 'utf8'))
    } catch (error) {
      return { ok: false, reason: 'bad-json', entry, message: errorText(error), warnings }
    }

    const refs = doc?.FileReferences ?? {}
    const resolveRef = (relative) => path.resolve(modelPath, relative)
    const missing = []

    const mocName = typeof refs.Moc === 'string' ? refs.Moc : null
    if (!mocName) missing.push('FileReferences.Moc 缺失')
    else if (!existsImpl(resolveRef(mocName))) missing.push(`moc3: ${mocName}`)

    const textureNames = Array.isArray(refs.Textures) ? refs.Textures.filter((item) => typeof item === 'string') : []
    if (textureNames.length === 0) missing.push('FileReferences.Textures 为空')
    for (const texture of textureNames) {
      if (!existsImpl(resolveRef(texture))) missing.push(`texture: ${texture}`)
    }

    const physicsName = typeof refs.Physics === 'string' ? refs.Physics : null
    if (physicsName && !existsImpl(resolveRef(physicsName))) {
      warnings.push(`physics 引用了但文件不存在：${physicsName}（可以继续渲染）`)
    }

    return {
      ok: missing.length === 0,
      format: 'cubism4',
      modelDir: modelPath,
      entry,
      entryFile: model3Files[0],
      moc: mocName ? resolveRef(mocName) : null,
      textures: textureNames.map(resolveRef),
      physics: physicsName ? resolveRef(physicsName) : null,
      missing,
      warnings,
      probedAt: new Date().toISOString(),
    }
  } catch (error) {
    return { ok: false, reason: 'probe-error', message: errorText(error), warnings }
  }
}

// ---------------------------------------------------------------------------
// 阶段 1：取会话里最后一条 assistant 文本
// ---------------------------------------------------------------------------

export function findLatestAssistantText(session) {
  if (!session || typeof session.deriveMessages !== 'function') {
    return { ok: false, reason: 'no-deriveMessages' }
  }
  let messages
  try {
    messages = session.deriveMessages()
  } catch (error) {
    return { ok: false, reason: 'derive-failed', message: errorText(error) }
  }
  if (!Array.isArray(messages)) return { ok: false, reason: 'not-array' }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const text = messageText(message).trim()
    if (text) return { ok: true, message, text, index }
  }
  return { ok: false, reason: 'no-assistant-message' }
}

/** 去掉常见 markdown 标记、合并空白、按 bubbleMaxChars 截断。 */
export function cleanBubbleText(text, maxChars = DEFAULT_CONFIG.bubbleMaxChars) {
  let value = String(text ?? '')
  value = value.replace(/```[\s\S]*?```/g, ' ')
  value = value.replace(/`([^`]*)`/g, '$1')
  value = value.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  value = value.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  value = value.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  value = value.replace(/\*\*([^*]+)\*\*/g, '$1')
  value = value.replace(/^\s*[-*+]\s+/gm, '')
  value = value.replace(/^\s*>\s?/gm, '')
  value = value.replace(/\r?\n+/g, ' ')
  value = value.replace(/[ \t]+/g, ' ').trim()
  if (value.length > maxChars) value = `${value.slice(0, Math.max(0, maxChars - 1))}…`
  return value
}

/**
 * 显示链：保留 Markdown 结构（标题 / 段落 / 列表 / 引用 / 代码块 / 换行），
 * 只按「可见字符」预算截断，尽量落在行边界，不留下半个代码围栏。
 * 原始 HTML 会被转义成可见文本 —— 渲染层只认 Markdown，不执行任何 HTML。
 */
export function displayBubbleText(text, maxChars = 2000) {
  let value = String(text ?? '').replace(/\r\n?/g, '\n')
  value = value.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  value = value.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  value = value.replace(/<\/?([a-zA-Z][^>]*)>/g, (m) => m.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
  const limit = Math.max(40, Number(maxChars) || 2000)
  if (value.length > limit) {
    let cut = value.slice(0, limit)
    // 代码围栏必须成对，否则渲染层会把后文全当代码
    if (((cut.match(/```/g) || []).length) % 2 === 1) {
      cut = `${cut.replace(/\n?```[\s\S]*$/, '')}\n\`\`\``
    }
    value = `${cut.replace(/\s+$/, '')}…`
  }
  return value
}

/** TTS 链：Markdown → 可朗读纯文本（保留停顿、不念符号、跳过代码块）。 */
export function ttsText(text, maxChars = 500) {
  let value = String(text ?? '').replace(/\r\n?/g, '\n')
  value = value.replace(/```[\s\S]*?```/g, '\n')
  value = value.replace(/`([^`]*)`/g, '$1')
  value = value.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  value = value.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  value = value.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  value = value.replace(/^\s*[-*+]\s+/gm, '')
  value = value.replace(/^\s*\d+[.)]\s+/gm, '')
  value = value.replace(/^\s*>\s?/gm, '')
  value = value.replace(/^\s*-{3,}\s*$/gm, '')
  value = value.replace(/\*\*([^*]+)\*\*/g, '$1')
  value = value.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
  value = value.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
  const limit = Math.max(20, Number(maxChars) || 500)
  if (value.length > limit) value = `${value.slice(0, Math.max(0, limit - 1))}…`
  return value
}

// ---------------------------------------------------------------------------
// 服务探测：ctx.<name> vs ctx.get(name) 到底谁有效
// ---------------------------------------------------------------------------

const PROBE_NAMES = [
  'webServer',
  'sessions',
  'agents',
  'sessionTitle',
  'sessionController',
  'workspaceRegistry',
  'tools',
  'llm',
  'timer',
]

function describeService(value) {
  if (!value) return { present: false }
  const methods = []
  try {
    let proto = Object.getPrototypeOf(value)
    while (proto && proto !== Object.prototype && methods.length < 14) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === 'constructor' || key.startsWith('_')) continue
        if (typeof value[key] === 'function' && !methods.includes(key)) methods.push(key)
      }
      proto = Object.getPrototypeOf(proto)
    }
  } catch { /* 代理对象取不到原型属正常 */ }
  return {
    present: true,
    type: typeof value,
    methods,
    ownKeys: (() => {
      try { return Object.keys(value).slice(0, 10) } catch { return [] }
    })(),
  }
}

function probeServices(ctx) {
  const result = {}
  for (const serviceName of PROBE_NAMES) {
    let viaProp
    let propError = null
    try { viaProp = ctx[serviceName] } catch (error) { propError = errorText(error) }

    let viaGet
    let getError = null
    try { viaGet = typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined } catch (error) { getError = errorText(error) }

    result[serviceName] = {
      'ctx.<name>': propError ? `THROW: ${propError}` : Boolean(viaProp),
      'ctx.get(name)': getError ? `THROW: ${getError}` : Boolean(viaGet),
      ...describeService(viaProp ?? viaGet),
    }
  }
  return result
}

function getService(ctx, serviceName) {
  try {
    const viaProp = ctx[serviceName]
    if (viaProp) return viaProp
  } catch { /* 落到 ctx.get */ }
  try {
    return typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// P1：会话 + 最近消息
// ---------------------------------------------------------------------------

function sessionTitleOf(ctx, session) {
  try {
    const service = getService(ctx, 'sessionTitle')
    if (!service || typeof service.get !== 'function') return { title: null, reason: 'sessionTitle 服务不可用' }
    const snapshot = service.get(session)
    const title = snapshot?.title ?? snapshot?.snap?.title ?? null
    return { title: typeof title === 'string' ? title : null, reason: title ? null : '返回里没有 title 字段' }
  } catch (error) {
    return { title: null, reason: errorText(error) }
  }
}

// 会话不活跃时（重启后、没打开的对话）sessionTitle 服务拿不到标题，
// 但 DSH 把标题快照落盘在 storages/session_projcache 里 —— 直接读文件兜底。
const SESSION_PROJCACHE_DIR = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')

/** DSH 的会话索引：archivedSessionIds / pinnedSessionIds 都在这里（0.2.1-rc.3）。 */
export const WORKSPACE_INDEX_FILE = path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  'storages',
  'workspace.json',
)

/** 已归档的会话 id 集合；文件读不到就当没有归档（不影响主流程）。 */
export function readArchivedSessionIds(file = WORKSPACE_INDEX_FILE) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const ids = data?.global?.archivedSessionIds
    return new Set(Array.isArray(ids) ? ids.map(String) : [])
  } catch {
    return new Set()
  }
}

/** projcache 里的会话元数据（目前用到 blank / lastPromptAt）。 */
export function projCacheMeta(sessionId, dir = SESSION_PROJCACHE_DIR) {
  if (!sessionId) return null
  const candidates = [sessionId, String(sessionId).replace(/^session-/, '')]
  for (const id of candidates) {
    const file = path.join(dir, `${id}.json`)
    try {
      if (!existsSync(file)) continue
      const data = JSON.parse(readFileSync(file, 'utf8'))
      const row = data?.record?.rows?.sessionListMetadata ?? data?.rows?.sessionListMetadata ?? null
      const meta = row?.val ?? row?.value ?? (typeof row === 'object' ? row : null)
      if (meta && typeof meta === 'object') return meta
    } catch {
      /* 缓存读不到就继续试下一个 */
    }
  }
  return null
}

export function titleFromProjCache(sessionId, dir = SESSION_PROJCACHE_DIR) {
  if (!sessionId) return null
  const candidates = [sessionId, String(sessionId).replace(/^session-/, '')]
  for (const id of candidates) {
    const file = path.join(dir, `${id}.json`)
    try {
      if (!existsSync(file)) continue
      const data = JSON.parse(readFileSync(file, 'utf8'))
      const row = data?.record?.rows?.title ?? data?.rows?.title ?? null
      const title = row?.val ?? row?.value ?? (typeof row === 'string' ? row : null)
      if (typeof title === 'string' && title.trim()) return title.trim()
    } catch {
      /* 缓存读不到就继续试下一个 */
    }
  }
  return null
}

/** 先问活跃会话的标题服务，拿不到再读 projcache —— 不活跃的对话也能显示名字。 */
export function resolveSessionTitle(ctx, sessionId) {
  if (!sessionId) return null
  try {
    const session = getService(ctx, 'sessions')?.get?.(sessionId) ?? null
    const title = sessionTitleOf(ctx, session)?.title
    if (title) return title
  } catch { /* 服务不可用就走缓存 */ }
  return titleFromProjCache(sessionId)
}

function collectSessions(ctx, limit) {
  const service = getService(ctx, 'sessions')
  if (!service) return { ok: false, error: 'sessions 服务不可用（inject 后仍拿不到）' }

  let list
  try {
    if (typeof service.list !== 'function') return { ok: false, error: 'sessions 服务没有 list()' }
    list = service.list()
  } catch (error) {
    return { ok: false, error: `list() 抛错：${errorText(error)}` }
  }
  if (!Array.isArray(list)) return { ok: false, error: `list() 返回的不是数组：${typeof list}` }

  const rows = []
  for (const item of list.slice(0, limit)) {
    const id = item?.id ?? item?.sessionId ?? item?.session?.id ?? null
    const row = { id, keys: item && typeof item === 'object' ? Object.keys(item).slice(0, 8) : [] }
    try {
      const session = (id && typeof service.get === 'function' ? service.get(id) : undefined) ?? item
      row.sessionFound = Boolean(session)
      row.seq = session?.seq ?? null
      const title = sessionTitleOf(ctx, session)
      row.title = title.title
      row.titleError = title.reason
      if (typeof session?.deriveMessages === 'function') {
        const messages = session.deriveMessages()
        row.messageCount = Array.isArray(messages) ? messages.length : null
        const last = Array.isArray(messages) ? messages.at(-1) : null
        row.lastRole = last?.role ?? null
        row.lastText = preview(messageText(last))
        row.lastSource = last?.source?.kind ?? null
        row.roles = Array.isArray(messages) ? [...new Set(messages.map((m) => m?.role).filter(Boolean))] : []
        // P2 闭合证据：会话里有没有 live2d 注入过的消息
        row.live2dMessages = Array.isArray(messages)
          ? messages.filter((m) => m?.source?.kind === 'live2d').length
          : null
      } else {
        row.messageCount = null
        row.deriveError = '会话对象没有 deriveMessages()'
      }
    } catch (error) {
      row.error = errorText(error)
    }
    rows.push(row)
  }
  return { ok: true, count: list.length, sessions: rows }
}

// ---------------------------------------------------------------------------
// P3：事件观测（只记录，不动作）
// ---------------------------------------------------------------------------

function createEventLog() {
  const buffer = []
  const counters = {}
  const record = (kind, detail) => {
    counters[kind] = (counters[kind] ?? 0) + 1
    buffer.push({ at: new Date().toISOString(), kind, detail })
    if (buffer.length > EVENT_BUFFER_SIZE) buffer.shift()
  }
  return { buffer, counters, record }
}

function frameKind(frame) {
  if (!frame || typeof frame !== 'object') return 'unknown'
  if (frame.kind) return frame.kind
  if (frame.end) return 'end'
  if (frame.start) return 'start'
  if (typeof frame.index === 'number') return 'chunk'
  return 'unknown'
}

/** 阶段 4：绑定了某个会话的实例。 */
export function instancesBoundTo(state, sessionId) {
  if (!sessionId) return []
  return (state.instances ?? []).filter((inst) => inst.config?.sessionId === sessionId)
}

/**
 * 阶段 4：auto / semi 模式下，这一轮的最新回复自动推成气泡。
 * semi 额外播一个「回答」动作；冷却挡掉时静默忽略。
 */
/** 半自动不该冒泡的内容：记忆插件的系统提示、工具结果、子 agent 摘要。 */
const AUTOMATION_TEXT = /^(记忆已更新|已写入记忆|已更新记忆|记忆已整理|记忆整理|记忆反思|已更新 lesson|meow-memory|memory\b|\[memory\])/i
const AUTOMATION_SOURCES = new Set(['memory', 'system', 'meow-memory', 'subagent', 'live2d-internal'])
// 同一实例 6 秒内最多推一条：挡住「同一轮多条事件 / 重复 idle」造成的连发
export const AUTO_BUBBLE_THROTTLE_MS = 6000

/**
 * 一轮结束（agent/status=idle）时，给每个绑定会话的实例推一次「最后一条 assistant」。
 * 这是半自动气泡的唯一入口：一轮推一次，不推中间态。
 */
export function pushIdleReplies(ctx, state, log, onlySessionId = null, source = null) {
  const service = getService(ctx, 'sessions')
  let pushed = 0
  for (const inst of state.instances ?? []) {
    if (inst.config.autoBubble === false) continue
    const sessionId = inst.config.sessionId
    if (!sessionId) continue
    // payload 带了 sessionId 就只处理那一个实例，避免多实例误推
    if (onlySessionId && sessionId !== onlySessionId) continue
    // 本轮回复从哪来：窗口输入框（window-chat）/ 唤醒（wake-*）/ 外部对话（external-chat）。
    // 用它决定推不推气泡——auto 只允许「用户在窗口说话」和「用户点 ⚡」两种情况。
    const effectiveSource = source ?? inst.chat?.replySource ?? 'external-chat'
    if (!canControl(inst, 'bubble', { source: effectiveSource })) {
      inst.chat && (inst.chat.replySource = null)
      continue
    }
    // 会话没在 GUI 打开时 sessions.get 返回 null：用 session/event 缓存的 session 兜底，
    // 否则「绑了没打开」的实例永远收不到自动气泡。
    let session = state.sessionCache?.get?.(sessionId) ?? null
    if (!session && service && typeof service.get === 'function') {
      try { session = service.get(sessionId) ?? null } catch { session = null }
    }
    if (!session) continue
    pushed += autoPushReply(state, session, log, null, effectiveSource)
    inst.chat && (inst.chat.replySource = null)
  }
  return pushed
}

export function autoPushReply(state, session, log, eventMessage = null, source = 'external-chat') {
  const eventMsg = eventMessage && eventMessage.role === 'assistant' ? eventMessage : null
  const found = findLatestAssistantText(session)
  if (!eventMsg && (!found?.ok || !found.text)) return 0
  // 文本与去重键必须同源：用事件消息时，文本也从这条消息里取。
  // （之前 text 取「最后一条已落盘」而 id 取事件里的新消息 → 新 id + 旧文本 = 每轮重推上一轮）
  const message = eventMsg ?? found.message
  const text = ((eventMsg ? messageText(eventMsg) : found.text) ?? '').trim()
  if (!text) return 0
  // 身份：稳定 messageId 优先（缺 ID 时才退回文本哈希，且只保留 5 秒）
  const replyKey = replyKeyOf(message, text)
  let pushed = 0
  for (const inst of instancesBoundTo(state, session?.id)) {
    if (inst.config.autoBubble === false) continue
    if (!canControl(inst, 'bubble', { source })) continue
    const view = instanceView(state, inst)
    if (!view?.windows) continue
    // 去重只认 claim（messageId 维度）：不再按 6 秒时间窗节流，
    // 否则两轮很快结束时，后一轮的合法回复会被整条吞掉。
    // 自动化会话/系统提示不冒泡，但要标记已读，避免下次又被当成新消息
    const kind = typeof message?.source?.kind === 'string' ? message.source.kind : ''
    if (AUTOMATION_SOURCES.has(kind) || AUTOMATION_TEXT.test(text)) {
      claimReply(inst, replyKey)
      continue
    }
    // 原子领取：窗口对话气泡/唤醒气泡/工具气泡若已经显示过这一条，这里就不再弹
    if (!claimReply(inst, replyKey)) continue
    // 自动气泡也按「回答」处理：保留 Markdown 结构，不截到 120 字，超长交给气泡内滚动
    const shown = displayBubbleText(text, 2000)
    if (!shown) continue
    const identity = textIdentity(shown)
    const seq = (inst.bubble.seq += 1)
    // 语音开：气泡先上屏但不自动消失（durationMs:0），等语音读完由窗口收掉
    const speechOn = inst.config.ttsEnabled === true && inst.config.ttsAutoSpeak === true
    const sent = view.windows.send({
      type: 'bubble',
      text: shown,
      format: 'markdown',
      seq,
      durationMs: speechOn ? 0 : inst.config.bubbleDurationMs,
      speechPending: speechOn,
    })
    if (!sent?.ok) {
      // 没发出去就退回领取，别让这条回复因为一次失败被永久吞掉
      if (inst.bubble) inst.bubble.claim = null
      continue
    }
    inst.bubble.lastMessageId = replyKey
    inst.bubble.lastIdentity = identity
    inst.bubble.lastAt = Date.now()
    inst.bubble.bubbleCount += 1
    logged(log, `live2d: [${inst.id}] 自动气泡 #${seq}（${shown.length} 字）`)
    pushed += 1
    if (inst.config.mode === 'semi') handleAnim(view, log, { action: 'happy', auto: true })
    // 语音：气泡已经上屏，异步合成后按 seq 回填（失败发 speech-failed 让气泡退回固定时长）
    if (speechOn) {
      // 只做「清洗」（去标记/代码块），不在这里截断：
      // 截断判定必须放在 speakForReply 里，否则它收到的永远 ≤500 字，truncated 恒 false，
      // 窗口就永远看不到「语音仅前 500 字」的提示（审查 P1-7）。
      speakForReply(state, inst, seq, ttsText(text, 1_000_000), log).catch((error) => logged(log, `[${inst.id}] 朗读异常：${errorText(error)}`))
    }
  }
  return pushed
}

/**
 * 阶段 4：semi 模式的状态机 + 「思考中」动作。
 * semi 的真实语义是「常态自动、回答期间切手动」：
 *  - agent/status=running → 该实例进入 manual（对话可以控制动作）
 *  - agent/status=idle    → 回到 auto（对话不再主动控制）
 * 只处理「绑定了这个会话」的实例，避免多实例时误驱动别人的模型。
 */
export function autoThinking(state, log, sessionId = null) {
  const running = state.instances ?? []
  for (const inst of running) {
    const bound = String(inst.config?.sessionId ?? '')
    if (sessionId && bound && bound !== sessionId) continue
    if (bound && !sessionId) continue
    if (inst.config?.mode === 'semi') {
      inst.modeState = { phase: 'manual', since: Date.now() }
      const view = instanceView(state, inst)
      if (view?.windows) handleAnim(view, log, { action: 'blink', auto: true })
    }
  }
}

/** semi：回答结束（idle）→ 回到自动态。 */
export function autoIdle(state, sessionId = null) {
  for (const inst of state.instances ?? []) {
    const bound = String(inst.config?.sessionId ?? '')
    if (sessionId && bound && bound !== sessionId) continue
    if (bound && !sessionId) continue
    if (inst.config?.mode === 'semi') inst.modeState = { phase: 'auto', since: Date.now() }
  }
}

/**
 * 思考提示：不管哪个模式，只要这个实例绑定的会话开始思考，
 * 就让窗口上方显示一条「思考中…」——这是事实通知，不是 AI 主动行为。
 */
export function pushThinking(state, sessionId, on) {
  for (const inst of state?.instances ?? []) {
    const bound = String(inst.config?.sessionId ?? '')
    if (!bound) continue
    // 「结束」是广播：宁可多清一次，也不能让「思考中」挂在窗口上（用户实测残留）
    if (on === true && sessionId && bound !== sessionId) continue
    const view = instanceView(state, inst)
    try {
      view?.windows?.send?.({ type: 'thinking', on: on === true, at: Date.now() })
    } catch { /* 窗口已关就忽略 */ }
  }
}

/**
 * 生效模式：仅诊断/展示用，不参与权限判定。
 * semi 在思考期按 manual 显示，其余按配置；权限一律走 canControl()。
 */
export function effectiveMode(inst) {
  const base = inst?.config?.mode === 'auto' ? 'auto' : inst?.config?.mode === 'semi' ? 'semi' : 'manual'
  if (base !== 'semi') return base
  return inst?.modeState?.phase === 'manual' ? 'manual' : 'auto'
}

function logged(log, message) {
  if (typeof log === 'function') { log(message); return }
  if (typeof log?.info === 'function') log.info(message)
}

// ---------------------------------------------------------------------------
// 阶段 4：读屏第一层 —— 只读前台窗口标题（不截图、不落盘）
// ---------------------------------------------------------------------------

export const FOREGROUND_SCRIPT_FILE = path.join(PLUGIN_DIR, 'electron', 'foreground.ps1')
export const CAPTURE_SCRIPT_FILE = path.join(PLUGIN_DIR, 'electron', 'capture.ps1')
// 读标题要起 PowerShell（0.3~1.3s），缓存窗口取 3 秒才可能命中
export const FOREGROUND_CACHE_MS = 3000

/** 解析 PowerShell 输出的一行 `标题|进程名`（标题里可能有 |，取最后一个分隔）。 */
export function parseForegroundOutput(raw) {
  let text = String(raw ?? '').trim()
  // 脚本用 base64(UTF-8) 传中文，避开控制台代码页（GBK）与 Node utf8 解码的冲突
  if (text.startsWith('L2D:')) {
    try {
      text = Buffer.from(text.slice(4), 'base64').toString('utf8').trim()
    } catch { /* 解不开就按原文处理 */ }
  }
  if (!text) return { ok: false, reason: 'empty' }
  const index = text.lastIndexOf('|')
  const title = (index >= 0 ? text.slice(0, index) : text).trim()
  const process = index >= 0 ? text.slice(index + 1).trim() : ''
  if (!title) return { ok: false, reason: 'no-title', process }
  return { ok: true, title, process }
}

function defaultExec(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout))
    })
  })
}

/** 调一次 PowerShell 取前台窗口标题；失败只返回原因，不抛。 */
export async function readForegroundTitle(execImpl, options = {}) {
  const run = execImpl ?? defaultExec
  const at = () => new Date().toISOString()
  try {
    const raw = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', options.scriptFile ?? FOREGROUND_SCRIPT_FILE],
      { timeout: options.timeoutMs ?? 3000, windowsHide: true, maxBuffer: 64 * 1024 },
    )
    return { ...parseForegroundOutput(raw), at: at() }
  } catch (error) {
    return { ok: false, reason: 'exec-failed', error: errorText(error), at: at() }
  }
}

/** 带 1 秒缓存的前台标题读取；开关关闭时直接拒绝（默认关）。config 缺省用实例合并后的视图配置。 */
export async function getForegroundTitle(state, execImpl, config = null) {
  const cfg = config ?? state.config ?? {}
  if (cfg.screenReadEnabled !== true) {
    return {
      ok: false,
      disabled: true,
      error: '读屏未开启',
      hint: '设置页勾选「读取前台窗口标题」后再试（只读标题，不截图）',
    }
  }
  const cache = state.screen ?? (state.screen = { lastAt: 0, lastTitle: null, lastProcess: null, count: 0, at: null })
  const now = Date.now()
  // 读一次要起 PowerShell（0.3~1.3s），缓存窗口必须比这长才有意义
  if (cache.lastAt && now - cache.lastAt < FOREGROUND_CACHE_MS) {
    return { ok: true, cached: true, title: cache.lastTitle, process: cache.lastProcess, at: cache.at }
  }
  // 同一时刻的并发请求复用同一次读取（否则会同时起多个 PowerShell）
  if (cache.titleInFlight) {
    const shared = await cache.titleInFlight
    return { ...shared, cached: true, shared: true }
  }
  cache.titleInFlight = readForegroundTitle(execImpl)
  try {
    const result = await cache.titleInFlight
    if (result.ok) {
      cache.lastAt = Date.now()
      cache.lastTitle = result.title
      cache.lastProcess = result.process
      cache.count += 1
      cache.at = result.at
    }
    return { ...result, cached: false }
  } finally {
    cache.titleInFlight = null
  }
}

// --- 读屏第二层：按需截图（默认关、需确认、限速、不落盘）-------------------

/** 解析 PowerShell 输出的一行 `宽x高|base64`。 */
export function parseCaptureOutput(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, reason: 'empty' }
  const index = text.indexOf('|')
  if (index < 0) return { ok: false, reason: 'no-separator' }
  const size = text.slice(0, index).trim()
  const base64 = text.slice(index + 1).replace(/\s+/g, '')
  const match = /^(\d+)x(\d+)$/.exec(size)
  if (!match || !base64) return { ok: false, reason: 'bad-format' }
  return {
    ok: true,
    width: Number(match[1]),
    height: Number(match[2]),
    base64,
    // base64 长度×3/4 会把 padding 算进去，差几个字节；用 Buffer 精确算
    bytes: Buffer.byteLength(base64, 'base64'),
    at: new Date().toISOString(),
  }
}

/** 真截一张全屏（结果只在内存里，不落盘）。 */
export async function captureScreen(execImpl, options = {}) {
  const run = execImpl ?? defaultExec
  try {
    const raw = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', options.scriptFile ?? CAPTURE_SCRIPT_FILE],
      { timeout: options.timeoutMs ?? 8000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    )
    return parseCaptureOutput(raw)
  } catch (error) {
    return { ok: false, reason: 'exec-failed', error: errorText(error) }
  }
}

/**
 * 截图前的三道闸：总开关 → 确认（免确认子开关）→ 30 秒限速。
 * 通过后才真正截屏；返回 base64（调用方负责用，不落盘）。
 */
export async function requestScreenCapture(state, options = {}) {
  if (state.config?.screenCaptureEnabled !== true) {
    return {
      ok: false,
      status: 403,
      disabled: true,
      error: '截图未开启',
      hint: '设置页勾选「允许截图」后再试（截图不会落盘）',
    }
  }
  const autoConfirm = state.config?.screenCaptureAutoConfirm === true
  if (!autoConfirm && options.confirmed !== true) {
    return {
      ok: false,
      status: 200,
      needsConfirm: true,
      hint: '截图前先用气泡问一句，用户同意后带 confirmed:true 再请求；或在设置页打开「截图免确认」',
    }
  }
  const screen = state.screen ?? (state.screen = { lastAt: 0, lastTitle: null, lastProcess: null, count: 0, at: null })
  const intervalMs = state.config?.screenCaptureIntervalMs ?? 30000
  const now = Date.now()
  const waitMs = intervalMs - (now - (screen.lastCaptureAt ?? 0))
  if (waitMs > 0) {
    return { ok: false, status: 429, error: `截图过于频繁，${waitMs}ms 后再试`, retryAfterMs: waitMs, intervalMs }
  }
  // 并发闸：先占位再 await，否则两个并发请求会同时通过间隔检查（0.12.4 实测漏过）
  if (screen.inFlight) {
    return { ok: false, status: 429, error: '上一次截图还没完成', retryAfterMs: 500, intervalMs }
  }
  const previousAt = screen.lastCaptureAt ?? 0
  screen.inFlight = true
  screen.lastCaptureAt = now
  try {
    const shot = await captureScreen(options.execImpl, options)
    if (!shot.ok) {
      screen.lastCaptureAt = previousAt
      return { ok: false, status: 502, ...shot }
    }
    screen.lastCaptureAtIso = shot.at
    screen.lastSize = `${shot.width}x${shot.height}`
    screen.captureCount = (screen.captureCount ?? 0) + 1
    return { ok: true, status: 200, ...shot, intervalMs }
  } finally {
    screen.inFlight = false
  }
}

// --- 截图落盘（给 AI 工具用：工具只能回文本，图像要用文件路径交给 read_image）---
export const CAPTURE_DIR = path.join(os.tmpdir(), 'dsh-live2d-screens')
const CAPTURE_KEEP = 10

export function saveCapturePng(base64, dir = CAPTURE_DIR, at = new Date()) {
  mkdirSync(dir, { recursive: true })
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `shot-${stamp}.png`)
  writeFileSync(file, Buffer.from(String(base64 ?? ''), 'base64'))
  return file
}

/** 只保留最近 keep 张：截图是临时文件，不留在用户目录里堆着。 */
export function pruneCaptureDir(dir = CAPTURE_DIR, keep = CAPTURE_KEEP) {
  try {
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.png'))
      .map((name) => ({ name, mtime: statSync(path.join(dir, name)).mtimeMs }))
    files.sort((a, b) => b.mtime - a.mtime)
    for (const item of files.slice(keep)) {
      try { rmSync(path.join(dir, item.name), { force: true }) } catch { /* 删不掉不影响本次截图 */ }
    }
    return files.length
  } catch {
    return 0
  }
}

// --- 阶段 4：语音（CosyVoice2 本地 HTTP）-----------------------------------

export const TTS_DEFAULT_URL = 'http://127.0.0.1:7890/tts'
export const TTS_TEXT_LIMIT = 500
const TTS_CACHE_LIMIT = 8
// 同一句（同参考音）重复回复不重复合成；LRU 8 条
const ttsCache = new Map()

/** 解析 WAV 头算时长（data 长度 / byteRate）；不是 WAV 就返回 null。 */
export function wavDurationMs(base64) {
  try {
    const buf = Buffer.from(String(base64 ?? ''), 'base64')
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
    let offset = 12
    let byteRate = 0
    let dataSize = 0
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4)
      const size = buf.readUInt32LE(offset + 4)
      if (id === 'fmt ') byteRate = buf.readUInt32LE(offset + 16)
      if (id === 'data') { dataSize = size; break }
      offset += 8 + size + (size % 2)
    }
    if (!byteRate || !dataSize) return null
    return Math.round((dataSize / byteRate) * 1000)
  } catch { return null }
}

/**
 * 调 CosyVoice2 `/tts`（text + prompt + prompt_text），返回 audio_base64。
 * 失败只返回原因，不抛；fetch 可注入便于测试。
 */
export async function synthesizeSpeech(text, options = {}) {
  const value = String(text ?? '').trim()
  if (!value) return { ok: false, status: 400, error: 'text 不能为空' }
  if (value.length > TTS_TEXT_LIMIT) {
    return { ok: false, status: 400, error: `text 太长（${value.length} > ${TTS_TEXT_LIMIT}）` }
  }
  const url = options.url || TTS_DEFAULT_URL
  const cacheKey = `${value}|${options.prompt ?? ''}|${options.promptText ?? ''}|${url}`
  if (options.noCache !== true) {
    const hit = ttsCache.get(cacheKey)
    if (hit) {
      // LRU：命中后挪到队尾
      ttsCache.delete(cacheKey)
      ttsCache.set(cacheKey, hit)
      return { ...hit, cached: true }
    }
  }
  const body = { text: value }
  if (options.prompt) {
    // 参考音是「本机绝对路径」，换机器后多半不存在：先明确报错，别让 TTS 服务端糊一个 500
    const promptPath = String(options.prompt)
    const existsImpl = options.existsImpl ?? ((p) => existsSync(p))
    if (!existsImpl(promptPath)) {
      return {
        ok: false,
        status: 400,
        code: 'tts-prompt-missing',
        error: `参考音文件不存在：${promptPath}`,
        hint: '去设置页「语音」把参考音改成这台机器上的 .wav，或留空用服务端默认音色。',
      }
    }
    body.prompt = promptPath
  }
  if (options.promptText) body.prompt_text = options.promptText
  const fetchImpl = options.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // CosyVoice2 冷启动（首次加载模型）实测要 24.5 秒，20 秒必失败
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    })
    if (!res.ok) return { ok: false, status: 502, error: `TTS 服务返回 ${res.status}` }
    const data = await res.json()
    const audio = data?.audio_base64 ?? data?.audioBase64 ?? data?.audio ?? null
    if (typeof audio !== 'string' || !audio) {
      return { ok: false, status: 502, error: 'TTS 响应里没有 audio_base64', keys: Object.keys(data ?? {}) }
    }
    const result = {
      ok: true,
      audioBase64: audio,
      mime: data?.mime ?? 'audio/wav',
      chars: value.length,
      durationMs: wavDurationMs(audio),
    }
    if (options.noCache !== true) {
      ttsCache.set(cacheKey, result)
      while (ttsCache.size > TTS_CACHE_LIMIT) ttsCache.delete(ttsCache.keys().next().value)
    }
    return result
  } catch (error) {
    return {
      ok: false,
      status: 503,
      error: `TTS 请求失败：${errorText(error)}`,
      hint: '确认 CosyVoice2 已在运行（默认端口 7890；启动脚本按你本机安装位置执行）',
      url,
    }
  }
}

/** 自动朗读一条回复（失败只告警，不影响气泡）。 */
/**
 * 给一条已经上屏的气泡配语音：成功下发 {type:'speech', seq, audioBase64, mime, durationMs}，
 * 失败下发 {type:'speech-failed', seq} 让窗口退回固定时长（绝不「永远挂着」）。
 */
export async function speakForReply(state, inst, seq, text, log) {
  const root = state.root ?? state
  const view = instanceView(root, inst)
  // 气泡允许长文（宿主按 2000 字清洗），但 TTS 单次只吃 500 字：先截断再合成，
  // 把「截断过」告诉窗口，让气泡角标注一句「语音仅前 N 字」，而不是整条静默失败。
  const raw = String(text ?? '')
  const spoken = raw.length > TTS_TEXT_LIMIT ? raw.slice(0, TTS_TEXT_LIMIT) : raw
  const truncated = spoken.length < raw.length
  const result = await synthesizeSpeech(spoken, {
    url: inst.config.ttsUrl,
    prompt: inst.config.ttsPrompt,
    promptText: inst.config.ttsPromptText,
  })
  if (!result.ok) {
    view?.windows?.send?.({ type: 'speech-failed', seq, error: result.error })
    pushRuntimeWarning(root, `朗读失败：${result.error}`)
    logged(log, `[${inst.id}] 朗读失败：${result.error}`)
    return result
  }
  // 时长以 WAV 头为准；算不出来就用气泡配置时长兜底
  const durationMs = result.durationMs && result.durationMs > 0 ? result.durationMs : inst.config.bubbleDurationMs
  view?.windows?.send?.({
    type: 'speech',
    seq,
    audioBase64: result.audioBase64,
    mime: result.mime,
    durationMs,
    truncated,
    spokenChars: spoken.length,
    // 长回答读完别立刻把气泡收掉：用户还要滚着看，留一段阅读时间
    keepReadingMs: raw.length > 200 ? Math.max(30_000, inst.config.bubbleDurationMs) : 0,
  })
  return { ok: true, chars: result.chars, spokenChars: spoken.length, truncated, durationMs, cached: result.cached === true }
}

function subscribeEvents(ctx, state, eventLog) {
  const offs = []
  const listen = (eventName, handler) => {
    if (typeof ctx.on !== 'function') {
      pushRuntimeWarning(state, 'ctx.on 不可用：事件观测未启用')
      return
    }
    // 事件回调一律包一层：抛出去就是未捕获异常，Node 22+ 会直接终结宿主进程。
    const safeHandler = (...args) => {
      try {
        return handler(...args)
      } catch (error) {
        pushRuntimeWarning(state, `${eventName} 回调异常：${errorText(error)}`)
        return undefined
      }
    }
    try {
      const result = ctx.on(eventName, safeHandler)
      if (typeof result === 'function') offs.push(result)
      else if (typeof result?.dispose === 'function') offs.push(() => result.dispose())
    } catch (error) {
      pushRuntimeWarning(state, `订阅 ${eventName} 失败：${errorText(error)}`)
    }
  }

  listen('agent/status', (payload) => {
    const status = typeof payload === 'string' ? payload : payload?.status
    // DSH 的真实载荷是 { agent, status }：会话 id 在 agent.session.id 上，
    // 没有 sessionId / session 这两个顶层字段（审查报告 P0-1 指出的就是这里）。
    const eventSessionId = payload?.agent?.session?.id ?? payload?.sessionId ?? payload?.session?.id ?? null
    eventLog.record('agent/status', status ?? payload)
    if (status === 'running' || status === 'idle') noteAgentLife(state, status, eventSessionId)
    // 阶段 2：agent 空闲时检查有没有待推送的窗口对话回复
    if (status === 'idle') {
      finishChatsEverywhere(state)
      // 阶段 4：一轮结束才推气泡 —— 一轮里 assistant/message 可能落多条（中间态 + 最终），
      // 逐条推会变成「每轮 2 次」；改成一轮结束取最后一条，天然一轮一次。
      pushIdleReplies(ctx, state, state.log, eventSessionId)
    }
    // 阶段 4：半自动 —— 开始思考时进入 manual 态并给一个小动作（冷却会挡掉密集调用）
    if (status === 'running') {
      autoThinking(state, state.log, eventSessionId)
      // 「思考中…」提示：主窗口发消息时窗口上方也要显示（用户 2026-11-05 反馈丢失）
      pushThinking(state, eventSessionId, true)
    }
    if (status === 'idle') {
      autoIdle(state, eventSessionId)
      pushThinking(state, eventSessionId, false)
    }
    // 绑定会话被打开/激活后，把排队的消息发出去
    if (status === 'running' || status === 'idle') flushChatQueue(ctx, state, state.log)
  })

  listen('agent/assistant-stream', (payload) => {
    const frame = payload?.frame ?? payload
    const kind = frameKind(frame)
    // 分片太密集：只记轻量信息；start/end 记下键名与文本，用来核对真实结构
    const detail = kind === 'chunk'
      ? { kind, index: frame?.index ?? null }
      : {
          kind,
          index: frame?.index ?? null,
          keys: frame && typeof frame === 'object' ? Object.keys(frame).slice(0, 10) : [],
          text: preview(messageText(frame), 60),
        }
    eventLog.record('agent/assistant-stream', detail)
  })

  listen('session/event', (session, event) => {
    eventLog.record('session/event', { sessionId: session?.id ?? null, type: event?.type ?? null })
    // 阶段 1：「当前会话」的解析依据之一 —— 最近有用户消息的会话
    try {
      if (event?.type === 'user/message' && session?.id) {
        state.recentSessionId = session.id
        markUserActivity(state, session.id, 'chat')
        // 用户重新提到休眠记忆时，在本地立刻恢复为“想起来了”。
        // 这一步只处理当前 session 自己的记忆，不读取也不串用别的对话。
        // DSH 的真实 user/message 正文在 event.data.message.content；兼容直接把
        // message 放在 event.data 的测试/旧载荷。
        const userText = messageText(event.data?.message ?? event.data)
        if (userText) {
          for (const inst of state.instances ?? []) {
            if (String(inst.config?.sessionId ?? '') === String(session.id) && inst.config?.memoryEnabled === true) {
              searchMemories(state, session.id, userText, 8)
            }
          }
        }
      }
      // 缓存事件里的 session 对象：会话没在 GUI 打开时 sessions.get 拿不到，
      // 自动气泡（idle 推）要靠这份缓存
      if (session?.id && typeof session.deriveMessages === 'function') {
        const cache = state.sessionCache ?? (state.sessionCache = new Map())
        cache.set(session.id, session)
        while (cache.size > 20) cache.delete(cache.keys().next().value)
      }
      // 阶段 2：assistant 消息落盘也算这一轮结束（idle 之外的兜底）
      if (event?.type === 'assistant/message') {
        finishChatsEverywhere(state)
        // 阶段 4：这里**不再**推气泡 —— 一轮会落多条 assistant/message（中间态 + 最终），
        // 逐条推就是「每轮 2 次」。改由 agent/status=idle 的 pushIdleReplies 一轮推一次。
      }
    } catch { /* 记录失败不影响主流程 */ }
  })

  if (offs.length === 0) pushRuntimeWarning(state, '没有成功订阅任何事件（详见上一条告警）')
  state.eventSubscription = { subscribed: offs.length, names: ['agent/status', 'agent/assistant-stream', 'session/event'] }
  return offs
}

// ---------------------------------------------------------------------------
// P2：向会话注入一条 user 消息
//
// 安全边界（写死在代码里，不靠调用方自觉）：
//   · dryRun 默认 true —— 不显式传 false 就一个字节都不会发出去；
//   · sessionId 必填 —— 不猜「最近会话」，绝不拿用户正在聊的会话当试验田；
//   · 所有 rejection 都必须有归宿（.then 双回调 / try-catch），
//     否则 Node 22+ 会把它当致命错误直接结束宿主进程。
// ---------------------------------------------------------------------------

const INJECT_MODES = ['followup', 'steer', 'inject']
const INJECT_TEXT_LIMIT = 4000
const VERIFY_DELAY_MS = 1200

function randomMessageId() {
  try {
    return `live2d-${randomUUID()}`
  } catch {
    return `live2d-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

/** 从 agents 服务里按会话 ID 找 agent（list 先匹配，再退回 get）。 */
function resolveAgent(ctx, sessionId) {
  const service = getService(ctx, 'agents')
  if (!service) return { ok: false, error: 'agents 服务不可用' }
  const attempts = []

  try {
    if (typeof service.list === 'function') {
      const list = service.list()
      if (Array.isArray(list)) {
        const hit = list.find((item) =>
          item?.session?.id === sessionId
          || item?.sessionId === sessionId
          || item?.id === sessionId)
        if (hit) return { ok: true, agent: hit, via: `agents.list()[${list.indexOf(hit)}]` }
        attempts.push(`list() 里 ${list.length} 个 agent 都不匹配 sessionId`)
      } else {
        attempts.push(`list() 返回的不是数组（${typeof list}）`)
      }
    }
  } catch (error) {
    attempts.push(`list() 抛错：${errorText(error)}`)
  }

  try {
    const direct = typeof service.get === 'function' ? service.get(sessionId) : undefined
    if (direct) return { ok: true, agent: direct, via: 'agents.get(sessionId)' }
    attempts.push('agents.get(sessionId) 返回空')
  } catch (error) {
    attempts.push(`agents.get() 抛错：${errorText(error)}`)
  }

  return { ok: false, error: attempts.join('；') }
}

function describeAgent(agent) {
  const methods = []
  for (const method of ['followup', 'steer', 'inject', 'cancel', 'whenIdle']) {
    methods.push([method, typeof agent?.[method] === 'function'])
  }
  return {
    id: agent?.id ?? null,
    sessionId: agent?.session?.id ?? null,
    status: agent?.status ?? null,
    methods: Object.fromEntries(methods),
  }
}

async function readJsonBody(req, limit = 16 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += Buffer.byteLength(chunk)
    if (total > limit) throw new Error(`请求体超过 ${limit} 字节`)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  return JSON.parse(raw)
}

/** 注入后读回会话，确认消息真的进去了（异步、失败只记录）。 */
function scheduleVerify(ctx, state, log, sessionId, messageId, text) {
  const timer = setTimeout(() => {
    if (state.disposed) return
    const result = { at: new Date().toISOString(), messageId, found: false, sessionId }
    try {
      const sessions = getService(ctx, 'sessions')
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
      const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : []
      const list = Array.isArray(messages) ? messages : []
      let index = -1
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const item = list[i]
        const textHit = messageText(item).includes(text.slice(0, 24))
        if (item?.id === messageId || textHit) { index = i; break }
      }
      result.found = index >= 0
      result.messageCount = list.length
      const hit = index >= 0 ? list[index] : null
      result.role = hit?.role ?? null
      result.sourceKind = hit?.source?.kind ?? null
      result.index = index
      const last = list.at(-1)
      result.lastRole = last?.role ?? null
      result.lastSourceKind = last?.source?.kind ?? null
      result.lastText = preview(messageText(last), 60)
    } catch (error) {
      result.error = errorText(error)
    }
    state.p2.verify = result
    if (result.found) log.info(`live2d: P2 注入已进会话（messageId=${messageId}）`)
    else log.warn(`live2d: P2 注入未在会话里找到（messageId=${messageId}，${result.error ?? '可能被队列合并或尚未落盘'}）`)
  }, VERIFY_DELAY_MS)
  if (typeof timer?.unref === 'function') timer.unref()
  return timer
}

async function handleInject(ctx, state, log, req, res) {
  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    jsonResponse(res, 400, { ok: false, error: `请求体不是合法 JSON：${errorText(error)}` })
    return
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  // 默认 dryRun：不传 / 传真值以外的任何东西都不发。
  const dryRun = body.dryRun !== false
  let mode = typeof body.mode === 'string' ? body.mode : 'followup'
  const warnings = []
  if (!INJECT_MODES.includes(mode)) {
    warnings.push(`mode 取值 ${JSON.stringify(mode)} 非法（合法 followup/steer/inject），已回落 followup`)
    mode = 'followup'
  }

  if (!sessionId) {
    jsonResponse(res, 400, { ok: false, error: 'sessionId 必填：本接口不会猜「最近会话」，请显式指定要注入哪个会话' })
    return
  }
  if (!text) {
    jsonResponse(res, 400, { ok: false, error: 'text 必填且不能为空' })
    return
  }
  if (text.length > INJECT_TEXT_LIMIT) {
    jsonResponse(res, 400, { ok: false, error: `text 超过 ${INJECT_TEXT_LIMIT} 字` })
    return
  }

  const resolved = resolveAgent(ctx, sessionId)
  if (!resolved.ok) {
    jsonResponse(res, 404, {
      ok: false,
      error: `找不到该会话的 agent：${resolved.error}`,
      hint: '会话可能还没激活：请先在 DSH GUI 里打开该会话（让 agent 创建并就绪），再回来注入。本接口不会替你在后台创建 agent。',
      sessionId,
    })
    return
  }

  const agent = resolved.agent
  const method = typeof agent?.[mode] === 'function' ? mode : null
  const message = {
    id: randomMessageId(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'live2d' },
  }

  const base = {
    ok: true,
    dryRun,
    dispatched: false,
    sessionId,
    mode,
    agent: describeAgent(agent),
    agentVia: resolved.via,
    message,
    warnings,
  }

  if (dryRun) {
    const missing = !method
      ? `agent 上没有 ${mode}() 方法（这是 P2 的硬依赖）`
      : null
    state.p2.attempts += 1
    state.p2.last = { at: new Date().toISOString(), dryRun: true, sessionId, mode, ok: !missing, error: missing, messageId: message.id }
    jsonResponse(res, missing ? 409 : 200, {
      ...base,
      ok: !missing,
      error: missing,
      hint: '这是预演：把 dryRun 改成 false 才会真的注入',
    })
    return
  }

  if (!method) {
    jsonResponse(res, 409, { ...base, ok: false, error: `agent 上没有 ${mode}() 方法` })
    return
  }

  // 真发：双回调兜住 rejection —— 这条线是宿主进程的生死线。
  // settled 用**同一个对象**在回调里原地改写：状态与响应/台账共享引用，
  // 不会出现「台账里永远写着 pending」。
  const settled = { ok: null, pending: true, at: null, error: null }
  try {
    const returned = agent[mode](message)
    if (returned && typeof returned.then === 'function') {
      returned.then(
        () => { Object.assign(settled, { ok: true, pending: false, at: new Date().toISOString() }) },
        (error) => {
          Object.assign(settled, { ok: false, pending: false, at: new Date().toISOString(), error: errorText(error) })
          pushRuntimeWarning(state, `P2 注入被拒绝（已兜住，未影响宿主）：${errorText(error)}`)
          log.warn(`live2d: P2 注入被拒绝（已兜住）：${errorText(error)}`)
        },
      )
    } else {
      Object.assign(settled, { ok: true, pending: false, at: new Date().toISOString(), sync: true })
    }
  } catch (error) {
    Object.assign(settled, { ok: false, pending: false, at: new Date().toISOString(), error: errorText(error) })
    pushRuntimeWarning(state, `P2 注入同步抛错（已兜住）：${errorText(error)}`)
    log.warn(`live2d: P2 注入同步抛错（已兜住）：${errorText(error)}`)
  }

  state.p2.attempts += 1
  state.p2.last = {
    at: new Date().toISOString(),
    dryRun: false,
    sessionId,
    mode,
    messageId: message.id,
    settled,
    textPreview: preview(text),
  }
  log.info(`live2d: P2 已调用 agent.${mode}（sessionId=${sessionId}, messageId=${message.id}）`)
  scheduleVerify(ctx, state, log, sessionId, message.id, text)

  jsonResponse(res, 200, { ...base, dispatched: true, settled, hint: `1.2s 后看 GET /live2d/diag 的 p2.verify` })
}

// ---------------------------------------------------------------------------
// P5：Electron 独立置顶窗口
//
// 复用 DSH 自己下载的 electron.exe（dsh-pet 同款），不新增 npm 依赖、
// 不复制宿主包。窗口入口是本插件 electron/main.cjs，userData 指到插件目录。
// ---------------------------------------------------------------------------

const WINDOW_LOG_LIMIT = 40
// Chromium 缓存目录建不起来时的固定噪音（不影响窗口本身）
const WINDOW_LOG_NOISE = [
  /disk_cache/i,
  /network_sandbox\.cc/i,
  /Unable to create cache/i,
  /Failed to create directory/i,
  /Unable to move the cache/i,
  /gpu_disk_cache/i,
]

/** 找 DSH 自带的 Electron 运行时（只找，不下载）。 */
export function resolveElectronExe(existsImpl = existsSync) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const candidates = []
  if (process.platform === 'win32') {
    candidates.push(path.join(home, 'electron', 'electron.exe'))
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'electron', 'electron.exe'))
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron'))
    candidates.push(path.join(home, 'electron', 'electron'))
  } else {
    candidates.push(path.join(home, 'electron', 'electron'))
  }
  for (const candidate of candidates) {
    try { if (existsImpl(candidate)) return { ok: true, path: candidate } } catch { /* 继续找下一个 */ }
  }
  return { ok: false, tried: candidates }
}

export function createWindowManager({ spawnImpl = spawn, existsImpl = existsSync, platform = process.platform, onProtocol = null } = {}) {
  let child = null
  let startedAt = null
  let lastExit = null
  let lastError = null
  const logTail = []
  let noiseCount = 0

  // 阶段 1：宿主 ↔ 窗口的控制通道。
  // 不用 stdin：Electron 在 Windows GUI 模式下 stdin 会立刻 EOF（实测 boot 后 30ms 就 'end'，
  // 随后进程 0xC0000005 退出），整条 stdin 协议收不到任何一条命令。
  // 改成窗口自己监听 127.0.0.1:0（随机端口），把端口打到 stdout，宿主连上去走换行 JSON。
  let socket = null
  let controlPort = null
  let stdoutBuffer = ''
  let ready = false
  const pending = []
  const protocolLog = []
  let lastAck = null

  const pushLog = (stream, chunk) => {
    for (const raw of String(chunk).split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      // 本机 Chromium 的网络/GPU 磁盘缓存目录建不起来（拒绝访问 0x5），
      // 会刷几十行 ERROR，但不影响窗口显示。过滤掉，只留有用的日志。
      if (WINDOW_LOG_NOISE.some((re) => re.test(line))) {
        noiseCount += 1
        continue
      }
      logTail.push({ at: new Date().toISOString(), stream, line: line.slice(0, 500) })
    }
    while (logTail.length > WINDOW_LOG_LIMIT) logTail.shift()
  }

  function status() {
    return {
      running: Boolean(child && !child.killed),
      pid: child?.pid ?? null,
      startedAt,
      lastExit,
      lastError,
      noiseCount,
      controlPort,
      connected: Boolean(socket && !socket.destroyed),
      ready,
      pending: pending.length,
      protocolLog: protocolLog.slice(-6),
      lastAck,
      logTail: logTail.slice(-12),
    }
  }

  function writeLine(command) {
    if (!socket || socket.destroyed) return false
    try {
      socket.write(`${JSON.stringify({ __live2d: 1, ...command })}\n`)
      return true
    } catch (error) {
      lastError = `写窗口控制通道失败：${errorText(error)}`
      return false
    }
  }

  function flushPending() {
    if (!socket || socket.destroyed) return
    while (pending.length > 0) {
      if (!writeLine(pending[0])) return
      pending.shift()
    }
  }

  /**
   * 发一条命令给窗口。控制通道还没连上时进 pending（上限 10，丢最旧），
   * 连上后按序重放，避免 init 早于通道建立被丢掉。
   * instanceId 由这里统一补上：调用方不需要自己拼（多实例下不会串窗）。
   */
  function send(command, instanceId = null) {
    const payload = instanceId ? { ...command, instanceId } : command
    if (!child || child.killed) return { ok: false, queued: false, error: '窗口未运行' }
    if (!socket || socket.destroyed) {
      pending.push(payload)
      while (pending.length > 20) pending.shift()
      return { ok: true, queued: true, pending: pending.length }
    }
    return { ok: writeLine(payload), queued: false }
  }

  /** 控制通道：窗口发来的 `{"__live2d":1,...}` 行（ready / state / bubble-shown / error / screenshot）。 */
  function handleControlChunk(chunk) {
    for (const raw of String(chunk).split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      let message = null
      try { message = JSON.parse(line) } catch { message = null }
      if (!message || message.__live2d !== 1) continue
      lastAck = {
        at: new Date().toISOString(),
        type: message.type ?? null,
        phase: message.phase ?? null,
        error: message.error ?? null,
      }
      protocolLog.push(lastAck)
      while (protocolLog.length > 20) protocolLog.shift()
      if (message.type === 'ready') ready = true
      try { onProtocol?.(message) } catch { /* 回调失败绝不影响窗口进程 */ }
    }
  }

  function connectControl(port) {
    if (socket && !socket.destroyed) return
    controlPort = port
    try {
      const next = net.connect({ host: '127.0.0.1', port })
      socket = next
      next.setEncoding('utf8')
      next.on('connect', () => {
        lastError = null
        flushPending()
      })
      next.on('data', handleControlChunk)
      next.on('error', (error) => {
        lastError = `窗口控制通道错误：${errorText(error)}`
        if (socket === next) socket = null
        ready = false
      })
      next.on('close', () => {
        if (socket === next) { socket = null; ready = false }
      })
    } catch (error) {
      lastError = `连接窗口控制通道失败：${errorText(error)}`
      socket = null
    }
  }

  /** stdout 只用来拿端口号与人类日志；协议数据走 TCP 控制通道。 */
  function handleStdout(chunk) {
    stdoutBuffer += chunk
    let index
    while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, index).replace(/\r$/, '').trim()
      stdoutBuffer = stdoutBuffer.slice(index + 1)
      if (!line) continue
      const portMatch = /\[live2d-window\]\s+port=(\d{2,5})/.exec(line)
      if (portMatch) {
        connectControl(Number(portMatch[1]))
        continue
      }
      pushLog('out', line)
    }
  }

  function open(mainPath = path.join(PLUGIN_DIR, 'electron', 'main.cjs')) {
    if (child && !child.killed) return { ok: true, alreadyRunning: true, ...status() }

    const exe = resolveElectronExe(existsImpl)
    if (!exe.ok) {
      lastError = `找不到 Electron 运行时（试过 ${exe.tried.join(' / ')}）`
      return {
        ok: false,
        error: lastError,
        hint: 'DSH 首次用桌宠类插件时会下载 electron 到 $DSH_HOME/electron；这里只复用，不替你下载。',
        ...status(),
      }
    }
    if (!existsImpl(mainPath)) {
      lastError = `窗口入口不存在：${mainPath}`
      return { ok: false, error: lastError, ...status() }
    }

    try {
      // DSH 宿主自己是用 ELECTRON_RUN_AS_NODE=1 把 electron 当 node 跑的。
      // 这里必须摘掉，否则 spawn 出来的 electron.exe 会退化成纯 Node，
      // 没有 app / BrowserWindow（实测会报 Cannot find module 'electron'）。
      const childEnv = { ...process.env, DSH_LIVE2D_WINDOW: '1' }
      delete childEnv.ELECTRON_RUN_AS_NODE

      // --no-sandbox 是本机实测必需：不带它，electron.exe 一启动就 0x80000003
      // （STATUS_BREAKPOINT，在 whenReady 之前）退出；带上它才能正常 ready。
      // 安全边界：窗口只 loadFile 本地 index.html，不加载任何远程内容，
      // 也不开放 nodeIntegration（preload 走 contextBridge）。
      child = spawnImpl(exe.path, ['--no-sandbox', mainPath], {
        cwd: PLUGIN_DIR,
        // stdout 用来读端口号与日志；控制通道走 TCP，stdin 用不上（Electron GUI 下会立即 EOF）
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false,
        env: childEnv,
      })
      startedAt = new Date().toISOString()
      lastExit = null
      lastError = null
      ready = false
      stdoutBuffer = ''
      pending.length = 0
      controlPort = null
      if (socket) { try { socket.destroy() } catch { /* ignore */ } }
      socket = null
      child.stdout?.setEncoding?.('utf8')
      child.stderr?.setEncoding?.('utf8')
      child.stdout?.on?.('data', handleStdout)
      child.stderr?.on?.('data', (chunk) => pushLog('err', chunk))
      child.on?.('error', (error) => {
        lastError = `窗口进程启动失败：${errorText(error)}`
        pushLog('err', lastError)
        child = null
        ready = false
      })
      child.on?.('exit', (code, signal) => {
        lastExit = { at: new Date().toISOString(), code, signal }
        child = null
        ready = false
        if (socket) { try { socket.destroy() } catch { /* ignore */ } }
        socket = null
        controlPort = null
      })
      return { ok: true, started: true, electron: exe.path, ...status() }
    } catch (error) {
      lastError = `spawn 失败：${errorText(error)}`
      child = null
      return { ok: false, error: lastError, ...status() }
    }
  }

  async function close() {
    if (!child || child.killed) return { ok: true, alreadyStopped: true, ...status() }
    const pid = child.pid
    pending.length = 0
    if (socket) { try { socket.destroy() } catch { /* ignore */ } }
    socket = null
    try {
      if (platform === 'win32') {
        // 先让 Electron 体面退出；taskkill 兜底（app.quit 偶尔卡在渲染进程）
        await new Promise((resolve) => {
          let killer = null
          try {
            killer = spawnImpl('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
          } catch {
            resolve()
            return
          }
          if (typeof killer?.on !== 'function') { resolve(); return }
          killer.on('exit', resolve)
          killer.on('error', resolve)
        })
      } else {
        child.kill?.('SIGTERM')
      }
    } catch (error) {
      lastError = `关闭窗口失败：${errorText(error)}`
    }
    return { ok: true, killedPid: pid, ...status() }
  }

  return { open, close, status, send }
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

async function runSelfTest(ctx, state) {
  const checks = []

  checks.push({ id: 'platform', label: '运行平台', ok: true, detail: `${process.platform} / node ${process.version}` })

  const services = {}
  for (const serviceName of ['webServer', 'sessions', 'agents', 'sessionTitle', 'sessionController']) {
    services[serviceName] = Boolean(getService(ctx, serviceName))
  }
  checks.push({
    id: 'services',
    label: '宿主服务（P1/P3 依赖）',
    ok: services.webServer && services.sessions && services.agents,
    detail: services,
  })

  checks.push({
    id: 'routes',
    label: 'HTTP 路由挂载',
    ok: state.routesRegistered === true,
    detail: state.routesRegistered
      ? '/live2d/{health,diag,panel,config,bubble,model/reload,preset,window,inject,ui-command}'
      : '未注册（宿主没有 webServer 服务）',
  })

  // 模型探测失败不算自检失败：验收④要求路径写错时插件仍保持 ready。
  checks.push({
    id: 'model',
    label: '模型探测（失败只降级为占位）',
    ok: true,
    detail: state.model
      ? {
          ok: state.model.ok === true,
          reason: state.model.reason ?? null,
          entry: state.model.entry ?? null,
          missing: state.model.missing ?? [],
        }
      : null,
  })

  checks.push({
    id: 'events',
    label: '事件订阅（P3 依赖）',
    ok: (state.eventSubscription?.subscribed ?? 0) > 0,
    detail: state.eventSubscription ?? null,
  })

  // P5：只报告 electron 运行时在不在，不因为它缺席把插件判成降级
  const electron = resolveElectronExe()
  checks.push({
    id: 'window-runtime',
    label: 'Electron 运行时（P5 依赖）',
    ok: true,
    detail: electron.ok ? { path: electron.path } : { missing: true, tried: electron.tried },
  })

  const failed = checks.filter((check) => check.ok === false)
  state.selfTest = { at: new Date().toISOString(), ok: failed.length === 0, checks }
  if (failed.length > 0) {
    state.phase = 'degraded'
    pushRuntimeWarning(state, `自检未全部通过：${failed.map((check) => check.id).join(', ')}（DSH 照常运行）`)
  }
  return state.selfTest
}

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------

function panelHtml(state, diag) {
  const rows = [
    ['阶段', STAGE],
    ['版本', VERSION],
    ['状态', state.phase],
    ['inject', inject.join(', ')],
    ['webServer 路由', state.routesRegistered ? '已注册' : '未注册'],
    ['事件订阅', state.eventSubscription ? `${state.eventSubscription.subscribed} 个` : '未启用'],
    ['自检', state.selfTest ? (state.selfTest.ok ? '通过' : '未全部通过') : '未执行'],
    ['P2 注入', state.p2?.attempts
      ? `${state.p2.attempts} 次（最近 ${state.p2.last?.mode}，dryRun=${state.p2.last?.dryRun}，verify=${state.p2.verify?.found ?? '待定'}）`
      : '未尝试'],
    ['窗口进程', (() => {
      const info = state.windows?.status?.()
      if (!info?.running) return info?.lastExit ? `未运行（上次退出 code=${info.lastExit.code}）` : '未启动'
      return `运行中 pid=${info.pid}`
    })()],
  ]
  const services = Object.entries(diag?.services ?? {})
    .map(([name, info]) => `<tr><td>${escapeHtml(name)}</td><td><code>${escapeHtml(JSON.stringify(info))}</code></td></tr>`)
    .join('')
  const warnings = state.warnings.length
    ? `<ul>${state.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : '<p class="muted">无</p>'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live2D 插件 · ${STAGE}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 "Segoe UI", system-ui, sans-serif; margin: 0; padding: 28px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 24px 0 6px; }
  p.sub { margin: 0 0 18px; opacity: .65; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; max-width: 900px; }
  td { padding: 6px 10px; border-bottom: 1px solid rgba(128,128,128,.22); vertical-align: top; }
  td:first-child { width: 200px; opacity: .7; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; }
  ul { margin: 6px 0 0; padding-left: 20px; }
  .muted { opacity: .6; }
</style></head>
<body>
  <h1>Live2D 插件 · ${STAGE}（真机 PoC）</h1>
  <p class="sub">只读诊断 + P2 注入预演。这里看不到模型是正常的；真注入必须显式传 dryRun:false。</p>
  <table>${rows.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td><code>${escapeHtml(String(value))}</code></td></tr>`).join('')}</table>
  <h2>宿主服务探测</h2>
  <table>${services || '<tr><td colspan="2" class="muted">无数据</td></tr>'}</table>
  <h2>告警</h2>
  ${warnings}
</body></html>`
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

function diagSnapshot(ctx, state, eventLog) {
  return {
    ok: true,
    plugin: 'dsh-live2d',
    version: VERSION,
    stage: STAGE,
    phase: state.phase,
    inject,
    services: probeServices(ctx),
    p1: collectSessions(ctx, state.config.diagSessionLimit),
    p3: {
      subscription: state.eventSubscription ?? null,
      counters: eventLog.counters,
      recent: eventLog.buffer.slice(-25),
    },
    p2: {
      attempts: state.p2?.attempts ?? 0,
      last: state.p2?.last ?? null,
      verify: state.p2?.verify ?? null,
    },
    window: state.windows?.status?.() ?? null,
    config: state.config,
    configFile: CONFIG_FILE,
    model: state.model ?? null,
    renderer: state.renderer,
    bubble: {
      count: state.bubble?.bubbleCount ?? 0,
      last: state.bubble?.lastShown ?? null,
      lastIdentity: state.bubble?.lastIdentity ?? null,
      lastMessageId: state.bubble?.lastMessageId ?? null,
    },
    chat: {
      pending: state.chat?.pending
        ? { requestId: state.chat.pending.requestId, sessionId: state.chat.pending.sessionId, startedAt: new Date(state.chat.pending.startedAt).toISOString() }
        : null,
      lastReply: state.chat?.lastReply ?? null,
      lastError: state.chat?.lastError ?? null,
      history: state.chat?.history ?? [],
      queue: state.chat?.queue ?? [],
    },
    anim: {
      lastAction: state.anim?.lastAction ?? null,      lastAt: state.anim?.lastAt ? new Date(state.anim.lastAt).toISOString() : null,
      lastDone: state.anim?.lastDone ?? null,
      count: state.anim?.count ?? 0,
      timeout: state.anim?.timeout === true,
      cooldownMs: state.config?.animCooldownMs ?? null,
      allowed: ANIM_WHITELIST,
    },
    screen: {
      enabled: state.config?.screenReadEnabled === true,
      lastTitle: state.screen?.lastTitle ?? null,
      lastProcess: state.screen?.lastProcess ?? null,
      lastAt: state.screen?.at ?? null,
      count: state.screen?.count ?? 0,
      capture: {
        enabled: state.config?.screenCaptureEnabled === true,
        autoConfirm: state.config?.screenCaptureAutoConfirm === true,
        intervalMs: state.config?.screenCaptureIntervalMs ?? null,
        count: state.screen?.captureCount ?? 0,
        lastAt: state.screen?.lastCaptureAtIso ?? null,
        lastSize: state.screen?.lastSize ?? null,
      },
    },
    warnings: state.warnings,
    at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// 阶段 1：窗口协议、配置生效、气泡
// ---------------------------------------------------------------------------

/** 给窗口的配置子集（不带插件内部开关）。 */
export function modelRoots(state) {
  const roots = Array.isArray(state?.config?.modelRoots) ? state.config.modelRoots.filter((x) => typeof x === 'string' && x.trim()) : []
  return roots.length > 0 ? roots : [DEFAULT_MODEL_ROOT]
}

/** 扫 modelRoots 下最多 3 层，找 *.model3.json（只读，不写盘）。 */
export function scanModels(state, io = {}) {
  const readdirImpl = io.readdirImpl ?? ((dir) => readdirSync(dir, { withFileTypes: true }))
  const roots = modelRoots(state)
  const used = new Map()
  for (const item of state.instances ?? []) {
    if (item?.config?.modelPath) used.set(normalizeModelKey(item.config.modelPath), item.id)
  }
  const models = []
  const walk = (dir, depth) => {
    let entries = []
    try {
      entries = readdirImpl(dir) ?? []
    } catch {
      return
    }
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name
      const isDir = typeof entry === 'string' ? null : entry.isDirectory()
      const full = path.join(dir, name)
      if (name.endsWith('.model3.json')) {
        models.push({
          dir,
          name: path.basename(dir),
          entry: name,
          key: normalizeModelKey(dir),
          usedBy: used.get(normalizeModelKey(dir)) ?? null,
        })
      } else if (depth < 3 && isDir !== false && !name.startsWith('.')) {
        walk(full, depth + 1)
      }
    }
  }
  for (const root of roots) walk(root, 0)
  models.sort((a, b) => a.dir.localeCompare(b.dir))
  return { models, scanned: roots }
}

export function instanceSummary(ctx, state, inst) {
  if (!inst) return null
  const sessionTitle = instanceTitle(state, inst)
  const memoryRows = listMemories(state, inst.config?.sessionId ?? '')
  return {
    id: inst.id,
    isDefault: state.instances?.[0]?.id === inst.id,
    // 完整实例配置：设置页重建表单要用它（摘要字段不够，拿摘要重建会把用户刚存的值显示成默认值）
    config: { ...inst.config },
    sessionId: inst.config.sessionId || null,
    sessionTitle: sessionTitle || null,
    mode: inst.config.mode ?? 'manual',
    autoBubble: inst.config.autoBubble !== false,
    boundLabel: inst.config.sessionId ? `已绑定：${sessionTitle || inst.config.sessionId.slice(0, 8)}` : '未绑定会话',
    modelPath: inst.config.modelPath,
    modelKey: normalizeModelKey(inst.config.modelPath),
    // 0.3.2：这只模型对应的「动作档案」（同一模型的实例共享同一份）
    profile: (() => {
      const profile = profileFor(state, inst)
      return profile ? { id: profile.id, label: profile.label, customActions: profile.customActions.length, presetSequences: profile.presetSequences.length } : null
    })(),
    model: inst.model
      ? { ok: inst.model.ok === true, reason: inst.model.reason ?? null, entry: inst.model.entry ?? null, format: inst.model.format ?? null }
      : null,
    renderer: {
      state: inst.renderer?.state ?? 'stopped',
      lastError: inst.renderer?.lastError ?? null,
      // 最近一次气泡布局的实测值：调试「为什么不滚 / 滚动条不显示」直接看这里
      metrics: inst.renderer?.metrics ?? null,
      // 最近一次布局：气泡实际可用高度 / 模型实际高度（设置页「刷新坐标」读它显示）
      layout: inst.renderer?.layout ?? null,
      // 动作可用性：{ at, actions:[{id,total,usable,missing}] }（0 轨 = 该模型做不了，设置页置灰）
      capability: inst.renderer?.capability ?? null,
      // 纹理健康：某张 4096 纹理上传失败时，模型上会出现黑块
      textures: inst.renderer?.textures ?? null,
    },
    bubble: {
      seq: inst.bubble?.seq ?? 0,
      bubbleCount: inst.bubble?.bubbleCount ?? 0,
      lastMessageId: inst.bubble?.lastMessageId ?? null,
      lastIdentity: inst.bubble?.lastIdentity ?? null,
      lastAt: inst.bubble?.lastAt ?? null,
    },
    window: { state: inst.window?.state ?? 'stopped', ready: Boolean(inst.window?.ready), bounds: inst.windowBounds ?? null },
    chat: {
      pending: Boolean(inst.chat?.pending),
      lastReply: inst.chat?.lastReply ? { at: inst.chat.lastReply.at, preview: preview(inst.chat.lastReply.text, 60) } : null,
      lastError: inst.chat?.lastError ?? null,
    },
    // 定时读屏的结果（只有 screenWatchEnabled 打开且读过之后才有）
    screen: inst.screen ?? null,
    memory: {
      enabled: inst.config?.memoryEnabled === true,
      count: memoryRows.filter((item) => !item.dormant).length,
      dormantCount: memoryRows.filter((item) => item.dormant).length,
      sessionId: inst.config?.sessionId ?? null,
      maxEntries: inst.config?.memoryMaxEntries ?? 100,
    },
    life: inst.life ? lifeStatusSnapshot(inst) : null,
    warnings: inst.warnings ?? [],
  }
}

/** 新增一个实例（sessionId 可空 = 未绑定；modelPath 必填）。 */
export function createInstance(state, body = {}) {
  const max = LIMITS.maxInstances ?? 2
  const existing = state.config.instances ?? []
  if (existing.length >= max) {
    return { ok: false, status: 409, code: 'too-many-instances', error: `最多 ${max} 个实例（当前 ${existing.length}）。想加新的先删掉一个。` }
  }
  const modelPath = typeof body.modelPath === 'string' ? body.modelPath.trim() : ''
  if (!modelPath) {
    return { ok: false, status: 400, code: 'model-required', error: '新增实例必须选模型（modelPath 必填）' }
  }
  let seq = existing.length + 1
  while (existing.some((item) => item.id === `inst-${seq}`)) seq += 1
  const id = `inst-${seq}`
  const base = { ...DEFAULT_INSTANCE, modelPath, sessionId: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : '' }
  for (const key of INSTANCE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) base[key] = body[key]
  }
  const next = [...existing, { ...base, id }]
  const normalized = normalizeConfig({ ...state.config, instances: next })
  // 新实例默认位置：按序号往右错开，避免两个窗口完全重叠
  const list = normalized.config.instances
  const target = list[list.length - 1]
  if (!Number.isInteger(target.windowX)) {
    target.windowX = clampRange(200 + seq * 40, LIMITS.windowPosition, 200)
    target.windowY = clampRange(120 + seq * 20, LIMITS.windowPosition, 120)
  }
  const check = validateInstances(normalized.config)
  if (!check.ok) {
    return { ok: false, status: 409, code: check.code, error: check.error, conflictWith: check.conflictWith ?? null }
  }
  state.config = normalized.config
  setWarningSource(state, 'config', normalized.warnings)
  syncInstances(state)
  const created = findInstance(state, id)
  if (created) {
    created.model = modelProbe(created.config.modelPath)
    setWarningSource(state, 'model', created.model.warnings ?? [])
  }
  const saved = writeConfigFile(state.config, state.configFile ?? CONFIG_FILE)
  if (!saved.ok) pushRuntimeWarning(state, `配置写盘失败：${saved.error}（本次已生效，但重启后会丢）`)
  return {
    ok: true,
    instanceId: id,
    instance: instanceSummary(state.ctx, state, created),
    instances: (state.instances ?? []).map((item) => instanceSummary(state.ctx, state, item)),
    fileError: saved.error ?? null,
  }
}

/** 删除一个实例：先关窗，再移除并写盘；最后一个不让删。 */
export function deleteInstance(state, instanceId) {
  const inst = findInstance(state, instanceId)
  if (!inst) return { ok: false, status: 404, error: `没有实例 ${instanceId}` }
  const list = state.config.instances ?? []
  if (list.length <= 1) {
    return { ok: false, status: 400, code: 'last-instance', error: '至少保留一个实例（最后一个不能删）' }
  }
  closeInstanceWindow(state, inst.id)
  // 删实例时把它的待用截图一起清掉（不然 pending 目录会留下孤儿文件）
  try {
    for (const item of inst.wake?.shots ?? []) {
      try { if (item?.path) rmSync(item.path, { force: true }) } catch { /* 单个删不掉不影响 */ }
    }
    rmSync(path.join(WAKE_PENDING_DIR, inst.id), { recursive: true, force: true })
  } catch { /* 清理失败不影响删实例 */ }
  const next = list.filter((item) => item.id !== inst.id)
  const normalized = normalizeConfig({ ...state.config, instances: next })
  state.config = normalized.config
  setWarningSource(state, 'config', normalized.warnings)
  syncInstances(state)
  const saved = writeConfigFile(state.config, state.configFile ?? CONFIG_FILE)
  if (!saved.ok) pushRuntimeWarning(state, `配置写盘失败：${saved.error}（本次已生效，但重启后会丢）`)
  return {
    ok: true,
    removed: inst.id,
    defaultInstanceId: state.instances?.[0]?.id ?? null,
    instances: (state.instances ?? []).map((item) => instanceSummary(state.ctx, state, item)),
    fileError: saved.error ?? null,
  }
}

/** 该实例绑定的会话标题（窗口左上角标签用）；未绑定返回空串。 */
export function instanceTitle(state, inst) {
  const sessionId = inst?.config?.sessionId
  if (!sessionId) return ''
  // 活跃会话走 sessionTitle；不活跃（重启后没打开的对话）读 projcache 兜底
  return resolveSessionTitle(state.ctx, sessionId) ?? ''
}

/** 打开某个实例的窗口（必要时先启动 Electron 进程）。 */
export function openInstanceWindow(state, instanceId) {
  const inst = findInstance(state, instanceId)
  if (!inst) return { ok: false, error: `没有实例 ${instanceId}` }
  if (!state.windows) return { ok: false, error: '窗口管理器不可用' }
  const opened = state.windows.open?.()
  if (!opened?.ok) {
    inst.window.state = 'stopped'
    inst.window.error = opened?.error ?? 'unknown'
    return opened
  }
  inst.window.state = 'starting'
  inst.window.error = null
  const title = instanceTitle(state, inst)
  inst.window.title = title
  // pushedTitle = 窗口「真正收到」的标题；inst.window.title 只代表宿主这边的认知。
  // 两者分开记，重试才知道该不该重推。
  inst.window.pushedTitle = title || null
  const sent = state.windows.send?.({
      type: 'pool:create',
      config: windowConfigPayload(inst.config, buildPresets(inst, profileFor(state, inst)), lifeStatusSnapshot(inst)),
      title,
      sessionId: inst.config.sessionId || null,
    },
    inst.id,
  )
  // 刚启动时会话标题常常还没加载出来（sessionTitle 服务晚几秒才就绪）：
  // 分几次重试，拿到就推给窗口，避免窗口一直显示「未绑定会话」。
  scheduleTitleRefresh(state, inst)
  return { ...opened, ok: true, instanceId: inst.id, sent, window: { ...opened } }
}

/** 启动后标题可能暂时解析不到：延迟重试几次，成功就推 config 通知窗口更新标签。 */
function scheduleTitleRefresh(state, inst) {
  if (!inst?.config?.sessionId) return
  // 标题解析有时比窗口开得晚：多补几次，覆盖「会话刚打开、标题还没算出来」的情况
  for (const delay of [1000, 3000, 7000, 15000, 30000]) {
    const timer = setTimeout(() => {
      if (state.disposed) return
      const title = instanceTitle(state, inst)
      if (!title || title === inst.window.pushedTitle) return
      inst.window.title = title
      inst.window.pushedTitle = title
      try {
        state.windows?.send?.({ type: 'config', title, sessionId: inst.config.sessionId }, inst.id)
      } catch { /* 窗口可能已关 */ }
    }, delay)
    if (typeof timer?.unref === 'function') timer.unref()
  }
}

/** 只关这一个实例的窗口（不影响其它实例、不影响进程）。 */
export function closeInstanceWindow(state, instanceId) {
  const inst = findInstance(state, instanceId)
  const id = inst?.id ?? instanceId
  if (inst) {
    inst.window.state = 'stopped'
    inst.window.ready = false
  }
  const sent = state.windows?.send?.({ type: 'pool:close' }, id) ?? null
  return { ok: true, instanceId: id, sent }
}

/**
 * 「按说明生成动作」的模板库。
 * 不是真模型推理，而是把常见的情绪/动作描述映射成一组参数关键帧——
 * 用户可以先在设置页预览，满意再保存；不够贴切也可以直接改说明再生成，或让 AI 用 live2d_preset define。
 */
const DESIGN_TEMPLATES = [
  {
    id: 'joy', label: '开心', match: /开心|高兴|笑|愉快|得意|happy|joy|smile/i, durationMs: 1500,
    tracks: [
      { param: 'headZ', keys: [[0, 0], [0.3, 8], [0.75, 6], [1, 0]] },
      { param: 'eyeOpenL', keys: [[0, 1], [0.3, 0.55], [0.8, 0.6], [1, 1]] },
      { param: 'eyeOpenR', keys: [[0, 1], [0.3, 0.55], [0.8, 0.6], [1, 1]] },
      { param: 'mouthForm', keys: [[0, 0], [0.3, 1], [0.8, 1], [1, 0]] },
    ],
  },
  {
    id: 'sad', label: '难过', match: /难过|伤心|失落|沮丧|sad|down/i, durationMs: 1800,
    tracks: [
      { param: 'headY', keys: [[0, 0], [0.25, -9], [0.8, -8], [1, 0]] },
      { param: 'eyeOpenL', keys: [[0, 1], [0.3, 0.65], [1, 1]] },
      { param: 'eyeOpenR', keys: [[0, 1], [0.3, 0.65], [1, 1]] },
      { param: 'mouthForm', keys: [[0, 0], [0.3, -0.8], [1, 0]] },
    ],
  },
  {
    id: 'angry', label: '生气', match: /生气|愤怒|恼|angry|mad/i, durationMs: 1600,
    tracks: [
      { param: 'headZ', keys: [[0, 0], [0.2, -10], [0.8, -8], [1, 0]] },
      { param: 'eyeOpenL', keys: [[0, 1], [0.2, 0.55], [0.8, 0.6], [1, 1]] },
      { param: 'eyeOpenR', keys: [[0, 1], [0.2, 0.55], [0.8, 0.6], [1, 1]] },
      { param: 'mouthForm', keys: [[0, 0], [0.2, -1], [1, 0]] },
    ],
  },
  {
    id: 'surprise', label: '惊讶', match: /惊讶|吃惊|震惊|surprise|shock/i, durationMs: 1400,
    tracks: [
      { param: 'eyeOpenL', keys: [[0, 1], [0.2, 1.25], [0.75, 1.1], [1, 1]] },
      { param: 'eyeOpenR', keys: [[0, 1], [0.2, 1.25], [0.75, 1.1], [1, 1]] },
      { param: 'mouthOpen', keys: [[0, 0], [0.2, 0.85], [0.75, 0.6], [1, 0]] },
      { param: 'headY', keys: [[0, 0], [0.2, 4], [1, 0]] },
    ],
  },
  {
    id: 'shy', label: '害羞', match: /害羞|不好意思|脸红|shy|blush/i, durationMs: 1800,
    tracks: [
      { param: 'headZ', keys: [[0, 0], [0.3, 9], [0.8, 8], [1, 0]] },
      { param: 'headY', keys: [[0, 0], [0.3, -5], [0.8, -4], [1, 0]] },
      { param: 'eyeOpenL', keys: [[0, 1], [0.3, 0.7], [1, 1]] },
      { param: 'eyeOpenR', keys: [[0, 1], [0.3, 0.7], [1, 1]] },
    ],
  },
  {
    id: 'tired', label: '困倦', match: /困|累|疲惫|睡着|tired|sleepy/i, durationMs: 2200,
    tracks: [
      { param: 'headY', keys: [[0, 0], [0.3, -10], [0.85, -9], [1, 0]] },
      { param: 'eyeOpenL', keys: [[0, 1], [0.25, 0.35], [0.85, 0.4], [1, 1]] },
      { param: 'eyeOpenR', keys: [[0, 1], [0.25, 0.35], [0.85, 0.4], [1, 1]] },
    ],
  },
  {
    id: 'think', label: '思考', match: /思考|想|琢磨|think|hmm/i, durationMs: 2000,
    tracks: [
      { param: 'headZ', keys: [[0, 0], [0.25, 7], [0.8, 5], [1, 0]] },
      { param: 'eyeBallY', keys: [[0, 0], [0.25, 0.5], [0.8, 0.4], [1, 0]] },
      { param: 'eyeBallX', keys: [[0, 0], [0.25, 0.45], [0.8, 0.35], [1, 0]] },
    ],
  },
  {
    id: 'wave', label: '招手', match: /挥手|招手|打招呼|wave|hello/i, durationMs: 1600,
    tracks: [
      { param: 'bodyX', keys: [[0, 0], [0.25, 5], [0.7, 4], [1, 0]] },
      { param: 'headZ', keys: [[0, 0], [0.25, 5], [0.7, 4], [1, 0]] },
    ],
  },
]

const DESIGN_FALLBACK_TRACKS = [
  { param: 'headZ', keys: [[0, 0], [0.25, 6], [0.75, 4], [1, 0]] },
  { param: 'mouthForm', keys: [[0, 0], [0.3, 0.6], [0.8, 0.5], [1, 0]] },
]

export function designAction(label, description) {
  const text = `${label ?? ''} ${description ?? ''}`
  const hit = DESIGN_TEMPLATES.find((item) => item.match.test(text))
  const raw = String(label || hit?.label || '自定义动作').trim()
  const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const id = `c-${(base || 'action').slice(0, 20)}`
  return {
    id,
    label: raw.slice(0, 24),
    durationMs: hit?.durationMs ?? 1600,
    tracks: hit ? hit.tracks : DESIGN_FALLBACK_TRACKS,
    matched: hit?.id ?? null,
  }
}

/**
 * 窗口要显示/播放的预设动作。
 *
 * 内置动作仍留在渲染层和 ANIM_WHITELIST 里，供摸头、生命感和旧调用使用；
 * 但它们按示例模型参数写死，不能作为跨模型菜单项展示。菜单只下发当前模型
 * 可验证的默认动作、模型自带能力，以及用户/AI 的自定义动作。
 */
export function buildPresets(inst, profile = null) {
  // 0.3.2：动作/循环来自「模型档案」；没传档案时退回实例字段（兼容测试与旧调用）
  const customActions = profile?.customActions ?? inst?.config?.customActions ?? []
  const presetSequences = profile?.presetSequences ?? inst?.config?.presetSequences ?? []
  const customIds = new Set(customActions.map((item) => item?.id).filter(Boolean))
  const actions = customActions.map((custom) => ({
    id: custom.id,
    label: custom.label,
    kind: 'custom',
    durationMs: custom.durationMs,
    tracks: custom.tracks,
  }))
  // 0.4.0：按模型能力自动挑的默认动作（与用户自定义动作同构，渲染层一视同仁）
  for (const auto of profile?.autoActions ?? []) {
    // 同 id 自定义动作是 AI/用户给默认动作做的覆盖层；只显示覆盖后的版本。
    if (customIds.has(auto.id)) continue
    actions.push({ id: auto.id, label: auto.label, kind: 'custom', auto: true, durationMs: auto.durationMs, tracks: auto.tracks })
  }
  // 0.5.0：从 Exp3/Animation 扫出来的表情、换装、手势（hold=true，再点一次取消）
  for (const cap of profile?.capabilityActions ?? []) {
    if (customIds.has(cap.id)) continue
    actions.push({
      id: cap.id, label: cap.label, kind: 'custom', auto: true, capability: true,
      hold: cap.hold === true, group: cap.group ?? '', desc: cap.desc ?? '',
      durationMs: cap.durationMs, tracks: cap.tracks,
    })
  }
  const sequences = presetSequences.map((seq) => ({
    id: seq.id, label: seq.label, steps: seq.steps, intervalMs: seq.intervalMs,
  }))
  return { actions, sequences, activeSequence: inst?.presetRun?.id ?? null, profileId: profile?.id ?? null }
}

export function windowConfigPayload(config, presets = null, life = null) {
  return {
    windowWidth: config.windowWidth,
    windowHeight: config.windowHeight,
    windowX: config.windowX,
    windowY: config.windowY,
    bubbleDurationMs: config.bubbleDurationMs,
    bubbleQueueLimit: config.bubbleQueueLimit,
    bubbleMaxChars: config.bubbleMaxChars,
    rendererEnabled: config.rendererEnabled,
    clickThrough: config.clickThrough,
    modelPassthrough: config.modelPassthrough === true,
    adjustMode: config.adjustMode === true,
    replyStyle: config.replyStyle === 'card' ? 'card' : 'bubble',
    bubbleSkin: BUBBLE_SKINS.includes(config.bubbleSkin) ? config.bubbleSkin : 'classic',
    replyOpacity: config.replyOpacity,
    // 阶段 4：回答区的字号与最大高度（%），窗口按这两个值渲染并可滚动
    replyFontSize: config.replyFontSize,
    replyMaxHeightPct: config.replyMaxHeightPct,
    replyHeightRatio: config.replyHeightRatio,
    // 固定气泡大小：开启后窗口侧锁死 bubbleHeightPx，上下拖调整框不再改变气泡
    bubbleFixedSize: config.bubbleFixedSize === true,
    bubbleHeightPx: config.bubbleHeightPx ?? 200,
    // 置顶（持久化；窗口创建时按它设置 alwaysOnTop）
    pinned: config.pinned !== false,
    // 阶段 4：模型缩放（基础适配大小 × pct%）与布局模式（fit / zoom-overlay）
    modelScalePct: config.modelScalePct ?? 100,
    modelLayoutMode: config.modelLayoutMode === 'zoom-overlay' ? 'zoom-overlay' : 'fit',
    // 阶段 4：动态效果开关与幅度
    idleFloat: config.idleFloat !== false,
    lookFollow: config.lookFollow !== false,
    dragInertia: config.dragInertia !== false,
    motionStrength: config.motionStrength,
    autoInteract: config.autoInteract !== false,
    idlePresets: config.idlePresets !== false,
    // 0.13.0：模式与唤醒状态（窗口工具栏按钮要用）
    mode: config.mode === 'auto' || config.mode === 'semi' ? config.mode : 'manual',
    wakeDriver: WAKE_DRIVERS.includes(config.wakeDriver) ? config.wakeDriver : 'off',
    wakeEnabled: config.wakeEnabled === true,
    eventWakeEnabled: config.eventWakeEnabled === true,
    lifeEnabled: config.lifeEnabled !== false,
    lifeFarewellEnabled: config.lifeFarewellEnabled !== false,
    life: life ?? null,
    wakeBusy: false,
    // 0.13.4：窗口自己算「思考超时」提示要用（之前漏发，改过超时的实例窗口仍按 90s 算）
    chatTimeoutMs: config.chatTimeoutMs,
    presets: presets ?? null,
  }
}

export function initPayload(state, extra = {}) {
  const model = state.model
  return {
    type: 'init',
    instanceId: state.id ?? null,
    title: extra.title ?? '',
    // 有 sessionId 但标题暂时解析不到时，窗口显示「会话 xxxxxxxx」而不是「未绑定会话」
    sessionId: state.config?.sessionId || extra.sessionId || null,
    config: windowConfigPayload(state.config, buildPresets(state, state.profile ?? null), lifeStatusSnapshot(state)),
    model: model
      ? {
          ok: model.ok === true,
          entry: model.entry ?? null,
          entryFile: model.entryFile ?? null,
          modelDir: model.modelDir ?? null,
          format: model.format ?? null,
          reason: model.reason ?? null,
          message: model.message ?? null,
          missing: model.missing ?? [],
        }
      : { ok: false, reason: 'not-probed', message: '还没有探测模型' },
    assetBase: 'live2d-asset://model/',
  }
}

/** 窗口 stdout 协议下行（单测也直接调这个）。 */
export function applyWindowMessage(state, message) {
  if (!message || typeof message !== 'object') return
  const type = message.type
  if (type === 'ready') {
    state.renderer.state = 'starting'
    if (state.window) {
      state.window.ready = true
      state.window.state = 'starting'
      if (message.bounds) state.window.bounds = message.bounds
    }
    // at 用来让「改几何」的工具判断这次回报是不是它触发的那一次（0.13.0）
    if (message.bounds) state.windowBounds = { ...message.bounds, at: Date.now() }
    // init 必须带标题：窗口的左上角标签就靠这条消息。
    // 早先 init 只带空 title，渲染层只能退回「会话 xxxxxxxx」；
    // 后面重试又因为「标题已经等于 inst.window.title」被当成没变，永远不推。
    const owner = state.root ? findInstance(state.root, state.id) : null
    const title = owner ? instanceTitle(state.root, owner) : ''
    if (owner && title) owner.window.pushedTitle = title
    // 窗口报回实际几何：旧坐标超屏时主进程会把它夹回工作区（超界部分 Windows 留白底），
    // 这里把纠正后的值落盘一次，免得下次重开又用回超界坐标。
    if (message.bounds && owner && typeof state.applyBounds === 'function') {
      const cfg = owner.config ?? {}
      const b = message.bounds
      const near = (a, c) => typeof a === 'number' && Math.abs(a - c) <= 2
      const changed = !near(cfg.windowX, b.x) || !near(cfg.windowY, b.y)
        || !near(cfg.windowWidth, b.width) || !near(cfg.windowHeight, b.height)
      if (changed) {
        try { state.applyBounds({ x: b.x, y: b.y, width: b.width, height: b.height }) } catch { /* 只影响持久化 */ }
      }
    }
    const sent = state.windows?.send?.(initPayload(state, { title }))
    state.renderer.initQueued = sent?.queued === true
    return
  }
  // 运行中窗口回报几何（用户拖动 / 工具 move-resize-reset / 主进程夹取后）。
  // 以前只有 ready 才写 windowBounds，导致「改几何」的工具永远等不到回报（window-timeout）。
  if (type === 'bounds' && message.bounds) {
    const b = message.bounds
    if (message.transient === true) {
      state.windowBounds = { ...b, at: Date.now() }
      if (state.window) state.window.bounds = { ...b }
      return
    }
    // applyBounds = clamp + patchInstance + 写盘（拖动松手时的原始通道，行为保持不变）
    if (typeof state.applyBounds === 'function') {
      try { state.applyBounds({ x: b.x, y: b.y, width: b.width, height: b.height }) } catch { /* 只影响持久化 */ }
    }
    const cfg = state.config ?? {}
    const landed = {
      x: Number.isFinite(cfg.windowX) ? cfg.windowX : b.x,
      y: Number.isFinite(cfg.windowY) ? cfg.windowY : b.y,
      width: Number.isFinite(cfg.windowWidth) ? cfg.windowWidth : b.width,
      height: Number.isFinite(cfg.windowHeight) ? cfg.windowHeight : b.height,
    }
    // at 用来让「改几何」的工具判断这次回报是不是它触发的那一次
    state.windowBounds = { ...landed, at: Date.now() }
    if (state.window) state.window.bounds = landed
    return
  }
  if (type === 'idle-state') {
    const root = state.root ?? state
    const idleSeconds = Number(message.idleSeconds)
    root.lifeSystem = {
      ...(root.lifeSystem ?? {}),
      idleSeconds: Number.isFinite(idleSeconds) ? Math.max(0, idleSeconds) : null,
      at: Number(message.at) || Date.now(),
    }
    if (state.life) {
      state.life.systemIdleSec = root.lifeSystem.idleSeconds
      state.life.systemIdleAt = root.lifeSystem.at
    }
    return
  }
  if (type === 'state') {
    // 只有生命周期阶段才改 renderer.state；reply-metrics 这类诊断上报不能把状态冲成 'reply-metrics'
    const phase = typeof message.phase === 'string' ? message.phase : null
    if (phase && ['starting', 'rendering', 'placeholder', 'stopped'].includes(phase)) {
      state.renderer.state = phase
      if (state.window) state.window.state = phase
    }
    if (phase === 'layout') {
      state.renderer.layout = {
        at: new Date().toISOString(),
        bubblePx: message.bubblePx ?? null,
        modelPx: message.modelPx ?? null,
        windowWidth: message.windowWidth ?? null,
        windowHeight: message.windowHeight ?? null,
        fixedBubble: message.fixedBubble === true,
      }
    }
    if (phase === 'reply-metrics') {
      state.renderer.metrics = {
        at: new Date().toISOString(),
        mode: message.mode ?? null,
        chars: message.chars ?? null,
        renderedChars: message.renderedChars ?? null,
        maxHeight: message.maxHeight ?? null,
        height: message.height ?? null,
        scrollHeight: message.scrollHeight ?? null,
        overflowing: message.overflowing === true,
        scrollbarVisible: message.scrollbarVisible === true,
        fontSize: message.fontSize ?? null,
      }
    }
    if (message.model) state.renderer.model = message.model
    // 模型真实参数表：AI 设计自定义动作前先看它（换模型也不用改代码）
    if (message.phase === 'model-params') {
      state.renderer.params = {
        at: new Date().toISOString(),
        count: Number(message.count) || 0,
        params: Array.isArray(message.params) ? message.params.map(String).slice(0, 300) : [],
      }
      // 0.4.0：按这只模型真实有的参数挑默认动作（参数集没变不会重复写）
      const owner = state.root ? findInstance(state.root, state.id) : null
      if (owner) owner.rendererParams = { at: new Date().toISOString(), params: state.renderer.params.params }
      try {
        ensureAutoActions(state, owner ?? state)
      } catch (error) {
        state.renderer.autoActionsError = errorText(error)
      }
    }
    // 每个动作在这只模型上能落到几轨（0 轨 = 这个模型做不了，设置页置灰）
    if (message.phase === 'model-capability') {
      state.renderer.capability = {
        at: new Date().toISOString(),
        actions: Array.isArray(message.actions)
          ? message.actions.filter((item) => item && typeof item.id === 'string').map((item) => ({
            id: item.id,
            total: Number(item.total) || 0,
            usable: Number(item.usable) || 0,
            missing: Number(item.missing) || 0,
          }))
          : [],
      }
    }
    // 纹理健康：多纹理模型某张上传失败会渲染成黑块（鼻尖黑块就是这类）
    if (message.phase === 'model-textures') {
      state.renderer.textures = {
        at: new Date().toISOString(),
        count: Number(message.count) || 0,
        managerCount: message.managerCount == null ? null : Number(message.managerCount) || 0,
        maxTextureSize: message.maxTextureSize == null ? null : Number(message.maxTextureSize) || 0,
        list: Array.isArray(message.list)
          ? message.list.map((item) => ({
            i: Number(item?.i) || 0,
            valid: item?.valid === true,
            failed: item?.failed === true,
            w: Number(item?.w) || 0,
            h: Number(item?.h) || 0,
          }))
          : [],
      }
    }
    if (message.error) {
      state.renderer.lastError = String(message.error)
      if (state.window) state.window.error = String(message.error)
      pushRuntimeWarning(state, `渲染失败：${message.error}`)
    }
    // 渲染成功 → 之前那次失败不该一直挂在告警里
    if (message.phase === 'rendering') {
      state.renderer.lastError = null
      if (state.window) {
        state.window.error = null
        state.window.state = 'rendering'
        state.window.ready = true
      }
      clearRuntimeWarnings(state, '渲染失败：')
    }
    return
  }
  if (type === 'error') {
    state.renderer.lastError = String(message.error ?? 'unknown')
    state.renderer.state = 'placeholder'
    if (state.window) {
      state.window.error = String(message.error ?? 'unknown')
      state.window.state = message.code === 'renderer-crash' ? 'stopped' : 'placeholder'
      if (message.code === 'renderer-crash') state.window.ready = false
    }
    pushRuntimeWarning(state, `窗口报错：${message.error ?? 'unknown'}`)
    return
  }
  if (type === 'pin') {
    // 置顶状态：先记在实例上，持久化由协议回调统一写盘（那里能拿到 root state）
    if (state.window && typeof message.pinned === 'boolean') state.window.pinned = message.pinned
    return
  }
  if (type === 'closed') {
    state.renderer.state = 'stopped'
    state.renderer.model = null
    state.renderer.lastError = null
    if (state.window) {
      state.window.state = 'stopped'
      state.window.ready = false
    }
    return
  }
  if (type === 'bubble-shown') {
    state.bubble.bubbleCount = (state.bubble.bubbleCount ?? 0) + 1
    state.bubble.lastShown = { at: new Date().toISOString(), seq: message.seq ?? null }
    return
  }
  if (type === 'anim-done') {
    // 窗口确认动作播完（或已被新指令顶掉）——清掉超时兜底标记
    state.anim = {
      ...(state.anim ?? {}),
      ackedAt: new Date().toISOString(),
      timeout: false,
      lastDone: typeof message.action === 'string' ? message.action : state.anim?.lastAction ?? null,
    }
    return
  }
  if (type === 'preset-refresh') {
    const owner = state.root ? findInstance(state.root, state.id) : null
    if (owner) pushPresetsToWindow(state.root, owner)
    return
  }
  if (type === 'drag') {
    // 窗口正在被拖动/调整：双模型互动跳过它，别对着一个正在移动的模型做反应
    const owner = state.root ? findInstance(state.root, state.id) : null
    if (owner) owner.window = { ...(owner.window ?? {}), dragging: message.active === true }
    return
  }
  if (type === 'tap') {
    // 用户点了模型（预设交互）：窗口只负责报坐标区域，动作选择和冷却都在宿主
    const owner = state.root ? findInstance(state.root, state.id) : null
    if (owner) {
      markUserActivity(state.root, owner.config?.sessionId ?? null, 'tap')
      const zone = ['hair', 'face', 'hand', 'head', 'body'].includes(message.zone) ? message.zone : 'body'
      const gesture = ['tap', 'double', 'long', 'pat'].includes(message.gesture) ? message.gesture : 'tap'
      handlePresetTap(state.root, owner, zone, state.logger, gesture)
    }
    return
  }
  if (type === 'preset-play') {
    // 右键菜单点了某个动作：立刻播（用户行为，不走模式守卫/冷却）
    const owner = state.root ? findInstance(state.root, state.id) : null
    if (owner) {
      const result = playPreset(state.root, owner, message.action, state.logger)
      if (!result.ok) {
        pushPresetsToWindow(state.root, owner)
        notifyInstance(state.root, owner, `这个动作不属于当前模型档案（${result.code || 'unknown'}），菜单已经刷新。`, 4000)
      }
    }
    return
  }
  if (type === 'preset-sequence') {
    // 右键菜单点了某个循环：正在跑就停，否则开
    const owner = state.root ? findInstance(state.root, state.id) : null
    if (!owner) return
    const id = String(message.id ?? '')
    if (owner.presetRun?.id === id) stopPresetSequence(state.root, owner)
    else {
      const started = startPresetSequence(state.root, owner, id, state.logger)
      if (!started.ok) {
        pushPresetsToWindow(state.root, owner)
        notifyInstance(state.root, owner, '这个循环不属于当前模型档案，菜单已经刷新。', 4000)
      }
    }
    return
  }
  if (type === 'preset-sequence-stop') {
    const owner = state.root ? findInstance(state.root, state.id) : null
    if (owner) stopPresetSequence(state.root, owner)
    return
  }
  if (type === 'open-settings') {
    const owner = state.root ? findInstance(state.root, state.id) : null
    queueUiCommand(state.root, 'open-settings', {
      section: 'actions',
      instanceId: owner?.id ?? state.id ?? null,
      profileId: owner ? profileFor(state.root, owner)?.id ?? null : null,
    })
    return
  }
  if (type === 'set-mode') {
    // 工具栏点了模式按钮：写回实例配置（不是 AI 控制，不受权限层限制）
    const owner = state.root ? findInstance(state.root, state.id) : null
    if (!owner) return
    const next = message.mode === 'auto' || message.mode === 'semi' ? message.mode : 'manual'
    const result = patchInstance(state.root, owner.id, { mode: next })
    if (result.ok) {
      try { state.windows?.send?.({ type: 'config', patch: { mode: next } }, owner.id) } catch { /* 窗口可能已关 */ }
      // 切模式时把「这个模式会用到什么」讲清楚（含风险），开关没开也一起提示
      // 重新取一次实例：patchInstance 会重建 config 对象，用旧引用会读到切模式前的开关值
      const fresh = findInstance(state.root, owner.id) ?? owner
      const cfg = fresh.config ?? {}
      const missing = []
      if (cfg.screenReadEnabled !== true) missing.push('读屏·前台标题')
      if (cfg.screenCaptureEnabled !== true) missing.push('允许截图')
      if (next === 'manual' && cfg.aiMoveEnabled !== true) missing.push('交给 AI 移动窗口')
      if (next !== 'auto' && cfg.wakeDriver === 'off') missing.push('主动感知方式（定时或事件）')
      if (next === 'auto') {
        notifyInstance(state.root, owner, '已切到「手动」：我不会自己动，只有你点 ⚡ 或摸模型才回应。')
      } else if (next === 'semi') {
        notifyInstance(state.root, owner, `已切到「AI 半自动」：会在你思考/回答时读屏并主动说话${cfg.screenCaptureEnabled ? '（会定期截屏）' : '（只读窗口标题）'}。${missing.length ? `未开启：${missing.join('、')}——去「设置 → 模式设置」打开。` : ''}`, 8000)
      } else {
        notifyInstance(state.root, owner, `已切到「AI 自动」：除半自动的全部能力外，还能自己挪动/缩放窗口。${missing.length ? `未开启：${missing.join('、')}——去「设置 → 模式设置」打开。` : ''}`, 8000)
      }
    }
    return
  }
  if (type === 'set-passthrough') {
    // 工具栏点了「◐」：模型区是否拦鼠标（用户操作，不受权限层限制）
    const owner = state.root ? findInstance(state.root, state.id) : null
    if (!owner) return
    const on = message.on === true
    const result = patchInstance(state.root, owner.id, { modelPassthrough: on })
    if (result.ok) {
      try { state.windows?.send?.({ type: 'config', patch: { modelPassthrough: on } }, owner.id) } catch { /* 窗口可能已关 */ }
    }
    return
  }
  if (type === 'wake-request') {
    // 工具栏点了 ⚡：按钮唤醒（来源 wake-button，受滚动额度限制）
    const owner = state.root ? findInstance(state.root, state.id) : null
    if (!owner) return
    markUserActivity(state.root, owner.config?.sessionId ?? null, 'wake-button')
    const result = requestWake(state.root, owner, 'wake-button', state.logger)
    if (result.ok !== true) {
      // 没开起来：把按钮的忙碌态推回去（窗口不再本地定时清除）
      try { setWakeBusy(state.root, owner, false) } catch { /* 忽略 */ }
      pushRuntimeWarning(state.root, `唤醒未执行：${result.error ?? result.code}`)
      try {
        state.windows?.send?.(
          { type: 'bubble', text: result.error ?? '这次没能叫醒我', durationMs: 4000, seq: Date.now() % 100000 },
          owner.id,
        )
      } catch { /* 忽略 */ }
    }
    return
  }
  if (type === 'bounds') {
    // 阶段 1.5：用户在调整框里拖完松手 —— 窗口把最终 bounds 回传，这里 clamp + 落盘。
    // 多实例下由 instanceView 提供 applyBounds（只改这个实例自己的几何）。
    if (typeof state.applyBounds === 'function') state.applyBounds(message.bounds)
  }
}

function findSessionForBubble(ctx, state, sessionId) {
  const service = getService(ctx, 'sessions')
  if (!service || typeof service.get !== 'function') {
    return { ok: false, status: 503, error: 'sessions 服务不可用' }
  }
  const tryGet = (id) => {
    try { return service.get(id) ?? null } catch { return null }
  }

  if (sessionId) {
    const session = tryGet(sessionId)
    if (!session) return { ok: false, status: 404, error: `会话 ${sessionId} 不存在`, hint: 'GET /live2d/diag 的 p1 段能看到当前可用会话 id' }
    return { ok: true, session, sessionId, resolvedBy: 'explicit' }
  }

  // 设置页里显式绑定的会话：优先级高于「最近活动」，避免多会话时静默发错人。
  // 绑定存在但拿不到会话（还没在 GUI 里打开 / agent 未激活）时必须直接失败——
  // 绝不能回落到 recent 或 list()[0]，那正是「绑定无效、消息跑到别的对话」的来源。
  const bound = state.config?.sessionId || state.config?.boundSessionId
  if (bound) {
    const session = tryGet(bound)
    if (!session) {
      return {
        ok: false,
        status: 404,
        code: 'bound-inactive',
        error: `绑定的会话 ${bound} 还没激活`,
        hint: '在 DSH 里打开一次这个对话（让它的 agent 激活）再发；在此之前不会把消息发到任何别的会话。',
        sessionId: bound,
        resolvedBy: 'bound',
      }
    }
    return { ok: true, session, sessionId: bound, resolvedBy: 'bound' }
  }

  if (state.recentSessionId) {
    const session = tryGet(state.recentSessionId)
    if (session) return { ok: true, session, sessionId: state.recentSessionId, resolvedBy: 'recent-user-message' }
  }

  let list = []
  try { list = service.list?.() ?? [] } catch { list = [] }
  if (Array.isArray(list) && list.length > 0 && list[0]?.id) {
    // list() 返回的可能是轻量行（只有 id），必须再 get() 一次拿带 deriveMessages 的完整会话
    const full = tryGet(list[0].id) ?? list[0]
    return { ok: true, session: full, sessionId: list[0].id, resolvedBy: 'first-in-list' }
  }
  return { ok: false, status: 404, error: '当前没有可用会话', hint: '先在 DSH GUI 里打开一个会话（或传 sessionId）' }
}

/** 设置页用：显示「这条消息会发到哪个会话」，避免多会话时静默发错。 */
export function resolveChatTarget(ctx, state) {
  const target = findSessionForBubble(ctx, state, null)
  if (!target.ok) return { ok: false, error: target.error }
  const title = sessionTitleOf(ctx, target.session)
  return {
    ok: true,
    sessionId: target.sessionId,
    title: title?.title ?? null,
    resolvedBy: target.resolvedBy,
  }
}

/**
 * 设置页「绑定会话」下拉的数据源。
 * sessions.list() 只覆盖当前进程里活跃/加载过的会话；没打开的对话从 projcache 目录补，
 * 否则「不活跃会话也要能选、能显示标题」做不到（下拉里会缺项，看起来像未绑定）。
 */
/** 自动化会话（治理插件 AI 审查 / 只读工具调用 / headless）——用户不认识，默认不进下拉。 */
export const AUTOMATION_TITLE = /^headless\b|plugin_governance|^call the tool|^read-only governance|summary call/i

export function isAutomationTitle(title) {
  return typeof title === 'string' && AUTOMATION_TITLE.test(title.trim())
}

export function collectSessionsForPicker(ctx, limit = 50, dir = SESSION_PROJCACHE_DIR, options = {}) {
  const includeArchived = options.includeArchived === true
  const includeBlank = options.includeBlank === true
  const includeAutomation = options.includeAutomation === true
  const archived = includeArchived ? new Set() : readArchivedSessionIds(options.workspaceFile)
  const service = getService(ctx, 'sessions')

  /** 空白对话：projcache 标的 blank，或活跃会话里一条消息都没有。 */
  const isBlank = (id) => {
    const meta = projCacheMeta(id, dir)
    if (meta) return meta.blank === true
    try {
      const session = service?.get?.(id) ?? null
      const messages = session?.deriveMessages?.()
      return Array.isArray(messages) ? messages.length === 0 : false
    } catch {
      return false
    }
  }
  const keep = (id) => !archived.has(id) && (includeBlank || !isBlank(id))
  const acceptTitle = (title) => includeAutomation || !isAutomationTitle(title)

  const out = new Map()
  if (service && typeof service.list === 'function') {
    let list = []
    try { list = service.list() ?? [] } catch { list = [] }
    for (const item of (Array.isArray(list) ? list : [])) {
      const id = item?.id ?? item?.sessionId ?? null
      if (!id || !keep(id)) continue
      // 标题：先问活跃会话，拿不到再读 projcache
      const title = resolveSessionTitle(ctx, id) ?? null
      if (!acceptTitle(title)) continue
      out.set(id, { id, title })
    }
  }
  try {
    // 目录里不只有会话：还有工作区级缓存文件（非会话记录）也要跳过。
    // 只认带 `session-` 前缀的 UUID 文件——不带前缀的是 subagent 子会话，
    // 硬拼成 session-<uuid> 会列出根本不存在的对话（显示成「无标题」）。
    const isSessionFile = (name) => /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.test(name)
    for (const name of readdirSync(dir)) {
      if (!isSessionFile(name)) continue
      const id = name.slice(0, -5)
      if (out.has(id) || !keep(id)) continue
      const title = titleFromProjCache(id, dir)
      if (!acceptTitle(title)) continue
      out.set(id, { id, title })
    }
  } catch {
    /* 目录不存在就只靠 sessions 服务 */
  }
  const rows = [...out.values()]
  rows.sort((a, b) => (a.title ? 0 : 1) - (b.title ? 0 : 1))
  return rows.slice(0, limit)
}

function agentIsRunning(ctx, sessionId) {
  try {
    const agents = getService(ctx, 'agents')
    if (!agents) return false
    const list = agents.list?.() ?? []
    const hit = Array.isArray(list)
      ? list.find((item) => item?.session?.id === sessionId || item?.sessionId === sessionId || item?.id === sessionId)
      : null
    if (hit && hit.status === 'running') return true
    const direct = agents.get?.(sessionId)
    return direct?.status === 'running'
  } catch {
    return false
  }
}

function textIdentity(text) {
  return `text:${createHash('sha1').update(text).digest('hex').slice(0, 12)}`
}

/** 一条回复的稳定身份：messageId 优先，其次 seq，最后才是文本哈希（只在缺 ID 时用）。 */
export function replyKeyOf(message, text = '') {
  const id = message?.id ?? message?.messageId
  if (id) return `id:${id}`
  if (typeof message?.seq === 'number') return `seq:${message.seq}`
  return `text:${textIdentity(text)}`
}

/**
 * 原子领取一条回复：同一实例同一条消息只允许一个显示者。
 * 窗口气泡（maybeFinishChat）、自动气泡（pushIdleReplies）、唤醒气泡（pushWakeBubble）
 * 三条路径都会到这里，抢到的那条负责显示，其余直接跳过——这是「一轮只弹一次」的唯一保证。
 * 文本兜底键只保留 5 秒：不同轮次的「好的」「收到」不能因为文本相同就永久被吞。
 */
export function claimReply(inst, key, now = Date.now()) {
  if (!inst || !key) return true
  if (!inst.bubble) inst.bubble = {}
  const last = inst.bubble.claim
  const ttl = String(key).startsWith('text:') ? 5000 : 10 * 60 * 1000
  if (last && last.key === key && now - last.at < ttl) return false
  inst.bubble.claim = { key, at: now }
  return true
}

async function waitForWindowReady(state, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (state.windows?.status?.().ready) return true
    if (!state.windows?.status?.().running) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return Boolean(state.windows?.status?.().ready)
}

// ---------------------------------------------------------------------------
// 阶段 2：窗口内对话（提交 → 等回复 → 推 reply 事件）
//
// 约定：HTTP 与窗口协议共用 submitChat；长回复**不进 HTTP 响应**，
// 一律通过控制通道的 `reply` 消息推给窗口，避免请求超时。
// ---------------------------------------------------------------------------

const CHAT_TEXT_LIMIT = 2000
const CHAT_FINISH_DELAY_MS = 400
// 绑定会话还没打开时，消息可以先排队（等它激活后自动发出去）
const CHAT_QUEUE_LIMIT = 3
const CHAT_QUEUE_TTL_MS = 10 * 60 * 1000

/** 会话还没激活：不拒收，排队等它打开再发（队列上限 3、10 分钟过期）。 */
function enqueueChat(state, text, log) {
  const chat = state.chat ?? (state.chat = {})
  const queue = Array.isArray(chat.queue) ? chat.queue : (chat.queue = [])
  const requestId = `chat-${randomUUID()}`
  queue.push({ requestId, text, at: Date.now(), sessionId: state.config?.sessionId ?? null })
  while (queue.length > CHAT_QUEUE_LIMIT) queue.shift()
  logged(log, `[${state.id ?? 'live2d'}] 绑定会话未激活，消息已排队（${queue.length}/${CHAT_QUEUE_LIMIT}）`)
  state.windows?.send?.({
    type: 'chat-ack',
    ok: true,
    queued: true,
    requestId,
    text: '已排队：等这个对话打开后自动发出',
  })
  return {
    status: 200,
    payload: {
      ok: true,
      queued: true,
      requestId,
      queueSize: queue.length,
      hint: '绑定会话还没打开，消息已排队；打开那个对话后会自动发出（最多等 10 分钟）',
    },
  }
}

/** 事件里检测到会话激活：把排队的消息投出去（一次一条，剩下的等下一轮）。 */
export function flushChatQueue(ctx, state, log) {
  for (const inst of state.instances ?? []) {
    const view = instanceView(state, inst)
    const queue = view.chat?.queue
    if (!Array.isArray(queue) || queue.length === 0) continue
    if (view.chat.pending) continue
    const now = Date.now()
    while (queue.length && now - (queue[0]?.at ?? 0) > CHAT_QUEUE_TTL_MS) queue.shift()
    if (queue.length === 0) continue
    const bound = view.config?.sessionId
    if (!bound) continue
    const session = getService(ctx, 'sessions')?.get?.(bound) ?? null
    if (!session) continue
    // 会话在、但 agent 还没激活时不要投递（否则 submitChat 会把它又塞回队列）
    if (!resolveAgent(ctx, bound).ok) continue
    const item = queue.shift()
    const result = submitChat(ctx, view, log, { text: item.text, sessionId: bound })
    if (result.status === 200 && result.payload?.accepted) {
      logged(log, `[${inst.id}] 排队的消息已发出（requestId=${result.payload.requestId}）`)
      view.windows?.send?.({ type: 'chat-status', phase: 'queued-sent', requestId: result.payload.requestId, queueId: item.requestId })
    } else {
      // 还没准备好（例如 agent 仍未激活）：放回队首，下一轮再试
      queue.unshift(item)
      break
    }
  }
}

function assistantIdentity(session) {
  const latest = findLatestAssistantText(session)
  if (!latest.ok) return null
  // 稳定身份优先用 message id：数组下标会随压缩/裁剪漂移，文本哈希在同文回复时会误判
  const id = latest.message?.id ?? latest.message?.messageId
  if (id) return `id:${id}`
  return `${latest.index}:${createHash('sha1').update(latest.text).digest('hex').slice(0, 12)}`
}

function clearChatTimers(state) {
  if (!state.chat) return
  if (state.chat.finishTimer) { clearTimeout(state.chat.finishTimer); state.chat.finishTimer = null }
  if (state.chat.timeoutTimer) { clearTimeout(state.chat.timeoutTimer); state.chat.timeoutTimer = null }
}

function failChat(state, log, requestId, error) {
  const pending = state.chat?.pending
  if (!pending) return
  if (requestId && pending.requestId !== requestId) return
  clearChatTimers(state)
  state.chat.pending = null
  state.chat.lastError = error
  state.chat.replySource = null
  state.windows?.send?.({ type: 'reply', requestId: pending.requestId, ok: false, error })
  pushRuntimeWarning(state, `窗口对话失败：${error}`)
}

/** agent 空闲 / assistant 消息落盘后，用「最后一条 assistant 文本」判定这一轮结束。 */
/** 事件回调只拿到 root state：对每个实例的视图各跑一遍（pending 只会在有对话的那个实例上）。 */
function finishChatsEverywhere(state) {
  const ctx = state.ctx ?? state.root?.ctx ?? null
  const list = state.instances ?? []
  if (list.length === 0) {
    maybeFinishChat(state, ctx)
    return
  }
  for (const inst of list) {
    try {
      maybeFinishChat(instanceView(state, inst), ctx)
    } catch {
      /* 单个实例出错不影响别的 */
    }
  }
}

/** 通知窗口「这一轮结束」，只负责收掉输入框的「思考中」，不弹气泡。 */
function notifyChatDone(state, requestId) {
  try {
    state.windows?.send?.({ type: 'chat-status', phase: 'done', requestId })
  } catch { /* 窗口没了就算了 */ }
}

function maybeFinishChat(state, ctx = null) {
  const pending = state.chat?.pending
  if (!pending || !pending.session) return
  if (state.chat.finishTimer) clearTimeout(state.chat.finishTimer)
  state.chat.finishTimer = setTimeout(() => {
    state.chat.finishTimer = null
    if (state.chat?.pending?.requestId !== pending.requestId) return
    // agent 还在跑（工具调用往返中）就先不结束：中间那条 assistant 不是最终回答
    if (ctx && agentIsRunning(ctx, pending.sessionId)) {
      maybeFinishChat(state, ctx)
      return
    }
    // agent 已结束：本轮来源标记只属于这次等待，不能在失败/无回复/去重路径遗留。
    state.chat.replySource = null
    const identity = assistantIdentity(pending.session)
    if (!identity || identity === pending.before) {
      // 这一轮没有新回复（被取消/失败）：仍要告诉窗口收掉「思考中」
      clearChatTimers(state)
      state.chat.pending = null
      notifyChatDone(state, pending.requestId)
      return
    }
    const latest = findLatestAssistantText(pending.session)
    if (!latest.ok) {
      clearChatTimers(state)
      state.chat.pending = null
      notifyChatDone(state, pending.requestId)
      return
    }
    // 一轮只允许一个显示者：若自动气泡 / 唤醒气泡已经先抢到这一条，这里只收尾不再弹
    const claimed = claimReply(state, replyKeyOf(latest.message, latest.text))
    clearChatTimers(state)
    state.chat.pending = null
    if (!claimed) {
      // 气泡已经被别的路径显示过，但输入框的「思考中」必须收掉
      notifyChatDone(state, pending.requestId)
      return
    }
    const at = new Date().toISOString()
    state.chat.lastReply = { requestId: pending.requestId, text: latest.text, at, sessionId: pending.sessionId }
    state.chat.history = [
      ...(state.chat.history ?? []),
      { at, requestId: pending.requestId, sessionId: pending.sessionId, text: latest.text.slice(0, 500) },
    ].slice(-20)
    state.windows?.send?.({
      type: 'reply',
      requestId: pending.requestId,
      ok: true,
      text: displayBubbleText(latest.text, 2000),
      format: 'markdown',
      sessionId: pending.sessionId,
      style: state.config.replyStyle,
      durationMs: state.config.bubbleDurationMs,
      maxChars: state.config.bubbleMaxChars,
      opacity: state.config.replyOpacity,
    })
  }, CHAT_FINISH_DELAY_MS)
  if (typeof state.chat.finishTimer?.unref === 'function') state.chat.finishTimer.unref()
}

/**
 * 提交一条窗口消息。返回 { status, payload }，HTTP 路由与窗口协议共用。
 * 发送走 agent.followup，**必须**接住 rejection（否则会直接结束宿主进程）。
 */
export function submitChat(ctx, state, log, body) {
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text) return { status: 400, payload: { ok: false, error: 'text 不能为空' } }
  if (text.length > CHAT_TEXT_LIMIT) {
    return { status: 400, payload: { ok: false, error: `text 太长（${text.length} 字，上限 ${CHAT_TEXT_LIMIT}）` } }
  }
  if (state.chat?.pending) {
    return {
      status: 409,
      payload: { ok: false, error: '上一条还在等回复', requestId: state.chat.pending.requestId },
    }
  }

  // 多实例：只有默认实例允许「没绑定时自动解析」（单实例向后兼容）。
  // 非默认实例没绑定会话就必须拒绝，绝不能回落到别的实例/别人的会话里。
  const rootState = state.root ?? state
  const boundSessionId = typeof state.config?.sessionId === 'string' && state.config.sessionId.trim()
    ? state.config.sessionId.trim()
    : ''
  const isDefaultInstance = !state.root || rootState.instances?.[0]?.id === state.id
  if (!body?.sessionId && !boundSessionId && !isDefaultInstance) {
    return {
      status: 409,
      payload: {
        ok: false,
        code: 'unbound-instance',
        error: '这个实例还没绑定会话：请先在设置页给它绑定一个对话，或请求体里带 sessionId',
      },
    }
  }

  const target = findSessionForBubble(ctx, state, body?.sessionId)
  if (!target.ok) {
    // 绑定了会话但还没激活：排队，等它打开后自动发（绝不改投别的会话）
    if (target.code === 'bound-inactive') return enqueueChat(state, text, log)
    return { status: target.status ?? 400, payload: { ok: false, error: target.error, hint: target.hint } }
  }
  const agent = resolveAgent(ctx, target.sessionId)
  if (!agent.ok) {
    // 会话存在但 agent 还没起来（未激活）——同样排队，避免用户白打一条
    return enqueueChat(state, text, log)
  }

  const requestId = `chat-${randomUUID()}`
  markUserActivity(rootState, target.sessionId, 'chat')
  const message = {
    id: `live2d-chat-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'live2d-chat' },
  }
  const before = assistantIdentity(target.session)
  state.chat = {
    ...(state.chat ?? {}),
    pending: {
      requestId,
      sessionId: target.sessionId,
      session: target.session,
      agent: agent.agent,
      startedAt: Date.now(),
      before,
      text,
    },
    history: state.chat?.history ?? [],
    finishTimer: null,
    timeoutTimer: null,
  }

  const timeoutMs = state.config.chatTimeoutMs
  const showLate = state.config.showLateReply === true
  // 思考超时：默认直接判失败（不输出回答）；开了 showLateReply 就继续等，
  // 但在 2× 时间后再兜一次底，避免永远挂着 loading。
  const onTimeout = () => {
    if (!showLate) {
      failChat(state, log, requestId, `等回复超时（${Math.round(timeoutMs / 1000)} 秒）`)
      return
    }
    try {
      state.windows?.send?.({ type: 'chat-status', requestId, phase: 'late' }, state.id)
    } catch { /* 窗口可能已关 */ }
    state.chat.timeoutTimer = setTimeout(
      () => failChat(state, log, requestId, `等回复超时（${Math.round((timeoutMs * 2) / 1000)} 秒）`),
      timeoutMs,
    )
    if (typeof state.chat.timeoutTimer?.unref === 'function') state.chat.timeoutTimer.unref()
  }
  state.chat.timeoutTimer = setTimeout(onTimeout, timeoutMs)
  if (typeof state.chat.timeoutTimer?.unref === 'function') state.chat.timeoutTimer.unref()

  try {
    // 标记本轮来源：一轮结束时 pushIdleReplies 用它决定推不推气泡
    // （auto 模式下「用户在窗口输入框说话」也必须能看到回复）
    if (state.chat) state.chat.replySource = 'window-chat'
    const result = agent.agent.followup(message)
    Promise.resolve(result).then(
      () => {},
      (error) => failChat(state, log, requestId, `会话拒绝了这条消息：${errorText(error)}`),
    )
  } catch (error) {
    failChat(state, log, requestId, `发送失败：${errorText(error)}`)
    return { status: 500, payload: { ok: false, error: errorText(error) } }
  }

  return {
    status: 200,
    payload: {
      ok: true,
      accepted: true,
      requestId,
      sessionId: target.sessionId,
      resolvedBy: target.resolvedBy,
      agentVia: agent.via ?? null,
    },
  }
}

/** 阶段 4：可触发的动作白名单（窗口侧有关键帧动画；不在表里的一律拒绝）。 */
export const ANIM_WHITELIST = [
  'idle', 'nod', 'shake', 'tilt', 'happy', 'shy', 'surprised', 'blink',
  // 表情扩展（模型 EXP 参数自带贴图，观感比单纯调参数明显）
  'angry', 'drool', 'xx', 'puff',
]

/** 内置动作的中文名（右键菜单/设置页显示用）。 */
export const BUILTIN_ACTION_LABELS = {
  idle: '停止动作', nod: '点头', shake: '摇头', tilt: '歪头', happy: '开心',
  shy: '害羞', surprised: '惊讶', blink: '眨眼', angry: '生气', drool: '流口水',
  xx: 'X X 眼', puff: '栗子嘴',
}

const BUILTIN_ACTION_IDS = new Set(ANIM_WHITELIST)

// --- 动作词条库（0.4.0）-------------------------------------------------------
// 起因：内置 12 个动作写死「示例模型」的参数（PARAM_EXP3~8 等），换到没这些参数的模型上，
// 缺轨被静默跳过 → 用户看到「动作做不出来」。改成词条库：每条只声明自己要哪几个逻辑参数，
// 模型加载后按它的真实参数筛出「所有轨道都落得下」的，挑 10 条写进模型档案当默认动作。
// pool 决定优先级：core（标准参数，人人有）> special（模型专属参数）> exp（表情贴图参数）。
export const ACTION_LIBRARY = [
  // 通用池：只依赖 Cubism 标准参数
  { id: 'nod', label: '点头', desc: '头往下点几下', pool: 'core', durationMs: 2200, repeat: 3,
    needs: ['headY'], tracks: [{ param: 'headY', keys: [[0, 0], [0.2, -26], [0.6, -24], [1, 0]] }] },
  { id: 'shake', label: '摇头', desc: '左右摇两次头', pool: 'core', durationMs: 2000, repeat: 2,
    needs: ['headX'], tracks: [{ param: 'headX', keys: [[0, 0], [0.22, 24], [0.62, -22], [1, 0]] }] },
  { id: 'tilt', label: '歪头', desc: '头歪向一侧停一下', pool: 'core', durationMs: 2000,
    needs: ['headZ', 'headX'], tracks: [
      { param: 'headZ', keys: [[0, 0], [0.15, 18], [0.8, 16], [1, 0]] },
      { param: 'headX', keys: [[0, 0], [0.15, 8], [0.8, 6], [1, 0]] },
    ] },
  { id: 'blink', label: '眨眼', desc: '连眨三次', pool: 'core', durationMs: 900, repeat: 3,
    needs: ['eyeOpenL', 'eyeOpenR'], tracks: [
      { param: 'eyeOpenL', keys: [[0, 1], [0.3, 0.02], [0.6, 0.02], [1, 1]] },
      { param: 'eyeOpenR', keys: [[0, 1], [0.3, 0.02], [0.6, 0.02], [1, 1]] },
    ] },
  { id: 'wink-l', label: '眨左眼', desc: '睁一只眼闭一只眼', pool: 'core', durationMs: 1200,
    needs: ['eyeOpenL', 'mouthForm'], tracks: [
      { param: 'eyeOpenL', keys: [[0, 1], [0.25, 0.04], [0.8, 0.04], [1, 1]] },
      { param: 'mouthForm', keys: [[0, 0], [0.25, 0.7], [0.8, 0.7], [1, 0]] },
    ] },
  { id: 'wink-r', label: '眨右眼', desc: '另一只眼眨一下', pool: 'core', durationMs: 1200,
    needs: ['eyeOpenR', 'mouthForm'], tracks: [
      { param: 'eyeOpenR', keys: [[0, 1], [0.25, 0.04], [0.8, 0.04], [1, 1]] },
      { param: 'mouthForm', keys: [[0, 0], [0.25, 0.7], [0.8, 0.7], [1, 0]] },
    ] },
  { id: 'look', label: '东张西望', desc: '眼珠左右看，头跟着转', pool: 'core', durationMs: 2600,
    needs: ['eyeBallX', 'headX'], tracks: [
      { param: 'eyeBallX', keys: [[0, 0], [0.2, 0.9], [0.5, -0.9], [0.8, 0.5], [1, 0]] },
      { param: 'headX', keys: [[0, 0], [0.2, 12], [0.5, -12], [0.8, 6], [1, 0]] },
    ] },
  { id: 'smile', label: '微笑', desc: '嘴角上扬、嘴微张', pool: 'core', durationMs: 1600,
    needs: ['mouthForm', 'mouthOpen'], tracks: [
      { param: 'mouthForm', keys: [[0, 0], [0.2, 1], [0.8, 0.9], [1, 0]] },
      { param: 'mouthOpen', keys: [[0, 0], [0.2, 0.3], [0.8, 0.25], [1, 0]] },
    ] },
  { id: 'talk', label: '张嘴说话', desc: '嘴连续开合几次', pool: 'core', durationMs: 1200, repeat: 3,
    needs: ['mouthOpen'], tracks: [
      { param: 'mouthOpen', keys: [[0, 0], [0.3, 0.7], [0.6, 0.15], [1, 0]] },
    ] },
  { id: 'lean', label: '身体前倾', desc: '身子往一侧歪一下', pool: 'core', durationMs: 2000,
    needs: ['bodyX'], tracks: [
      { param: 'bodyX', keys: [[0, 0], [0.2, 10], [0.8, 8], [1, 0]] },
    ] },
  { id: 'surprise-eyes', label: '瞪大眼', desc: '眼睛睁大、嘴张开', pool: 'core', durationMs: 1600,
    needs: ['eyeOpenL', 'eyeOpenR', 'mouthOpen'], tracks: [
      { param: 'eyeOpenL', keys: [[0, 1], [0.18, 1.5], [0.75, 1.35], [1, 1]] },
      { param: 'eyeOpenR', keys: [[0, 1], [0.18, 1.5], [0.75, 1.35], [1, 1]] },
      { param: 'mouthOpen', keys: [[0, 0], [0.18, 0.85], [0.75, 0.7], [1, 0]] },
    ] },
  { id: 'brow-up', label: '挑眉', desc: '眉毛挑起来', pool: 'core', durationMs: 1400,
    needs: ['browLY', 'browRY'], tracks: [
      { param: 'browLY', keys: [[0, 0], [0.2, 1], [0.8, 0.9], [1, 0]] },
      { param: 'browRY', keys: [[0, 0], [0.2, 1], [0.8, 0.9], [1, 0]] },
    ] },
  { id: 'frown', label: '皱眉', desc: '眉毛压低、嘴角往下', pool: 'core', durationMs: 1800,
    needs: ['browLY', 'browRY', 'mouthForm'], tracks: [
      { param: 'browLY', keys: [[0, 0], [0.2, -1], [0.8, -0.9], [1, 0]] },
      { param: 'browRY', keys: [[0, 0], [0.2, -1], [0.8, -0.9], [1, 0]] },
      { param: 'mouthForm', keys: [[0, 0], [0.2, -0.8], [0.8, -0.7], [1, 0]] },
    ] },
  { id: 'nod-tilt', label: '点头歪头', desc: '点头的同时歪一下', pool: 'core', durationMs: 2400,
    needs: ['headY', 'headZ'], tracks: [
      { param: 'headY', keys: [[0, 0], [0.25, -20], [0.6, -6], [1, 0]] },
      { param: 'headZ', keys: [[0, 0], [0.25, 10], [0.7, 12], [1, 0]] },
    ] },
  // 模型专属参数：一些精致模型自带（如鼓脸、惊讶嘴型、瞳孔位移）
  { id: 'cheek-puff', label: '鼓脸', desc: '脸颊鼓起来', pool: 'special', durationMs: 2000,
    needs: ['cheekPuff'], tracks: [
      { param: 'cheekPuff', keys: [[0, 0], [0.2, 1], [0.8, 1], [1, 0]] },
    ] },
  { id: 'shock-mouth', label: '惊讶张嘴', desc: '用模型的惊讶嘴型', pool: 'special', durationMs: 1800,
    needs: ['shockL', 'shockR'], tracks: [
      { param: 'shockL', keys: [[0, 0], [0.2, 1], [0.8, 1], [1, 0]] },
      { param: 'shockR', keys: [[0, 0], [0.2, 1], [0.8, 1], [1, 0]] },
    ] },
  { id: 'pupil-look', label: '瞳孔游移', desc: '眼珠（瞳孔）左右移动', pool: 'special', durationMs: 2000,
    needs: ['pupilX', 'pupilY'], tracks: [
      { param: 'pupilX', keys: [[0, 0], [0.25, 0.8], [0.6, -0.8], [1, 0]] },
      { param: 'pupilY', keys: [[0, 0], [0.25, 0.3], [0.6, -0.3], [1, 0]] },
    ] },
  // 表情贴图池：靠模型的 EXP* 参数（示例模型这类模型有，很多模型没有 → 会自动跳过）
  { id: 'blush', label: '脸红', desc: '腮红贴图 + 歪头', pool: 'exp', durationMs: 3200,
    needs: ['blush'], tracks: [
      { param: 'blush', keys: [[0, 0], [0.12, 1], [0.86, 1], [1, 0]] },
      { param: 'headX', keys: [[0, 0], [0.12, 16], [0.86, 13], [1, 0]] },
    ] },
  { id: 'shock', label: '震惊', desc: 'O_O 圆眼贴图', pool: 'exp', durationMs: 1600,
    needs: ['shockEye'], tracks: [
      { param: 'shockEye', keys: [[0, 0], [0.18, 1], [0.75, 1], [1, 0]] },
    ] },
  { id: 'xeyes', label: 'X X 眼', desc: '晕过去的眼睛', pool: 'exp', durationMs: 1400,
    needs: ['xeyes'], tracks: [
      { param: 'xeyes', keys: [[0, 0], [0.2, 1], [0.75, 1], [1, 0]] },
    ] },
  { id: 'drool', label: '流口水', desc: '嘴角口水贴图', pool: 'exp', durationMs: 2600,
    needs: ['drool'], tracks: [
      { param: 'drool', keys: [[0, 0], [0.2, 1], [0.85, 1], [1, 0]] },
    ] },
  { id: 'dark-face', label: '脸黑', desc: '阴沉的脸色贴图', pool: 'exp', durationMs: 2400,
    needs: ['darkFace'], tracks: [
      { param: 'darkFace', keys: [[0, 0], [0.15, 1], [0.85, 1], [1, 0]] },
    ] },
  { id: 'happy', label: '开心笑', desc: '笑眼 + 笑嘴', pool: 'exp', durationMs: 2000,
    needs: ['eyeSmile', 'mouthForm', 'mouthOpen'], tracks: [
      { param: 'eyeSmile', keys: [[0, 0], [0.18, 1], [0.82, 1], [1, 0]] },
      { param: 'mouthForm', keys: [[0, 0], [0.18, 1], [0.82, 0.9], [1, 0]] },
      { param: 'mouthOpen', keys: [[0, 0], [0.18, 0.55], [0.82, 0.45], [1, 0]] },
    ] },
]

/** 逻辑参数名 → 各模型里可能的真实参数名（与 renderer.js 的 PARAM_ALIASES 保持一致，另加 EXP/专属）。 */
const LIBRARY_PARAM_ALIASES = {
  headX: ['ParamAngleX'],
  headY: ['ParamAngleY'],
  headZ: ['ParamAngleZ'],
  bodyX: ['ParamBodyAngleX'],
  bodyY: ['ParamBodyAngleY'],
  eyeOpenL: ['ParamEyeLOpen'],
  eyeOpenR: ['ParamEyeROpen'],
  eyeBallX: ['ParamEyeBallX'],
  eyeBallY: ['ParamEyeBallY'],
  mouthOpen: ['ParamMouthOpenY'],
  mouthForm: ['ParamMouthForm'],
  browLY: ['ParamBrowLY'],
  browRY: ['ParamBrowRY'],
  eyeSmile: ['ParamEyeSmile', 'EyeSmile'],
  cheekPuff: ['CheeckPuff', 'CheekPuff', 'ParamCheek'],
  shockL: ['ShockL'],
  shockR: ['ShockR'],
  pupilX: ['PupilX'],
  pupilY: ['PupilY'],
  blush: ['PARAM_EXP4'],
  shockEye: ['PARAM_EXP5'],
  // 示例模型实测：EXP3 = X 眼、EXP6 = 脸黑、EXP7 = 流口水（早期动作实现已验证过）
  xeyes: ['PARAM_EXP3'],
  drool: ['PARAM_EXP7'],
  darkFace: ['PARAM_EXP6'],
}

function resolveLibraryParam(name, paramSet) {
  const raw = String(name ?? '')
  if (!raw) return null
  if (paramSet.has(raw)) return raw
  for (const candidate of LIBRARY_PARAM_ALIASES[raw] ?? []) {
    if (paramSet.has(candidate)) return candidate
  }
  return null
}

/** 模型参数集指纹：参数集合变了（换模型/模型资源更新）就该重新挑默认动作。 */
export function libraryParamsHash(params) {
  const list = (Array.isArray(params) ? params : []).map(String).filter(Boolean).sort()
  if (!list.length) return ''
  return createHash('sha1').update(list.join('|')).digest('hex').slice(0, 12)
}

/**
 * 按模型真实参数挑默认动作：core 先占 7 个（通用、一定明显），再从 special/exp 补 3 个。
 * 只有「needs 全部解析得到」的词条才会入选——缺一轨就不选，避免又出现「做一半」的动作。
 */
export function pickDefaultActions(params, limit = 10) {
  const set = new Set((Array.isArray(params) ? params : []).map(String))
  const usable = (entry) => entry.needs.every((name) => resolveLibraryParam(name, set))
  const core = ACTION_LIBRARY.filter((entry) => entry.pool === 'core' && usable(entry))
  const extra = ACTION_LIBRARY.filter((entry) => entry.pool !== 'core' && usable(entry))
  const picked = []
  const take = (entry) => {
    if (picked.length >= limit) return
    if (picked.some((item) => item.id === `auto-${entry.id}`)) return
    picked.push({
      id: `auto-${entry.id}`,
      label: entry.label,
      desc: entry.desc ?? '',
      durationMs: entry.durationMs,
      repeat: entry.repeat ?? 1,
      // tracks 落成这只模型真实有的参数名：渲染层不用再猜，换模型时靠 hash 重挑
      tracks: entry.tracks.map((track) => ({
        param: resolveLibraryParam(track.param, set) ?? track.param,
        logical: track.param,
        keys: track.keys.map((pair) => [pair[0], pair[1]]),
      })),
    })
  }
  for (const entry of core.slice(0, 7)) take(entry)
  // 剩余名额：先补「表情类」（示例模型这类有 PARAM_EXP* 的模型），再补其它专属动作
  const extraOrdered = [
    ...extra.filter((entry) => entry.pool === 'exp'),
    ...extra.filter((entry) => entry.pool !== 'exp'),
  ]
  for (const entry of extraOrdered.slice(0, Math.max(0, limit - picked.length))) take(entry)
  for (const entry of [...core, ...extra]) take(entry)
  return picked.slice(0, Math.max(1, limit))
}

/** 外部可用的别名（AI 说 blush 等于 shy，stare 等于 xx）。 */
export const ANIM_ALIASES = { blush: 'shy', embarrassed: 'shy', stare: 'xx' }

// ---------------------------------------------------------------------------
// 模型能力扫描（0.5.0）
// 很多模型包（尤其 VTube Studio 转过来的）把表情/换装放在 Exp3/*.exp3.json 里，
// 但 model3.json 的 FileReferences 不登记 Expressions —— 引擎默认看不到。
// 这里直接读文件：把「表情/换装/手势开关」翻译成可执行动作（参数 → 目标值）。
// ---------------------------------------------------------------------------
const CAP_EXPR_DIRS = ['Exp3', 'Exp2', 'Exp', 'Expression', 'expressions']
const CAP_MOTION_DIRS = ['Animation', 'Motion', 'motions', 'animations']

function capabilityGroupOf(param) {
  const p = String(param ?? '')
  if (/^clothes/i.test(p)) return 'clothes'
  if (/^movement/i.test(p) || /^(gesture|hand)/i.test(p)) return 'gesture'
  if (/^(key\d+|param_exp|exp)/i.test(p)) return 'face'
  if (/^(head|eye|mouth|brow|body|arm|leg|tail)/i.test(p)) return 'body'
  return 'other'
}

/**
 * 扫一个模型目录，返回它能做什么（不依赖 model3.json 是否登记）。
 * 只读文件，不碰运行中的窗口；参数是否真的存在由调用方用运行时参数集再筛一遍。
 */
export function scanModelCapability(modelPath) {
  const root = String(modelPath ?? '').trim()
  const out = { ok: false, root, modelEntries: [], expressions: [], motions: [], warnings: [] }
  if (!root || !existsSync(root)) {
    out.warnings.push('模型目录不存在')
    return out
  }
  let names = []
  try { names = readdirSync(root) } catch (error) {
    out.warnings.push(`目录读取失败：${error?.message ?? error}`)
    return out
  }
  out.modelEntries = names.filter((name) => /\.model3\.json$/i.test(name))
  const registered = { expressions: new Set(), motions: new Set() }
  for (const file of out.modelEntries) {
    try {
      const json = JSON.parse(readFileSync(path.join(root, file), 'utf8'))
      for (const expr of json?.FileReferences?.Expressions ?? []) {
        if (expr?.Name) registered.expressions.add(String(expr.Name))
      }
      const motions = json?.FileReferences?.Motions ?? {}
      for (const group of Object.keys(motions)) {
        for (const item of motions[group] ?? []) {
          if (item?.File) registered.motions.add(String(item.File).replace(/\\/g, '/'))
        }
      }
    } catch (error) {
      out.warnings.push(`${file} 解析失败：${error?.message ?? error}`)
    }
  }
  let index = 0
  for (const dir of CAP_EXPR_DIRS) {
    let files = []
    try { files = readdirSync(path.join(root, dir)) } catch { continue }
    for (const file of files.sort()) {
      if (!/\.exp3?\.json$/i.test(file)) continue
      let json = null
      try { json = JSON.parse(readFileSync(path.join(root, dir, file), 'utf8')) } catch { continue }
      const params = (json?.Parameters ?? [])
        .filter((item) => item && item.Id)
        .map((item) => ({
          param: String(item.Id),
          value: Number(item.Value) || 0,
          blend: item.Blend && item.Blend !== 'Add' ? String(item.Blend) : 'Add',
        }))
      if (!params.length) continue
      index += 1
      const label = file.replace(/\.exp3?\.json$/i, '')
      out.expressions.push({
        id: `cap-${createHash('sha1').update(`${dir}/${file}`).digest('hex').slice(0, 6)}`,
        label,
        file: `${dir}/${file}`,
        group: capabilityGroupOf(params[0].param),
        params,
        registered: registered.expressions.has(label),
        index,
      })
    }
  }
  for (const dir of CAP_MOTION_DIRS) {
    let files = []
    try { files = readdirSync(path.join(root, dir)) } catch { continue }
    for (const file of files.sort()) {
      if (!/\.motion3\.json$/i.test(file)) continue
      out.motions.push({
        label: file.replace(/\.motion3\.json$/i, ''),
        file: `${dir}/${file}`,
        registered: registered.motions.has(`${dir}/${file}`),
      })
    }
  }
  out.ok = true
  return out
}

/**
 * 把能力里的表情/换装翻成动作（hold=true：设完保持，再点一次取消）。
 * 只有「所有参数都在这只模型的运行时参数集里」的条目才生成，避免半套。
 */
export function pickCapabilityActions(capability, params, limit = 24) {
  const set = new Set((Array.isArray(params) ? params : []).map(String))
  if (!set.size || !capability?.expressions?.length) return []
  const out = []
  for (const expr of capability.expressions) {
    if (out.length >= limit) break
    if (!expr.params.length) continue
    if (!expr.params.every((item) => set.has(item.param))) continue
    out.push({
      id: expr.id,
      label: expr.label,
      desc: `${expr.group === 'clothes' ? '换装' : expr.group === 'gesture' ? '手势' : expr.group === 'face' ? '表情' : '开关'}（再点一次取消）`,
      group: expr.group,
      hold: true,
      durationMs: 700,
      tracks: expr.params.map((item) => ({
        param: item.param,
        keys: [[0, 'current'], [1, item.value]],
      })),
    })
  }
  return out
}

/**
 * 动作指令：白名单校验 → 冷却 → 下发 → 超时回落 idle。
 * 冷却按实例算（两个窗口各自 3 秒），不是全局。
 */
export function handleAnim(state, log, body, source = 'ui') {
  body = body && typeof body === 'object' ? body : {}
  // auto:true = 插件内部自动动作（半自动/自动模式的预设反应），不受「对话不能主动控制」限制；
  // source='ui' = 设置页/右键菜单里用户亲手点的，也该放行（只有 AI/对话发起的动作走模式守卫）。
  const guard = body.auto === true || canControl(state, 'anim', { source }) ? null : modeForbidden(state, 'anim')
  if (guard) return { status: guard.status, payload: guard }
  const requested = typeof body.action === 'string' ? body.action.trim().toLowerCase() : ''
  // 别名先归一（blush → shy），再走白名单
  const action = ANIM_ALIASES[requested] || requested
  // 白名单 = 内置动作 + 该实例的自定义动作 + 按本模型能力生成的默认动作
  const customList = state.config.customActions ?? []
  const autoList = state.profile?.autoActions ?? []
  const capList = state.profile?.capabilityActions ?? []
  const custom = [...customList, ...autoList, ...capList].find((item) => item.id === action)
  if (!ANIM_WHITELIST.includes(action) && !custom) {
    return {
      status: 400,
      payload: {
        ok: false,
        error: `未知动作 ${requested || '(空)'}`,
        allowed: [...ANIM_WHITELIST, ...[...customList, ...autoList].map((item) => item.id)],
      },
    }
  }
  const now = Date.now()
  const cooldownMs = state.config.animCooldownMs
  const waitMs = cooldownMs - (now - (state.anim?.lastAt ?? 0))
  if (waitMs > 0) {
    return {
      status: 429,
      payload: { ok: false, error: `动作冷却中，${waitMs}ms 后再试`, retryAfterMs: waitMs, cooldownMs },
    }
  }
  if (!state.windows) return { status: 400, payload: { ok: false, error: '窗口管理器不可用' } }

  state.anim = {
    ...(state.anim ?? {}),
    lastAt: now,
    lastAction: action,
    count: (state.anim?.count ?? 0) + 1,
    timeout: false,
    ackedAt: null,
  }
  // 动作本身有 1.4~1.8s，超时兜底不能比动作还短（否则刚歪头就被 idle 拉回）
  // 兜底要长于最长动作（tilt/nod 现在 2.0~2.2s），否则刚歪上头就被拉回 idle
  const timeoutMs = Math.max(state.config.animTimeoutMs, 4000)
  const sent = state.windows.send?.({ type: 'anim', action, timeoutMs })

  // 执行超时：窗口没回 anim-done 就补一条 idle，别让模型卡在半个动作里。
  // 注意 log 可能是对象（safeLogger 返回 {info,warn,error}），直接 log(...) 会抛 TypeError，
  // 而这段跑在定时器里 → 未捕获异常 → 宿主进程退出（2026-11-03 真炸过一次）。
  const timer = setTimeout(() => {
    try {
      if (!state.anim || state.anim.lastAction !== action || state.anim.ackedAt) return
      state.anim.timeout = true
      logged(log, `动作 ${action} 在 ${timeoutMs}ms 内没有确认，回落 idle`)
      state.windows?.send?.({ type: 'anim', action: 'idle', timeoutMs })
    } catch (error) {
      logged(log, `动作超时兜底失败：${errorText(error)}`)
    }
  }, timeoutMs)
  if (typeof timer?.unref === 'function') timer.unref()

  return {
    status: 200,
    payload: {
      ok: true,
      action,
      sent,
      timeoutMs,
      cooldownMs,
      allowed: ANIM_WHITELIST,
      lastAnimAt: new Date(now).toISOString(),
    },
  }
}

export async function handleBubble(ctx, state, log, body, res) {
  body = body && typeof body === 'object' ? body : {}
  // 这个路由是「用户自己在操作」（设置页按钮 / curl），不受 AI 模式权限限制；
  // AI 那条路径在 toolBubble 里已经用 canControl(...,{source:'tool'}) 判过了。

  let text = typeof body.text === 'string' ? body.text : ''
  let source = null
  let resolvedSessionId = null
  let resolvedBy = null

  if (!text && body.latest === true) {
    const resolved = findSessionForBubble(ctx, state, typeof body.sessionId === 'string' ? body.sessionId : '')
    if (!resolved.ok) {
      jsonResponse(res, resolved.status ?? 404, { ok: false, error: resolved.error, hint: resolved.hint })
      return
    }
    resolvedSessionId = resolved.sessionId
    resolvedBy = resolved.resolvedBy

    if (agentIsRunning(ctx, resolvedSessionId)) {
      jsonResponse(res, 409, {
        ok: false,
        error: '当前会话正在回复中，等它说完再点',
        resolvedSessionId,
      })
      return
    }

    const found = findLatestAssistantText(resolved.session)
    if (!found.ok) {
      jsonResponse(res, 404, {
        ok: false,
        error: '当前会话还没有 assistant 回复',
        hint: '先让模型回一句再点；或直接用 { "text": "..." } 发一条',
        resolvedSessionId,
        reason: found.reason ?? null,
      })
      return
    }
    text = found.text
    source = { sessionId: resolvedSessionId, messageId: found.message?.id ?? null }
  }

  if (!text) {
    jsonResponse(res, 400, { ok: false, error: '要传 { "text": "..." } 或 { "latest": true, "sessionId": "..." }' })
    return
  }

  // 「把最新回复打进气泡」是长回答：不能按气泡短文本的 120 字截断，
  // 否则永远看不到「太长要滚动」的效果。手动传入的短文本仍按 bubbleMaxChars。
  // 显示链保留 Markdown 结构（标题/列表/代码块），渲染层按 format 处理。
  const maxChars = body.latest === true ? 2000 : Math.max(state.config.bubbleMaxChars, 2000)
  const shown = displayBubbleText(text, maxChars)
  if (!shown) {
    jsonResponse(res, 400, { ok: false, error: '文本清洗后为空（可能只有图片/链接标记）' })
    return
  }

  // 去重：同一个 messageId（或同段文本 5 秒内）只发一次，防连点
  const identity = source?.messageId ? `id:${source.messageId}` : replyKeyOf(null, shown)
  const now = Date.now()
  if (!claimReply(state, identity)) {
    jsonResponse(res, 200, { ok: true, shown: false, deduped: true, messageId: identity, resolvedSessionId })
    return
  }

  // 窗口没开就先开，再等它 ready（最多 3s）
  if (!state.windows?.status?.().running) {
    const opened = state.windows?.open?.()
    if (!opened?.ok) {
      jsonResponse(res, 503, { ok: false, error: '窗口起不来，气泡没法显示', detail: opened ?? null })
      return
    }
  }
  const ready = await waitForWindowReady(state, 3000)
  if (!ready) {
    jsonResponse(res, 503, { ok: false, error: '窗口 3s 内没就绪', hint: 'GET /live2d/window 看 logTail 与 lastError' })
    return
  }

  const seq = (state.bubble.seq += 1)
  const sent = state.windows?.send?.({ type: 'bubble', text: shown, format: 'markdown', durationMs: state.config.bubbleDurationMs, seq })
  if (!sent?.ok) {
    jsonResponse(res, 503, { ok: false, error: '气泡没能发到窗口', detail: sent ?? null })
    return
  }

  state.bubble.lastIdentity = identity
  // 手动气泡也记消息身份：否则 diag 里 lastMessageId 恒 null，看数据会误以为去重没生效
  state.bubble.lastMessageId = identity
  state.bubble.lastAt = now
  log.info?.(`live2d: 气泡 #${seq} 已发（${shown.length} 字，${resolvedBy ?? 'direct'}）`)

  jsonResponse(res, 200, {
    ok: true,
    shown: true,
    seq,
    textPreview: cleanBubbleText(shown, 120),
    messageId: identity,
    resolvedSessionId,
    resolvedBy,
    source,
    durationMs: state.config.bubbleDurationMs,
    renderer: state.renderer,
  })
}

/**
 * 定时感知的单次调度（导出给测试直接调用，不用等 5 秒）：
 * 每次 tick 都现场判断「定时开没开 / 读屏总开关 / 当前模式允不允许 / 到没到间隔」，
 * 所以设置页改开关/间隔会立刻生效，关掉之后下一次 tick 自然停。
 */
export async function screenWatchTick(state, log, deps = {}) {
  if (state.disposed) return { read: [] }
  const read = deps.getForegroundTitle ?? getForegroundTitle
  const now = Date.now()
  const due = []
  for (const inst of state.instances ?? []) {
    const cfg = inst.config
    if (cfg?.enabled === false) continue
    if (cfg?.screenWatchEnabled !== true) continue
    if (cfg?.screenReadEnabled !== true) continue
    // 定时唤醒已经接管上下文采集时，旧定时感知让位，避免同一秒读两遍标题
    if (cfg?.wakeEnabled === true) continue
    // 自动模式读屏不可用（原始设计）：后台定时器也必须守这条，不能绕过 HTTP/工具层
    if (!modeAllows(inst, 'screen')) continue
    const interval = Math.max(15000, Number(cfg.screenWatchIntervalMs) || 30000)
    const last = inst.screen?.watch?.at ? Date.parse(inst.screen.watch.at) : 0
    if (Number.isFinite(last) && last > 0 && now - last < interval) continue
    due.push(inst)
  }
  const done = []
  for (const inst of due) {
    if (state.disposed) break
    try {
      const result = await read(state, undefined, inst.config)
      if (result?.ok !== true) continue
      const count = (inst.screen?.watch?.count ?? 0) + 1
      inst.screen = {
        ...(inst.screen ?? {}),
        watch: { at: new Date().toISOString(), title: result.title ?? '', process: result.process ?? '', count },
      }
      done.push(inst.id)
    } catch (error) {
      logged(log, `live2d: 定时读屏失败（已忽略）：${errorText(error)}`)
    }
  }
  return { read: done }
}

export function startScreenWatch(state, log, registerCleanup = () => {}) {
  const TICK_MS = 5000
  const tick = async () => {
    if (state.disposed || state.screenWatchBusy) return
    state.screenWatchBusy = true
    try {
      await screenWatchTick(state, log)
    } finally {
      state.screenWatchBusy = false
    }
  }
  for (const inst of state.instances ?? []) {
    if (inst.config?.screenWatchEnabled === true && inst.config?.screenReadEnabled !== true) {
      pushRuntimeWarning(state, `实例 ${inst.id} 开了定时感知，但「读屏·标题」还没开，定时感知不会生效`)
    }
  }
  const timer = setInterval(tick, TICK_MS)
  if (typeof timer?.unref === 'function') timer.unref()
  registerCleanup(() => clearInterval(timer))
  log?.info?.('live2d: 定时感知调度器已启动（每 5s 检查一次，按实例间隔读标题）')
  tick()
  return timer
}

// ---------------------------------------------------------------------------
// 0.13.0：主动唤醒（⚡ 按钮 / 定时器）
//  - 唤醒 = 给绑定会话注入一条「带屏幕上下文」的用户消息，等它回完再上气泡
//  - 额度按滚动 60 分钟算，不是整点重置
// ---------------------------------------------------------------------------

export const WAKE_PENDING_DIR = path.join(CONFIG_DIR, 'pending')
export const WAKE_PENDING_MAX = 2
export const WAKE_HISTORY_MS = 60 * 60 * 1000

function formatClock(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value ?? '')
  if (!Number.isFinite(ms)) return '--:--'
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function wakeQuota(inst, now = Date.now()) {
  const max = Math.max(1, Number(inst?.config?.wakeMaxPerHour) || 60)
  const since = now - WAKE_HISTORY_MS
  const times = (Array.isArray(inst?.wake?.times) ? inst.wake.times : [])
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t > since)
    .sort((a, b) => a - b)
  const used = times.length
  const ok = used < max
  return {
    ok,
    used,
    max,
    remaining: Math.max(0, max - used),
    nextAt: ok ? null : new Date(times[0] + WAKE_HISTORY_MS).toISOString(),
  }
}

/** 能不能叫醒：绑定会话 / 模式权限 / 额度 / 是否还在忙。 */
export function wakePlan(inst, source = 'wake-timer', now = Date.now()) {
  if (!inst) return { ok: false, code: 'no-instance', error: '没有这个实例' }
  const config = inst.config ?? {}
  if (!config.sessionId) {
    return { ok: false, code: 'wake-no-session', error: '这个实例还没绑定会话，先去设置页选一个' }
  }
  if (!canControl(inst, 'wake', { source })) {
    return { ok: false, code: 'wake-forbidden', error: `当前模式（${config.mode}）下不允许主动唤醒` }
  }
  if (source === 'wake-timer' && config.wakeDriver !== 'timer') {
    return { ok: false, code: 'wake-driver-disabled', error: '当前主动感知方式不是“定时唤醒”' }
  }
  if (source === 'wake-event' && config.wakeDriver !== 'event') {
    return { ok: false, code: 'wake-driver-disabled', error: '当前主动感知方式不是“事件唤醒”' }
  }
  // 只有「真的在跑」的运行态才算忙：成功/失败/超时都会回到 idle，
  // 历史遗留的 completed/failed 也不能把实例永久锁住（2026-11-05 真机踩到过一次）。
  const running = ['capturing', 'injecting', 'waiting-reply', 'running']
  if (running.includes(inst.wake?.state)) {
    return { ok: false, code: 'wake-busy', error: '上一次唤醒还没结束' }
  }
  const quota = wakeQuota(inst, now)
  if (!quota.ok) {
    return {
      ok: false,
      code: 'wake-quota',
      status: 429,
      error: `唤醒额度已满（${quota.used}/${quota.max}），预计 ${formatClock(quota.nextAt)} 可再次唤醒`,
      nextAt: quota.nextAt,
      quota,
    }
  }
  return { ok: true, quota }
}

export function prunePendingShots(inst, keep = WAKE_PENDING_MAX) {
  const list = Array.isArray(inst?.wake?.shots) ? inst.wake.shots : []
  const drop = list.slice(0, Math.max(0, list.length - keep))
  for (const item of drop) {
    try { if (item?.path) rmSync(item.path, { force: true }) } catch { /* 删不掉就算了 */ }
  }
  if (inst?.wake) inst.wake.shots = list.slice(-keep)
}

async function collectWakeContext(root, inst, log, options = {}) {
  // markSent=false：只采集、不消耗（忙时取消的那一轮，截图要留给下一次唤醒）
  const markSent = options.markSent !== false
  const config = inst.config ?? {}
  const state = instanceView(root, inst)
  const wantCapture = config.wakeCaptureEnabled === true && config.screenCaptureEnabled === true
  if (wantCapture) {
    try {
      const shot = await requestScreenCapture(state, { confirmed: true })
      if (shot?.ok && shot.base64) {
        const dir = path.join(WAKE_PENDING_DIR, inst.id)
        const file = saveCapturePng(shot.base64, dir)
        inst.wake.shots = [
          ...(inst.wake.shots ?? []),
          { path: file, at: new Date().toISOString(), width: shot.width, height: shot.height },
        ]
        prunePendingShots(inst, WAKE_PENDING_MAX)
      } else if (shot?.code) {
        pushRuntimeWarning(root, `唤醒截图失败（${shot.code}），这次只读标题`)
      }
    } catch (error) {
      logged(log, `live2d: 唤醒截图异常（已忽略）：${errorText(error)}`)
    }
  }
  let title = ''
  let processName = ''
  if (config.screenReadEnabled === true) {
    try {
      const read = await getForegroundTitle(root, undefined, config)
      if (read?.ok) {
        title = read.title ?? ''
        processName = read.process ?? ''
      }
    } catch { /* 读标题失败不影响唤醒 */ }
  }
  // 待发截图的生命周期：
  //  - 超过 10 分钟的删掉（文件也删），不无限复用旧画面
  //  - 只发「还没发过」的（最多 2 张），发过就打 sentAt，下一轮不再带上
  const cutoff = Date.now() - 10 * 60 * 1000
  const kept = []
  for (const item of inst.wake?.shots ?? []) {
    const at = Date.parse(item?.at ?? '')
    if (Number.isFinite(at) && at < cutoff) {
      try { if (item?.path) rmSync(item.path, { force: true }) } catch { /* 删不掉就算了 */ }
      continue
    }
    kept.push(item)
  }
  inst.wake.shots = kept
  const fresh = kept.filter((item) => !item.sentAt).slice(-WAKE_PENDING_MAX)
  // 只有「真的要把这几张发给 AI」时才标记已发；忙时取消的这一轮不能消耗它们
  if (markSent) for (const item of fresh) item.sentAt = new Date().toISOString()
  const shots = markSent ? fresh.map((item) => item.path) : []
  return {
    title,
    process: processName,
    shots,
    mode: wantCapture ? 'capture' : (title ? 'title' : 'none'),
  }
}

export function buildWakeMessage(inst, info, source, now = Date.now(), reason = null, memories = []) {
  const isButton = source === 'wake-button'
  const isEvent = source === 'wake-event'
  const trigger = isButton ? '你点了按钮' : isEvent ? '事件感知' : '定时感知'
  const lines = [`[主动唤醒 · ${trigger} · ${formatClock(now)}]`]
  if (isEvent && reason?.detail) lines.push(`触发原因：${reason.detail}`)
  // 时间感对所有唤醒来源生效：不只是事件唤醒，机械定时和 ⚡ 按钮也不能猜错早晚。
  const date = new Date(now)
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  const hour = date.getHours()
  const period = hour < 5 ? '凌晨' : hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜'
  const since = Math.max(0, now - Number(inst?.life?.lastUserActivityAt ?? now))
  const sinceText = since < 60_000 ? '不到 1 分钟' : since < 3_600_000 ? `约 ${Math.round(since / 60_000)} 分钟` : `约 ${Math.round(since / 3_600_000)} 小时`
  lines.push(`时间感：${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} 星期${weekdays[date.getDay()]} ${String(hour).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}（${period}）；距离用户上次互动 ${sinceText}。`)
  lines.push('请按真实时间和最近互动决定语气；不要凭猜测说早上好/晚安，也不要表现得像刚被叫醒。')
  if (Array.isArray(memories) && memories.length) lines.push(...memories)
  if (info?.title) {
    lines.push(`当前前台窗口：${info.title}${info.process ? `（${info.process}）` : ''}`)
  } else {
    lines.push('这次没读到前台窗口标题。')
  }
  if (Array.isArray(info?.shots) && info.shots.length > 0) {
    lines.push(`截图（共 ${info.shots.length} 张，最后一张最新）：`)
    for (const file of info.shots) lines.push(`- ${file}`)
    lines.push('要看画面细节就用 read_image 打开上面的路径。')
  } else if (info?.mode === 'title') {
    lines.push('这次只允许读窗口标题，没有截图。')
  }
  lines.push('请先根据窗口标题和截图判断用户当前在做什么，再把观察转成陪伴反应；不要只复述画面，也不要套固定模板。')
  lines.push('场景参考：游戏时像在旁边陪着一样应援、加油、为精彩操作欢呼、失误时安慰；工作/学习/写代码时轻声鼓励并减少打断；看视频或阅读时像一起看一样回应。')
  lines.push('游戏场景不要居高临下地指挥或连续教用户怎么玩，只用简短自然的话应援；如果信息不足，不要硬猜具体游戏结果。')
  lines.push('主动跟我说一两句话，并选择与当前场景相符的表情/动作。')
  // 告诉模型它能用哪些工具（不同模式不一样），避免它乱试
  const canAct = canControl(inst, 'anim', { source })
  if (canAct) {
    lines.push('当前模式允许你做表情/动作：')
    lines.push('- 需要同时表达视线、动作和一句话时，优先用 live2d_perform，例如 {lookAt:"user", anim:"happy", text:"这波好稳，继续！", delayMs:300}；比连续调用多个工具更自然。')
    lines.push('- 只需要单个动作时用 live2d_anim（nod/shake/tilt/happy/shy/surprised/blink/angry/drool/xx/puff）。')
    lines.push('- 现成动作不贴切时，自己设计一个再立刻播：')
    lines.push('  live2d_preset {op:"define", id:"proud", label:"得意", durationMs:1600, tracks:[{param:"headZ", keys:[[0,0],[0.3,12],[0.85,10],[1,0]]},{param:"mouthForm", keys:[[0,0],[0.4,1],[1,0]]}]}')
    lines.push('  live2d_preset {op:"play", action:"proud"}')
    lines.push('  param 可用逻辑名 headX/headY/headZ/eyeOpenL/eyeOpenR/eyeBallX/eyeBallY/mouthOpen/mouthForm/bodyX，也可写真实参数名；模型没有的参数会自动跳过。')
    lines.push('- 一次只做一个动作，等它跑完再说话/做下一个，别连刷。')
  } else {
    lines.push('当前模式下不要做动作，只回话。')
  }
  return lines.join('\n')
}

async function waitForWakeReply(ctx, session, sessionId, baseline, timeoutMs, isDisposed) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (isDisposed?.()) return { ok: false, code: 'wake-cancelled' }
    await new Promise((resolve) => setTimeout(resolve, 700))
    const identity = assistantIdentity(session)
    if (!identity || identity === baseline) continue
    // 必须等这一轮真正结束：工具调用中途落盘的 assistant 消息不能当最终回答
    if (agentIsRunning(ctx, sessionId)) continue
    const latest = findLatestAssistantText(session)
    if (latest?.ok && latest.text) return { ok: true, text: latest.text, identity, message: latest.message }
  }
  return { ok: false, code: 'wake-timeout' }
}

function setWakeBusy(root, inst, busy) {
  try {
    instanceView(root, inst).windows?.send?.({ type: 'config', patch: { wakeBusy: busy === true } }, inst.id)
  } catch { /* 窗口可能已关 */ }
}

/** 用户操作后的即时反馈气泡（不受模式权限限制，只有用户亲手点才走这里） */
function notifyInstance(root, inst, text, durationMs = 6000) {
  const shown = displayBubbleText(text, 400)
  if (!shown) return { ok: false, code: 'empty' }
  const seq = (inst.bubble?.seq ?? 0) + 1
  inst.bubble = {
    ...(inst.bubble ?? {}),
    seq,
    bubbleCount: (inst.bubble?.bubbleCount ?? 0) + 1,
    lastShown: new Date().toISOString(),
    lastIdentity: textIdentity(shown),
    lastAt: Date.now(),
  }
  try {
    instanceView(root, inst).windows?.send?.(
      { type: 'bubble', text: shown, format: 'markdown', durationMs, seq, source: 'wake-button' },
      inst.id,
    )
  } catch { /* 窗口没开就算了，设置页也有状态 */ }
  return { ok: true, seq }
}

function pushWakeBubble(root, inst, text, source, message = null) {
  if (!canControl(inst, 'bubble', { source })) return { ok: false, code: 'mode-forbidden' }
  // 与窗口对话/自动气泡共用同一个原子去重键：idle 先弹过的话这里直接让出
  const key = replyKeyOf(message, text)
  if (!claimReply(inst, key)) return { ok: false, code: 'deduped' }
  const shown = displayBubbleText(text, 2000)
  if (!shown) {
    if (inst.bubble) inst.bubble.claim = null
    return { ok: false, code: 'empty' }
  }
  const seq = (inst.bubble?.seq ?? 0) + 1
  const now = Date.now()
  inst.bubble = {
    ...(inst.bubble ?? {}),
    seq,
    bubbleCount: (inst.bubble?.bubbleCount ?? 0) + 1,
    lastShown: new Date().toISOString(),
    // 唤醒已经上屏了这段文本：写进同一套去重键，否则 agent 回到 idle 时
    // pushIdleReplies 会拿同一条回复再弹一次（用户实测「点 ⚡ 弹两次」）。
    lastIdentity: textIdentity(shown),
    lastMessageId: key,
    lastAt: now,
  }
  try {
    instanceView(root, inst).windows?.send?.(
      {
        type: 'bubble',
        text: shown,
        format: 'markdown',
        durationMs: inst.config?.bubbleDurationMs ?? 5000,
        seq,
        source,
      },
      inst.id,
    )
  } catch (error) {
    logged(root.logger, `live2d: 唤醒气泡下发失败：${errorText(error)}`)
  }
  return { ok: true, seq }
}

export async function wakeUp(root, inst, source = 'wake-timer', log = null, opts = {}) {
  const now = Date.now()
  const plan = wakePlan(inst, source, now)
  if (!plan.ok) return plan

  const ctx = root.ctx
  const view = instanceView(root, inst)
  const target = findSessionForBubble(ctx, view, null)
  if (!target.ok) {
    return { ok: false, code: target.code ?? 'wake-no-session', error: target.error, hint: target.hint }
  }
  const agent = resolveAgent(ctx, target.sessionId)
  if (!agent.ok) {
    return { ok: false, code: 'wake-agent-missing', error: '绑定的会话还没激活（先在 DSH 里打开它）' }
  }

  // 会话语义：上一轮还没说完 → 这次不注入（截图照常进 pending，下次一起读）
  if (agentIsRunning(ctx, target.sessionId)) {
    try { await collectWakeContext(root, inst, log, { markSent: false }) } catch { /* 截图失败不影响跳过 */ }
    inst.wake = {
      ...(inst.wake ?? {}),
      state: 'idle',
      at: new Date(now).toISOString(),
      source,
      busySkipped: (inst.wake?.busySkipped ?? 0) + 1,
      lastResult: { ok: false, code: 'wake-skipped-busy', at: new Date(now).toISOString() },
    }
    return { ok: false, code: 'wake-skipped-busy', deferred: true }
  }

  // 两个上下文开关都关着：定时唤醒不要往里灌一条空消息
  const canTitle = inst.config?.screenReadEnabled === true
  const canShot = inst.config?.wakeCaptureEnabled === true && inst.config?.screenCaptureEnabled === true
  if (!canTitle && !canShot && source !== 'wake-button') {
    inst.wake = {
      ...(inst.wake ?? {}),
      state: 'idle',
      at: new Date(now).toISOString(),
      source,
      lastResult: { ok: false, code: 'no-context-permission', at: new Date(now).toISOString() },
    }
    return { ok: false, code: 'no-context-permission', error: '主动感知需要「读前台标题」或「唤醒时截图」，当前都关着' }
  }

  // 进运行态：从这里开始任何一条路径结束都必须回到 idle（finally 统一收口）
  inst.wake = {
    ...(inst.wake ?? {}),
    state: 'running',
    at: new Date(now).toISOString(),
    source,
    times: [...(inst.wake?.times ?? []).filter((t) => Number(t) > now - WAKE_HISTORY_MS), now],
    count: (inst.wake?.count ?? 0) + 1,
    lastResult: null,
  }
  setWakeBusy(root, inst, true)

  let info = null
  try {
    try {
      info = await collectWakeContext(root, inst, log)
    } catch (error) {
      logged(log, `live2d: 唤醒采集失败（已忽略）：${errorText(error)}`)
      info = { title: '', process: '', shots: [], mode: 'none' }
    }

    const baseline = assistantIdentity(target.session)
    const memories = memoryPromptLines(root, inst, `${info?.title ?? ''} ${opts.reason?.detail ?? ''}`.trim(), 4)
    const text = buildWakeMessage(inst, info, source, now, opts.reason ?? null, memories)
    const message = {
      id: `live2d-wake-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'live2d-wake' },
    }

    // 让这一轮的回复在 idle 时按唤醒来源决定推不推气泡
    if (inst.chat) inst.chat.replySource = source

    inst.wake.state = 'injecting'
    // followup 必须接住 rejection：未处理的 rejection 会让 DSH 宿主进程退出
    Promise.resolve(agent.agent.followup(message)).catch((error) => {
      logged(log, `live2d: 唤醒消息被会话拒绝：${errorText(error)}`)
    })

    inst.wake.state = 'waiting-reply'
    const timeoutMs = Math.max(30_000, Number(inst.config?.wakeTimeoutMs) || 120_000)
    const reply = await waitForWakeReply(
      ctx, target.session, target.sessionId, baseline, timeoutMs, () => root.disposed === true,
    )

    if (!reply.ok) {
      inst.wake.lastResult = { ok: false, code: reply.code, at: new Date().toISOString() }
      logged(log, `live2d: 唤醒没拿到回复（${reply.code}）`)
      return { ok: false, code: reply.code }
    }

    inst.wake.lastResult = { ok: true, at: new Date().toISOString(), chars: reply.text.length }
    const bubble = pushWakeBubble(root, inst, reply.text, source, reply.message)
    return {
      ok: true,
      source,
      text: reply.text,
      info,
      bubble,
      quota: wakeQuota(inst),
      at: inst.wake.at,
    }
  } finally {
    // 运行态一律复位：成功 / 超时 / 异常 / 取消 都回到可再次唤醒的状态
    inst.wake.state = 'idle'
    if (inst.wake.lastResult == null) {
      inst.wake.lastResult = { ok: false, code: 'wake-aborted', at: new Date().toISOString() }
    }
    setWakeBusy(root, inst, false)
    // 回复来源只属于本轮：失败/超时也要清，否则下一次外部对话会被错误放行
    if (inst.chat) inst.chat.replySource = null
  }
}

/** 按钮唤醒：立刻返回 accepted（真正的回复稍后以气泡形式出现），连点会被 state 挡住。 */
export function requestWake(root, inst, source = 'wake-button', log = null) {
  const plan = wakePlan(inst, source)
  if (!plan.ok) return plan
  Promise.resolve(wakeUp(root, inst, source, log)).catch((error) => {
    logged(log, `live2d: 唤醒异常（已兜住）：${errorText(error)}`)
    if (inst.wake) {
      inst.wake.state = 'idle'
      inst.wake.lastResult = { ok: false, code: 'wake-error', error: errorText(error), at: new Date().toISOString() }
    }
    setWakeBusy(root, inst, false)
  })
  return { ok: true, accepted: true, quota: plan.quota, source }
}

export function startWakeLoop(state, log, registerCleanup = () => {}) {
  const TICK_MS = 5000
  const tick = async () => {
    if (state.disposed) return
    const tasks = []
    for (const inst of state.instances ?? []) {
      const config = inst.config ?? {}
      if (config.enabled === false) continue
      if (config.wakeEnabled !== true) continue
      if (!canControl(inst, 'wake', { source: 'wake-timer' })) continue
      // 实例级防重入：一个实例在等回复不阻塞另一个实例
      if (inst.wake?.state && inst.wake.state !== 'idle') continue
      const interval = Math.max(15_000, Number(config.wakeIntervalMs) || 30_000)
      const last = inst.wake?.at ? Date.parse(inst.wake.at) : 0
      if (Number.isFinite(last) && last > 0 && Date.now() - last < interval) continue
      tasks.push(
        wakeUp(state, inst, 'wake-timer', log).then((result) => {
          if (result?.ok === false && result.code === 'wake-quota') {
            pushRuntimeWarning(state, `${inst.id} 唤醒额度已满，预计 ${formatClock(result.nextAt)} 可再次唤醒`)
          }
        }),
      )
    }
    await Promise.allSettled(tasks)
  }
  const timer = setInterval(() => { tick().catch(() => {}) }, TICK_MS)
  if (typeof timer?.unref === 'function') timer.unref()
  registerCleanup(() => clearInterval(timer))
  log?.info?.('live2d: 主动唤醒调度器已启动（每 5s 检查一次，按实例并行）')
  return timer
}

// ---------------------------------------------------------------------------
// P1：陪伴行为循环（宿主侧事件驱动，不新增自我唤醒工具）
// ---------------------------------------------------------------------------

export function markUserActivity(state, sessionId = null, source = 'activity', now = Date.now()) {
  let touched = 0
  for (const inst of state.instances ?? []) {
    if (!inst.life) inst.life = createLifeRuntime({}, now)
    const bound = String(inst.config?.sessionId ?? '')
    if (sessionId && bound !== String(sessionId)) continue
    inst.life.lastUserActivityAt = now
    inst.life.mood = Math.min(1, inst.life.mood + 0.08)
    inst.life.boredom = Math.max(0, inst.life.boredom - 0.18)
    inst.life.closeness = Math.min(1, inst.life.closeness + 0.005)
    inst.life.proactiveSinceUser = 0
    if (source === 'tap' || source === 'chat' || source === 'wake-button') {
      inst.life.lastModelInteractionAt = now
    }
    inst.life.eventCounts.userActivity = (inst.life.eventCounts.userActivity ?? 0) + 1
    touched += 1
  }
  return touched
}

export function noteAgentLife(state, status, sessionId = null, now = Date.now()) {
  for (const inst of state.instances ?? []) {
    const bound = String(inst.config?.sessionId ?? '')
    if (sessionId && bound !== String(sessionId)) continue
    if (!inst.life) inst.life = createLifeRuntime({}, now)
    if (status === 'running') {
      inst.life.lastAgentStartAt = now
      inst.life.energy = Math.max(0, inst.life.energy - 0.01)
    } else if (status === 'idle') {
      inst.life.lastAgentFinishAt = now
      inst.life.mood = Math.min(1, inst.life.mood + 0.03)
    }
  }
}

function lifeReactionFor(event) {
  switch (event?.code) {
    case 'return-after-absence': return { action: 'happy', lookAt: 'user' }
    case 'focus-milestone': return { action: 'nod', lookAt: 'cursor' }
    case 'agent-finished': return { action: 'happy', lookAt: 'user' }
    case 'app-change': return { action: 'tilt', lookAt: 'cursor' }
    case 'long-idle': return { action: 'blink', lookAt: 'away' }
    default: return null
  }
}

async function performLifeReaction(root, inst, event, log, deps = {}, now = Date.now()) {
  if (inst.config?.lifeNonverbalEnabled !== true || !event) return null
  const will = lifeWillingness(inst)
  inst.life.willingness = will.state
  if (!will.nonverbal) return null
  const cooldown = Math.max(3000, Number(inst.config?.lifeNonverbalCooldownMs) || 12_000)
  if (now - Number(inst.life?.lastNonverbalAt ?? 0) < cooldown) return null
  const baseReaction = lifeReactionFor(event)
  let reaction = will.state === 'tired'
    ? { action: 'blink', lookAt: 'away' }
    : baseReaction
  if (!reaction) return null
  // P2：没有观众时不做大幅“对空气表演”；只剩呼吸/眨眼由渲染层的待机浮动负责。
  if (inst.life.audience === 'absent') return null
  if (inst.life.audience === 'ambient' && reaction.action !== 'blink') {
    reaction = { action: 'blink', lookAt: 'cursor' }
  }
  const view = instanceView(root, inst)
  let anim = null
  try {
    anim = deps.playLifeAction
      ? await deps.playLifeAction(inst, reaction.action, event)
      : handleAnim(view, log, { action: reaction.action, auto: true })
  } catch (error) {
    logged(log, `live2d: [${inst.id}] 陪伴动作失败（已忽略）：${errorText(error)}`)
  }
  try {
    const look = deps.lookAt
      ? await deps.lookAt(inst, reaction.lookAt, event)
      : view.windows.send({ type: 'look-at', mode: reaction.lookAt, durationMs: 5000 })
    if (look?.ok === false) logged(log, `live2d: [${inst.id}] look-at 下发失败：${look.error ?? 'unknown'}`)
  } catch { /* 窗口可能未开 */ }
  inst.life.lastNonverbalAt = now
  inst.life.lastEventAt = now
  inst.life.lastEvent = event.code
  inst.life.eventCounts[event.code] = (inst.life.eventCounts[event.code] ?? 0) + 1
  return { action: reaction.action, lookAt: reaction.lookAt, anim }
}

/**
 * 一次陪伴决策。导出给测试注入 now/idle/title/action/wake 桩，不依赖真实定时器。
 */
export async function lifeTick(state, log = null, deps = {}) {
  const now = Number(deps.now) || Date.now()
  const instances = (state.instances ?? []).filter((inst) => inst.config?.enabled !== false && inst.config?.lifeEnabled !== false)
  if (instances.length === 0) return { events: [], reactions: [], verbal: [] }

  if (deps.idleSeconds !== undefined) {
    state.lifeSystem = {
      ...(state.lifeSystem ?? {}),
      idleSeconds: Number.isFinite(Number(deps.idleSeconds)) ? Math.max(0, Number(deps.idleSeconds)) : null,
      at: now,
    }
  }

  // 前台标题只读、限频；一次读取共享给同一轮的所有实例。
  const titleDue = instances.filter((inst) => {
    const cfg = inst.config ?? {}
    return cfg.screenReadEnabled === true
      && now - Number(inst.life?.lastForegroundReadAt ?? 0) >= Math.max(10_000, Number(cfg.eventWakeTitleIntervalMs) || 30_000)
  })
  let foreground = null
  if (titleDue.length > 0 && typeof (deps.getForegroundTitle ?? getForegroundTitle) === 'function') {
    try {
      foreground = await (deps.getForegroundTitle ?? getForegroundTitle)(state, undefined, titleDue[0].config)
    } catch { foreground = null }
  }

  const events = []
  const reactions = []
  const verbal = []
  for (const inst of instances) {
    if (!inst.life) inst.life = createLifeRuntime({}, now)
    const cfg = inst.config ?? {}
    if (state.lifeSystem?.at) {
      inst.life.systemIdleSec = state.lifeSystem.idleSeconds
      inst.life.systemIdleAt = state.lifeSystem.at
    }
    if (titleDue.includes(inst)) inst.life.lastForegroundReadAt = now
    if (foreground && titleDue.includes(inst)) {
      if (foreground.ok === true) {
        const title = String(foreground.title ?? '')
        const processName = String(foreground.process ?? '')
        const changed = Boolean(inst.life.lastForegroundTitle && title !== inst.life.lastForegroundTitle)
        inst.life.lastForegroundTitle = title
        inst.life.lastForegroundProcess = processName
        if (!inst.life.foregroundSince || changed) inst.life.foregroundSince = now
        if (changed) inst.life.pendingAppChangeAt = now
      }
    }

    const before = inst.life.attention
    const attention = deriveLifeAttention(inst.life, cfg, now)
    inst.life.previousAttention = before
    inst.life.attention = attention
    inst.life.audience = deriveAudience(inst.life, cfg, attention, now)
    updateLifeNeeds(inst.life, cfg, attention, now, false)
    const dayKey = lifeDayKey(now)
    if (inst.life.dailyKey !== dayKey) {
      inst.life.dailyKey = dayKey
      inst.life.dailyShare = 0
      inst.life.dailyImportant = 0
    }
    const will = lifeWillingness(inst)
    inst.life.willingness = will.state
    pushLifeStatus(state, inst)

    const candidates = []
    if (before === 'away' && attention !== 'away') {
      candidates.push({
        code: 'return-after-absence',
        importance: 'share',
        score: 0.95,
        detail: `离开约 ${Math.round((now - Number(inst.life.lastUserActivityAt || now)) / 60_000)} 分钟后回来`,
      })
    }
    if (attention === 'focused' && inst.life.lastForegroundTitle && inst.life.focusFiredFor !== inst.life.lastForegroundTitle) {
      candidates.push({
        code: 'focus-milestone',
        importance: 'share',
        score: 0.78,
        detail: `已专注 ${Math.round((now - inst.life.foregroundSince) / 60_000)} 分钟：${inst.life.lastForegroundTitle}`,
      })
    }
    if (inst.life.pendingAppChangeAt && now - inst.life.pendingAppChangeAt < 30_000) {
      candidates.push({
        code: 'app-change',
        importance: 'none',
        score: 0.3,
        detail: `切换到：${inst.life.lastForegroundTitle || '未知窗口'}`,
      })
      inst.life.pendingAppChangeAt = 0
    }
    if (inst.life.lastAgentFinishAt > Math.max(inst.life.lastEventAt, 0) && now - inst.life.lastAgentFinishAt < 45_000) {
      candidates.push({ code: 'agent-finished', importance: 'share', score: 0.42, detail: '刚完成一轮对话' })
    }
    if (
      now - Number(inst.life.lastModelInteractionAt ?? now) >= 30 * 60 * 1000
      && Number(inst.life.boredom) >= 0.42
    ) {
      candidates.push({ code: 'long-idle', importance: 'none', score: 0.35, detail: '很久没有互动' })
    }

    const event = candidates.sort((a, b) => b.score - a.score)[0] ?? null
    if (!event) continue
    events.push({ instanceId: inst.id, ...event, at: now })
    inst.life.lastEventAt = now
    inst.life.lastEvent = event.code
    if (event.code === 'focus-milestone') inst.life.focusFiredFor = inst.life.lastForegroundTitle

    const reaction = await performLifeReaction(state, inst, event, log, deps, now)
    if (reaction) reactions.push({ instanceId: inst.id, event: event.code, ...reaction })

    const canSpeakEvent = event.code === 'return-after-absence' || event.code === 'focus-milestone'
    const quota = lifeSpeakQuota(inst, now)
    const budget = lifeDailyBudget(inst, event.importance === 'important' ? 'important' : 'share', now)
    const quiet = quietHoursActive(cfg, now)
    const cooldownReady = now - Number(inst.life.lastVerbalAt ?? 0) >= Math.max(30_000, Number(cfg.eventWakeCooldownMs) || 180_000)
    const contextAllowed = cfg.screenReadEnabled === true
      || (cfg.wakeCaptureEnabled === true && cfg.screenCaptureEnabled === true)
    const agentRunning = deps.agentRunning ? deps.agentRunning(inst) : agentIsRunning(state.ctx, cfg.sessionId)
    const willingToSpeak = will.speak || event.importance === 'important'
    const plan = canSpeakEvent && willingToSpeak && cfg.eventWakeEnabled === true && !quiet && contextAllowed && !agentRunning
      && quota.ok && budget.ok && cooldownReady
      ? wakePlan(inst, 'wake-event', now)
      : { ok: false, code: 'event-disabled' }
    if (!plan.ok || !canControl(inst, 'wake', { source: 'wake-event' })) {
      inst.life.lastDecision = {
        at: now,
        event: event.code,
        speak: false,
        reason: !canSpeakEvent
          ? 'nonverbal-only'
          : !willingToSpeak
            ? `willingness-${will.state}`
            : quiet
              ? 'quiet-hours'
              : !contextAllowed
                ? 'no-context-permission'
                : agentRunning
                  ? 'agent-running'
              : !budget.ok
                ? `${event.importance}-budget`
                : !quota.ok
                  ? 'event-quota'
                  : !cooldownReady ? 'event-cooldown' : plan.code,
      }
      continue
    }

    inst.life.lastVerbalAt = now
    inst.life.verbalTimes = [...(inst.life.verbalTimes ?? []).filter((t) => t > now - 60 * 60 * 1000), now]
    inst.life.proactiveSinceUser = Number(inst.life.proactiveSinceUser ?? 0) + 1
    if (event.importance === 'important') inst.life.dailyImportant += 1
    else inst.life.dailyShare += 1
    inst.life.lastDecision = { at: now, event: event.code, speak: true, score: event.score }
    verbal.push({ instanceId: inst.id, code: event.code })
    const wakeTask = deps.wakeEvent
      ? deps.wakeEvent(inst, event)
      : wakeUp(state, inst, 'wake-event', log, { reason: event })
    Promise.resolve(wakeTask).catch((error) => {
      logged(log, `live2d: [${inst.id}] 事件唤醒失败（已兜住）：${errorText(error)}`)
    })
  }

  return { events, reactions, verbal }
}

export function startLifeLoop(state, log, registerCleanup = () => {}) {
  restoreLifeState(state)
  let lastSaveAt = 0
  const tick = async () => {
    if (state.disposed) return
    try {
      const queryTarget = (state.instances ?? []).find((inst) => inst.window?.ready === true && inst.config?.enabled !== false)
      if (queryTarget) state.windows?.send?.({ type: 'query-idle' }, queryTarget.id)
      await lifeTick(state, log)
      if (Date.now() - lastSaveAt >= 60_000) {
        lastSaveAt = Date.now()
        const saved = saveLifeState(state)
        if (!saved.ok) logged(log, `live2d: 陪伴状态写盘失败：${saved.error}`)
      }
    } catch (error) {
      logged(log, `live2d: 陪伴循环出错（已忽略）：${errorText(error)}`)
    }
  }
  const timer = setInterval(tick, 5000)
  if (typeof timer.unref === 'function') timer.unref()
  registerCleanup(() => {
    clearInterval(timer)
    saveLifeState(state)
  })
  log?.info?.('live2d: 陪伴行为循环已启动（事件驱动，每 5s 评估）')
  return timer
}

// --- 自动模式预设交互（用户在窗口里点模型/摸头；不算 AI 主动控制） ---
const PRESET_COOLDOWN_MS = 1200
const PRESET_ACTIONS = {
  hair: ['surprised', 'tilt', 'happy'],
  face: ['shy', 'happy', 'nod'],
  hand: ['nod', 'happy', 'tilt'],
  head: ['happy', 'tilt', 'nod'],
  body: ['nod', 'shake', 'surprised'],
}

function boundsOf(inst) {
  const b = inst?.windowBounds
  if (b && Number.isFinite(b.x) && Number.isFinite(b.y)) return b
  const cfg = inst?.config ?? {}
  return {
    x: Number(cfg.windowX) || 0,
    y: Number(cfg.windowY) || 0,
    width: Number(cfg.windowWidth) || 320,
    height: Number(cfg.windowHeight) || 420,
  }
}

function peerReaction(root, inst, zone, gesture, now = Date.now()) {
  if (inst?.config?.dualRelationEnabled === false) return null
  const peer = (root?.instances ?? []).find((item) =>
    item.id !== inst.id && item.config?.enabled !== false && item.window?.ready === true && item.window?.dragging !== true,
  )
  if (!peer || peer.config?.dualRelationEnabled === false) return null
  if (now - Number(peer.preset?.lastPeerAt ?? 0) < 2200) return null
  const recent = (inst.preset?.recentTaps ?? []).filter((at) => now - Number(at) < 8000)
  let action = 'tilt'
  if (gesture === 'double') action = 'surprised'
  else if (gesture === 'pat') action = 'happy'
  else if (recent.length >= 4) action = 'angry'
  else if (zone === 'face') action = 'shy'
  const source = boundsOf(inst)
  const targetBounds = boundsOf(peer)
  const target = {
    x: source.x + source.width / 2 - targetBounds.x,
    y: source.y + source.height * 0.22 - targetBounds.y,
  }
  let sentLook = null
  let sentAnim = null
  try {
    const view = instanceView(root, peer)
    sentLook = view.windows.send({ type: 'look-at', mode: 'peer', target, durationMs: 2600 })
    sentAnim = view.windows.send({ type: 'anim', action, timeoutMs: 2600 })
  } catch { /* 对端窗口可能刚好关闭 */ }
  peer.preset = { ...(peer.preset ?? {}), lastPeerAt: now, peerAction: action }
  inst.life = {
    ...(inst.life ?? createLifeRuntime({}, now)),
    peerAffinity: Math.min(1, Number(inst.life?.peerAffinity ?? 0.2) + 0.03),
    lastPeerInteractionAt: now,
  }
  peer.life = {
    ...(peer.life ?? createLifeRuntime({}, now)),
    peerAffinity: Math.min(1, Number(peer.life?.peerAffinity ?? 0.2) + 0.015),
    lastPeerInteractionAt: now,
  }
  return { peerId: peer.id, action, sentLook, sentAnim }
}

export function handlePresetTap(state, inst, zone, log = null, gesture = 'tap') {
  if (!inst) return { ok: false, code: 'no-instance' }
  if (inst.config?.autoInteract !== true) {
    return { ok: false, code: 'preset-disabled', error: '预设交互已关闭（设置页「点模型有反应」）' }
  }
  const now = Date.now()
  const lastAt = inst.preset?.lastAt ?? 0
  if (now - lastAt < PRESET_COOLDOWN_MS) {
    return { ok: false, code: 'preset-cooldown', retryAfterMs: PRESET_COOLDOWN_MS - (now - lastAt) }
  }
  const nowTap = Date.now()
  const recentTaps = [...(inst.preset?.recentTaps ?? []), nowTap].filter((at) => nowTap - Number(at) < 10000)
  // 10 秒内连续三次摸头，即使都是单击也按“连续摸头”处理。
  const effectiveGesture = zone === 'hair' && recentTaps.length >= 3 ? 'pat' : gesture
  const pool = PRESET_ACTIONS[zone] ?? PRESET_ACTIONS.body
  const count = inst.preset?.count ?? 0
  let action = pool[count % pool.length]
  if (effectiveGesture === 'double') action = 'happy'
  else if (effectiveGesture === 'long') action = zone === 'hair' || zone === 'face' ? 'shy' : 'tilt'
  else if (effectiveGesture === 'pat') action = zone === 'hair' ? 'happy' : 'shy'
  inst.preset = {
    ...(inst.preset ?? {}),
    lastAt: now,
    action,
    zone,
    gesture: effectiveGesture,
    count: count + 1,
    recentTaps,
  }
  let sent = null
  try {
    sent = instanceView(state, inst).windows.send({ type: 'anim', action, timeoutMs: 2600 })
  } catch (error) {
    logged(log, `live2d: 预设动作下发失败（${inst.id}）：${errorText(error)}`)
  }
  const peer = peerReaction(state, inst, zone, effectiveGesture, nowTap)
  return { ok: sent?.ok !== false, action, zone, gesture: effectiveGesture, sent, peer }
}

/**
 * 右键菜单里点一个动作：立刻播放。
 * 这是「用户在自己窗口里点」，不是 AI 主动控制 —— 不守模式守卫，也不占 anim 冷却。
 */
export function playPreset(root, inst, action, log = null) {
  if (!inst) return { ok: false, code: 'no-instance' }
  const requested = String(action ?? '').trim().toLowerCase()
  const normalized = ANIM_ALIASES[requested] || requested
  // 0.3.2：自定义动作来自「模型档案」；没有档案时退回实例字段（兼容尚未迁移的旧配置）
  const profile = profileFor(root, inst)
  const customs = profile ? profile.customActions : (inst.config?.customActions ?? [])
  // 0.4.0/0.5.0：右键菜单里也有「按模型能力生成」的默认动作与表情/换装，必须一起认
  const generated = profile ? [...(profile.autoActions ?? []), ...(profile.capabilityActions ?? [])] : []
  const custom = [...customs, ...generated].find((item) => item.id === normalized)
  if (!ANIM_WHITELIST.includes(normalized) && !custom) {
    return {
      ok: false,
      code: 'unknown-action',
      allowed: [...ANIM_WHITELIST, ...customs.map((item) => item.id), ...generated.map((item) => item.id)],
    }
  }
  const timeoutMs = Math.max(inst.config?.animTimeoutMs ?? 2000, custom?.durationMs ?? 0, 4000)
  let sent = null
  try {
    sent = instanceView(root, inst).windows.send({ type: 'anim', action: normalized, timeoutMs })
  } catch (error) {
    logged(log, `live2d: 预设动作播放失败（${inst.id}）：${errorText(error)}`)
  }
  inst.anim = {
    ...(inst.anim ?? {}),
    lastAt: Date.now(),
    lastAction: normalized,
    count: (inst.anim?.count ?? 0) + 1,
    lastPresetAt: Date.now(),
  }
  return { ok: sent?.ok !== false, action: normalized, sent }
}

function pushPresetsToWindow(root, inst) {
  try {
    instanceView(root, inst).windows.send({ type: 'config', patch: { presets: buildPresets(inst, profileFor(root, inst)) } })
  } catch { /* 窗口没开就算了 */ }
}

/** 独立模型窗口 -> DSH 网页半边的一次性 UI 指令。 */
export function queueUiCommand(state, type, payload = {}) {
  const root = state?.root ?? state
  if (!root || !type) return { ok: false, error: '缺少 state 或 type' }
  root.ui = {
    ...(root.ui ?? {}),
    pending: { type, payload: { ...payload }, at: Date.now() },
  }
  return { ok: true, command: root.ui.pending }
}

/** 网页半边领取后立即清空，避免多个 UI/刷新重复打开设置。 */
export function takeUiCommand(state, now = Date.now(), ttlMs = 15000) {
  const root = state?.root ?? state
  const pending = root?.ui?.pending
  if (!pending) return null
  root.ui.pending = null
  if (!Number.isFinite(Number(pending.at)) || now - Number(pending.at) > ttlMs) return null
  return { type: pending.type, ...(pending.payload ?? {}), at: pending.at }
}

export function stopPresetSequence(root, inst) {
  if (!inst) return { ok: false, code: 'no-instance' }
  const id = inst.presetRun?.id ?? null
  if (inst.presetRun?.timer) clearTimeout(inst.presetRun.timer)
  inst.presetRun = null
  pushPresetsToWindow(root, inst)
  return { ok: true, stopped: id }
}

export function startPresetSequence(root, inst, sequenceId, log = null, options = {}) {
  if (!inst) return { ok: false, code: 'no-instance' }
  // 0.3.2：循环来自「模型档案」，启动时由当前实例发起（不再有 targets）
  // 没有档案时退回实例字段（兼容尚未迁移的旧配置）
  const profile = profileFor(root, inst)
  const sequences = profile ? profile.presetSequences : (inst.config?.presetSequences ?? [])
  const seq = sequences.find((item) => item.id === sequenceId)
  if (!seq) return { ok: false, code: 'no-such-sequence', available: sequences.map((i) => i.id) }
  if (!Array.isArray(seq.steps) || seq.steps.length === 0) {
    return { ok: false, code: 'empty-sequence', error: `循环「${seq.label || seq.id}」没有动作步骤，先勾选动作再保存` }
  }
  if (inst.presetRun?.timer) clearTimeout(inst.presetRun.timer)
  const run = { id: seq.id, index: 0, timer: null, startedAt: Date.now(), preview: options.once === true }
  // 预览 = 只把整条循环走一遍就停，不进入无限循环
  const single = options.once === true || seq.loop !== true
  inst.presetRun = run
  const step = () => {
    if (root.disposed || inst.presetRun !== run) return
    // 1.6 秒内刚播过动作（AI 点的 / 用户点菜单）就跳过这一拍：循环不该把它的动作盖掉
    if (Date.now() - (inst.anim?.lastAt ?? 0) < 1600) {
      run.timer = setTimeout(step, Math.max(300, seq.intervalMs))
      if (typeof run.timer?.unref === 'function') run.timer.unref()
      return
    }
    const action = seq.steps[run.index % seq.steps.length]
    run.index += 1
    try {
      instanceView(root, inst).windows.send({ type: 'anim', action, timeoutMs: 4000 })
    } catch (error) {
      logged(log, `live2d: 预设循环下发失败（${inst.id}）：${errorText(error)}`)
    }
    if (single && run.index >= seq.steps.length) {
      stopPresetSequence(root, inst)
      return
    }
    run.timer = setTimeout(step, Math.max(300, seq.intervalMs))
    if (typeof run.timer?.unref === 'function') run.timer.unref()
  }
  step()
  pushPresetsToWindow(root, inst)
  return { ok: true, id: seq.id, steps: seq.steps.length, intervalMs: seq.intervalMs, loop: seq.loop }
}

export function startPresetLoop(state, log, registerCleanup = () => {}) {
  const TICK_MS = 8000
  const tick = () => {
    if (state.disposed) return
    const now = Date.now()
    for (const inst of state.instances ?? []) {
      if (inst.config?.enabled === false) continue
      if (inst.config?.idlePresets !== true) continue
      const alive = inst.window?.ready === true || inst.renderer?.state === 'rendering'
      if (!alive) continue
      const preset = inst.preset ?? {}
      // 第一次只记基线：开窗后先安静一会儿，不要立刻自己动
      if (!preset.idleAt) {
        inst.preset = { ...preset, idleAt: now, idleGap: 20000 + Math.floor(Math.random() * 20000) }
        continue
      }
      const gap = Number(preset.idleGap) || 30000
      if (now - preset.idleAt < gap) continue
      // 刚被点过/刚有对话动作时不抢戏
      if (now - (preset.lastAt ?? 0) < 6000) continue
      // P1「允许不想」：疲惫时只保留很轻的眨眼并拉长间隔；彻底不想动时连空闲动作也停。
      const will = inst.config?.lifeEnabled !== false && inst.life ? lifeWillingness(inst) : null
      if (will?.state === 'withdrawn') {
        inst.preset = {
          ...preset,
          idleAt: now,
          idleGap: 60000 + Math.floor(Math.random() * 30000),
          idleSuppressed: 'withdrawn',
        }
        continue
      }
      if (inst.config?.audienceAwareEnabled !== false && inst.life?.audience === 'absent') {
        inst.preset = {
          ...preset,
          idleAt: now,
          idleGap: 60000 + Math.floor(Math.random() * 30000),
          idleSuppressed: 'no-audience',
        }
        continue
      }
      const tired = will?.state === 'tired' || (inst.config?.audienceAwareEnabled !== false && inst.life?.audience === 'ambient')
      const action = tired ? 'blink' : ['blink', 'tilt', 'nod'][Math.floor(Math.random() * 3)]
      inst.preset = {
        ...preset,
        idleAt: now,
        idleGap: (tired ? 45000 : 20000) + Math.floor(Math.random() * 20000),
        idleAction: action,
        idleCount: (preset.idleCount ?? 0) + 1,
        idleSuppressed: null,
      }
      try {
        instanceView(state, inst).windows.send({ type: 'anim', action, timeoutMs: 2000 })
      } catch (error) {
        logged(log, `live2d: 空闲预设动作下发失败（${inst.id}）：${errorText(error)}`)
      }
    }
  }
  const timer = setInterval(tick, TICK_MS)
  if (typeof timer?.unref === 'function') timer.unref()
  registerCleanup(() => clearInterval(timer))
  // 先跑一次：把各实例的 idleAt 基线记下来（否则要等 8s 才初始化）
  tick()
  return timer
}

function registerRoutes(ctx, state, log, eventLog, windows) {
  const webServer = getService(ctx, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    pushRuntimeWarning(state, '宿主没有可用的 webServer 服务：/live2d/* 未注册（插件其它功能不受影响）')
    return { dispose: null }
  }

  const dispose = webServer.register({
    kind: 'prefix',
    path: '/live2d',
    async handler(req, res) {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        // 多实例：所有老路由都支持 ?instanceId=xxx，缺省 = 默认实例（数组第一个）。
        const requestedId = url.searchParams.get('instanceId')
        const inst = findInstance(state, requestedId)
        const view = inst ? instanceView(state, inst) : state
        if (req.method === 'GET' && url.pathname === '/live2d/health') {
          jsonResponse(res, 200, {
            ok: true,
            plugin: 'dsh-live2d',
            version: VERSION,
            stage: STAGE,
            phase: state.phase,
            armed: view.config.enabled,
            routesRegistered: state.routesRegistered,
            inject,
            selfTest: state.selfTest,
            eventSubscription: state.eventSubscription ?? null,
            instanceId: view.id ?? null,
            instances: state.instances?.map((item) => item.id) ?? [],
            windowRunning: Boolean(state.windows?.status?.().running),
            renderer: view.renderer,
            model: view.model
              ? { ok: view.model.ok === true, reason: view.model.reason ?? null, entry: view.model.entry ?? null, format: view.model.format ?? null, missing: view.model.missing ?? [] }
              : null,
            bubbleCount: view.bubble?.bubbleCount ?? 0,
            mode: view.config.mode ?? 'manual',
            autoBubble: view.config.autoBubble !== false,
            chat: {
              pending: Boolean(view.chat?.pending),
              requestId: view.chat?.pending?.requestId ?? null,
              sessionId: view.chat?.pending?.sessionId ?? null,
              lastReply: view.chat?.lastReply
                ? { requestId: view.chat.lastReply.requestId, at: view.chat.lastReply.at, preview: preview(view.chat.lastReply.text, 80) }
                : null,
              lastError: view.chat?.lastError ?? null,
              historyCount: view.chat?.history?.length ?? 0,
              queueCount: view.chat?.queue?.length ?? 0,
              replyStyle: view.config.replyStyle,
              boundSessionId: view.config.sessionId || null,
              target: resolveChatTarget(ctx, view),
            },
            anim: {
              lastAction: view.anim?.lastAction ?? null,
              lastAt: view.anim?.lastAt ? new Date(view.anim.lastAt).toISOString() : null,
              count: view.anim?.count ?? 0,
              timeout: view.anim?.timeout === true,
              cooldownMs: view.config.animCooldownMs,
              timeoutMs: view.config.animTimeoutMs,
              allowed: ANIM_WHITELIST,
            },
            warnings: state.warnings,
            startedAt: state.startedAt,
          })
          return
        }
        if (req.method === 'GET' && url.pathname === '/live2d/diag') {
          const snap = diagSnapshot(ctx, view, eventLog)
          // 多实例：diag 里带上每个实例的窗口/渲染状态（阶段 3 验收要看）
          snap.instances = (state.instances ?? []).map((item) => instanceSummary(ctx, state, item))
          jsonResponse(res, 200, snap)
          return
        }
        if (url.pathname === '/live2d/inject' && (req.method === 'POST' || req.method === 'PUT')) {
          await handleInject(ctx, view, log, req, res)
          return
        }
        if (url.pathname === '/live2d/ui-command' && req.method === 'GET') {
          jsonResponse(res, 200, { ok: true, command: takeUiCommand(state) })
          return
        }

        // --- 阶段 1：配置 / 模型 / 气泡 ---
        if (url.pathname === '/live2d/config' && req.method === 'GET') {
          const file = readConfigFile()
          jsonResponse(res, 200, {
            ok: true,
            instanceId: view.id ?? null,
            config: view.config,
            instances: state.config.instances,
            defaults: DEFAULT_CONFIG,
            defaultInstance: DEFAULT_INSTANCE,
            limits: LIMITS,
            warnings: state.warnings,
            file: CONFIG_FILE,
            configFile: CONFIG_FILE,
            fileExists: file.exists,
            fileError: file.ok ? null : file.error,
          })
          return
        }
        if (url.pathname === '/live2d/config' && (req.method === 'POST' || req.method === 'PUT')) {
          let body = {}
          try {
            body = await readJsonBody(req)
          } catch (error) {
            jsonResponse(res, 400, { ok: false, error: `请求体不是合法 JSON：${errorText(error)}` })
            return
          }
          const patch = body && typeof body.patch === 'object' && body.patch !== null ? body.patch : body
          if (!patch || typeof patch !== 'object') {
            jsonResponse(res, 400, { ok: false, error: 'body 形如 { "patch": { "windowWidth": 360 } }' })
            return
          }
          const targetId = body.instanceId ?? requestedId ?? null

          // 整表替换（新增/删除一批实例）：也要过唯一性校验
          if (Array.isArray(patch.instances)) {
            const before = state.config
            // 0.3.2：动作/循环属于「模型档案」，整表保存时剥掉实例上的这两个字段，
            // 避免旧的设置页草稿把动作又写回实例（与档案并存会造成两套数据源）。
            const cleanInstances = patch.instances.map((item) => {
              const { customActions, presetSequences, ...rest } = item ?? {}
              return rest
            })
            const normalized = normalizeConfig({ ...before, ...patch, instances: cleanInstances })
            const check = validateInstances(normalized.config)
            if (!check.ok) {
              setWarningSource(state, 'config', [...normalized.warnings, check.error])
              jsonResponse(res, 409, { ok: false, code: check.code, error: check.error, conflictWith: check.conflictWith ?? null, config: before, warnings: state.warnings })
              return
            }
            state.config = normalized.config
            setWarningSource(state, 'config', normalized.warnings)
            syncInstances(state)
            const saved = writeConfigFile(state.config, state.configFile ?? CONFIG_FILE)
            if (!saved.ok) pushRuntimeWarning(state, `配置写盘失败：${saved.error}（本次已生效，但重启后会丢）`)
            jsonResponse(res, saved.ok ? 200 : 500, {
              ok: saved.ok,
              instanceId: targetId ?? null,
              config: state.config,
              instances: state.config.instances,
              warnings: state.warnings,
              file: saved.file,
              fileError: saved.error ?? null,
            })
            return
          }

          const before = view.config
          const result = patchInstance(state, targetId, patch)
          if (!result.ok) {
            jsonResponse(res, result.status ?? 409, { ok: false, code: result.code ?? null, error: result.error, conflictWith: result.conflictWith ?? null, config: state.config, warnings: state.warnings })
            return
          }

          // 模型/渲染开关变了 → 重新探测 + 通知窗口重载
          const target = findInstance(state, targetId)
          const after = target?.config ?? state.config
          const needsReload = after.modelPath !== before.modelPath || after.rendererEnabled !== before.rendererEnabled
          if (needsReload && target) {
            target.model = modelProbe(after.modelPath)
            setWarningSource(state, 'model', target.model.warnings ?? [])
            if (target.model.ok) clearRuntimeWarnings(state, '渲染失败：')
          }

          const viewAfter = target ? instanceView(state, target) : view
          const configSent = viewAfter.windows?.send?.({
            type: 'config',
            patch: windowConfigPayload(after, buildPresets(target, profileFor(state, target)), lifeStatusSnapshot(target)),
            title: instanceTitle(state, target),
            sessionId: after.sessionId || null,
          })
          const reloadSent = needsReload ? viewAfter.windows?.send?.({ type: 'reload', model: initPayload(viewAfter).model }) : null
          const saved = writeConfigFile(state.config, state.configFile ?? CONFIG_FILE)
          if (!saved.ok) pushRuntimeWarning(state, `配置写盘失败：${saved.error}（本次已生效，但重启后会丢）`)

          jsonResponse(res, saved.ok ? 200 : 500, {
            ok: saved.ok,
            instanceId: target?.id ?? null,
            config: after,
            instances: state.config.instances,
            warnings: state.warnings,
            file: saved.file,
            fileError: saved.error ?? null,
            needsReload,
            applied: { config: configSent ?? null, reload: reloadSent ?? null },
          })
          return
        }
        if (url.pathname === '/live2d/model/reload' && (req.method === 'POST' || req.method === 'PUT')) {
          if (inst) {
            inst.model = modelProbe(inst.config.modelPath)
            setWarningSource(state, 'model', inst.model.warnings ?? [])
            if (inst.model.ok) clearRuntimeWarnings(state, '渲染失败：')
          }
          const sent = view.windows?.send?.({ type: 'reload', model: initPayload(view).model })
          jsonResponse(res, 200, { ok: true, instanceId: view.id ?? null, model: view.model, renderer: view.renderer, sent: sent ?? null })
          return
        }
        if (url.pathname === '/live2d/model/reload' && req.method === 'GET') {
          jsonResponse(res, 405, { ok: false, error: '请用 POST' })
          return
        }
        if (url.pathname === '/live2d/anim' && (req.method === 'POST' || req.method === 'PUT')) {
          let body = {}
          try {
            body = await readJsonBody(req)
          } catch (error) {
            jsonResponse(res, 400, { ok: false, error: `请求体不是合法 JSON：${errorText(error)}` })
            return
          }
          const targetView = body.instanceId && body.instanceId !== view.id
            ? instanceView(state, findInstance(state, body.instanceId))
            : view
          if (!targetView) {
            jsonResponse(res, 404, { ok: false, error: `没有实例 ${body.instanceId}` })
            return
          }
          const result = handleAnim(targetView, log, body)
          jsonResponse(res, result.status, { ...result.payload, instanceId: targetView.id ?? null })
          return
        }
        if (url.pathname === '/live2d/anim' && req.method === 'GET') {
          jsonResponse(res, 200, { ok: true, allowed: ANIM_WHITELIST, anim: view.anim ?? null })
          return
        }
        // 预设动作：设置页/右键菜单都走这里（play=立刻播、start/stop=循环）
        if (url.pathname === '/live2d/preset' && (req.method === 'POST' || req.method === 'PUT')) {
          let body = {}
          try {
            body = await readJsonBody(req)
          } catch (error) {
            jsonResponse(res, 400, { ok: false, error: `请求体不是合法 JSON：${errorText(error)}` })
            return
          }
          const owner = body.instanceId ? findInstance(state, body.instanceId) : defaultInstance(state)
          if (!owner) {
            jsonResponse(res, 404, { ok: false, error: `没有实例 ${body.instanceId ?? ''}`.trim() })
            return
          }
          const op = String(body.op || 'play')
          if (op === 'play') {
            const result = playPreset(state, owner, body.action, log)
            jsonResponse(res, result.ok ? 200 : 400, { ...result, instanceId: owner.id })
            return
          }
          if (op === 'start' || (op === 'preview' && body.sequenceId)) {
            const result = startPresetSequence(state, owner, String(body.sequenceId || ''), log, { once: op === 'preview' })
            jsonResponse(res, result.ok ? 200 : 400, { ...result, instanceId: owner.id, preview: op === 'preview' })
            return
          }
          if (op === 'stop') {
            jsonResponse(res, 200, { ...stopPresetSequence(state, owner), instanceId: owner.id })
            return
          }
          if (op === 'list') {
            jsonResponse(res, 200, { ok: true, instanceId: owner.id, presets: buildPresets(owner, profileFor(state, owner)), running: owner.presetRun?.id ?? null })
            return
          }
          if (op === 'design') {
            // 按说明生成动作草稿（不落盘）；用户预览满意后由设置页带着 tracks 保存成自定义动作
            const draft = designAction(String(body.label || ''), String(body.description || ''))
            jsonResponse(res, 200, {
              ok: true,
              instanceId: owner.id,
              draft,
              hint: draft.matched
                ? `匹配到内置模板「${draft.matched}」，可以直接预览保存`
                : '没匹配到模板，用了通用摆动；改改说明或让 AI 用 live2d_preset define 会更贴切',
            })
            return
          }
          if (op === 'preview' && !body.sequenceId) {
            // 预览未保存的草稿：直接把关键帧塞给窗口播一遍
            const draft = body.draft ?? {}
            const tracks = Array.isArray(draft.tracks) ? draft.tracks : []
            if (!tracks.length) {
              jsonResponse(res, 400, { ok: false, error: '草稿里没有 tracks，先点「生成」' })
              return
            }
            const durationMs = Math.max(200, Math.min(10_000, Number(draft.durationMs) || 1500))
            const sent = instanceView(state, owner).windows?.send?.({
              type: 'anim',
              action: 'preview',
              timeoutMs: Math.max(2500, durationMs),
              override: { duration: durationMs, tracks },
            })
            jsonResponse(res, sent?.ok === false ? 400 : 200, { ok: true, instanceId: owner.id, sent })
            return
          }
          jsonResponse(res, 400, { ok: false, error: `不支持的 op：${op}` })
          return
        }
        if (url.pathname === '/live2d/preset' && req.method === 'GET') {
          jsonResponse(res, 200, { ok: true, presets: buildPresets(view, view.profile ?? null), running: view.presetRun?.id ?? null })
          return
        }
        if (url.pathname === '/live2d/bubble' && (req.method === 'POST' || req.method === 'PUT')) {
          let body = {}
          try {
            body = await readJsonBody(req)
          } catch (error) {
            jsonResponse(res, 400, { ok: false, error: `请求体不是合法 JSON：${errorText(error)}` })
            return
          }
          const targetView = body.instanceId && body.instanceId !== view.id
            ? instanceView(state, findInstance(state, body.instanceId))
            : view
          await handleBubble(ctx, targetView, log, body, res)
          return
        }
        if (url.pathname === '/live2d/bubble' && req.method === 'GET') {
          jsonResponse(res, 405, { ok: false, error: '请用 POST，body 形如 { "latest": true } 或 { "text": "..." }' })
          return
        }
        if (url.pathname === '/live2d/memory' && req.method === 'GET') {
          const wantedId = url.searchParams.get('instanceId')
          const resolved = wantedId ? resolveInstanceStrict(state, wantedId) : { ok: true, instance: findInstance(state, view.id) }
          if (!resolved.ok || !resolved.instance) {
            jsonResponse(res, resolved.status ?? 404, resolved)
            return
          }
          const inst = resolved.instance
          const sessionId = inst.config?.sessionId ?? ''
          jsonResponse(res, 200, {
            ok: true,
            instanceId: inst.id,
            sessionId: sessionId || null,
            enabled: inst.config?.memoryEnabled === true,
            entries: listMemories(state, sessionId),
          })
          return
        }
        if (url.pathname === '/live2d/memory' && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
          let body = {}
          try {
            body = await readJsonBody(req)
          } catch (error) {
            jsonResponse(res, 400, { ok: false, error: `请求体不是合法 JSON：${errorText(error)}` })
            return
          }
          const resolved = body.instanceId ? resolveInstanceStrict(state, body.instanceId) : { ok: true, instance: findInstance(state, view.id) }
          if (!resolved.ok || !resolved.instance) {
            jsonResponse(res, resolved.status ?? 404, resolved)
            return
          }
          const inst = resolved.instance
          const result = memoryMutation(state, inst, inst.config?.sessionId ?? '', String(body.op || ''), body)
          jsonResponse(res, result.ok ? 200 : (result.code === 'memory-disabled' ? 403 : 400), { ...result, instanceId: inst.id })
          return
        }
        // 阶段 2：窗口内对话（立即返回 accepted，回复走控制通道的 reply 事件）
        if (url.pathname === '/live2d/tts' && (req.method === 'POST' || req.method === 'PUT')) {
          // 阶段 4：语音合成（CosyVoice2）。返回 base64 音频，窗口负责播放。
          let body = {}
          try { body = await readJsonBody(req) } catch { body = {} }
          if (view.config.ttsEnabled !== true) {
            jsonResponse(res, 403, { ok: false, disabled: true, error: '语音未开启', hint: '设置页勾选「语音朗读」后再试' })
            return
          }
          const result = await synthesizeSpeech(body.text, {
            url: view.config.ttsUrl,
            prompt: view.config.ttsPrompt,
            promptText: view.config.ttsPromptText,
          })
          jsonResponse(res, result.status ?? (result.ok ? 200 : 500), { ...result, instanceId: view.id ?? null })
          return
        }
        if (url.pathname === '/live2d/screen/capture' && (req.method === 'POST' || req.method === 'PUT')) {
          // 读屏第二层：按需截图（默认关、需确认、限速、不落盘）
          // 这个路由是「用户自己在操作」（设置页按钮 / curl），不受 AI 模式权限限制；
          // AI 那条路径在 live2d_screen_capture 工具里已经用 canControl(...,{source:'tool'}) 判过。
          if (!canControl(view, 'capture', { source: 'ui' })) {
            jsonResponse(res, 403, modeForbidden(view, 'capture'))
            return
          }
          let body = {}
          try { body = await readJsonBody(req) } catch { body = {} }
          const result = await requestScreenCapture(view, { confirmed: body.confirmed === true })
          jsonResponse(res, result.status ?? (result.ok ? 200 : 400), { ...result, instanceId: view.id ?? null })
          return
        }
        if (url.pathname === '/live2d/screen' && req.method === 'GET') {
          // 读屏第一层：只回前台窗口标题（默认关；开启后 1 秒内重复请求走缓存）
          // 用户手动查询（设置页 / curl）不受 AI 模式权限限制
          if (!canControl(view, 'screen', { source: 'ui' })) {
            jsonResponse(res, 403, modeForbidden(view, 'screen'))
            return
          }
          const result = await getForegroundTitle(view)
          jsonResponse(res, result.disabled ? 403 : (result.ok ? 200 : 502), {
            ...result,
            instanceId: view.id ?? null,
            // 定时感知的最近一次结果（没开定时或还没跑过就是 null）
            watch: view.screen?.watch ?? null,
          })
          return
        }
        if (url.pathname === '/live2d/wake' && req.method === 'GET') {
          // 只读：唤醒开关、额度、上次结果、待用截图
          jsonResponse(res, 200, {
            ok: true,
            instanceId: view.id ?? null,
            mode: view.config.mode,
            enabled: view.config.wakeEnabled === true,
            intervalMs: view.config.wakeIntervalMs,
            captureEnabled: view.config.wakeCaptureEnabled === true,
            state: view.wake?.state ?? 'idle',
            lastAt: view.wake?.at ?? null,
            lastResult: view.wake?.lastResult ?? null,
            pendingShots: (view.wake?.shots ?? []).length,
            quota: wakeQuota(view),
          })
          return
        }
        if (url.pathname === '/live2d/wake' && (req.method === 'POST' || req.method === 'PUT')) {
          // 按钮唤醒（窗口 ⚡ / 设置页「叫醒一次」）：立刻 accepted，回复稍后以气泡出现
          const result = requestWake(state, view, 'wake-button', log)
          jsonResponse(res, result.status ?? (result.ok ? 202 : 400), { ...result, instanceId: view.id ?? null })
          return
        }
        if (url.pathname === '/live2d/sessions' && req.method === 'GET') {
          const used = new Map()
          for (const item of state.instances ?? []) {
            if (item.config.sessionId) used.set(item.config.sessionId, item.id)
          }
          // 默认按用户要求过滤空白对话与归档对话；?all=1 看全量（排查用）
          const includeAll = url.searchParams.get('all') === '1'
          const rows = collectSessionsForPicker(ctx, 50, SESSION_PROJCACHE_DIR, {
            includeArchived: includeAll,
            includeBlank: includeAll,
            includeAutomation: includeAll,
          })
          jsonResponse(res, 200, {
            ok: true,
            instanceId: view.id ?? null,
            boundSessionId: view.config.sessionId || null,
            filtered: !includeAll,
            count: rows.length,
            sessions: rows.map((row) => ({ ...row, usedBy: used.get(row.id) ?? null })),
          })
          return
        }
        if (url.pathname === '/live2d/chat' && (req.method === 'POST' || req.method === 'PUT')) {
          let body = {}
          try {
            body = await readJsonBody(req)
          } catch (error) {
            jsonResponse(res, 400, { ok: false, error: `请求体不是合法 JSON：${errorText(error)}` })
            return
          }
          const targetView = body.instanceId && body.instanceId !== view.id
            ? instanceView(state, findInstance(state, body.instanceId))
            : view
          const result = submitChat(ctx, targetView, log, body)
          jsonResponse(res, result.status, result.payload)
          return
        }
        if (url.pathname === '/live2d/chat' && req.method === 'GET') {
          jsonResponse(res, 405, { ok: false, error: '请用 POST，body 形如 { "text": "你好", "sessionId": "可选" }' })
          return
        }
        if (url.pathname === '/live2d/chat/cancel' && (req.method === 'POST' || req.method === 'PUT')) {
          // 应急出口：窗口卡在 loading（比如发现目标会话不对）时，把 pending 清掉
          let body = {}
          try { body = await readJsonBody(req) } catch { body = {} }
          const targetView = body.instanceId && body.instanceId !== view.id
            ? instanceView(state, findInstance(state, body.instanceId))
            : view
          const pending = targetView?.chat?.pending
          if (!pending) {
            jsonResponse(res, 200, { ok: true, cancelled: false, error: '没有等待中的回复', instanceId: targetView?.id ?? null })
            return
          }
          failChat(targetView, log, pending.requestId, body.reason || '已被手动取消')
          jsonResponse(res, 200, { ok: true, cancelled: true, requestId: pending.requestId, instanceId: targetView.id ?? null })
          return
        }
        if (req.method === 'GET' && url.pathname === '/live2d/inject') {
          jsonResponse(res, 405, { ok: false, error: '请用 POST，body 形如 { "sessionId": "...", "text": "...", "dryRun": true }' })
          return
        }

        // --- 多实例：实例池 / 可用模型 ---
        if (url.pathname === '/live2d/instances' && req.method === 'GET') {
          jsonResponse(res, 200, {
            ok: true,
            defaultInstanceId: state.instances?.[0]?.id ?? null,
            limits: { maxInstances: LIMITS.maxInstances },
            instances: (state.instances ?? []).map((item) => instanceSummary(ctx, state, item)),
          })
          return
        }
        // 0.3.2：模型档案（动作/循环按模型共享）
        if (url.pathname === '/live2d/profiles' && req.method === 'GET') {
          const profiles = state.config?.modelProfiles ?? {}
          const bindings = state.config?.modelPathBindings ?? {}
          const usedPaths = new Map()
          for (const inst of state.instances ?? []) {
            const key = normalizeModelKey(inst.config?.modelPath)
            if (key) usedPaths.set(key, inst.id)
          }
          const rows = Object.values(profiles).map((profile) => ({
            id: profile.id,
            label: profile.label,
            pathKey: profile.pathKey,
            modelEntry: profile.modelEntry,
            customActions: profile.customActions.length,
            presetSequences: profile.presetSequences.length,
            updatedAt: profile.updatedAt,
            bound: bindings[profile.pathKey] === profile.id,
            boundInstanceIds: (state.instances ?? [])
              .filter((inst) => normalizeModelKey(inst.config?.modelPath) === profile.pathKey)
              .map((inst) => inst.id),
            inUse: usedPaths.has(profile.pathKey),
          }))
          jsonResponse(res, 200, { ok: true, profiles: rows, bindings, limits: { maxProfiles: PROFILE_LIMIT } })
          return
        }
        const profileAction = url.pathname.match(/^\/live2d\/profiles\/([^/]+)(\/rebind|\/auto-actions)?$/)
        if (profileAction) {
          const profileId = decodeURIComponent(profileAction[1])
          const isRebind = profileAction[2] === '/rebind'
          const isAutoActions = profileAction[2] === '/auto-actions'
          const current = state.config?.modelProfiles?.[profileId]
          if (!current) {
            jsonResponse(res, 404, { ok: false, code: 'no-such-profile', error: `没有模型档案 ${profileId}` })
            return
          }
          if (!isRebind && req.method === 'GET') {
            jsonResponse(res, 200, {
              ok: true,
              profile: current,
              boundInstanceIds: (state.instances ?? [])
                .filter((inst) => normalizeModelKey(inst.config?.modelPath) === current.pathKey)
                .map((inst) => inst.id),
            })
            return
          }
          if (isAutoActions && (req.method === 'POST' || req.method === 'PUT')) {
            let body = {}
            try {
              body = await readJsonBody(req)
            } catch {
              body = {}
            }
            const inst = (state.instances ?? []).find((item) => normalizeModelKey(item.config?.modelPath) === current.pathKey)
            if (!inst) {
              jsonResponse(res, 400, {
                ok: false,
                code: 'no-instance',
                error: `档案「${current.label}」当前没有实例在用，先把某个模型窗格切到这个模型再生成默认动作`,
              })
              return
            }
            // force=false 时参数集没变就跳过；默认强制重挑，让用户点一次就见效
            const result = ensureAutoActions(state, inst, null, { force: body?.force !== false })
            jsonResponse(res, result.ok ? 200 : 400, result.ok
              ? {
                ok: true,
                profileId,
                changed: result.changed === true,
                count: result.count,
                capabilityCount: result.capabilityCount ?? 0,
                hash: result.hash,
                profile: state.config.modelProfiles?.[profileId] ?? null,
              }
              : { ok: false, code: result.code, error: `生成默认动作失败：${result.code ?? '未知'}` })
            return
          }
          if (isRebind && (req.method === 'POST' || req.method === 'PUT')) {
            let body = {}
            try {
              body = await readJsonBody(req)
            } catch (error) {
              jsonResponse(res, 400, { ok: false, error: `请求体不是合法 JSON：${errorText(error)}` })
              return
            }
            const key = normalizeModelKey(body?.path ?? body?.pathKey)
            if (!key) {
              jsonResponse(res, 400, { ok: false, error: '需要 path（模型目录）或 pathKey' })
              return
            }
            const bindings = { ...(state.config.modelPathBindings ?? {}) }
            // 一个路径只绑一个档案：别的档案如果占着这条路径就先让位
            for (const [otherKey, otherId] of Object.entries(bindings)) {
              if (otherId === profileId && otherKey !== key) delete bindings[otherKey]
            }
            bindings[key] = profileId
            state.config.modelPathBindings = normalizeModelPathBindings(bindings, state.config.modelProfiles)
            const saved = writeConfigFile(state.config, state.configFile ?? CONFIG_FILE)
            if (!saved.ok) pushRuntimeWarning(state, `配置写盘失败：${saved.error}`)
            jsonResponse(res, saved.ok ? 200 : 500, { ok: saved.ok, profileId, pathKey: key, bindings: state.config.modelPathBindings, fileError: saved.error ?? null })
            return
          }
          if (req.method === 'PATCH' || req.method === 'PUT') {
            let body = {}
            try {
              body = await readJsonBody(req)
            } catch (error) {
              jsonResponse(res, 400, { ok: false, error: `请求体不是合法 JSON：${errorText(error)}` })
              return
            }
            const patch = {}
            if (typeof body?.label === 'string') patch.label = body.label
            if (typeof body?.modelEntry === 'string') patch.modelEntry = body.modelEntry
            if (body?.customActions !== undefined) patch.customActions = body.customActions
            if (body?.presetSequences !== undefined) patch.presetSequences = body.presetSequences
            const result = patchProfile(state, profileId, patch)
            if (!result.ok) {
              jsonResponse(res, result.status ?? 400, { ok: false, code: result.code, error: `保存模型档案失败：${result.code ?? '未知'}` })
              return
            }
            const saved = writeConfigFile(state.config, state.configFile ?? CONFIG_FILE)
            if (!saved.ok) pushRuntimeWarning(state, `配置写盘失败：${saved.error}`)
            // 所有用这个模型的实例都要收到新的动作表
            for (const inst of state.instances ?? []) {
              if (normalizeModelKey(inst.config?.modelPath) === result.profile.pathKey) pushPresetsToWindow(state, inst)
            }
            jsonResponse(res, saved.ok ? 200 : 500, { ok: saved.ok, profile: result.profile, warnings: result.warnings ?? [], fileError: saved.error ?? null })
            return
          }
          if (req.method === 'DELETE') {
            const bindings = { ...(state.config.modelPathBindings ?? {}) }
            const usedBy = (state.instances ?? []).filter((inst) => normalizeModelKey(inst.config?.modelPath) === current.pathKey)
            const force = url.searchParams.get('force') === '1'
            if (usedBy.length && !force) {
              jsonResponse(res, 409, { ok: false, code: 'profile-in-use', error: `档案「${current.label}」正在被 ${usedBy.map((i) => i.id).join(' / ')} 使用，换掉模型或加 ?force=1 再删` })
              return
            }
            for (const [key, id] of Object.entries(bindings)) if (id === profileId) delete bindings[key]
            const profiles = { ...(state.config.modelProfiles ?? {}) }
            delete profiles[profileId]
            state.config.modelProfiles = normalizeModelProfiles(profiles, [])
            state.config.modelPathBindings = normalizeModelPathBindings(bindings, state.config.modelProfiles)
            const saved = writeConfigFile(state.config, state.configFile ?? CONFIG_FILE)
            if (!saved.ok) pushRuntimeWarning(state, `配置写盘失败：${saved.error}`)
            jsonResponse(res, saved.ok ? 200 : 500, { ok: saved.ok, removed: profileId, fileError: saved.error ?? null })
            return
          }
          jsonResponse(res, 405, { ok: false, error: '只支持 PATCH / DELETE / POST …/rebind / POST …/auto-actions' })
          return
        }
        if (url.pathname === '/live2d/instances' && (req.method === 'POST' || req.method === 'PUT')) {
          let body = {}
          try {
            body = await readJsonBody(req)
          } catch (error) {
            jsonResponse(res, 400, { ok: false, error: `请求体不是合法 JSON：${errorText(error)}` })
            return
          }
          const created = createInstance(state, body)
          jsonResponse(res, created.ok ? 201 : created.status ?? 400, created.ok ? { ok: true, ...created } : created)
          return
        }
        const instanceWindowPath = url.pathname.match(/^\/live2d\/instances\/([^/]+)\/window$/)
        if (instanceWindowPath) {
          const instanceId = decodeURIComponent(instanceWindowPath[1])
          if (req.method === 'GET') {
            const target = findInstance(state, instanceId)
            if (!target) {
              jsonResponse(res, 404, { ok: false, error: `没有实例 ${instanceId}` })
              return
            }
            jsonResponse(res, 200, { ok: true, instanceId, window: target.window ?? null, ...instanceView(state, target).windows.status() })
            return
          }
          if (req.method === 'POST' || req.method === 'PUT') {
            let body = {}
            try { body = await readJsonBody(req) } catch { body = {} }
            const action = typeof body.action === 'string' ? body.action : 'open'
            if (action === 'open') {
              const result = openInstanceWindow(state, instanceId)
              jsonResponse(res, result.ok ? 200 : 404, result)
              return
            }
            if (action === 'close') {
              jsonResponse(res, 200, closeInstanceWindow(state, instanceId))
              return
            }
            if (action === 'reload') {
              const target = findInstance(state, instanceId)
              if (!target) {
                jsonResponse(res, 404, { ok: false, error: `没有实例 ${instanceId}` })
                return
              }
              const viewAfter = instanceView(state, target)
              const sent = viewAfter.windows?.send?.({ type: 'reload', model: initPayload(viewAfter).model })
              jsonResponse(res, 200, { ok: true, instanceId, sent, ...viewAfter.windows?.status?.() })
              return
            }
            jsonResponse(res, 400, { ok: false, error: `action 只能是 open / close / reload（收到 ${JSON.stringify(action)}）` })
            return
          }
          jsonResponse(res, 405, { ok: false, error: '请用 GET 或 POST' })
          return
        }
        if (url.pathname.startsWith('/live2d/instances/') && (req.method === 'PATCH' || req.method === 'PUT' || req.method === 'POST')) {
          const rest = decodeURIComponent(url.pathname.slice('/live2d/instances/'.length))
          if (rest.includes('/')) {
            jsonResponse(res, 404, { ok: false, error: `未知的实例子路径：${rest}` })
            return
          }
          const id = rest
          let body = {}
          try {
            body = await readJsonBody(req)
          } catch (error) {
            jsonResponse(res, 400, { ok: false, error: `请求体不是合法 JSON：${errorText(error)}` })
            return
          }
          const patch = body && typeof body.patch === 'object' && body.patch !== null ? body.patch : body
          const result = patchInstance(state, id, patch ?? {})
          if (!result.ok) {
            jsonResponse(res, result.status ?? 409, { ok: false, code: result.code ?? null, error: result.error, conflictWith: result.conflictWith ?? null, warnings: state.warnings })
            return
          }
          const target = findInstance(state, id)
          const needsReload = target && (result.needsReload === true)
          if (needsReload) {
            target.model = modelProbe(target.config.modelPath)
            setWarningSource(state, 'model', target.model.warnings ?? [])
            if (target.model.ok) clearRuntimeWarnings(state, '渲染失败：')
          }
          const saved = writeConfigFile(state.config, state.configFile ?? CONFIG_FILE)
          if (!saved.ok) pushRuntimeWarning(state, `配置写盘失败：${saved.error}（本次已生效，但重启后会丢）`)
          const viewAfter = target ? instanceView(state, target) : null
          const sentConfig = viewAfter?.windows?.send?.({
            type: 'config',
            patch: windowConfigPayload(target.config, buildPresets(target, profileFor(state, target)), lifeStatusSnapshot(target)),
            title: instanceTitle(state, target),
            sessionId: target.config.sessionId || null,
          })
          const sentReload = needsReload ? viewAfter?.windows?.send?.({ type: 'reload', model: initPayload(viewAfter).model }) : null
          jsonResponse(res, saved.ok ? 200 : 500, {
            ok: saved.ok,
            instance: target ? instanceSummary(ctx, state, target) : null,
            warnings: state.warnings,
            needsReload: Boolean(needsReload),
            applied: { config: sentConfig ?? null, reload: sentReload ?? null },
            fileError: saved.error ?? null,
          })
          return
        }
        if (url.pathname.startsWith('/live2d/instances/') && req.method === 'DELETE') {
          const id = decodeURIComponent(url.pathname.slice('/live2d/instances/'.length))
          const removed = deleteInstance(state, id)
          jsonResponse(res, removed.ok ? 200 : removed.status ?? 400, removed)
          return
        }
        if (url.pathname === '/live2d/models' && req.method === 'GET') {
          jsonResponse(res, 200, { ok: true, roots: modelRoots(state), ...scanModels(state) })
          return
        }
        if (url.pathname === '/live2d/window' && req.method === 'GET') {
          jsonResponse(res, 200, {
            ok: true,
            instanceId: view.id ?? null,
            bounds: view.windowBounds ?? null,
            window: view.window ?? null,
            ...windows.status(),
            ready: Boolean(view.window?.ready),
          })
          return
        }
        if (url.pathname === '/live2d/window' && (req.method === 'POST' || req.method === 'PUT')) {
          let body = {}
          try {
            body = await readJsonBody(req)
          } catch (error) {
            jsonResponse(res, 400, { ok: false, error: `请求体不是合法 JSON：${errorText(error)}` })
            return
          }
          const action = typeof body.action === 'string' ? body.action : 'open'
          const targetId = body.instanceId ?? requestedId ?? view.id ?? null
          if (action === 'open') {
            const result = openInstanceWindow(state, targetId)
            jsonResponse(res, result.ok ? 200 : 409, result)
            return
          }
          if (action === 'close') {
            const target = findInstance(state, targetId)
            const farewell = sendFarewell(state, target, 'window-close')
            const isolated = state.configFile && state.configFile !== CONFIG_FILE
            let result = null
            if (farewell.ok && !isolated) {
              const timer = setTimeout(() => {
                try { closeInstanceWindow(state, targetId) } catch { /* 已关闭 */ }
              }, 1400)
              if (typeof timer.unref === 'function') timer.unref()
              result = { ok: true, instanceId: targetId, deferred: true, farewell }
            } else {
              result = { ...closeInstanceWindow(state, targetId), farewell }
            }
            jsonResponse(res, 200, result)
            return
          }
          if (action === 'reload') {
            const target = findInstance(state, targetId)
            const viewAfter = target ? instanceView(state, target) : view
            const sent = viewAfter.windows?.send?.({ type: 'reload', model: initPayload(viewAfter).model })
            jsonResponse(res, 200, { ok: true, instanceId: viewAfter.id ?? null, sent, ...viewAfter.windows?.status?.() })
            return
          }
          jsonResponse(res, 400, { ok: false, error: `action 只能是 open / close / reload（收到 ${JSON.stringify(action)}）` })
          return
        }
        if (req.method === 'GET' && (url.pathname === '/live2d/panel' || url.pathname === '/live2d' || url.pathname === '/live2d/')) {
          htmlResponse(res, panelHtml(state, { services: probeServices(ctx) }))
          return
        }
        jsonResponse(res, 404, { ok: false, error: 'not found' })
      } catch (error) {
        log.warn(`live2d: 路由处理失败：${errorText(error)}`)
        try { jsonResponse(res, 500, { ok: false, error: 'internal error' }) } catch { /* socket 可能已断 */ }
      }
    },
  })

  state.routesRegistered = true
  return { dispose }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

/**
 * 工具层：把 HTTP 能力注册成 DSH 工具，让 AI 在对话里直接知道「我能控制桌宠」。
 * 关键约束（审查 P0-2/P0-3）：
 *  - 目标实例必须由「当前会话」唯一解析，找不到就明确拒绝，绝不回落默认实例；
 *  - 自动模式下拒绝动作/气泡/读屏这类「对话主动控制」的能力。
 */
export function resolveToolTarget(state, { instanceId, sessionId } = {}) {
  const selfId = String(sessionId ?? '')
  if (!selfId) {
    return { ok: false, code: 'missing-session', message: '拿不到当前会话 id，无法判断该控制哪个模型。' }
  }
  if (instanceId) {
    const hit = state.instances.find((inst) => inst.id === instanceId) ?? null
    if (!hit) {
      return { ok: false, code: 'no-such-instance', message: `没有编号为 ${instanceId} 的模型实例。`, available: state.instances.map((inst) => inst.id) }
    }
    // 显式 id 也要过归属校验：普通工具只能控制「绑定到当前会话」的实例（审查 P1-1）
    const boundTo = String(hit.config?.sessionId ?? '')
    if (!boundTo) {
      return { ok: false, code: 'instance-not-bound', message: `模型 ${instanceId} 还没绑定任何对话。请用户在「设置 → Live2D」里把它绑定到当前对话再用。` }
    }
    if (boundTo !== selfId) {
      return { ok: false, code: 'instance-not-yours', message: `模型 ${instanceId} 绑定的是另一个对话，普通工具不能跨会话控制它。` }
    }
    return { ok: true, inst: hit, resolvedBy: 'instanceId' }
  }
  const bound = state.instances.find((inst) => String(inst.config?.sessionId ?? '') === selfId) ?? null
  if (bound) return { ok: true, inst: bound, resolvedBy: 'session' }
  return {
    ok: false,
    code: 'no-instance-for-session',
    message: '当前会话还没有绑定 Live2D 模型。请在「设置 → Live2D」里给这个对话选择模型（或直接说「把模型绑到这个对话」）。',
    available: state.instances.map((inst) => ({ instanceId: inst.id, sessionId: inst.config?.sessionId ?? null })),
  }
}

export function toolSummary(value) {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function createLive2dTools(state, log) {
  const fail = (code, message, extra = {}) => ({ ok: false, summary: toolSummary({ code, message, ...extra }) })

  const toolStatus = {
    name: 'live2d_status',
    description: '查看 Live2D 桌宠状态：有哪些模型实例、各自绑定哪个会话、当前模式、窗口与模型是否加载、气泡尺寸。只读。',
    parameters: {
      type: 'object',
      properties: { instanceId: { type: 'string', description: '可选，只看某个实例' } },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['ok', 'summary'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }] },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? exec?.agent?.sessionId ?? null
      // 只返回「绑定到当前会话」的实例：别的会话的模型不该被普通 AI 看到（审查 P1-1）
      const mine = state.instances.filter((inst) => String(inst.config?.sessionId ?? '') === String(sessionId ?? ''))
      const rows = mine.map((inst) => ({
        instanceId: inst.id,
        sessionId: inst.config?.sessionId ?? null,
        title: inst.window?.title ?? null,
        mode: inst.config?.mode ?? 'manual',
        modelPath: inst.config?.modelPath ?? null,
        modelOk: inst.model?.ok === true,
        renderer: inst.renderer?.state ?? 'unknown',
        window: inst.window?.state ?? 'unknown',
        modelScalePct: inst.config?.modelScalePct ?? 100,
        bubblePx: inst.renderer?.layout?.bubblePx ?? null,
        bubbleFixedSize: inst.config?.bubbleFixedSize === true,
        screen: inst.screen?.watch ?? null,
        life: inst.life
          ? {
              attention: inst.life.attention,
              audience: inst.life.audience,
              willingness: inst.life.willingness,
              energy: Math.round(Number(inst.life.energy) * 100) / 100,
              mood: Math.round(Number(inst.life.mood) * 100) / 100,
              boredom: Math.round(Number(inst.life.boredom) * 100) / 100,
              lastEvent: inst.life.lastEvent,
              peerAffinity: Math.round(Number(inst.life.peerAffinity) * 100) / 100,
            }
          : null,
        memory: {
          enabled: inst.config?.memoryEnabled === true,
          count: listMemories(state, inst.config?.sessionId ?? '').filter((item) => !item.dormant).length,
        },
      }))
      const wanted = typeof args?.instanceId === 'string' ? args.instanceId : ''
      const list = wanted ? rows.filter((row) => row.instanceId === wanted) : rows
      if (list.length === 0) {
        return {
          ok: true,
          summary: toolSummary({
            sessionId,
            instances: [],
            hint: '当前会话还没有绑定 Live2D 模型（或者指定的实例不属于本会话）。请让用户在「设置 → Live2D」里把模型绑定到这个对话。',
          }),
        }
      }
      return { ok: true, summary: toolSummary({ sessionId, instances: list }) }
    },
  }

  const toolBubble = {
    name: 'live2d_bubble',
    description: '让 Live2D 桌宠的气泡显示一段文字（手动模式/半自动模式可用）。不传 text 时显示本会话最新一条回复。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要显示的文字；留空则取当前会话最新回复' },
        instanceId: { type: 'string', description: '可选，指定实例' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['ok', 'summary'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }] },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? null
      const target = resolveToolTarget(state, { instanceId: args?.instanceId, sessionId })
      if (!target.ok) return fail(target.code, target.message, { available: target.available })
      if (!modeAllows(target.inst, 'bubble')) {
        return fail('mode-forbidden', '当前是「手动」模式，AI 不能主动往气泡里推内容。可在设置页或窗口模式菜单切到「AI 半自动 / AI 自动」，或让用户自己点测试按钮。')
      }
      let text = typeof args?.text === 'string' ? args.text.trim() : ''
      let latestMessage = null
      if (!text) {
        const latest = findLatestAssistantText(exec?.agent?.session)
        if (!latest?.ok || !latest.text) return fail('no-reply', '本会话还没有可显示的回复。')
        text = latest.text
        latestMessage = latest.message ?? null
      }
      const shown = displayBubbleText(text, 2000)
      // 与 idle 自动推送共用去重键：否则这条显示完，agent 回 idle 时会再弹一次
      const key = replyKeyOf(latestMessage, text)
      if (!claimReply(target.inst, key)) {
        return { ok: true, summary: toolSummary({ shown: false, deduped: true, instanceId: target.inst.id }) }
      }
      const seq = ++target.inst.bubble.seq
      // inst 上没有 windows（窗口管理器挂在 state 上），必须走 instanceView 的代理
      const view = instanceView(state, target.inst)
      const sent = view.windows.send({ type: 'bubble', text: shown, format: 'markdown', seq, durationMs: target.inst.config.bubbleDurationMs, speechPending: false })
      // 传播真实结果：窗口没开/命令没写进去时不能说「显示成功」（审查 P1-2）
      if (sent?.ok === false) {
        if (target.inst.bubble) target.inst.bubble.claim = null
        return fail('bubble-failed', `气泡没能送到窗口：${sent.error || '未知原因'}`, { instanceId: target.inst.id, sent })
      }
      target.inst.bubble.lastMessageId = key
      target.inst.bubble.lastIdentity = textIdentity(shown)
      target.inst.bubble.lastAt = Date.now()
      target.inst.bubble.bubbleCount = (target.inst.bubble.bubbleCount ?? 0) + 1
      return { ok: true, summary: toolSummary({ shown: true, sent, instanceId: target.inst.id, resolvedBy: target.resolvedBy, preview: cleanBubbleText(shown, 60) }) }
    },
  }

  const toolPerform = {
    name: 'live2d_perform',
    description: '一次性完成一小段有身体感的回应：先看某个方向，再播放动作，延迟后显示气泡（可选自动朗读）。适合根据用户当前界面场景做应援、鼓励、安慰或共同反应；需要把语言、表情和动作连贯表达时优先用这个工具，而不是连续调用多个工具。',
    parameters: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: '可选，指定实例' },
        lookAt: { type: 'string', enum: ['cursor', 'user', 'away', 'none'], description: '看向鼠标、看向用户、看向别处或取消强制视线' },
        anim: { type: 'string', description: `动作 id：${ANIM_WHITELIST.join(' | ')}，也可用当前实例的自定义动作` },
        text: { type: 'string', description: '气泡文本；留空则只做视线/动作' },
        delayMs: { type: 'number', description: '动作开始后延迟多久显示气泡，0~3000ms，默认 350ms' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['ok', 'summary'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }] },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? null
      const target = resolveToolTarget(state, { instanceId: args?.instanceId, sessionId })
      if (!target.ok) return fail(target.code, target.message, { available: target.available })
      const inst = target.inst
      const view = instanceView(state, inst)
      const text = typeof args?.text === 'string' ? args.text.trim() : ''
      const anim = typeof args?.anim === 'string' ? args.anim.trim().toLowerCase() : ''
      const lookAt = ['cursor', 'user', 'away', 'none'].includes(args?.lookAt) ? args.lookAt : null
      if (!text && !anim && !lookAt) return fail('empty-plan', 'live2d_perform 至少需要 lookAt / anim / text 之一')
      if (!canControl(inst, 'bubble', { source: 'tool' }) && text) {
        const denied = modeForbidden(inst, 'bubble')
        return fail(denied.code, denied.error, { instanceId: inst.id })
      }
      if (!canControl(inst, 'anim', { source: 'tool' }) && (anim || lookAt)) {
        const denied = modeForbidden(inst, 'anim')
        return fail(denied.code, denied.error, { instanceId: inst.id })
      }

      let look = null
      if (lookAt) {
        look = view.windows.send({ type: 'look-at', mode: lookAt, durationMs: 5000 })
        if (look?.ok === false) return fail('look-failed', `视线指令没送到窗口：${look.error ?? 'unknown'}`, { instanceId: inst.id, look })
      }

      let animation = null
      if (anim) {
        const result = handleAnim(view, log, { action: anim })
        animation = result.payload ?? { status: result.status }
        if (result.status !== 200) {
          return fail(animation.code ?? 'anim-failed', animation.error ?? `动作失败（${result.status}）`, { instanceId: inst.id, animation, look })
        }
      }

      let bubble = null
      if (text) {
        const delayMs = clampInt(Math.round(Number(args?.delayMs ?? 350)), { min: 0, max: 3000, fallback: 350 }, 'delayMs', [])
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
        const shown = displayBubbleText(text, 2000)
        const key = replyKeyOf(null, text)
        if (!claimReply(inst, key)) {
          bubble = { ok: true, shown: false, deduped: true }
        } else {
          const seq = (inst.bubble.seq += 1)
          const speechOn = inst.config.ttsEnabled === true && inst.config.ttsAutoSpeak === true
          const sent = view.windows.send({
            type: 'bubble',
            text: shown,
            format: 'markdown',
            seq,
            durationMs: speechOn ? 0 : inst.config.bubbleDurationMs,
            speechPending: speechOn,
          })
          if (sent?.ok === false) {
            if (inst.bubble) inst.bubble.claim = null
            return fail('bubble-failed', `气泡没能送到窗口：${sent.error ?? 'unknown'}`, { instanceId: inst.id, sent })
          }
          inst.bubble.lastMessageId = key
          inst.bubble.lastIdentity = textIdentity(shown)
          inst.bubble.lastAt = Date.now()
          inst.bubble.bubbleCount = (inst.bubble.bubbleCount ?? 0) + 1
          bubble = { ok: true, shown: true, seq }
          if (speechOn) {
            speakForReply(state, inst, seq, ttsText(text, 1_000_000), log)
              .catch((error) => logged(log, `[${inst.id}] 表演语音异常：${errorText(error)}`))
          }
        }
      }
      return {
        ok: true,
        summary: toolSummary({
          instanceId: inst.id,
          resolvedBy: target.resolvedBy,
          lookAt: lookAt ?? null,
          anim: anim || null,
          bubble: bubble ? { shown: bubble.shown === true, seq: bubble.seq ?? null, deduped: bubble.deduped === true } : null,
        }),
      }
    },
  }

  const toolAnim = {
    name: 'live2d_anim',
    description: `让 Live2D 桌宠做一个动作。可用动作：${ANIM_WHITELIST.join(' / ')}。手动/半自动模式可用，带 3 秒冷却。`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: ANIM_WHITELIST.join(' | ') },
        instanceId: { type: 'string', description: '可选，指定实例' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['ok', 'summary'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }] },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? null
      const target = resolveToolTarget(state, { instanceId: args?.instanceId, sessionId })
      if (!target.ok) return fail(target.code, target.message, { available: target.available })
      const view = instanceView(state, target.inst)
      const result = handleAnim(view, log, { action: args?.action }, 'tool')
      const payload = result.payload ?? {}
      return { ok: result.status === 200, summary: toolSummary({ status: result.status, ...payload, instanceId: target.inst.id, resolvedBy: target.resolvedBy }) }
    },
  }

  const toolWindow = {
    name: 'live2d_window',
    description: '管理 Live2D 桌宠窗口：打开/重载；AI 自动模式下还能移动、改大小、按比例缩放、复位，以及安全地坐到任务栏、靠屏幕边缘或短时跟随鼠标。（AI 不能关闭窗口。）',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'reload', 'move', 'resize', 'scale', 'reset', 'presence'] },
        instanceId: { type: 'string', description: '可选，指定实例' },
        x: { type: 'number', description: 'move：目标左上角 x（会夹在工作区内）' },
        y: { type: 'number', description: 'move：目标左上角 y' },
        width: { type: 'number', description: 'resize：宽 160~800' },
        height: { type: 'number', description: 'resize：高 200~1000' },
        scalePct: { type: 'number', description: 'scale：相对当前尺寸的百分比 50~200' },
        position: { type: 'string', enum: ['home', 'taskbar', 'edge-left', 'edge-right', 'follow-cursor', 'stop'], description: 'presence：语义化位置；follow-cursor 会保持距离跟随鼠标直到 stop/用户拖动' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['ok', 'summary'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }] },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? null
      const target = resolveToolTarget(state, { instanceId: args?.instanceId, sessionId })
      if (!target.ok) return fail(target.code, target.message, { available: target.available })
      const action = String(args?.action ?? '')
      const view = instanceView(state, target.inst)
      const lifecycle = action === 'open' || action === 'reload'
      // 生命周期操作：auto 仍然禁止；移动/缩放：只有手动 + 显式开启 aiMoveEnabled
      if (lifecycle) {
        if (target.inst.config?.mode === 'auto') {
          const denied = modeForbidden(target.inst, 'window')
          return fail(denied.code, denied.error, { instanceId: target.inst.id, mode: 'auto' })
        }
      } else if (!canControl(target.inst, 'window', { source: 'tool' })) {
        const aiMove = target.inst.config?.aiMoveEnabled === true
        const why = target.inst.config?.mode !== 'manual'
          ? '移动/缩放窗口只在「AI 手动」模式可用'
          : '需要先在设置页打开「允许 AI 移动/缩放窗口」'
        return fail('window-forbidden', why, { instanceId: target.inst.id, mode: target.inst.config?.mode, aiMoveEnabled: aiMove })
      }
      try {
        if (action === 'open') {
          const opened = await openInstanceWindow(state, target.inst.id)
          // 传播真实结果：开窗失败 / 命令没写进管道都不能报成功（审查 P1-2）
          if (opened?.ok !== true || opened?.sent?.ok === false) {
            return fail('window-failed', `窗口没能打开：${opened?.error ?? opened?.sent?.error ?? '未知原因'}`, {
              instanceId: target.inst.id,
              opened,
            })
          }
          return { ok: true, summary: toolSummary({ action, instanceId: target.inst.id, window: target.inst.window?.state ?? 'starting', sent: opened.sent }) }
        }
        if (action === 'reload') {
          const sent = view.windows.send({ type: 'reload' })
          if (sent?.ok === false) {
            return fail('window-failed', `重载命令没送出去：${sent.error || '未知原因'}`, { instanceId: target.inst.id, sent })
          }
          return { ok: true, summary: toolSummary({ action, instanceId: target.inst.id, window: target.inst.window?.state ?? 'unknown', sent }) }
        }
        if (action === 'presence') {
          const position = String(args?.position || '')
          if (!['home', 'taskbar', 'edge-left', 'edge-right', 'follow-cursor', 'stop'].includes(position)) {
            return fail('bad-action', 'presence 需要 position：home / taskbar / edge-left / edge-right / follow-cursor / stop')
          }
          const before = target.inst.windowBounds?.at ?? 0
          const sent = view.windows.send({ type: 'presence', position, durationMs: 850 })
          if (sent?.ok === false) return fail('window-failed', `窗口命令没送出去：${sent.error || '未知原因'}`, { instanceId: target.inst.id, sent })
          const landed = await waitForBounds(target.inst, before, 3200)
          if (!landed) return fail('window-timeout', '窗口没有在 3.2 秒内回报新位置', { instanceId: target.inst.id })
          if (position !== 'follow-cursor' && position !== 'stop') {
            patchInstance(state, target.inst.id, {
              windowX: landed.x, windowY: landed.y, windowWidth: landed.width, windowHeight: landed.height,
            })
          }
          return { ok: true, summary: toolSummary({ action, position, instanceId: target.inst.id, bounds: landed }) }
        }
        if (action === 'move' || action === 'resize' || action === 'scale' || action === 'reset') {
          view.windows.send({ type: 'presence', position: 'stop' }, target.inst.id)
          const bounds = {}
          if (action === 'move') {
            if (!Number.isFinite(Number(args?.x)) || !Number.isFinite(Number(args?.y))) {
              return fail('bad-action', 'move 需要 x 与 y')
            }
            bounds.x = Math.round(Number(args.x))
            bounds.y = Math.round(Number(args.y))
          }
          if (action === 'resize') {
            bounds.width = Math.round(Number(args?.width))
            bounds.height = Math.round(Number(args?.height))
          }
          if (action === 'scale') {
            const pct = Number(args?.scalePct)
            if (!Number.isFinite(pct)) return fail('bad-action', 'scale 需要 scalePct')
            const ratio = Math.min(200, Math.max(50, pct)) / 100
            const cur = target.inst.windowBounds ?? { width: 320, height: 420 }
            bounds.width = Math.round(cur.width * ratio)
            bounds.height = Math.round(cur.height * ratio)
          }
          if (action === 'reset') {
            bounds.width = target.inst.config?.windowWidth ?? 320
            bounds.height = target.inst.config?.windowHeight ?? 420
            bounds.center = true
          }
          const before = target.inst.windowBounds?.at ?? 0
          // 先让模型做个「挪动」的姿态，再让窗口平滑滑过去（不是瞬移）
          const walkMs = 700
          view.windows.send({ type: 'walk', on: true, ms: walkMs }, target.inst.id)
          const sent = view.windows.send({ type: 'set-bounds', bounds, animate: true, durationMs: walkMs }, target.inst.id)
          if (sent?.ok === false) {
            return fail('window-failed', `窗口命令没送出去：${sent.error || '未知原因'}`, { instanceId: target.inst.id, sent })
          }
          const landed = await waitForBounds(target.inst, before, 3000)
          if (!landed) {
            return fail('window-timeout', '窗口没有在 3 秒内回报新位置（可能还没就绪）', { instanceId: target.inst.id })
          }
          // 写回配置：重启后保持同一几何
          patchInstance(state, target.inst.id, {
            windowX: landed.x, windowY: landed.y, windowWidth: landed.width, windowHeight: landed.height,
          })
          return { ok: true, summary: toolSummary({ action, instanceId: target.inst.id, bounds: landed }) }
        }
        return fail('bad-action', `不支持的动作：${action}`)
      } catch (error) {
        return fail('window-failed', errorText(error))
      }
    },
  }

  const toolScreen = {
    name: 'live2d_screen',
    description: '读取当前前台窗口的标题与进程名（只读，不截图）。需要该实例在设置里开启「读取前台窗口标题」；手动/半自动模式可用。',
    parameters: {
      type: 'object',
      properties: { instanceId: { type: 'string', description: '可选，指定实例' } },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['ok', 'summary'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }] },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? null
      const target = resolveToolTarget(state, { instanceId: args?.instanceId, sessionId })
      if (!target.ok) return fail(target.code, target.message, { available: target.available })
      if (!modeAllows(target.inst, 'screen')) {
        return fail('mode-forbidden', '当前是「手动」模式，AI 不能主动读屏。可在设置页或窗口模式菜单切到「AI 半自动 / AI 自动」。')
      }
      if (target.inst.config?.screenReadEnabled !== true) {
        return fail('screen-disabled', '这个实例还没开「读取前台窗口标题」。请让用户在「设置 → Live2D」里勾选后再试（只读标题，不截图）。')
      }
      const result = await getForegroundTitle(state, undefined, target.inst.config)
      if (result?.ok !== true) {
        return fail('screen-failed', result?.error ?? '读取前台窗口失败', { hint: result?.hint })
      }
      return {
        ok: true,
        summary: toolSummary({
          instanceId: target.inst.id,
          title: result.title ?? '',
          process: result.process ?? '',
          at: result.at ?? null,
          cached: result.cached === true,
          watch: target.inst.screen?.watch ?? null,
        }),
      }
    },
  }

  const toolPreset = {
    name: 'live2d_preset',
    description:
      '管理预设动作：列出当前实例的动作/循环、播放某个动作、设计一个新的自定义动作、删除自定义动作、设置循环序列、启停循环。' +
      '自定义动作只描述「参数 → 关键帧」，参数可写逻辑名（headX/headY/headZ/eyeOpenL/eyeOpenR/mouthOpen/mouthForm/eyeBallX/eyeBallY/bodyX）' +
      '或模型真实参数名；换模型时缺的参数会被自动跳过，不必改代码。' +
      '没有合适的现成动作时，应该自己 define 一个新动作（先 list 看现有），再 play 播放，而不是硬套不贴切的预设。',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['list', 'play', 'define', 'remove', 'sequence', 'start', 'stop'],
          description: 'list=看动作与循环；play=立刻播；define=新增/覆盖自定义动作；remove=删自定义动作；sequence=新增/覆盖循环；start/stop=启停循环',
        },
        instanceId: { type: 'string', description: '可选，指定实例（默认当前会话绑定的实例）' },
        id: { type: 'string', description: 'op=define/sequence 时：动作或循环的 id（小写字母开头，2~24 位，只含 a-z 0-9 _ -，例如 "proud"）' },
        action: { type: 'string', description: 'op=play 时：动作 id（内置或自定义）；op=define 时也可当 id 用（兼容旧写法）' },
        sequenceId: { type: 'string', description: 'op=sequence/start/stop 时：循环 id（sequence 可省略，缺省自动生成）' },
        label: { type: 'string', description: '显示名（≤24 字）' },
        durationMs: { type: 'number', description: '自定义动作时长（200~10000ms，默认 1000）' },
        tracks: {
          type: 'array',
          description: '自定义动作轨道：[{param, keys:[[0,0],[0.5,10],[1,0]]}]，最多 8 条轨道×12 个关键帧',
          items: {
            type: 'object',
            properties: {
              param: { type: 'string' },
              keys: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
            },
            required: ['param', 'keys'],
          },
        },
        steps: { type: 'array', items: { type: 'string' }, description: '循环步骤（动作 id 列表，最多 20 个）' },
        intervalMs: { type: 'number', description: '循环间隔（300~60000ms，默认 2500）' },
        loop: { type: 'boolean', description: '是否循环（默认 true）' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['ok', 'summary'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }] },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? null
      const target = resolveToolTarget(state, { instanceId: args?.instanceId, sessionId })
      if (!target.ok) return fail(target.code, target.message, { available: target.available })
      const inst = target.inst
      const view = instanceView(state, inst)
      const op = String(args?.op || '')

      if (op === 'list') {
        // 0.3.2：自定义动作/循环来自模型档案
        const profile = profileFor(state, inst)
        const customIds = new Set((profile?.customActions ?? []).map((item) => item.id))
        return {
          ok: true,
          summary: toolSummary({
            instanceId: inst.id,
            profileId: profile?.id ?? null,
            profileLabel: profile?.label ?? null,
            // 内置动作仍可被内部事件/AI 调用，但菜单已不再按示例模型皮套展示。
            builtin: ANIM_WHITELIST.map((id) => ({ id, label: BUILTIN_ACTION_LABELS[id] ?? id })),
            defaultActions: (profile?.autoActions ?? [])
              .filter((item) => !customIds.has(item.id))
              .map((item) => ({ id: item.id, label: item.label, durationMs: item.durationMs, tracks: item.tracks })),
            capabilityActions: (profile?.capabilityActions ?? [])
              .filter((item) => !customIds.has(item.id))
              .map((item) => ({ id: item.id, label: item.label, group: item.group ?? '', hold: item.hold === true, tracks: item.tracks })),
            custom: (profile?.customActions ?? []).map((item) => ({ id: item.id, label: item.label, tracks: item.tracks.length })),
            sequences: profile?.presetSequences ?? [],
            running: inst.presetRun?.id ?? null,
            modelParams: inst.renderer?.params?.params ?? null,
          }),
        }
      }

      if (op === 'play') {
        // 自己点/工具点：不算「AI 主动控制模型」，但 auto 模式下仍按既有规矩拒绝（保持模式语义一致）
        if (!modeAllows(inst, 'anim')) return fail('mode-forbidden', modeForbidden(inst, 'anim').message)
        const result = playPreset(state, inst, args?.action, log)
        if (!result.ok) return fail(result.code || 'preset-failed', `播放失败：${result.code ?? '未知'}`, result)
        return { ok: true, summary: toolSummary({ played: result.action, instanceId: inst.id }) }
      }

      if (op === 'define') {
        if (!modeAllows(inst, 'anim')) return fail('mode-forbidden', modeForbidden(inst, 'anim').message)
        // id 优先取 id，其次兼容旧的 action 字段；空 id 直接给出可照抄的调用示例
        const wantedId = String(args?.id ?? args?.action ?? '').trim()
        if (!wantedId) {
          return fail('bad-action', '缺少 id：define 需要 id（小写字母开头，2~24 位，只含 a-z 0-9 _ -）', {
            hint: '例：{"op":"define","id":"proud","label":"得意","durationMs":1600,"tracks":[{"param":"headZ","keys":[[0,0],[0.3,12],[1,0]]}]}',
          })
        }
        const warnings = []
        const def = normalizeCustomActions(
          [{ id: wantedId, label: args?.label, durationMs: args?.durationMs, tracks: args?.tracks }],
          warnings,
        )[0]
        if (!def) return fail('bad-action', warnings[0] ?? '动作定义不合法', { warnings, id: wantedId })
        const currentProfile = profileFor(state, inst)
        const others = (currentProfile?.customActions ?? []).filter((item) => item.id !== def.id)
        const saved = savePresetsToProfile(state, inst, { customActions: [...others, def] }, log)
        if (!saved.ok) return fail(saved.code || 'define-failed', saved.error ?? '保存失败')
        return { ok: true, summary: toolSummary({ defined: def.id, label: def.label, tracks: def.tracks.length, warnings: [...warnings, ...saved.warnings] }) }
      }

      if (op === 'remove') {
        const id = String(args?.action || '')
        if (!id) return fail('bad-action', '需要 action（要删除的自定义动作 id）')
        const currentProfile = profileFor(state, inst)
        const list = currentProfile?.customActions ?? []
        const next = list.filter((item) => item.id !== id)
        if (next.length === list.length) return fail('no-such-action', `没有自定义动作「${id}」`)
        const saved = savePresetsToProfile(state, inst, { customActions: next }, log)
        if (!saved.ok) return fail(saved.code || 'remove-failed', saved.error ?? '保存失败')
        return { ok: true, summary: toolSummary({ removed: id }) }
      }

      if (op === 'sequence') {
        const warnings = []
        const wantedSeqId = String(args?.id ?? args?.sequenceId ?? '').trim() || `loop-${Date.now().toString(36)}`
        const seq = normalizePresetSequences(
          [{ id: wantedSeqId, label: args?.label, steps: args?.steps, intervalMs: args?.intervalMs, loop: args?.loop }],
          warnings,
        )[0]
        if (!seq) return fail('bad-sequence', warnings[0] ?? '循环定义不合法', { warnings })
        const currentProfile = profileFor(state, inst)
        const others = (currentProfile?.presetSequences ?? []).filter((item) => item.id !== seq.id)
        const saved = savePresetsToProfile(state, inst, { presetSequences: [...others, seq] }, log)
        if (!saved.ok) return fail(saved.code || 'sequence-failed', saved.error ?? '保存失败')
        return { ok: true, summary: toolSummary({ sequence: seq.id, steps: seq.steps, intervalMs: seq.intervalMs }) }
      }

      if (op === 'start' || op === 'stop') {
        if (op === 'stop') {
          const stopped = stopPresetSequence(state, inst)
          return { ok: true, summary: toolSummary({ stopped: stopped.stopped }) }
        }
        const started = startPresetSequence(state, inst, String(args?.sequenceId || ''), log)
        if (!started.ok) return fail(started.code || 'sequence-failed', `启动失败：${started.code ?? '未知'}`, started)
        return { ok: true, summary: toolSummary(started) }
      }

      return fail('bad-action', `不支持的 op：${op || '(空)'}`)
    },
  }

  const toolParams = {
    name: 'live2d_params',
    description: '列出当前模型真实可用的 Cubism 参数名（AI 设计自定义动作前先查，换模型时用它确认参数是否还在）。',
    parameters: {
      type: 'object',
      properties: { instanceId: { type: 'string', description: '可选，指定实例' } },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['ok', 'summary'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }] },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? null
      const target = resolveToolTarget(state, { instanceId: args?.instanceId, sessionId })
      if (!target.ok) return fail(target.code, target.message, { available: target.available })
      const known = target.inst.renderer?.params
      if (!known?.params?.length) {
        return fail('no-params', '还没拿到模型参数表：窗口要先把模型渲染出来（打开窗口/等待渲染完成后重试）')
      }
      const profile = profileFor(state, target.inst)
      const caps = profile?.capabilities ?? null
      let summary = toolSummary({ instanceId: target.inst.id, count: known.count, at: known.at, params: known.params })
      if (caps) {
        const by = (group) => caps.expressions.filter((item) => item.group === group).length
        const acts = (profile?.capabilityActions ?? []).map((item) => item.label)
        summary += `\n\n【模型能力】表情 ${by('face')} · 换装 ${by('clothes')} · 手势 ${by('gesture')} · 其它 ${by('other')}`
        if (acts.length) summary += `\n可做动作（右键菜单）：${acts.join('、')}`
        if (caps.motions.length) {
          summary += `\n动画文件（motion3，model3.json 未注册，当前不播）：${caps.motions.map((item) => item.label).join('、')}`
        }
      } else {
        summary += '\n\n【模型能力】还没扫描过：让窗口渲染完成后，设置页点一次「重新生成」即可生成能力清单'
      }
      return { ok: true, summary }
    },
  }

  const toolCapture = {
    name: 'live2d_screen_capture',
    description:
      '截一张全屏（读屏第二层）。需要用户先开「允许截图」；没开「截图免确认」时必须先征得用户同意、再带 confirm:true 调用；两次截图至少间隔 screenCaptureIntervalMs（默认 30 秒）。' +
      '返回一张临时 PNG 的路径（系统临时目录，只保留最近 10 张），用 read_image 打开它即可看到屏幕内容。',
    parameters: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: '可选，指定实例' },
        confirm: { type: 'boolean', description: '用户已同意这次截图；开了「截图免确认」可省略' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['ok', 'summary'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }] },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? null
      const target = resolveToolTarget(state, { instanceId: args?.instanceId, sessionId })
      if (!target.ok) return fail(target.code, target.message, { available: target.available })
      if (!modeAllows(target.inst, 'screen')) {
        return fail('mode-forbidden', '当前是「手动」模式，AI 不能主动截图。可在设置页或窗口模式菜单切到「AI 半自动 / AI 自动」。')
      }
      const view = instanceView(state, target.inst)
      const shot = await requestScreenCapture(view, { confirmed: args?.confirm === true })
      if (shot.ok !== true) {
        if (shot.needsConfirm) {
          return fail('needs-confirm', '截图需要用户同意：先用气泡问一句「要我看一眼屏幕吗？」，用户同意后再带 confirm:true 调用。')
        }
        if (shot.disabled) {
          return fail('screen-capture-disabled', '截图没开。请让用户在「设置 → Live2D」勾选「允许截图」后再试（截图只落在系统临时目录）。')
        }
        return fail('screen-capture-failed', shot.error ?? '截图失败', { retryAfterMs: shot.retryAfterMs })
      }
      let file = null
      try {
        file = saveCapturePng(shot.base64)
        pruneCaptureDir()
      } catch (error) {
        return fail('capture-save-failed', `截图成功但写临时文件失败：${error?.message ?? error}`)
      }
      return {
        ok: true,
        summary: toolSummary({
          instanceId: target.inst.id,
          path: file,
          width: shot.width,
          height: shot.height,
          bytes: shot.bytes,
          at: shot.at ?? null,
          hint: '用 read_image 打开 path 查看这张截图',
        }),
      }
    },
  }

  const toolMemory = {
    name: 'live2d_memory',
    description:
      '管理当前对话专用的陪伴记忆。记忆按 sessionId 隔离，切换对话不会串用。' +
      'remember=记住用户明确要求保留的信息；search/list=检索；update=修正；' +
      'forget=让它休眠（不会删除，之后用户重新提到时可自动想起）；recall=立刻重新想起；' +
      'forget-old=把长期未更新的活跃记忆转为休眠。不要存储密码、密钥、验证码等敏感凭据。',
    parameters: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: '可选，指定实例（仍只访问该实例当前绑定会话的记忆）' },
        op: { type: 'string', enum: ['remember', 'search', 'list', 'update', 'forget', 'recall', 'forget-old'] },
        id: { type: 'string', description: 'update / forget / recall 使用的记忆 id' },
        text: { type: 'string', description: '记忆正文（最长 500 字）' },
        kind: { type: 'string', enum: MEMORY_KINDS, description: '记忆类型' },
        tags: { type: 'array', items: { type: 'string' }, description: '最多 8 个标签' },
        importance: { type: 'number', description: '重要度 1~5，默认 3' },
        query: { type: 'string', description: 'search 的检索词；用户重新提起休眠记忆时会靠它触发“想起来”' },
        limit: { type: 'number', description: 'search/list 返回条数，默认 8' },
        olderThanDays: { type: 'number', description: 'forget-old：多少天未更新后休眠，默认 90' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['ok', 'summary'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }] },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? null
      const target = resolveToolTarget(state, { instanceId: args?.instanceId, sessionId })
      if (!target.ok) return fail(target.code, target.message, { available: target.available })
      const inst = target.inst
      if (inst.config?.memoryEnabled !== true) {
        return fail('memory-disabled', '这个实例的陪伴记忆未启用。请让用户在「设置 → Live2D → 模式设置」打开。')
      }
      const memorySession = String(inst.config?.sessionId ?? '')
      if (!memorySession) return fail('memory-no-session', '这个实例还没绑定会话，记忆无法确定归属。')
      const op = String(args?.op || '')
      if (op === 'search') {
        return {
          ok: true,
          summary: toolSummary({
            op,
            sessionId: memorySession,
            entries: searchMemories(state, memorySession, String(args?.query ?? ''), Number(args?.limit) || 8),
          }),
        }
      }
      if (op === 'list') {
        const rows = listMemories(state, memorySession)
        return {
          ok: true,
          summary: toolSummary({
            op,
            sessionId: memorySession,
            active: rows.filter((item) => !item.dormant).slice(0, Math.max(1, Math.min(50, Number(args?.limit) || 20))),
            dormant: rows.filter((item) => item.dormant).slice(0, Math.max(1, Math.min(50, Number(args?.limit) || 20))),
          }),
        }
      }
      const result = memoryMutation(state, inst, memorySession, op, args)
      if (!result.ok) return fail(result.code || 'memory-failed', result.error ?? '记忆操作失败')
      return { ok: true, summary: toolSummary({ op, sessionId: memorySession, ...result }) }
    },
  }

  // 只读：AI 不能叫醒自己（用户要求），只能看台账
  const toolWake = {
    name: 'live2d_wake',
    description:
      '查看主动唤醒的当前状态（只读）：是否开启、间隔、上次唤醒时间与结果、滚动 60 分钟额度、待用截图数量。' +
      '注意：这个工具不能触发唤醒，唤醒只能由用户点窗口上的 ⚡ 或定时器发起。',
    parameters: {
      type: 'object',
      properties: { instanceId: { type: 'string', description: '可选，指定实例' } },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['ok', 'summary'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }] },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? null
      const target = resolveToolTarget(state, { instanceId: args?.instanceId, sessionId })
      if (!target.ok) return fail(target.code, target.message, { available: target.available })
      const inst = target.inst
      return {
        ok: true,
        summary: toolSummary({
          instanceId: inst.id,
          mode: inst.config?.mode ?? 'manual',
          wakeDriver: inst.config?.wakeDriver ?? 'off',
          timerEnabled: inst.config?.wakeEnabled === true,
          eventEnabled: inst.config?.eventWakeEnabled === true,
          intervalMs: inst.config?.wakeIntervalMs ?? 30_000,
          captureEnabled: inst.config?.wakeCaptureEnabled === true,
          state: inst.wake?.state ?? 'idle',
          lastAt: inst.wake?.at ?? null,
          lastResult: inst.wake?.lastResult ?? null,
          pendingShots: (inst.wake?.shots ?? []).length,
          quota: wakeQuota(inst),
        }),
      }
    },
  }

  return [toolStatus, toolBubble, toolPerform, toolAnim, toolWindow, toolScreen, toolCapture, toolMemory, toolPreset, toolParams, toolWake]
}

export function registerLive2dTools(ctx, state, log) {
  if (typeof ctx?.tools?.register !== 'function') {
    log?.warn?.('live2d: 宿主没有 tools 服务，AI 工具未注册（HTTP 接口仍可用）')
    return () => {}
  }
  const disposers = []
  for (const tool of createLive2dTools(state, log)) {
    try {
      const dispose = ctx.tools.register(tool)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      log?.warn?.(`live2d: 工具 ${tool.name} 注册失败（已跳过）：${errorText(error)}`)
    }
  }
  return () => disposers.forEach((dispose) => { try { dispose() } catch { /* 忽略 */ } })
}

export function apply(ctx, rawConfig) {
  const log = safeLogger(ctx)

  const state = {
    phase: 'starting',
    // 事件回调（半自动模式等）里要用同一套 logger
    log,
    // session/event 里见过的会话对象（sessions.get 拿不到未激活会话时兜底）
    sessionCache: new Map(),
    config: { ...DEFAULT_CONFIG },
    // 告警按来源分组：config（参数越界）/ model（模型探测）/ runtime（运行期）。
    // 每次重新归一化或重新探测都会**整体替换**对应来源，
    // 这样「路径改对了刷新后旧告警还在」的问题不会出现。
    warningSources: { config: [], model: [], runtime: [] },
    warnings: [],
    // 窗口「此刻」的真实几何（ready / 拖动松手时更新），供设置页「刷新坐标」读
    windowBounds: null,
    // P1 生命感：系统级输入空闲时间（由 Electron 窗口进程回报）
    lifeSystem: { idleSeconds: null, at: 0 },
    // P2 陪伴记忆：独立于主会话与生命状态，按实例分组
    memory: emptyMemoryStore(),
    selfTest: null,
    routesRegistered: false,
    eventSubscription: null,
    // P2 台账：只记本进程内的注入尝试（不落盘）
    p2: { attempts: 0, last: null, verify: null },
    // P5：窗口进程管理器（卸载时一并关掉，避免留下孤儿窗口）
    windows: null,
    // 阶段 1：模型探测 / 渲染状态 / 气泡队列
    model: null,
    renderer: { state: 'stopped', lastError: null, model: null, initQueued: false },
    bubbleCount: 0,
    bubble: { seq: 0, lastIdentity: null, lastAt: 0, lastShown: null },
    // 阶段 2：窗口内对话（pending 只存在进程内，不落盘）
    chat: { pending: null, lastReply: null, lastError: null, history: [], finishTimer: null, timeoutTimer: null },
    recentSessionId: null,
    // 多实例：运行态实例数组（config.instances 的展开，数组第一个 = 默认实例）
    instances: [],
    ctx: null,
    startedAt: new Date().toISOString(),
    disposed: false,
  }

  const cleanups = []
  const registerCleanup = (fn) => { if (typeof fn === 'function') cleanups.push(fn) }

  // 收摊不改写 'failed'：验收时要能从 health 里看到「是加载失败，不是正常卸载」。
  const disposeAll = () => {
    if (state.disposed) return
    state.disposed = true
    if (state.phase !== 'failed') state.phase = 'disposed'
    // 卸载时别把等待回复的定时器留着
    try { clearChatTimers(state) } catch { /* ignore */ }
    for (const fn of cleanups.splice(0)) {
      try { fn() } catch (error) {
        log.warn(`live2d: 清理阶段出错（已忽略）：${errorText(error)}`)
      }
    }
  }

  try {
    state.ctx = ctx
    // 配置文件位置：测试用 ctx.__live2dConfigFile 隔离到临时目录，别动真实配置
    const configFile = (ctx && typeof ctx.__live2dConfigFile === 'string' && ctx.__live2dConfigFile) || CONFIG_FILE
    state.configFile = configFile
    // 配置优先级：默认 < patch(config 里写死的) < config.json（用户在设置页保存的）
    const configWarnings = []
    const file = readConfigFile(configFile)
    if (!file.ok) {
      configWarnings.push(`配置文件读取失败（已用默认值）：${file.error}`)
      log.warn(`live2d: 配置文件读取失败（已用默认值）：${file.error}`)
    }
    const fileData = file.data ? pickPersisted(file.data) : {}
    // P2 存量迁移：已有安装可能已经用了别的记忆插件。只有缺失该字段的旧实例默认关闭，
    // 新建实例/新安装仍使用 DEFAULT_INSTANCE.memoryEnabled=true。
    for (const item of fileData.instances ?? []) {
      if (item && typeof item === 'object' && !Object.prototype.hasOwnProperty.call(item, 'memoryEnabled')) {
        item.memoryEnabled = false
      }
    }
    if (file.exists === true && !Array.isArray(fileData.instances) && !Object.prototype.hasOwnProperty.call(fileData, 'memoryEnabled')) {
      fileData.memoryEnabled = false
    }
    // 安全保险（用户要求）：模式不跨重启保留——上次调成「AI 自动/半自动」，
    // 重新加载插件后要回到默认的「手动」（内部键 auto，不主动说话、不自己动）。
    // 只丢弃「从文件读到的」mode；patch 里写死的仍然生效。
    for (const item of fileData.instances ?? []) {
      if (item && typeof item === 'object') delete item.mode
    }
    const merged = {
      ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}),
      // config.json 只覆盖用户在设置页能调的字段；
      // crashOnLoad / shellSelfTest 这类 patch 开关不受历史配置文件影响。
      ...fileData,
    }
    const normalized = normalizeConfig(merged)
    state.config = normalized.config
    // 多实例：把 config.instances 展开成运行态实例数组（数组第一个 = 默认实例）
    syncInstances(state)
    // 0.3.2：模型档案迁移（实例上的动作/循环 → 按模型共享的档案）
    // 顺序：备份配置 → 计算档案 → 写盘成功 → 才清空实例旧字段（写盘失败就保留双份，绝不先清）
    try {
      const isolated = ctx && typeof ctx.__live2dConfigFile === 'string'
      if (!isolated) {
        const backupFile = `${state.configFile}.bak-model-profiles-${Date.now()}`
        try {
          if (existsSync(state.configFile)) copyFileSync(state.configFile, backupFile)
        } catch (error) {
          log.warn(`live2d: 模型档案迁移前备份失败（继续）：${errorText(error)}`)
        }
        const migration = migrateModelProfiles(state)
        if (migration.changed) {
          const saved = writeConfigFile(state.config, state.configFile ?? CONFIG_FILE)
          if (saved.ok) {
            const cleared = clearLegacyInstancePresets(state)
            if (cleared.length) writeConfigFile(state.config, state.configFile ?? CONFIG_FILE)
            syncInstances(state)
            const report = migration.report ?? {}
            log.warn(
              `live2d: 模型档案迁移完成（新建 ${report.created?.length ?? 0}、合并 ${report.merged?.length ?? 0}、`
              + `冲突 ${report.conflicts?.length ?? 0}、清理实例字段 ${cleared.length}）；备份 ${path.basename(backupFile)}`,
            )
          } else {
            log.warn(`live2d: 模型档案迁移未写盘（实例动作保留，不影响启动）：${saved.error}`)
          }
        }
      }
    } catch (error) {
      log.warn(`live2d: 模型档案迁移异常（不影响启动）：${errorText(error)}`)
    }
    state.memory = loadMemoryStore(state)
    // 0.13.9 一次性迁移：存量 config 里的模式开关默认打开（用户要求「模式设置默认全开」）。
    // 只跑一次并写标记，之后用户在「模式设置」里关掉就保持关闭。
    // 测试会注入 ctx.__live2dConfigFile 隔离配置，那种情况不迁移（否则断言会被默认值污染）。
    try {
      const isolated = ctx && typeof ctx.__live2dConfigFile === 'string'
      const migrated = isolated ? [] : migrateModeSwitches(state, '0.13.13-mode-switches')
      if (migrated.length > 0) {
        writeConfigFile(state.config, state.configFile ?? CONFIG_FILE)
        log.warn(`live2d: 已开启模式所需开关（${migrated.join('、')}），如需关闭请到设置页「模式设置」`)
      }
    } catch (error) {
      log.warn(`live2d: 模式开关迁移失败（不影响启动）：${error && error.message}`)
    }
    setWarningSource(state, 'config', [...configWarnings, ...normalized.warnings])
    for (const warning of normalized.warnings) {
      log.warn(`live2d: ${warning}`)
    }

    if (state.config.crashOnLoad) {
      throw new Error('live2d: crashOnLoad=true（验收模式），本插件故意在 apply 阶段抛错')
    }

    // P5：窗口管理器（创建不启动进程，open 时才 spawn）
    // 测试钩子：ctx.__live2dWindowManager 可注入假管理器（显式 null = 不要窗口），
    // 用 hasOwnProperty 判断，避免测试时落到真 spawn。
    const hasInjectedWindows = Boolean(ctx && Object.prototype.hasOwnProperty.call(ctx, '__live2dWindowManager'))
    state.windows = hasInjectedWindows
      ? ctx.__live2dWindowManager
      : createWindowManager({
          onProtocol: (message) => {
            try {
              // 多实例：先按 instanceId 找到是哪个窗口发来的，再交给那个实例的视图处理
              const inst = message?.instanceId
                ? findInstance(state, message.instanceId)
                : defaultInstance(state)
              const view = inst ? instanceView(state, inst) : state
              // 阶段 2：窗口输入栏发来的消息
              if (message?.type === 'chat') {
                const result = submitChat(ctx, view, log, { text: message.text, sessionId: message.sessionId })
                view.windows?.send?.({
                  type: 'chat-ack',
                  requestId: result.payload?.requestId ?? null,
                  ok: result.payload?.ok === true,
                  error: result.payload?.error ?? null,
                })
                return
              }
              // 置顶切换：写回实例配置并落盘（重开窗口/重启后保持）
              if (message?.type === 'pin' && inst && typeof message.pinned === 'boolean') {
                const result = patchInstance(state, inst.id, { pinned: message.pinned })
                if (result?.ok) {
                  try { writeConfigFile(state.config, state.configFile ?? CONFIG_FILE) } catch (error) {
                    log.warn(`live2d: 保存置顶状态失败：${errorText(error)}`)
                  }
                }
                applyWindowMessage(view, message)
                return
              }
              // 工具栏「移动/调整」开关：同样写回配置，重开窗口后保持上次状态
              if (message?.type === 'adjust-mode' && inst && typeof message.on === 'boolean') {
                const result = patchInstance(state, inst.id, { adjustMode: message.on })
                if (result?.ok) {
                  try { writeConfigFile(state.config, state.configFile ?? CONFIG_FILE) } catch (error) {
                    log.warn(`live2d: 保存调整模式失败：${errorText(error)}`)
                  }
                }
                return
              }
              applyWindowMessage(view, message)
            } catch (error) {
              log.warn(`live2d: 处理窗口协议失败（已忽略）：${errorText(error)}`)
            }
          },
        })
    registerCleanup(() => {
      const closeNow = () => {
        try {
          const closing = state.windows?.close?.()
          if (closing && typeof closing.catch === 'function') closing.catch(() => {})
        } catch { /* 关闭失败不影响卸载 */ }
      }
      const isolated = state.configFile && state.configFile !== CONFIG_FILE
      let saidGoodbye = false
      if (!isolated) {
        for (const inst of state.instances ?? []) {
          const result = sendFarewell(state, inst, 'plugin-unload')
          if (result.ok) saidGoodbye = true
        }
      }
      if (saidGoodbye) {
        const timer = setTimeout(closeNow, 1450)
        if (typeof timer.unref === 'function') timer.unref()
      } else {
        closeNow()
      }
    })

    // 阶段 1：先探测模型（只读）。探测失败不抛错，渲染侧降级成占位。
    for (const inst of state.instances) {
      inst.model = modelProbe(inst.config.modelPath)
      if (!inst.model.ok) {
        log.warn(`live2d: [${inst.id}] 模型探测未通过（${inst.model.reason ?? 'unknown'}）：${inst.model.message ?? inst.model.missing?.join(', ') ?? ''}`)
      }
    }
    state.model = state.instances[0]?.model ?? null
    setWarningSource(state, 'model', state.model?.warnings ?? [])

    // 0B 核心：事件观测（只读）
    const eventLog = createEventLog()
    if (state.config.watchEvents) {
      const offs = subscribeEvents(ctx, state, eventLog)
      if (offs.length > 0) registerCleanup(() => { for (const off of offs) { try { off() } catch { /* ignore */ } } })
    } else {
      state.eventSubscription = { subscribed: 0, names: [] }
    }

    const route = registerRoutes(ctx, state, log, eventLog, state.windows)
    if (route.dispose) registerCleanup(route.dispose)

    // 阶段 4：读屏定时感知（只读前台窗口标题、不截图、不落盘；auto 模式跳过）
    startScreenWatch(state, log, registerCleanup)

    // 阶段 4：自动模式的空闲小动作（眨眼/歪头；用户点模型/摸头由 tap 消息触发）
    startPresetLoop(state, log, registerCleanup)

    // 0.13.0：主动唤醒调度器（定时叫醒；与按钮唤醒共用滚动额度）
    startWakeLoop(state, log, registerCleanup)

    // P1：宿主侧陪伴行为（定时机制保留，事件驱动可独立开关）
    startLifeLoop(state, log, registerCleanup)

    state.phase = 'ready'
    log.info(`live2d: ${STAGE} v${VERSION} 已加载，webServer=${state.routesRegistered}，事件订阅=${state.eventSubscription?.subscribed ?? 0}`)

    // 阶段 1：自动开窗（延迟 800ms，避开宿主启动高峰；失败只记状态不抛错）
    if (state.config.enabled) {
      const timer = setTimeout(() => {
        if (state.disposed) return
        for (const inst of state.instances) {
          // 自动开窗按实例生效（每个实例可以单独关掉）
          if (inst.config.enabled === false) continue
          if (inst.config.autoOpenWindow === false) continue
          try {
            const opened = openInstanceWindow(state, inst.id)
            if (!opened?.ok) {
              inst.window.state = 'stopped'
              inst.window.error = opened?.error ?? 'unknown'
              pushRuntimeWarning(state, `[${inst.id}] 自动开窗失败（已降级，可用 POST /live2d/window 手动开）：${opened?.error ?? 'unknown'}`)
            }
          } catch (error) {
            log.warn(`live2d: [${inst.id}] 自动开窗失败（已忽略）：${errorText(error)}`)
          }
        }
      }, 800)
      if (typeof timer?.unref === 'function') timer.unref()
      registerCleanup(() => clearTimeout(timer))
    }

    if (state.config.shellSelfTest) {
      const timer = setTimeout(() => {
        if (state.disposed) return
        try {
          withTimeout(runSelfTest(ctx, state), state.config.selfTestTimeoutMs, '自检')
            .then((result) => {
              if (state.disposed) return
              if (result.ok) log.info('live2d: 自检通过')
              else log.warn(`live2d: 自检未全部通过：${result.checks.filter((c) => !c.ok).map((c) => c.id).join(', ')}`)
            })
            .catch((error) => {
              if (state.disposed) return
              state.phase = 'degraded'
              state.selfTest = { ok: false, at: new Date().toISOString(), error: errorText(error) }
              pushRuntimeWarning(state, `自检失败（已降级，不影响 DSH）：${errorText(error)}`)
              log.warn(`live2d: 自检失败（已降级）：${errorText(error)}`)
            })
        } catch (error) {
          state.phase = 'degraded'
          log.warn(`live2d: 自检启动失败（已降级）：${errorText(error)}`)
        }
      }, 0)
      if (typeof timer?.unref === 'function') timer.unref()
      registerCleanup(() => clearTimeout(timer))
    }

    // AI 工具：注册失败只告警，不影响插件其它功能（审查 P0-1）
    try {
      const disposeTools = registerLive2dTools(ctx, state, log)
      registerCleanup(() => disposeTools())
      state.toolsRegistered = createLive2dTools(state, log).length
    } catch (error) {
      pushRuntimeWarning(state, `工具注册失败（已跳过）：${errorText(error)}`)
      log.warn(`live2d: 工具注册失败（已跳过）：${errorText(error)}`)
    }

    if (typeof ctx.effect === 'function') {
      ctx.effect(() => disposeAll, 'live2d: 卸载收摊')
    }
  } catch (error) {
    state.phase = 'failed'
    const message = errorText(error)
    pushRuntimeWarning(state, `加载失败：${message}`)
    log.error(`live2d: 加载失败（已隔离，不影响 DSH）：${message}`)
    disposeAll()
  }

  return state
}

export default { name, inject, apply }

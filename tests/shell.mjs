// 阶段 0D 的本地自测（不装 DSH，纯 mock ctx；窗口管理器用假 spawn，不真弹窗）
// 跑法：node tests/shell.mjs
//
// 覆盖：inject 声明、服务获取、P1 会话读取、P3 事件订阅与计数、P2 注入
//       （预演/真发/拒绝兜底/参数校验）、P5 窗口（open/close/status/缺运行时）、
//       越界回落、crashOnLoad 隔离、webServer 降级、卸载收摊。

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  apply, inject, VERSION, STAGE, createWindowManager, resolveElectronExe,
  modelProbe, cleanBubbleText, displayBubbleText, ttsText, readConfigFile, writeConfigFile,
  windowConfigPayload, initPayload, applyWindowMessage, setWarningSource,
  instanceView, validateInstances, normalizeModelKey, scanModels, normalizeConfig,
  findLatestAssistantText, titleFromProjCache, collectSessionsForPicker,
  autoPushReply, autoThinking, MODES, resolveChatTarget, handleAnim,
  submitChat, flushChatQueue, pushIdleReplies,
  parseForegroundOutput, getForegroundTitle, screenWatchTick,
  parseCaptureOutput, requestScreenCapture, synthesizeSpeech, wavDurationMs,
  resolveToolTarget, createLive2dTools, registerLive2dTools, handlePresetTap, startPresetLoop,
  saveCapturePng, pruneCaptureDir,
  normalizeCustomActions, normalizePresetSequences, buildPresets, playPreset, startPresetSequence, stopPresetSequence,
  normalizeModelRoots, DEFAULT_CONFIG, DEFAULT_INSTANCE,
  canControl, wakeQuota, wakePlan, buildWakeMessage, requestWake, WAKE_HISTORY_MS, designAction, claimReply, replyKeyOf, pickPersisted,
  deactivateInstance,
} from '../index.js'

let failed = 0
let configSeq = 0
function check(label, condition, detail = '') {
  const ok = Boolean(condition)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}

const unhandled = []
process.on('unhandledRejection', (reason) => { unhandled.push(String(reason)) })

function makeCtx({ withWebServer = true, brokenWebServer = false, withServices = true, rejectFollowup = false, windowManager = null } = {}) {
  const routes = []
  const logs = []
  const cleanups = []
  const listeners = new Map()
  const injected = []

  const webServer = withWebServer
    ? brokenWebServer
      ? {}
      : {
          register({ kind, path, handler }) {
            const entry = { kind, path, handler }
            routes.push(entry)
            return () => {
              const index = routes.indexOf(entry)
              if (index >= 0) routes.splice(index, 1)
            }
          },
        }
    : undefined

  const sessionState = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: '你好，我是测试消息' }] },
      { role: 'assistant', content: '收到' },
    ],
  }

  const sessionsStub = {
    list: () => [{ id: 's1' }, { id: 's2' }],
    get: (id) => ({
      id,
      seq: 42,
      deriveMessages: () => sessionState.messages,
    }),
  }
  const sessionTitleStub = { get: () => ({ title: '测试会话' }) }

  const agent = {
    id: 'agent-s1',
    status: 'idle',
    session: { id: 's1' },
    followup(message) {
      injected.push({ mode: 'followup', message })
      if (rejectFollowup) return Promise.reject(new Error('模拟 followup 被拒（队列满）'))
      sessionState.messages.push(message)
      return Promise.resolve()
    },
    steer(message) { injected.push({ mode: 'steer', message }); return Promise.resolve() },
    inject(message) { injected.push({ mode: 'inject', message }); return Promise.resolve() },
    cancel() {},
    whenIdle() { return Promise.resolve() },
  }
  const agentsStub = { list: () => [agent], get: (id) => (id === 'agent-s1' ? agent : undefined) }

  const ctx = {
    webServer,
    sessions: withServices ? sessionsStub : undefined,
    agents: withServices ? agentsStub : undefined,
    sessionTitle: withServices ? sessionTitleStub : undefined,
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    _routes: routes,
    _logs: logs,
    _cleanups: cleanups,
    _listeners: listeners,
    _injected: injected,
    _sessionState: sessionState,
    __live2dWindowManager: windowManager,
    // 每个 ctx 一份独立配置路径，避免测试读写真实 %USERPROFILE%\.dsh\dsh-live2d\config.json。
    // 带随机后缀：PID 会被系统复用，残留的旧测试文件会让「默认只有 1 个实例」这类用例间歇失败。
    __live2dConfigFile: path.join(
      os.tmpdir(),
      `live2d-test-${process.pid}-${Date.now().toString(36)}-${(configSeq += 1)}-${Math.random().toString(36).slice(2, 8)}.json`,
    ),
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'sessions') return withServices ? sessionsStub : undefined
      if (name === 'agents') return withServices ? agentsStub : undefined
      if (name === 'sessionTitle') return withServices ? sessionTitleStub : undefined
      return undefined
    },
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
      return () => {
        const list = listeners.get(name) ?? []
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    emitForTest(name, ...args) {
      for (const handler of listeners.get(name) ?? []) handler(...args)
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') cleanups.push(disposer)
    },
  }
  return ctx
}

function fakeReq(path, method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key] = value },
    end(chunk) { this.body += chunk ?? '' },
  }
}

async function callRoute(ctx, path, { method = 'GET', body } = {}) {
  const route = ctx._routes.find((item) => item.kind === 'prefix' && item.path === '/live2d')
  if (!route) return null
  const res = fakeRes()
  await route.handler(fakeReq(path, method, body), res)
  return res
}

const get = (ctx, path) => callRoute(ctx, path)
const post = (ctx, path, body) => callRoute(ctx, path, { method: 'POST', body })
const del_ = (ctx, path) => callRoute(ctx, path, { method: 'DELETE' })

check('inject 声明了五个服务', JSON.stringify(inject) === JSON.stringify(['webServer', 'sessions', 'agents', 'sessionTitle', 'tools']), JSON.stringify(inject))
check('版本/阶段已升级', VERSION === '0.1.0' && STAGE === '5-wake', `${VERSION} / ${STAGE}`)

// --- 1. 正常加载 + P1 + P3 ------------------------------------------------
{
  const ctx = makeCtx()
  const state = apply(ctx, undefined)
  check('正常加载 → phase=ready', state.phase === 'ready', state.phase)
  check('正常加载 → 路由已注册', state.routesRegistered === true)
  check('正常加载 → 无告警', state.warnings.length === 0, JSON.stringify(state.warnings))
  check('订阅了 3 类事件', state.eventSubscription?.subscribed === 3, JSON.stringify(state.eventSubscription))
  check('P2 台账初始为空', state.p2?.attempts === 0, JSON.stringify(state.p2))

  const health = await get(ctx, '/live2d/health')
  const payload = JSON.parse(health.body)
  check('GET /live2d/health → 200 JSON', health.statusCode === 200 && payload.ok === true)
  check('health 带 inject/阶段', payload.stage === '5-wake' && Array.isArray(payload.inject) && payload.inject.length === 5)

  const diagRes = await get(ctx, '/live2d/diag')
  const diag = JSON.parse(diagRes.body)
  check('GET /live2d/diag → 200', diagRes.statusCode === 200 && diag.ok === true)
  check('P1：sessions.list() 拿到会话', diag.p1?.ok === true && diag.p1.count === 2, String(diag.p1?.count))
  check('P1：deriveMessages 拿到消息', diag.p1.sessions[0]?.messageCount === 2 && diag.p1.sessions[0]?.lastRole === 'assistant', JSON.stringify(diag.p1.sessions[0]))
  check('P1：标题可用', diag.p1.sessions[0]?.title === '测试会话', String(diag.p1.sessions[0]?.title))
  check('P1：统计 live2d 来源消息', diag.p1.sessions[0]?.live2dMessages === 0, String(diag.p1.sessions[0]?.live2dMessages))
  check('P3：订阅信息在 diag 里', diag.p3?.subscription?.subscribed === 3)
  check('服务探测记录了两条途径', diag.services?.sessions?.['ctx.<name>'] === true && diag.services?.sessions?.['ctx.get(name)'] === true, JSON.stringify(diag.services?.sessions))

  ctx.emitForTest('agent/status', { status: 'running' })
  ctx.emitForTest('agent/assistant-stream', { frame: { kind: 'start', index: 0, turn: 1 } })
  ctx.emitForTest('agent/assistant-stream', { frame: { index: 1, text: '片段' } })
  ctx.emitForTest('agent/assistant-stream', { frame: { kind: 'end', index: 2 } })
  ctx.emitForTest('session/event', { id: 's1' }, { type: 'assistant/message' })

  const diag2 = JSON.parse((await get(ctx, '/live2d/diag')).body)
  check('P3：agent/status 计数', diag2.p3.counters['agent/status'] === 1, JSON.stringify(diag2.p3.counters))
  check('P3：assistant-stream 计数', diag2.p3.counters['agent/assistant-stream'] === 3, JSON.stringify(diag2.p3.counters))
  check('P3：session/event 计数', diag2.p3.counters['session/event'] === 1)
  const endFrame = diag2.p3.recent.filter((item) => item.kind === 'agent/assistant-stream').at(-1)
  check('P3：end 帧带 kind', endFrame?.detail?.kind === 'end', JSON.stringify(endFrame))

  const panel = await get(ctx, '/live2d/panel')
  check('GET /live2d/panel → 200 HTML', panel.statusCode === 200 && panel.body.includes('5-wake'))

  const missing = await get(ctx, '/live2d/nope')
  check('未知路径 → 404', missing.statusCode === 404)

  const getInject = await get(ctx, '/live2d/inject')
  check('GET /live2d/inject → 405', getInject.statusCode === 405)

  await new Promise((resolve) => setTimeout(resolve, 80))
  check('自检通过（服务齐、事件齐）', state.selfTest?.ok === true, JSON.stringify(state.selfTest?.checks?.map((c) => [c.id, c.ok])))
}

// --- 2. P2 参数校验 --------------------------------------------------------
{
  const ctx = makeCtx()
  const state = apply(ctx, {})
  const noSession = await post(ctx, '/live2d/inject', { text: '你好' })
  check('P2 缺 sessionId → 400', noSession.statusCode === 400, noSession.body)
  const noText = await post(ctx, '/live2d/inject', { sessionId: 's1', text: '   ' })
  check('P2 空 text → 400', noText.statusCode === 400, noText.body)
  const badJson = await post(ctx, '/live2d/inject', undefined)
  check('P2 空 body → 400', badJson.statusCode === 400, badJson.body)
  check('P2 校验失败不计数', state.p2.attempts === 0, String(state.p2.attempts))
  check('P2 校验失败未注入', ctx._injected.length === 0)
}

// --- 3. P2 预演（默认 dryRun） --------------------------------------------
{
  const ctx = makeCtx()
  const state = apply(ctx, {})
  const res = await post(ctx, '/live2d/inject', { sessionId: 's1', text: '预演消息' })
  const payload = JSON.parse(res.body)
  check('P2 预演 → 200', res.statusCode === 200, res.body)
  check('P2 预演 → dryRun=true / 未发送', payload.dryRun === true && payload.dispatched === false)
  check('P2 预演 → 真的没调 agent', ctx._injected.length === 0)
  check('P2 预演 → 解析到 agent', payload.agent?.sessionId === 's1' && payload.agent?.methods?.followup === true, JSON.stringify(payload.agent))
  check('P2 预演 → 消息结构合法', payload.message?.role === 'user' && payload.message?.content?.[0]?.text === '预演消息' && payload.message?.source?.kind === 'live2d', JSON.stringify(payload.message))
  check('P2 预演 → 消息 id 带前缀', String(payload.message?.id).startsWith('live2d-'), String(payload.message?.id))
  check('P2 预演 → 记了台账', state.p2.attempts === 1 && state.p2.last?.dryRun === true)
  check('P2 预演 → 会话没变', ctx._sessionState.messages.length === 2)
}

// --- 4. P2 真发 + 读回验证 ------------------------------------------------
{
  const ctx = makeCtx()
  const state = apply(ctx, {})
  const res = await post(ctx, '/live2d/inject', { sessionId: 's1', text: '这是一条来自 Live2D 的注入测试消息', dryRun: false })
  const payload = JSON.parse(res.body)
  check('P2 真发 → 200 dispatched', res.statusCode === 200 && payload.dispatched === true, res.body)
  check('P2 真发 → 调用了 followup', ctx._injected.length === 1 && ctx._injected[0].mode === 'followup')
  check('P2 真发 → 消息进会话', ctx._sessionState.messages.length === 3 && ctx._sessionState.messages[2].source.kind === 'live2d')

  await new Promise((resolve) => setTimeout(resolve, 1400))
  check('P2 读回验证 → found', state.p2.verify?.found === true, JSON.stringify(state.p2.verify))
  check('P2 读回验证 → sourceKind=live2d', state.p2.verify?.sourceKind === 'live2d', JSON.stringify(state.p2.verify))
  const diag = JSON.parse((await get(ctx, '/live2d/diag')).body)
  check('P2 → diag 里能看到台账', diag.p2?.attempts === 1 && diag.p2?.verify?.found === true)
  check('P2 → p1 统计 live2d 消息数', diag.p1.sessions[0]?.live2dMessages === 1, String(diag.p1.sessions[0]?.live2dMessages))
  check('P2 → p1 lastSource', diag.p1.sessions[0]?.lastSource === 'live2d', String(diag.p1.sessions[0]?.lastSource))
}

// --- 5. P2 rejection 必须被兜住（宿主进程生死线） --------------------------
{
  const ctx = makeCtx({ rejectFollowup: true })
  const state = apply(ctx, {})
  const res = await post(ctx, '/live2d/inject', { sessionId: 's1', text: '会被拒绝的消息', dryRun: false })
  check('P2 被拒 → 响应仍是 200（不炸请求）', res.statusCode === 200, res.body)
  await new Promise((resolve) => setTimeout(resolve, 120))
  check('P2 被拒 → settled.ok=false', state.p2.last?.settled?.ok === false, JSON.stringify(state.p2.last?.settled))
  check('P2 被拒 → 告警留痕', state.warnings.some((w) => w.includes('已兜住')), JSON.stringify(state.warnings))
  check('P2 被拒 → 无 unhandled rejection', unhandled.length === 0, JSON.stringify(unhandled))
  check('P2 被拒 → 插件仍 ready', state.phase === 'ready', state.phase)
}

// --- 6. P2 找不到 agent / 非法 mode ---------------------------------------
{
  const ctx = makeCtx()
  apply(ctx, {})
  const notFound = await post(ctx, '/live2d/inject', { sessionId: 'nope', text: '你好' })
  check('P2 找不到 agent → 404', notFound.statusCode === 404, notFound.body)

  const badMode = await post(ctx, '/live2d/inject', { sessionId: 's1', text: '你好', mode: 'teleport' })
  const payload = JSON.parse(badMode.body)
  check('P2 非法 mode → 回落 followup + 告警', payload.mode === 'followup' && payload.warnings.some((w) => w.includes('回落')), JSON.stringify(payload.warnings))
}

// --- 7. 服务缺失：只降级 ---------------------------------------------------
{
  const ctx = makeCtx({ withServices: false })
  const state = apply(ctx, {})
  check('缺 sessions/agents → 仍 ready', state.phase === 'ready', state.phase)
  await new Promise((resolve) => setTimeout(resolve, 80))
  check('缺服务 → 自检 degraded', state.phase === 'degraded', state.phase)
  const diag = JSON.parse((await get(ctx, '/live2d/diag')).body)
  check('缺服务 → P1 明确报错', diag.p1?.ok === false && String(diag.p1.error).includes('sessions'), String(diag.p1?.error))
  const injectRes = await post(ctx, '/live2d/inject', { sessionId: 's1', text: '你好' })
  check('缺 agents → P2 明确 404', injectRes.statusCode === 404, injectRes.body)
}

// --- 8. 参数越界回落 -------------------------------------------------------
{
  const ctx = makeCtx()
  const state = apply(ctx, { diagSessionLimit: 99, selfTestTimeoutMs: 'abc' })
  check('diagSessionLimit 越界 → 回落 8', state.config.diagSessionLimit === 8, String(state.config.diagSessionLimit))
  check('selfTestTimeoutMs 非数值 → 回落 3000', state.config.selfTestTimeoutMs === 3000)
  check('越界产生两条告警', state.warnings.filter((w) => w.includes('回落')).length === 2, JSON.stringify(state.warnings))
}

// --- 9. crashOnLoad --------------------------------------------------------
{
  const ctx = makeCtx()
  let threw = null
  let state = null
  try { state = apply(ctx, { crashOnLoad: true }) } catch (error) { threw = error }
  check('crashOnLoad 不向外抛', threw === null, threw ? String(threw.message) : '')
  check('crashOnLoad → phase=failed', state?.phase === 'failed', state?.phase)
  check('crashOnLoad → 未挂路由', state?.routesRegistered === false)
}

// --- 10. webServer 不可用 --------------------------------------------------
{
  const ctx = makeCtx({ brokenWebServer: true })
  const state = apply(ctx, {})
  check('webServer 不可用 → 仍 ready', state.phase === 'ready', state.phase)
  check('webServer 不可用 → 路由未挂载', state.routesRegistered === false)
  check('webServer 不可用 → 记告警', state.warnings.some((w) => w.includes('webServer')))
}

// --- 11. 卸载收摊 ----------------------------------------------------------
{
  const ctx = makeCtx()
  const state = apply(ctx, {})
  check('ctx.effect 被托管', ctx._cleanups.length === 1)
  ctx._cleanups[0]()
  check('卸载后 phase=disposed', state.phase === 'disposed', state.phase)
  check('卸载后路由已移除', ctx._routes.length === 0, String(ctx._routes.length))
  check('卸载后事件已注销', [...ctx._listeners.values()].every((list) => list.length === 0), JSON.stringify([...ctx._listeners.keys()].map((k) => [k, ctx._listeners.get(k).length])))
  let threw = null
  try { ctx._cleanups[0]() } catch (error) { threw = error }
  check('重复卸载安全', threw === null, threw ? String(threw.message) : '')
}

// --- 12. 服务解析抛错也不炸 ------------------------------------------------
{
  const ctx = makeCtx()
  ctx.get = () => { throw new Error('服务解析炸了') }
  let threw = null
  let state = null
  try { state = apply(ctx, {}) } catch (error) { threw = error }
  check('ctx.get 抛错 → apply 不炸', threw === null, threw ? String(threw.message) : '')
  check('ctx.get 抛错 → 仍靠 ctx.<name> 挂上路由', state?.routesRegistered === true)
  const diag = JSON.parse((await get(ctx, '/live2d/diag')).body)
  check('ctx.get 抛错 → 仍能读会话', diag.p1?.ok === true, JSON.stringify(diag.p1?.error))
  const res = await post(ctx, '/live2d/inject', { sessionId: 's1', text: '你好' })
  check('ctx.get 抛错 → P2 仍能预演', res.statusCode === 200, res.body)
}

// --- 13. P5 窗口：路由层（假管理器，不真弹窗） ----------------------------
{
  const calls = { open: 0, close: 0, send: [] }
  const fakeManager = {
    open: () => { calls.open += 1; return { ok: true, started: true, pid: 4242 } },
    close: async () => { calls.close += 1; return { ok: true, killedPid: 4242 } },
    send: (command, instanceId) => { calls.send.push({ command, instanceId }); return { ok: true, queued: false } },
    status: () => ({ running: false, pid: null, startedAt: null, lastExit: null, lastError: null, logTail: [] }),
  }
  const ctx = makeCtx({ windowManager: fakeManager })
  const state = apply(ctx, {})
  const view = instanceView(state, state.instances[0])
  check('P5 用注入的管理器', state.windows === fakeManager)
  check('实例默认取数组第一个', state.instances[0].id === 'inst-1' && view.id === 'inst-1')

  const getStatus = await get(ctx, '/live2d/window')
  check('GET /live2d/window → 200', getStatus.statusCode === 200 && JSON.parse(getStatus.body).ok === true)

  // 「刷新坐标」的数据源：ready/拖动后记下的窗口真实几何
  applyWindowMessage(view, { type: 'ready', pid: 1, bounds: { x: 100, y: 200, width: 360, height: 480 } })
  const withBounds = JSON.parse((await get(ctx, '/live2d/window')).body)
  check('GET /live2d/window 带 bounds', withBounds.bounds?.width === 360 && withBounds.bounds?.x === 100, JSON.stringify(withBounds.bounds))

  const opened = await post(ctx, '/live2d/window', { action: 'open' })
  check('POST window open → started', opened.statusCode === 200 && JSON.parse(opened.body).started === true, opened.body)
  check('P5 open 被调用', calls.open === 1)
  check('P5 下发 pool:create（带 instanceId）', calls.send.some((item) => item.command.type === 'pool:create' && item.instanceId === 'inst-1'), JSON.stringify(calls.send.map((item) => item.command.type)))

  const closed = await post(ctx, '/live2d/window', { action: 'close' })
  check('POST window close → 下发 pool:close', closed.statusCode === 200 && JSON.parse(closed.body).ok === true, closed.body)
  check('P5 close 下发到该实例', calls.send.some((item) => item.command.type === 'pool:close' && item.instanceId === 'inst-1'))

  const badAction = await post(ctx, '/live2d/window', { action: 'boom' })
  check('POST window 非法 action → 400', badAction.statusCode === 400, badAction.body)

  const diag = JSON.parse((await get(ctx, '/live2d/diag')).body)
  check('diag 带 window 段', diag.window && typeof diag.window.running === 'boolean', JSON.stringify(diag.window))

  // 卸载时应该顺手关窗口（避免孤儿进程）
  ctx._cleanups[0]()
  check('卸载时关闭窗口', calls.close === 1, String(calls.close))
}

// --- 14. P5 窗口：进程管理（假 spawn） ------------------------------------
{
  const spawned = []
  const children = []
  const makeChild = () => {
    const child = new EventEmitter()
    child.pid = 5151
    child.killed = false
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdout.setEncoding = () => {}
    child.stderr.setEncoding = () => {}
    return child
  }
  const spawnImpl = (command, args) => {
    spawned.push({ command, args })
    const child = makeChild()
    children.push(child)
    if (command === 'taskkill') {
      setImmediate(() => child.emit('exit', 0, null))
    }
    return child
  }
  const manager = createWindowManager({ spawnImpl, existsImpl: () => true, platform: 'win32' })

  const opened = manager.open()
  check('P5 真 spawn → started', opened.ok === true && opened.started === true && opened.pid === 5151, JSON.stringify(opened))
  // 参数顺序固定为 ['--no-sandbox', main.cjs]：--no-sandbox 是本机 electron 能起来的硬前提
  check('P5 spawn 的是 electron.exe + --no-sandbox + main.cjs', spawned.length === 1 && spawned[0].args[0] === '--no-sandbox' && spawned[0].args[1].endsWith('main.cjs'), JSON.stringify(spawned[0]))

  const again = manager.open()
  check('P5 重复 open → alreadyRunning', again.alreadyRunning === true)

  // 模拟 Electron 打出 ready 行：status 里应该能看到
  children[0].stdout.emit('data', '[live2d-window] ready pid=5151 alwaysOnTop=true visible=true\n')
  const lines = manager.status().logTail.map((item) => item.line)
  check('P5 收集子进程 stdout', lines.some((line) => line.includes('ready pid=5151')), JSON.stringify(lines))

  // close 走 taskkill
  await manager.close()
  const killCall = spawned.find((item) => item.command === 'taskkill')
  check('P5 close 调 taskkill /pid /t /f', Boolean(killCall) && killCall.args.includes('/f'), JSON.stringify(killCall))

  // 进程退出事件 → 状态回到未运行
  const third = createWindowManager({ spawnImpl, existsImpl: () => true, platform: 'win32' })
  third.open()
  const thirdChild = children[children.length - 1]
  check('P5 状态 running=true', third.status().running === true)
  thirdChild.emit('exit', 3, null)
  check('P5 退出后 running=false 且记 lastExit', third.status().running === false && third.status().lastExit?.code === 3, JSON.stringify(third.status()))

  // 找不到 electron → 明确报错，不静默下载
  const missing = createWindowManager({ spawnImpl, existsImpl: () => false, platform: 'win32' })
  const failed = missing.open()
  check('P5 缺 electron → ok:false + hint', failed.ok === false && String(failed.hint).includes('只复用'), JSON.stringify(failed))

  const resolved = resolveElectronExe(() => false)
  check('P5 resolveElectronExe 找不到 → 给出试过的路径', resolved.ok === false && resolved.tried.length > 0, JSON.stringify(resolved.tried))
}
// --- 15. 阶段 1：配置持久化 / 模型探测 / 气泡文本 / 窗口协议 ----------------
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live2d-test-'))
  const configFile = path.join(tmpDir, 'config.json')

  // 配置写读往返
  const saved = writeConfigFile({ modelPath: 'D:\\x', windowWidth: 360, bubbleQueueLimit: 4 }, configFile)
  check('配置原子写成功', saved.ok === true && fs.existsSync(configFile), JSON.stringify(saved))
  const readBack = readConfigFile(configFile)
  check('配置读回一致', readBack.ok === true && readBack.data.windowWidth === 360 && readBack.data.bubbleQueueLimit === 4, JSON.stringify(readBack.data))
  const missingFile = readConfigFile(path.join(tmpDir, 'nope.json'))
  check('配置不存在 → 空对象不抛错', missingFile.ok === true && Object.keys(missingFile.data).length === 0, JSON.stringify(missingFile))
  const brokenFile = path.join(tmpDir, 'broken.json')
  fs.writeFileSync(brokenFile, '{ not json')
  check('配置坏 JSON → ok:false 带 error', readConfigFile(brokenFile).ok === false, String(readConfigFile(brokenFile).error).slice(0, 80))

  // 模型探测（用临时 fixture，不依赖本机真实模型）
  const fixtureDir = path.join(tmpDir, 'model-fixture')
  fs.mkdirSync(fixtureDir, { recursive: true })
  fs.writeFileSync(path.join(fixtureDir, 'test.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: { Moc: 'test.moc3', Textures: ['tex.png'], Physics: 'test.physics3.json' },
  }))
  fs.writeFileSync(path.join(fixtureDir, 'test.moc3'), 'MOC3')
  fs.writeFileSync(path.join(fixtureDir, 'tex.png'), 'PNG')
  fs.writeFileSync(path.join(fixtureDir, 'test.physics3.json'), '{}')
  const realModel = modelProbe(fixtureDir)
  check('真实模型探测通过', realModel.ok === true && realModel.format === 'cubism4' && realModel.entryFile === 'test.model3.json', JSON.stringify({ ok: realModel.ok, entryFile: realModel.entryFile, missing: realModel.missing }))
  const noDir = modelProbe(path.join(tmpDir, 'no-such-dir'))
  check('模型目录不存在 → missing-dir', noDir.ok === false && noDir.reason === 'missing-dir', JSON.stringify(noDir.reason))
  const cubism2Dir = path.join(tmpDir, 'c2')
  fs.mkdirSync(cubism2Dir)
  fs.writeFileSync(path.join(cubism2Dir, 'm.model.json'), '{}')
  check('只有 model.json → cubism2-only', modelProbe(cubism2Dir).reason === 'cubism2-only')

  // 气泡文本清洗
  check('去代码围栏', cleanBubbleText('看这个：\n```js\nconst a = 1\n```\n好', 120) === '看这个： 好'.replace(/\s+/g, ' ') || !cleanBubbleText('```js\nx\n```', 120).includes('```'), JSON.stringify(cleanBubbleText('```js\nconst a = 1\n```', 120)))
  check('去 markdown 强调与链接', !cleanBubbleText('**粗** [链接](https://x.y) ![图](a.png)', 120).includes('http'), JSON.stringify(cleanBubbleText('**粗** [链接](https://x.y) ![图](a.png)', 120)))

  // 思考链不能当回复：assistant 消息里 reasoning 与 text 并存时只取 text
  const reasoningSession = {
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: '问题' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: '我先想想…' }, { type: 'text', text: '这是真正的回答' }] },
    ],
  }
  const picked = findLatestAssistantText(reasoningSession)
  check('assistant 只取 text 块（不把 reasoning 当回复）', picked.ok === true && picked.text === '这是真正的回答', JSON.stringify(picked.text))
  const reasoningOnly = findLatestAssistantText({ deriveMessages: () => [{ role: 'assistant', content: [{ type: 'reasoning', text: '只有思考' }] }] })
  check('只有 reasoning 的消息不算回复', reasoningOnly.ok === false, JSON.stringify(reasoningOnly))
  const long = cleanBubbleText('字'.repeat(200), 40)
  check('超长截断到 maxChars 以内并加 …', long.length <= 41 && long.endsWith('…'), `${long.length}`)
  // 显示链 vs TTS 链分离
  const md = '# 标题\n\n第一段 **重点** 和 `代码`。\n\n- 甲\n- 乙\n\n```\nconst a = 1\n```\n\n> 引用'
  const shown = displayBubbleText(md, 2000)
  check('displayBubbleText 保留标题/列表/代码块结构', shown.includes('# 标题') && shown.includes('- 甲') && shown.includes('```'), shown.slice(0, 40))
  check('displayBubbleText 转义原始 HTML', !displayBubbleText('<script>alert(1)</script>', 2000).includes('<script>'))
  const spoken = ttsText(md, 500)
  check('ttsText 去掉标记并跳过代码块', !spoken.includes('#') && !spoken.includes('**') && !spoken.includes('const a'), spoken.replace(/\n/g, '|'))
  check('ttsText 保留段落停顿', spoken.includes('\n') && spoken.startsWith('标题'), JSON.stringify(spoken.slice(0, 12)))

  // 窗口配置与 init 载荷
  const config = { modelPath: 'D:\\m', windowWidth: 320, windowHeight: 420, windowX: null, windowY: null, bubbleDurationMs: 5000, bubbleQueueLimit: 3, bubbleMaxChars: 120, rendererEnabled: true, clickThrough: true }
  const payload = windowConfigPayload(config)
  check('windowConfigPayload 字段完整', payload.bubbleDurationMs === 5000 && payload.clickThrough === true && payload.windowWidth === 320, JSON.stringify(payload))
  // 模型缩放：默认 100% / fit，非法值回落并告警
  const scaleDefault = normalizeConfig({ instances: [{}] }).config
  check('模型缩放默认 100% / fit', scaleDefault.instances[0].modelScalePct === 100 && scaleDefault.instances[0].modelLayoutMode === 'fit', JSON.stringify({ pct: scaleDefault.instances[0].modelScalePct, mode: scaleDefault.instances[0].modelLayoutMode }))
  const scaleBad = normalizeConfig({ instances: [{ modelScalePct: 300, modelLayoutMode: 'weird' }] })
  check('缩放越界 300 → 回落 100 并告警', scaleBad.config.instances[0].modelScalePct === 100 && scaleBad.warnings.some((w) => w.includes('modelScalePct')), JSON.stringify(scaleBad.warnings))
  check('布局模式非法 → 回落 fit 并告警', scaleBad.config.instances[0].modelLayoutMode === 'fit' && scaleBad.warnings.some((w) => w.includes('modelLayoutMode')), JSON.stringify(scaleBad.config.instances[0].modelLayoutMode))
  const scaleLow = normalizeConfig({ instances: [{ modelScalePct: 20 }] })
  check('缩放 20 越界 → 回落 100 并告警', scaleLow.config.instances[0].modelScalePct === 100 && scaleLow.warnings.some((w) => w.includes('modelScalePct')), String(scaleLow.config.instances[0].modelScalePct))
  const scalePayload = windowConfigPayload({ ...config, modelScalePct: 150, modelLayoutMode: 'zoom-overlay' })
  check('windowConfigPayload 带模型缩放', scalePayload.modelScalePct === 150 && scalePayload.modelLayoutMode === 'zoom-overlay', JSON.stringify(scalePayload))

  const ratioDefault = normalizeConfig({ instances: [{}] }).config
  check(
    '气泡高度按模型比例默认 50%',
    ratioDefault.instances[0].replyHeightRatio === 50,
    JSON.stringify(ratioDefault.instances[0].replyHeightRatio),
  )
  const ratioBad = normalizeConfig({ instances: [{ replyHeightRatio: 300 }] })
  check(
    '气泡比例越界 → 回落 50 并告警',
    ratioBad.config.instances[0].replyHeightRatio === 50 && ratioBad.warnings.some((w) => w.includes('replyHeightRatio')),
    JSON.stringify(ratioBad.warnings),
  )
  const ratioPayload = windowConfigPayload({ ...config, replyHeightRatio: 80 })
  check('windowConfigPayload 带气泡比例', ratioPayload.replyHeightRatio === 80, String(ratioPayload.replyHeightRatio))

  // 固定气泡大小：默认关 + 200px；越界回落并告警；payload 透传
  const fixedDefault = normalizeConfig({ instances: [{}] })
  check(
    '固定气泡默认关、200px',
    fixedDefault.config.instances[0].bubbleFixedSize === false && fixedDefault.config.instances[0].bubbleHeightPx === 200,
    JSON.stringify(fixedDefault.config.instances[0].bubbleHeightPx),
  )
  const fixedBad = normalizeConfig({ instances: [{ bubbleHeightPx: 5000, bubbleFixedSize: 'yes' }] })
  check(
    '固定气泡参数越界 → 回落并告警',
    fixedBad.config.instances[0].bubbleHeightPx === 200 &&
      fixedBad.config.instances[0].bubbleFixedSize === false &&
      fixedBad.warnings.some((w) => w.includes('bubbleHeightPx')) &&
      fixedBad.warnings.some((w) => w.includes('bubbleFixedSize')),
    JSON.stringify(fixedBad.warnings),
  )
  const fixedPayload = windowConfigPayload({ ...config, bubbleFixedSize: true, bubbleHeightPx: 260 })
  check(
    'windowConfigPayload 带固定气泡字段',
    fixedPayload.bubbleFixedSize === true && fixedPayload.bubbleHeightPx === 260,
    JSON.stringify({ f: fixedPayload.bubbleFixedSize, h: fixedPayload.bubbleHeightPx }),
  )

  const motionDefault = normalizeConfig({ instances: [{}] }).config
  check(
    '动态效果默认开启、幅度 60',
    motionDefault.instances[0].idleFloat === true && motionDefault.instances[0].lookFollow === true &&
      motionDefault.instances[0].dragInertia === true && motionDefault.instances[0].motionStrength === 60,
    JSON.stringify(motionDefault.instances[0]),
  )
  const motionBad = normalizeConfig({ instances: [{ motionStrength: 500, idleFloat: 'yes' }] })
  check(
    '动态效果越界/非法 → 回落并告警',
    motionBad.config.instances[0].motionStrength === 60 && motionBad.config.instances[0].idleFloat === true &&
      motionBad.warnings.some((w) => w.includes('motionStrength')) && motionBad.warnings.some((w) => w.includes('idleFloat')),
    JSON.stringify(motionBad.warnings),
  )
  const motionPayload = windowConfigPayload({ ...config, idleFloat: false, lookFollow: false, dragInertia: false, motionStrength: 30 })
  check(
    'windowConfigPayload 带动态效果',
    motionPayload.idleFloat === false && motionPayload.lookFollow === false &&
      motionPayload.dragInertia === false && motionPayload.motionStrength === 30,
    JSON.stringify(motionPayload),
  )
  const state = {
    config,
    model: realModel,
    renderer: { state: 'stopped', model: null, lastError: null, initQueued: false },
    bubble: { seq: 0, lastIdentity: null, lastAt: 0, lastShown: null },
    bubbleCount: 0,
    warnings: [],
    windows: { send: () => ({ ok: true }) },
  }
  const init = initPayload(state)
  check('initPayload 带 entryFile 与 assetBase', init.model.entryFile === 'test.model3.json' && init.assetBase === 'live2d-asset://model/', JSON.stringify(init.model))
  const initBound = initPayload({ config: { ...config, sessionId: 's1' }, model: realModel, id: 'inst-2' })
  check('initPayload 带 instanceId 与 sessionId（标题未解析时不显示成未绑定）', initBound.instanceId === 'inst-2' && initBound.sessionId === 's1', JSON.stringify({ id: initBound.instanceId, sid: initBound.sessionId }))

  // 窗口协议回报
  applyWindowMessage(state, { type: 'ready', pid: 1 })
  check('ready → renderer=starting', state.renderer.state === 'starting')
  applyWindowMessage(state, { type: 'state', phase: 'rendering', model: { width: 269 } })
  check('state rendering → renderer.state', state.renderer.state === 'rendering' && state.renderer.model.width === 269)
  applyWindowMessage(state, { type: 'bubble-shown', seq: 3 })
  check('bubble-shown → bubbleCount+1', state.bubble.bubbleCount === 1 && state.bubble.lastShown.seq === 3)
  applyWindowMessage(state, { type: 'state', phase: 'placeholder', error: 'boom' })
  check('error 进 warnings', state.renderer.lastError === 'boom' && state.warnings.some((w) => w.includes('boom')))

  // 告警按来源整体替换：路径改对后旧告警必须消失
  const warningState = { warningSources: { config: [], model: [], runtime: [] }, warnings: [] }
  setWarningSource(warningState, 'model', ['模型目录不存在：D:\\bad'])
  check('model 告警写入', warningState.warnings.length === 1 && warningState.warnings[0].includes('模型目录不存在'), JSON.stringify(warningState.warnings))
  setWarningSource(warningState, 'model', [])
  check('model 告警整体替换为空（旧告警消失）', warningState.warnings.length === 0, JSON.stringify(warningState.warnings))
  setWarningSource(warningState, 'config', ['windowWidth 越界'])
  setWarningSource(warningState, 'config', [])
  check('config 告警整体替换为空', warningState.warnings.length === 0, JSON.stringify(warningState.warnings))

  // 阶段 1.5：调整框松手回传 bounds → clamp + 写盘 + 更新 config（走实例视图）
  const boundsFile = path.join(tmpDir, 'bounds.json')
  {
    const bctx = makeCtx({ windowManager: { open: () => ({ ok: true }), close: async () => ({ ok: true }), send: () => ({ ok: true }), status: () => ({ running: false }) } })
    const bstate = apply(bctx, {})
    bstate.configFile = boundsFile
    const bview = instanceView(bstate, bstate.instances[0])
    applyWindowMessage(bview, { type: 'bounds', bounds: { x: 120, y: 340, width: 360, height: 480 } })
    check('bounds → config 更新', bview.config.windowX === 120 && bview.config.windowWidth === 360, JSON.stringify({ x: bview.config.windowX, w: bview.config.windowWidth }))
    const boundsSaved = readConfigFile(boundsFile)
    check('bounds → 写入配置文件', boundsSaved.ok === true && boundsSaved.data.instances?.[0]?.windowHeight === 480, JSON.stringify(boundsSaved.data))
    applyWindowMessage(bview, { type: 'bounds', bounds: { x: 0, y: 0, width: 9999, height: 20 } })
    check('bounds 越界 → clamp 到合法值', bview.config.windowWidth === 800 && bview.config.windowHeight === 200, JSON.stringify({ w: bview.config.windowWidth, h: bview.config.windowHeight }))
  }

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

// --- 16. 阶段 2：窗口内对话（提交 / 拒绝 / 回复推送） -----------------------
{
  const sent = []
  const fakeManager = {
    open: () => ({ ok: true }),
    close: async () => ({ ok: true }),
    status: () => ({ ready: true, running: true }),
    send: (command) => { sent.push(command); return { ok: true } },
  }
  const ctx = makeCtx({ windowManager: fakeManager })
  const state = apply(ctx, {})

  const empty = await post(ctx, '/live2d/chat', { text: '   ' })
  check('chat 空文本 → 400', empty.statusCode === 400, empty.body)

  const sessRes = await get(ctx, '/live2d/sessions')
  const sessBody = JSON.parse(sessRes.body)
  check(
    'GET /live2d/sessions 返回会话列表',
    sessRes.statusCode === 200 && Array.isArray(sessBody.sessions) && sessBody.sessions[0]?.id === 's1',
    sessRes.body,
  )

  const accepted = await post(ctx, '/live2d/chat', { text: '你好呀' })
  const acceptedBody = JSON.parse(accepted.body)
  check(
    'chat 接受 → accepted + requestId',
    acceptedBody.ok === true && acceptedBody.accepted === true && String(acceptedBody.requestId).startsWith('chat-'),
    accepted.body,
  )
  const injectedChat = ctx._injected.filter((item) => item.message?.source?.kind === 'live2d-chat').pop()
  check('chat 注入 source.kind=live2d-chat', Boolean(injectedChat), JSON.stringify(injectedChat?.message?.source))
  const chatState = state.instances[0]
  check('chat pending 记在实例上', chatState.chat?.pending?.requestId === acceptedBody.requestId)

  const again = await post(ctx, '/live2d/chat', { text: '再说一句' })
  check('chat 上一条未回 → 409', again.statusCode === 409, again.body)

  // 模拟 assistant 回复落盘 + agent 空闲 → 应该推一条 reply
  ctx._sessionState.messages.push({ role: 'assistant', content: [{ type: 'text', text: '我在呀，主人。' }] })
  ctx.emitForTest('agent/status', { status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 600))
  const reply = sent.filter((item) => item.type === 'reply').pop()
  check('chat 回复 → reply 事件', reply?.ok === true && reply.text.includes('我在呀'), JSON.stringify(reply))
  check('chat 回复后 pending 清空', chatState.chat?.pending === null && chatState.chat?.history?.length === 1)

  // followup 被拒：不能崩，要推 error
  const rejectSent = []
  const rejectManager = { open: () => ({ ok: true }), close: async () => ({ ok: true }), status: () => ({ ready: true }), send: (c) => { rejectSent.push(c); return { ok: true } } }
  const rejectCtx = makeCtx({ rejectFollowup: true, windowManager: rejectManager })
  const rejectState = apply(rejectCtx, {})
  const bad = await post(rejectCtx, '/live2d/chat', { text: '这条会被拒' })
  check('chat followup 被拒仍返回 accepted（异步兜底）', bad.statusCode === 200, bad.body)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const errorReply = rejectSent.filter((item) => item.type === 'reply').pop()
  check('chat followup 被拒 → reply error', errorReply?.ok === false && String(errorReply.error).includes('拒绝'), JSON.stringify(errorReply))
  check('chat 被拒后 pending 清空', rejectState.chat?.pending === null)

  // 显式绑定会话：解析结果要可见（resolvedBy = bound）
  const boundCtx = makeCtx({ windowManager: fakeManager })
  const boundState = apply(boundCtx, { instances: [{ id: 'inst-1', sessionId: 's1' }] })
  check('实例 sessionId 透传', boundState.config.instances[0].sessionId === 's1' && boundState.config.boundSessionId === 's1')
  const boundHealth = JSON.parse((await get(boundCtx, '/live2d/health')).body)
  check('health.chat.target 显示解析结果', boundHealth.chat?.target?.ok === true && boundHealth.chat.target.resolvedBy === 'bound', JSON.stringify(boundHealth.chat?.target))
}

// --- 17. 多实例：新增 / 唯一性 / 删除 / 隔离 -------------------------------
{
  const commands = []
  const fakeManager = {
    open: () => ({ ok: true, started: true, pid: 6000 }),
    close: async () => ({ ok: true }),
    send: (command, instanceId) => { commands.push({ command, instanceId }); return { ok: true, queued: false } },
    status: () => ({ running: true, ready: false }),
  }
  const ctx = makeCtx({ windowManager: fakeManager })
  const state = apply(ctx, {})
  check('默认只有 1 个实例', state.instances.length === 1 && state.instances[0].id === 'inst-1')

  const listRes = await get(ctx, '/live2d/instances')
  const list = JSON.parse(listRes.body)
  check('GET /live2d/instances 返回默认实例', listRes.statusCode === 200 && list.defaultInstanceId === 'inst-1' && list.instances[0].boundLabel === '未绑定会话', listRes.body)
  check(
    'instanceSummary 带完整 config（设置页重建表单用）',
    Boolean(list.instances[0].config) && list.instances[0].config.windowWidth === 320 && typeof list.instances[0].config.adjustMode === 'boolean',
    JSON.stringify(list.instances[0].config),
  )

  // 新增：sessionId 可为空，modelPath 必填
  const noModel = await post(ctx, '/live2d/instances', { sessionId: 's1' })
  check('新增缺 modelPath → 400', noModel.statusCode === 400 && JSON.parse(noModel.body).code === 'model-required', noModel.body)

  const created = await post(ctx, '/live2d/instances', { modelPath: 'D:\\m2' })
  const createdBody = JSON.parse(created.body)
  check('新增实例（未绑定）→ 201', created.statusCode === 201 && createdBody.instanceId === 'inst-2' && createdBody.instance?.sessionId === null, created.body)
  check('新增后实例数 = 2', state.instances.length === 2)

  const created2 = await post(ctx, '/live2d/instances', { modelPath: 'D:\\m3' })
  check('超过上限 → 409', created2.statusCode === 409 && JSON.parse(created2.body).code === 'too-many-instances', created2.body)

  // 唯一性：同一会话不能绑两次（先把 inst-1 绑到 s1）
  const bindFirst = await post(ctx, '/live2d/instances/inst-1', { sessionId: 's1' })
  const bindFirstBody = JSON.parse(bindFirst.body)
  check('绑定会话 → 200 且显示已绑定', bindFirst.statusCode === 200 && bindFirstBody.instance?.boundLabel?.startsWith('已绑定：'), bindFirst.body)
  const dupSession = await post(ctx, '/live2d/instances/inst-2', { sessionId: 's1' })
  check('重复 sessionId → 409 duplicate-session', dupSession.statusCode === 409 && JSON.parse(dupSession.body).code === 'duplicate-session', dupSession.body)

  // 唯一性：同一模型不能两份（inst-2 已经在用 D:\m2，把 inst-1 也指过去）
  const dupModel = await post(ctx, '/live2d/instances/inst-1', { modelPath: 'D:\\m2' })
  check('重复 modelPath → 409 duplicate-model', dupModel.statusCode === 409 && JSON.parse(dupModel.body).code === 'duplicate-model', dupModel.body)

  // 两个窗口互不影响：只有目标实例收到 config
  commands.length = 0
  await post(ctx, '/live2d/instances/inst-2', { windowWidth: 400 })
  const onlyTwo = commands.every((item) => item.instanceId === 'inst-2')
  check('PATCH 只发到目标实例', commands.length > 0 && onlyTwo, JSON.stringify(commands.map((item) => [item.instanceId, item.command.type])))

  // 实例级气泡参数必须能存住（早先 normalizeInstance 漏了这几个字段 → 保存后跳回 5 秒）
  const bubbleSaved = await post(ctx, '/live2d/instances/inst-1', { bubbleDurationMs: 12000, bubbleQueueLimit: 5, bubbleMaxChars: 200 })
  const inst1After = state.instances.find((item) => item.id === 'inst-1')
  check(
    '实例级气泡参数保存后仍是新值',
    bubbleSaved.statusCode === 200 && inst1After.config.bubbleDurationMs === 12000 && inst1After.config.bubbleQueueLimit === 5 && inst1After.config.bubbleMaxChars === 200,
    JSON.stringify({ d: inst1After.config.bubbleDurationMs, q: inst1After.config.bubbleQueueLimit, c: inst1After.config.bubbleMaxChars }),
  )
  // 另一个实例不受影响（仍是各自的值）
  const inst2After = state.instances.find((item) => item.id === 'inst-2')
  check('改 inst-1 气泡参数不影响 inst-2', inst2After.config.bubbleDurationMs === 5000, JSON.stringify(inst2After.config.bubbleDurationMs))

  // 气泡时长上限 120 秒
  const maxOk = await post(ctx, '/live2d/instances/inst-1', { bubbleDurationMs: 120000 })
  const afterMax = state.instances.find((item) => item.id === 'inst-1')
  check('气泡时长 120s 合法', maxOk.statusCode === 200 && afterMax.config.bubbleDurationMs === 120000, JSON.stringify(afterMax.config.bubbleDurationMs))
  const overMax = await post(ctx, '/live2d/instances/inst-1', { bubbleDurationMs: 200000 })
  const afterOver = state.instances.find((item) => item.id === 'inst-1')
  check('气泡时长 >120s → 回落 5000 并告警', overMax.statusCode === 200 && afterOver.config.bubbleDurationMs === 5000 && state.warnings.some((w) => w.includes('bubbleDurationMs')), JSON.stringify({ v: afterOver.config.bubbleDurationMs, w: state.warnings }))

  // 不活跃会话的标题：从 projcache 落盘文件兜底
  const titleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live2d-title-'))
  fs.writeFileSync(path.join(titleDir, 'abc.json'), JSON.stringify({ record: { rows: { title: { val: '缓存里的会话名' } } } }), 'utf8')
  // 下拉扫描只认会话文件（UUID 名，可带 session- 前缀）；bili-whale.json 这类要跳过
  fs.writeFileSync(path.join(titleDir, 'session-11111111-1111-4111-8111-111111111111.json'), JSON.stringify({ record: { rows: { title: { val: '另一个会话' } } } }), 'utf8')
  fs.writeFileSync(path.join(titleDir, 'bili-whale.json'), JSON.stringify({ record: { rows: { title: { val: '不是会话' } } } }), 'utf8')
  check('titleFromProjCache 读 record.rows.title.val', titleFromProjCache('session-abc', titleDir) === '缓存里的会话名', String(titleFromProjCache('session-abc', titleDir)))
  // 下拉数据源：sessions 服务只给活跃会话时，projcache 里的不活跃会话要能补进来
  const pickerRows = collectSessionsForPicker({}, 20, titleDir)
  check('会话下拉补出不活跃会话', pickerRows.some((row) => row.id === 'session-11111111-1111-4111-8111-111111111111' && row.title === '另一个会话') && !pickerRows.some((row) => row.id.includes('bili-whale')), JSON.stringify(pickerRows))
  fs.rmSync(titleDir, { recursive: true, force: true })

  // 视图隔离：inst-1 的 renderer 不受 inst-2 影响
  applyWindowMessage(instanceView(state, state.instances[1]), { type: 'state', phase: 'rendering', model: { width: 100 } })
  check('实例渲染状态互不串台', state.instances[1].renderer.state === 'rendering' && state.instances[0].renderer.state === 'stopped',
    JSON.stringify([state.instances[0].renderer.state, state.instances[1].renderer.state]))

  // 崩一个渲染进程：只影响该实例
  applyWindowMessage(instanceView(state, state.instances[1]), { type: 'error', code: 'renderer-crash', error: 'gone' })
  check('renderer-crash 只影响该实例', state.instances[1].window.state === 'stopped' && state.instances[1].window.ready === false && state.instances[0].window.state === 'stopped',
    JSON.stringify(state.instances.map((item) => item.window.state)))

  // ready → init 必须带 title 字段（窗口左上角标签靠它；曾漏带导致一直显示「会话 xxxxxxxx」）
  commands.length = 0
  applyWindowMessage(instanceView(state, state.instances[0]), { type: 'ready', bounds: { width: 320, height: 420 } })
  const initCommand = commands.map((item) => item.command).find((item) => item?.type === 'init')
  check('ready → init 带 title 字段', Boolean(initCommand) && Object.prototype.hasOwnProperty.call(initCommand, 'title'),
    JSON.stringify(initCommand && { title: initCommand.title, keys: Object.keys(initCommand) }))

  // 删除：先关窗，再移除；默认实例顺位
  commands.length = 0
  const del = await del_(ctx, '/live2d/instances/inst-1')
  const delBody = JSON.parse(del.body)
  check('删除实例 → 200 且默认顺位到 inst-2', del.statusCode === 200 && delBody.defaultInstanceId === 'inst-2' && state.instances.length === 1, del.body)
  check('删除先下发 pool:close', commands.some((item) => item.command.type === 'pool:close' && item.instanceId === 'inst-1'))

  const last = await del_(ctx, '/live2d/instances/inst-2')
  check('最后一个实例不能删 → 400', last.statusCode === 400 && JSON.parse(last.body).code === 'last-instance', last.body)

  // 不存在的实例：要 404，不能假装 409 冲突，也不能静默成功
  const ghostPatch = await post(ctx, '/live2d/instances/inst-ghost', { windowWidth: 300 })
  check('PATCH 不存在实例 → 404', ghostPatch.statusCode === 404 && JSON.parse(ghostPatch.body).ok === false, ghostPatch.body)
  const ghostDelete = await del_(ctx, '/live2d/instances/inst-ghost')
  check('DELETE 不存在实例 → 404', ghostDelete.statusCode === 404, ghostDelete.body)

  // /live2d/models：扫到真实模型并标注占用
  const modelsRes = await get(ctx, '/live2d/models')
  const models = JSON.parse(modelsRes.body)
  check('GET /live2d/models 能扫到模型', modelsRes.statusCode === 200 && models.models.length >= 1 && models.models[0].entry.endsWith('.model3.json'), JSON.stringify(models.models?.[0]))

  // validateInstances / normalizeModelKey 纯函数
  check('normalizeModelKey 归一化大小写与尾斜杠', normalizeModelKey('D:\\Live2D\\A\\') === normalizeModelKey('d:\\live2d\\a'), normalizeModelKey('D:\\Live2D\\A\\'))
  const badTwo = validateInstances({ instances: [{ id: 'a', sessionId: 's' }, { id: 'b', sessionId: 's' }] })
  check('validateInstances 识别重复会话', badTwo.ok === false && badTwo.code === 'duplicate-session')
}

// --- 18. config.json 迁移：老扁平字段 → instances[0] ----------------------
{
  const migrationFile = path.join(os.tmpdir(), `live2d-legacy-${process.pid}.json`)
  fs.writeFileSync(migrationFile, JSON.stringify({ modelPath: 'D:\\old', windowWidth: 360, boundSessionId: 's9' }), 'utf8')
  const readLegacy = readConfigFile(migrationFile)
  check('老配置可读', readLegacy.ok === true && readLegacy.data.windowWidth === 360)
  const migrated = normalizeConfig(readLegacy.data)
  check('老扁平字段迁移为 instances[0]', Array.isArray(migrated.config.instances) && migrated.config.instances[0].modelPath === 'D:\\old' && migrated.config.instances[0].sessionId === 's9',
    JSON.stringify(migrated.config.instances?.[0]))
}

// --- 19. 阶段 4：动作指令（白名单 / 冷却 / 超时回落 idle）-------------------
{
  const animSent = []
  const animCtx = makeCtx({
    windowManager: {
      open: () => ({ ok: true }),
      close: async () => ({ ok: true }),
      status: () => ({ running: true, ready: true }),
      send: (command, instanceId) => { animSent.push({ command, instanceId }); return { ok: true } },
    },
  })
  // 默认模式现在是「手动」（内部 auto，不自动做动作），动作用例显式用「AI 自动」（内部 manual）
  const animState = apply(animCtx, { instances: [{ id: 'inst-1', sessionId: 's1', mode: 'manual' }] })

  const bad = await post(animCtx, '/live2d/anim', { action: 'dance' })
  const badBody = JSON.parse(bad.body)
  check('动作白名单拒绝未知动作', bad.statusCode === 400 && Array.isArray(badBody.allowed) && badBody.allowed.includes('nod'), bad.body)

  animSent.length = 0
  const ok = await post(animCtx, '/live2d/anim', { action: 'nod' })
  const okBody = JSON.parse(ok.body)
  check('合法动作下发到窗口', ok.statusCode === 200 && okBody.action === 'nod'
    && animSent.some((item) => item.command.type === 'anim' && item.command.action === 'nod'), ok.body)

  const busy = await post(animCtx, '/live2d/anim', { action: 'shake' })
  const busyBody = JSON.parse(busy.body)
  check('动作冷却 3 秒内拒绝', busy.statusCode === 429 && busyBody.retryAfterMs > 0, busy.body)

  // 冷却归零后可以继续；anim-done 会清掉超时标记
  animState.config.animCooldownMs = 0
  const idle = await post(animCtx, '/live2d/anim', { action: 'idle' })
  check('冷却归零后可再次触发', idle.statusCode === 200, idle.body)
  applyWindowMessage(instanceView(animState, animState.instances[0]), { type: 'anim-done', action: 'idle' })
  check('anim-done 记账', animState.instances[0].anim.ackedAt !== null && animState.instances[0].anim.timeout === false,
    JSON.stringify(animState.instances[0].anim))

  // 表情扩展 + 别名：blush 应该被归一到 shy，四个新表情都在白名单里
  animState.config.animCooldownMs = 0
  const blush = await post(animCtx, '/live2d/anim', { action: 'blush' })
  const blushBody = JSON.parse(blush.body)
  check('动作别名 blush → shy', blush.statusCode === 200 && blushBody.action === 'shy', blush.body)
  const extras = []
  for (const action of ['angry', 'drool', 'xx', 'puff']) {
    const res = await post(animCtx, '/live2d/anim', { action })
    extras.push(`${action}:${res.statusCode}`)
  }
  check('表情扩展四个可用', extras.every((item) => item.endsWith(':200')), extras.join(','))
}

// --- 20. 阶段 4：三模式 + 自动气泡 -----------------------------------------
{
  const commands = []
  const modeCtx = makeCtx({
    windowManager: {
      open: () => ({ ok: true }),
      close: async () => ({ ok: true }),
      status: () => ({ running: true, ready: true }),
      send: (command, instanceId) => { commands.push({ command, instanceId }); return { ok: true } },
    },
  })
  const modeState = apply(modeCtx, {
    // 气泡用例统一用 semi（external-chat 允许）；auto 的差异单独用 autoState 测
    instances: [{ id: 'inst-1', sessionId: 's-auto', mode: 'semi' }],
  })
  check('三模式枚举正确', MODES.join(',') === 'manual,auto,semi')

  const bad = normalizeConfig({ instances: [{ mode: 'robot' }] })
  // 默认模式是「手动」（内部 auto），非法值回落到它
  check('非法模式回落默认并告警', bad.config.instances[0].mode === 'auto'
    && bad.warnings.some((item) => item.includes('mode')), JSON.stringify(bad.warnings))

  const session = {
    id: 's-auto',
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: '在吗' }] },
      { role: 'assistant', content: [{ type: 'text', text: '在的，主人。' }] },
    ],
  }
  // 0.13.0：气泡由「回复来源」决定，不再由模式一刀切
  const autoState = apply(modeCtx, { instances: [{ id: 'inst-1', sessionId: 's-auto', mode: 'auto' }] })
  commands.length = 0
  const pushedAuto = autoPushReply(autoState, session, () => {})
  check('auto + external-chat 不推气泡', pushedAuto === 0, String(pushedAuto))

  commands.length = 0
  const pushedWindow = autoPushReply(autoState, session, () => {}, null, 'window-chat')
  check('auto + window-chat 推气泡', pushedWindow === 1
    && commands.some((item) => item.command.type === 'bubble' && item.command.text === '在的，主人。'),
    JSON.stringify(commands.map((item) => item.command.type)))

  commands.length = 0
  const again = autoPushReply(autoState, session, () => {}, null, 'window-chat')
  check('同一段回复 5s 内去重', again === 0, String(again))

  // 手动模式：外部对话也要冒泡（新方案里 manual 也会自动回）
  commands.length = 0
  const manualState = apply(modeCtx, { instances: [{ id: 'inst-1', sessionId: 's-auto', mode: 'manual' }] })
  const manualPushed = autoPushReply(manualState, session, () => {})
  check('manual + external-chat 推气泡', manualPushed === 1, String(manualPushed))

  // semi 模式：推气泡 + 播动作；思考中也能触发动作
  const semiState = apply(modeCtx, { instances: [{ id: 'inst-1', sessionId: 's-auto', mode: 'semi' }] })
  commands.length = 0
  autoPushReply(semiState, session, () => {})
  check('semi 模式自动气泡并带动作', commands.some((item) => item.command.type === 'bubble')
    && commands.some((item) => item.command.type === 'anim' && item.command.action === 'happy'),
    JSON.stringify(commands.map((item) => item.command.type)))

  // 冷却会挡掉第二次动作，但 autoThinking 不抛错
  commands.length = 0
  autoThinking(semiState, () => {})
  check('autoThinking 不发非法指令', commands.every((item) => item.command.type === 'anim'), JSON.stringify(commands))

  // 真实事件形状（审查 P0-1）：agent/status 的载荷是 { agent, status }，会话在 agent.session.id。
  // 以前只读 payload.sessionId → 拿到 null → semi 永远不进 manual。
  commands.length = 0
  semiState.instances[0].modeState = { phase: null, since: null }
  modeCtx.emitForTest('agent/status', { status: 'running', agent: { session: { id: 's-auto' } } })
  await new Promise((resolve) => setTimeout(resolve, 60))
  check(
    'semi：真实 {agent,status} 载荷进入 manual',
    semiState.instances[0].modeState?.phase === 'manual',
    JSON.stringify(semiState.instances[0].modeState),
  )
  modeCtx.emitForTest('agent/status', { status: 'idle', agent: { session: { id: 's-auto' } } })
  await new Promise((resolve) => setTimeout(resolve, 60))
  check(
    'semi：idle 回到 auto',
    semiState.instances[0].modeState?.phase !== 'manual',
    JSON.stringify(semiState.instances[0].modeState),
  )

  // 崩溃回归：handleAnim 的 log 参数是 logger 对象（{info,warn,error}），不是函数。
  // 以前超时回调里写 log(...) → TypeError → 宿主进程退出。
  const animView = instanceView(modeState, modeState.instances[0])
  // 模式守卫：手动模式允许动作，自动模式拒绝（审查 P0-3）。测完要恢复原模式，
  // 否则后面依赖「auto 自动推气泡」的用例会全空。
  const originalMode = modeState.instances[0].config.mode
  modeState.instances[0].config.mode = 'manual'
  const animResult = handleAnim(animView, { info() {}, warn() {}, error() {} }, { action: 'nod' })
  check('handleAnim 接受 logger 对象不抛错', animResult.status === 200 || animResult.status === 429, JSON.stringify(animResult.payload))
  modeState.instances[0].config.mode = 'auto'
  // 0.13.8：设置页/右键菜单这种「用户亲手点」的调用放行（source='ui'），
  // 只有 AI 工具（source='tool'）在 auto 下被拒。
  const animAutoTool = handleAnim(animView, { info() {}, warn() {}, error() {} }, { action: 'nod' }, 'tool')
  check('自动模式拒绝 AI 工具的动作指令', animAutoTool.status === 403 && animAutoTool.payload.code === 'mode-forbidden', JSON.stringify(animAutoTool.payload))
  const animAutoUi = handleAnim(animView, { info() {}, warn() {}, error() {} }, { action: 'nod' }, 'ui')
  check('自动模式下设置页点动作仍可播', animAutoUi.status === 200 || animAutoUi.status === 429, JSON.stringify(animAutoUi.payload))
  modeState.instances[0].config.mode = originalMode

  // 气泡按 message id 去重：同一条不重推，新消息才推
  const msgSession = (id, text) => ({
    id: 's-auto',
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: '在吗' }] },
      { id, role: 'assistant', content: [{ type: 'text', text }] },
    ],
  })
  commands.length = 0
  modeState.instances[0].bubble.lastMessageId = null
  modeState.instances[0].bubble.lastAt = 0
  autoPushReply(modeState, msgSession('m-1', '第一条回复'), () => {})
  autoPushReply(modeState, msgSession('m-1', '第一条回复'), () => {})
  check('同一 message id 只推一次', commands.filter((item) => item.command.type === 'bubble').length === 1,
    String(commands.filter((item) => item.command.type === 'bubble').length))

  commands.length = 0
  modeState.instances[0].bubble.lastAt = 0
  autoPushReply(modeState, msgSession('m-2', '第二条回复'), () => {})
  check('新 message id 会推', commands.some((item) => item.command.type === 'bubble' && item.command.text === '第二条回复'),
    JSON.stringify(commands.map((item) => item.command.text)))

  commands.length = 0
  modeState.instances[0].bubble.lastAt = 0
  autoPushReply(modeState, msgSession('m-3', '记忆已更新 lesson 0mvz…'), () => {})
  check('记忆通知不冒泡', !commands.some((item) => item.command.type === 'bubble'), JSON.stringify(commands))

  // 回归：事件里的新消息 + deriveMessages 还停在上一轮 → 必须推「事件这条」，不能推旧的
  const staleSession = {
    id: 's-auto',
    deriveMessages: () => [
      { id: 'm-old', role: 'assistant', content: [{ type: 'text', text: '上一轮回复' }] },
    ],
  }
  const freshMessage = { id: 'm-new', role: 'assistant', content: [{ type: 'text', text: '这一轮回复' }] }
  commands.length = 0
  modeState.instances[0].bubble.lastAt = 0
  modeState.instances[0].bubble.lastIdentity = null
  autoPushReply(modeState, staleSession, () => {}, freshMessage)
  check('文本与消息身份同源（推新不推旧）',
    commands.some((item) => item.command.type === 'bubble' && item.command.text === '这一轮回复')
    && !commands.some((item) => item.command.type === 'bubble' && item.command.text === '上一轮回复'),
    JSON.stringify(commands.map((item) => item.command.text)))
}

// --- 21. 绑定会话必须严格（未激活时不许回落到别的会话）--------------------
{
  const strictCtx = makeCtx()
  const real = strictCtx.sessions
  strictCtx.sessions = {
    list: () => [{ id: 's1' }],
    get: (id) => (id === 's1' ? real.get('s1') : null),
  }
  const strictState = apply(strictCtx, { instances: [{ id: 'inst-1', sessionId: 's-missing' }] })
  const view = instanceView(strictState, strictState.instances[0])
  const target = resolveChatTarget(strictCtx, view)
  check('绑定会话未激活时不回落到别的会话', target.ok === false && String(target.error || '').includes('s-missing'),
    JSON.stringify(target))

  const boundState = apply(strictCtx, { instances: [{ id: 'inst-1', sessionId: 's1' }] })
  const boundView = instanceView(boundState, boundState.instances[0])
  const boundTarget = resolveChatTarget(strictCtx, boundView)
  check('绑定会话激活后解析为 bound', boundTarget.ok === true && boundTarget.resolvedBy === 'bound'
    && boundTarget.sessionId === 's1', JSON.stringify(boundTarget))
}

// --- 22. 会话下拉过滤空白与归档 ---------------------------------------------
{
  const dir = path.join(os.tmpdir(), `live2d-picker-${process.pid}`)
  fs.mkdirSync(dir, { recursive: true })
  const uuid = (n) => `${String(n).padStart(8, '0')}-1111-2222-3333-444455556666`
  const writeCache = (id, { title = null, blank = false } = {}) => {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
      record: { rows: { title: { val: title }, sessionListMetadata: { val: { blank, lastPromptAt: blank ? null : Date.now() } } } },
    }), 'utf8')
  }
  writeCache(`session-${uuid(1)}`, { title: '有内容的对话' })
  writeCache(`session-${uuid(2)}`, { title: null, blank: true })
  writeCache(`session-${uuid(3)}`, { title: '已归档的对话' })
  const workspaceFile = path.join(dir, 'workspace.json')
  fs.writeFileSync(workspaceFile, JSON.stringify({ global: { archivedSessionIds: [`session-${uuid(3)}`] } }), 'utf8')

  const pickerCtx = makeCtx()
  pickerCtx.sessions = { list: () => [], get: () => null }
  const rows = collectSessionsForPicker(pickerCtx, 50, dir, { workspaceFile })
  const ids = rows.map((row) => row.id)
  check('会话下拉去掉空白对话', !ids.includes(`session-${uuid(2)}`), JSON.stringify(ids))
  check('会话下拉去掉归档对话', !ids.includes(`session-${uuid(3)}`), JSON.stringify(ids))
  check('正常对话保留', ids.includes(`session-${uuid(1)}`), JSON.stringify(ids))

  const allRows = collectSessionsForPicker(pickerCtx, 50, dir, { workspaceFile, includeBlank: true, includeArchived: true })
  check('include 选项可看全量', allRows.length >= 3, JSON.stringify(allRows.map((row) => row.id)))

  // 子会话（文件名无 session- 前缀）与自动化标题都不该出现
  fs.writeFileSync(path.join(dir, `${uuid(4)}.json`), JSON.stringify({
    record: { rows: { title: { val: '子会话' }, sessionListMetadata: { val: { blank: false } } } },
  }), 'utf8')
  writeCache(`session-${uuid(5)}`, { title: 'headless Call the tool plugin_governance' })
  const filtered2 = collectSessionsForPicker(pickerCtx, 50, dir, { workspaceFile })
  const ids2 = filtered2.map((row) => row.id)
  check('子会话（无 session- 前缀）不进下拉', !ids2.some((id) => id.includes(uuid(4))), JSON.stringify(ids2))
  check('自动化会话标题不进下拉', !ids2.some((id) => id.includes(uuid(5))), JSON.stringify(ids2))

  const allRows2 = collectSessionsForPicker(pickerCtx, 50, dir, {
    workspaceFile, includeAutomation: true, includeBlank: true, includeArchived: true,
  })
  check('includeAutomation 可看自动化会话', allRows2.some((row) => row.id.includes(uuid(5))), JSON.stringify(allRows2.map((row) => row.id)))

  fs.rmSync(dir, { recursive: true, force: true })
}

// --- 23. 绑定会话未激活时排队，激活后自动发出 ------------------------------
{
  const qCtx = makeCtx()
  const baseGet = qCtx.sessions.get.bind(qCtx.sessions)
  let active = false
  qCtx.sessions = { list: () => [], get: (id) => (active ? baseGet(id) : null) }
  const qState = apply(qCtx, { instances: [{ id: 'inst-1', sessionId: 's1', mode: 'manual' }] })
  const qView = instanceView(qState, qState.instances[0])
  const queued = submitChat(qCtx, qView, qState.log, { text: '排队一条' })
  check('会话未激活时排队而不是丢弃', queued.status === 200 && queued.payload.queued === true
    && qState.instances[0].chat.queue.length === 1, JSON.stringify(queued.payload))

  // 队列上限 3
  submitChat(qCtx, qView, qState.log, { text: '排队二' })
  submitChat(qCtx, qView, qState.log, { text: '排队三' })
  submitChat(qCtx, qView, qState.log, { text: '排队四' })
  check('排队上限 3', qState.instances[0].chat.queue.length === 3, String(qState.instances[0].chat.queue.length))

  active = true
  flushChatQueue(qCtx, qState, qState.log)
  check('激活后自动发出队首', qState.instances[0].chat.queue.length === 2, String(qState.instances[0].chat.queue.length))
  check('发出的内容正确', qState.instances[0].chat.queue[0].text === '排队三', JSON.stringify(qState.instances[0].chat.queue))
}

// --- 24. 一轮一次：idle 推气泡 + 节流 --------------------------------------
{
  const sent = []
  const idleCtx = makeCtx()
  idleCtx.windows = null
  // 0.13.0：气泡由「回复来源」决定；external-chat 在 auto 下不推，所以这里用 semi
  const idleState = apply(idleCtx, { instances: [{ id: 'inst-1', sessionId: 's1', mode: 'semi' }] })
  // 把实例的窗口发送换成收集器（apply 后替换实例视图的 windows 不可行，这里直接替换 root 的 send 钩子）
  const inst = idleState.instances[0]
  const originalSend = idleState.windows?.send
  idleState.windows = { ...(idleState.windows ?? {}), send: (command, instanceId) => { sent.push({ command, instanceId }); return { ok: true } } }
  if (originalSend) idleState.windows.status = originalSend.status

  const first = pushIdleReplies(idleCtx, idleState, () => {})
  check('idle 时推一次气泡', first === 1 && sent.some((item) => item.command.type === 'bubble'), JSON.stringify(sent.map((i) => i.command.type)))

  const again = pushIdleReplies(idleCtx, idleState, () => {})
  check('重复 idle 不重推', again === 0, String(again))

  // 0.13.6：6 秒时间节流已移除——两轮很快结束时第二条合法回复不该被吞。
  // 去重仍由 claim 按 messageId 负责（上一条「重复 idle 不重推」已经覆盖）。
  inst.bubble.claim = null
  const after = pushIdleReplies(idleCtx, idleState, () => {})
  check('去掉时间节流后新消息立即可推', after === 1, String(after))

  // 会话未激活（sessions.get 返回 null）时，用 session/event 缓存的 session 兜底
  idleState.sessionCache.set('s1', {
    id: 's1',
    deriveMessages: () => [{ id: 'cached-1', role: 'assistant', content: [{ type: 'text', text: '缓存里的回复' }] }],
  })
  idleCtx.sessions = { list: () => [], get: () => null }
  inst.bubble.lastAt = 0
  inst.bubble.lastMessageId = null
  inst.bubble.lastIdentity = null
  const cachedPush = pushIdleReplies(idleCtx, idleState, () => {})
  check('未激活会话用缓存也能推', cachedPush === 1 && sent.some((item) => item.command.text === '缓存里的回复'),
    JSON.stringify(sent.map((item) => item.command.text)))

  // onlySessionId 只处理匹配的实例
  inst.bubble.lastAt = 0
  inst.bubble.lastMessageId = null
  const otherSession = pushIdleReplies(idleCtx, idleState, () => {}, 's-other')
  check('onlySessionId 不误推别的实例', otherSession === 0, String(otherSession))
}

// --- 25. 读屏第一层：前台窗口标题 ------------------------------------------
{
  const parsed = parseForegroundOutput('笔记.txt - 记事本|notepad')
  check('前台标题解析', parsed.ok === true && parsed.title === '笔记.txt - 记事本' && parsed.process === 'notepad',
    JSON.stringify(parsed))
  const withPipe = parseForegroundOutput('a|b - 窗口|Code')
  check('标题含竖线也能解析', withPipe.ok === true && withPipe.title === 'a|b - 窗口' && withPipe.process === 'Code',
    JSON.stringify(withPipe))

  const screenCtx = makeCtx()
  const offState = apply(screenCtx, { instances: [{ id: 'inst-1', screenReadEnabled: false }] })
  const off = await getForegroundTitle(offState.instances[0], async () => 'x|y')
  // 0.13.9：默认改成开（模式功能优先），所以这里显式关掉来测「关掉即拒绝」
  check('读屏关掉后拒绝', off.ok === false && off.disabled === true, JSON.stringify(off))

  screenCtx.__screenExec = async () => '微信 · 阿斯特莉亚|WeChat'
  const onState = apply(screenCtx, { instances: [{ id: 'inst-1', screenReadEnabled: true }] })
  const on = await getForegroundTitle(onState.instances[0], screenCtx.__screenExec)
  check('开启后能读前台标题', on.ok === true && on.title === '微信 · 阿斯特莉亚' && on.process === 'WeChat', JSON.stringify(on))

  const cached = await getForegroundTitle(onState.instances[0], async () => { throw new Error('不该再调用') })
  check('1 秒内命中缓存', cached.ok === true && cached.cached === true && cached.title === '微信 · 阿斯特莉亚', JSON.stringify(cached))
}

// --- 26. 读屏第二层：按需截图（开关/确认/限速/不落盘）-----------------------
{
  const parsed = parseCaptureOutput('800x600|aGVsbG8=')
  check('截图输出解析', parsed.ok === true && parsed.width === 800 && parsed.height === 600 && parsed.base64 === 'aGVsbG8=',
    JSON.stringify(parsed))

  const shotCtx = makeCtx()
  // 0.13.9：默认开，显式关掉来测「关掉即拒绝」
  const offState = apply(shotCtx, { instances: [{ id: 'inst-1', screenCaptureEnabled: false }] })
  const off = await requestScreenCapture(offState.instances[0], { confirmed: true, execImpl: async () => '800x600|aGk=' })
  check('截图关掉后拒绝', off.ok === false && off.disabled === true && off.status === 403, JSON.stringify(off))

  const onState = apply(shotCtx, {
    instances: [{ id: 'inst-1', screenCaptureEnabled: true, screenCaptureIntervalMs: 30000 }],
  })
  const needConfirm = await requestScreenCapture(onState.instances[0], { execImpl: async () => '800x600|aGk=' })
  check('未确认时不截、要求确认', needConfirm.ok === false && needConfirm.needsConfirm === true, JSON.stringify(needConfirm))

  const taken = await requestScreenCapture(onState.instances[0], { confirmed: true, execImpl: async () => '800x600|aGk=' })
  check('确认后截图成功且返回 base64', taken.ok === true && taken.base64 === 'aGk=' && taken.width === 800, JSON.stringify({ ok: taken.ok, w: taken.width }))

  const throttled = await requestScreenCapture(onState.instances[0], { confirmed: true, execImpl: async () => '800x600|aGk=' })
  check('30 秒内再次截图被限速', throttled.ok === false && throttled.status === 429 && throttled.retryAfterMs > 0,
    JSON.stringify(throttled))

  // 免确认子开关：总开关关时不生效
  const autoState = apply(shotCtx, {
    instances: [{ id: 'inst-1', screenCaptureEnabled: true, screenCaptureAutoConfirm: true, screenCaptureIntervalMs: 5000 }],
  })
  const autoOff = apply(shotCtx, { instances: [{ id: 'inst-1', screenCaptureEnabled: false, screenCaptureAutoConfirm: true }] })
  const autoResult = await requestScreenCapture(autoOff.instances[0], { execImpl: async () => '800x600|aGk=' })
  check('免确认子开关受总开关约束', autoResult.ok === false && autoResult.disabled === true, JSON.stringify(autoResult))

  const autoOk = await requestScreenCapture(autoState.instances[0], { execImpl: async () => '800x600|aGk=' })
  check('免确认开启后无需 confirmed', autoOk.ok === true, JSON.stringify({ ok: autoOk.ok, status: autoOk.status }))

  // 回归：screen 台账必须落在实例上（0.12.4 限速失效的根因是写到了临时视图）
  check('截图计数写回实例', autoState.instances[0].screen.captureCount === 1
    && autoState.instances[0].screen.lastSize === '800x600',
    JSON.stringify(autoState.instances[0].screen))
  const viewA = instanceView(autoState, autoState.instances[0])
  const viewB = instanceView(autoState, autoState.instances[0])
  autoState.instances[0].screen.lastCaptureAt = 0
  const r1 = await requestScreenCapture(viewA, { confirmed: true, execImpl: async () => '800x600|aGk=' })
  const r2 = await requestScreenCapture(viewB, { confirmed: true, execImpl: async () => '800x600|aGk=' })
  check('视图重建后限速仍生效', r1.ok === true && r2.status === 429, JSON.stringify({ r1: r1.status, r2: r2.status }))

  // 并发闸：inFlight 时第二个请求直接 429
  autoState.instances[0].screen.inFlight = true
  const concurrent = await requestScreenCapture(viewA, { confirmed: true, execImpl: async () => '800x600|aGk=' })
  autoState.instances[0].screen.inFlight = false
  check('截图进行中拒绝并发请求', concurrent.ok === false && concurrent.status === 429, JSON.stringify(concurrent))
}

// --- 27. 语音：CosyVoice2 合成 -------------------------------------------------
{
  const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ audio_base64: 'UklGRg==', mime: 'audio/wav' }) })
  const spoken = await synthesizeSpeech('你好', { fetchImpl: okFetch, url: 'http://x/tts' })
  check('TTS 合成返回 base64', spoken.ok === true && spoken.audioBase64 === 'UklGRg==' && spoken.mime === 'audio/wav',
    JSON.stringify({ ok: spoken.ok, mime: spoken.mime }))

  const errorFetch = async () => ({ ok: false, status: 500, json: async () => ({}) })
  const failed = await synthesizeSpeech('你好', { fetchImpl: errorFetch })
  check('TTS 服务 5xx 有明确错误', failed.ok === false && failed.status === 502 && String(failed.error).includes('500'),
    JSON.stringify(failed))

  const downFetch = async () => { throw new Error('ECONNREFUSED') }
  const down = await synthesizeSpeech('你好', { fetchImpl: downFetch })
  check('TTS 未启动给出启动提示', down.ok === false && down.status === 503 && String(down.hint).includes('7890'),
    JSON.stringify({ status: down.status, hint: down.hint }))

  const longText = 'a'.repeat(501)
  const tooLong = await synthesizeSpeech(longText, { fetchImpl: okFetch })
  check('TTS 文本上限 500', tooLong.ok === false && tooLong.status === 400, JSON.stringify(tooLong))

  // 换机器可移植性：参考音是本机绝对路径，不同机器上要先给明确错误而不是让服务端糊 500
  const missingPrompt = await synthesizeSpeech('你好', { fetchImpl: okFetch, prompt: 'D:\\nope\\missing.wav', existsImpl: () => false })
  check('TTS 参考音不存在时明确报错', missingPrompt.ok === false && missingPrompt.code === 'tts-prompt-missing',
    JSON.stringify({ code: missingPrompt.code, error: missingPrompt.error }))
  check('TTS 参考音默认为空（用服务端音色）', DEFAULT_INSTANCE.ttsPrompt === '', String(DEFAULT_INSTANCE.ttsPrompt))
  const roots = normalizeModelRoots(['D:\\A', 'D:\\A', '', 'D:\\B', null], [])
  check('模型扫描根归一化：去空去重', roots.length === 2 && roots[0] === 'D:\\A' && roots[1] === 'D:\\B', JSON.stringify(roots))
  const manyRoots = normalizeModelRoots(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'], [])
  check('模型扫描根最多 5 个', manyRoots.length === 5, JSON.stringify(manyRoots))
}

// --- 28. 语音同步：WAV 时长 / 缓存 / 气泡+语音共用 seq ----------------------
{
  const makeWav = (seconds) => {
    const sampleRate = 8000
    const byteRate = sampleRate
    const dataSize = Math.round(byteRate * seconds)
    const buf = Buffer.alloc(44 + dataSize)
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8)
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
    buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(byteRate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34)
    buf.write('data', 36); buf.writeUInt32LE(dataSize, 40)
    return buf.toString('base64')
  }
  const wav = makeWav(1.5)
  const duration = wavDurationMs(wav)
  check('WAV 时长解析', duration !== null && Math.abs(duration - 1500) <= 2, String(duration))
  check('非 WAV 返回 null', wavDurationMs('aGVsbG8=') === null)

  let calls = 0
  const countingFetch = async () => {
    calls += 1
    return { ok: true, status: 200, json: async () => ({ audio_base64: wav, mime: 'audio/wav' }) }
  }
  const first = await synthesizeSpeech('缓存测试句', { fetchImpl: countingFetch, url: 'http://cache-test/tts' })
  const second = await synthesizeSpeech('缓存测试句', { fetchImpl: countingFetch, url: 'http://cache-test/tts' })
  check('相同文本命中缓存不重复合成', first.ok === true && second.cached === true && calls === 1,
    JSON.stringify({ calls, cached: second.cached }))

  // 气泡与语音共用 seq：ttsOn 时气泡先上屏、durationMs=0、speechPending=true
  const sent = []
  const ttsCtx = makeCtx()
  const ttsState = apply(ttsCtx, {
    // 0.13.0：auto 不再推 external-chat 气泡，语音链路用 semi 测
    instances: [{ id: 'inst-1', sessionId: 's1', mode: 'semi', ttsEnabled: true, ttsAutoSpeak: true }],
  })
  ttsState.windows = {
    ...(ttsState.windows ?? {}),
    send: (command, instanceId) => { sent.push({ command, instanceId }); return { ok: true } },
  }
  const ttsSession = {
    id: 's1',
    deriveMessages: () => [{ id: 'tts-msg-1', role: 'assistant', content: [{ type: 'text', text: '这句话会有语音。' }] }],
  }
  ttsState.instances[0].bubble.lastAt = 0
  autoPushReply(ttsState, ttsSession, () => {})
  const bubbleCmd = sent.find((item) => item.command.type === 'bubble')
  check('语音模式下气泡先上屏且不自动消失',
    bubbleCmd && bubbleCmd.command.durationMs === 0 && bubbleCmd.command.speechPending === true,
    JSON.stringify(bubbleCmd?.command ?? null))
  check('气泡与语音共用同一个 seq', bubbleCmd && Number.isInteger(bubbleCmd.command.seq) && bubbleCmd.command.seq > 0,
    String(bubbleCmd?.command?.seq))
}

// --- 工具层：会话 → 实例的唯一解析 + 模式权限（审查 P0-1/P0-2/P0-3） ---
{
  const ctx = makeCtx()
  const state = apply(ctx, { autoOpenWindow: false })
  const inst = state.instances[0]
  inst.config.sessionId = 'session-tool-a'

  const bySession = resolveToolTarget(state, { sessionId: 'session-tool-a' })
  check('工具：按会话解析到实例', bySession.ok && bySession.inst.id === inst.id && bySession.resolvedBy === 'session', JSON.stringify({ ok: bySession.ok, by: bySession.resolvedBy }))

  const stray = resolveToolTarget(state, { sessionId: 'session-not-bound' })
  check('工具：未绑定会话明确拒绝（不回落默认实例）', stray.ok === false && stray.code === 'no-instance-for-session', JSON.stringify({ code: stray.code }))

  const ghost = resolveToolTarget(state, { instanceId: 'inst-ghost', sessionId: 'session-tool-a' })
  check('工具：未知 instanceId 拒绝', ghost.ok === false && ghost.code === 'no-such-instance', JSON.stringify({ code: ghost.code }))

  const foreign = resolveToolTarget(state, { instanceId: inst.id, sessionId: 'session-other' })
  check('工具：别的会话的实例拒绝', foreign.ok === false && foreign.code === 'instance-not-yours', JSON.stringify({ code: foreign.code }))

  const missingSession = resolveToolTarget(state, { instanceId: inst.id })
  check('工具：没有会话 id 时拒绝', missingSession.ok === false && missingSession.code === 'missing-session', JSON.stringify({ code: missingSession.code }))

  const tools = createLive2dTools(state, { info() {}, warn() {}, error() {} })
  const expectedNames = 'live2d_status,live2d_bubble,live2d_anim,live2d_window,live2d_screen,live2d_screen_capture,live2d_preset,live2d_params,live2d_wake'
  check('工具：注册了 9 个能力', tools.length === 9 && tools.map((t) => t.name).join(',') === expectedNames, tools.map((t) => t.name).join(','))

  // 未绑定实例的显式 id 也要拒绝（不能拿未绑定的实例绕过归属）
  const saved = inst.config.sessionId
  inst.config.sessionId = ''
  const unbound = resolveToolTarget(state, { instanceId: inst.id, sessionId: 'session-tool-a' })
  check('工具：未绑定实例拒绝', unbound.ok === false && unbound.code === 'instance-not-bound', JSON.stringify({ code: unbound.code }))
  inst.config.sessionId = saved

  const animTool = tools.find((t) => t.name === 'live2d_anim')
  inst.config.mode = 'auto'
  const autoAnim = await animTool.execute({ action: 'nod' }, { agent: { session: { id: 'session-tool-a' } } })
  check('工具：自动模式拒绝动作', autoAnim.ok === false && String(autoAnim.summary).includes('mode-forbidden'), autoAnim.summary)
  // 窗口操作也算模型控制：auto 模式同样拒绝（审查 P2）
  const windowTool = tools.find((t) => t.name === 'live2d_window')
  const autoWindow = await windowTool.execute({ action: 'open' }, { agent: { session: { id: 'session-tool-a' } } })
  check('工具：自动模式拒绝窗口操作', autoWindow.ok === false && String(autoWindow.summary).includes('mode-forbidden'), autoWindow.summary)
  inst.config.mode = 'manual'

  // 定时感知调度：每 tick 现场判断开关/总开关/模式/间隔（审查 P1）
  const watchState = apply(makeCtx(), {
    autoOpenWindow: false,
    instances: [{
      id: 'inst-1', sessionId: 's-auto', mode: 'manual',
      screenReadEnabled: true, screenWatchEnabled: true, screenWatchIntervalMs: 15000,
    }],
  })
  let readCount = 0
  const fakeRead = async () => { readCount += 1; return { ok: true, title: 'VS Code', process: 'Code.exe' } }
  const t1 = await screenWatchTick(watchState, () => {}, { getForegroundTitle: fakeRead })
  check('定时感知：开启时 tick 会读', t1.read.length === 1 && readCount === 1, JSON.stringify(t1))
  check('定时感知：结果写进 screen.watch', watchState.instances[0].screen?.watch?.title === 'VS Code')
  const t2 = await screenWatchTick(watchState, () => {}, { getForegroundTitle: fakeRead })
  check('定时感知：未到间隔不重复读', t2.read.length === 0 && readCount === 1, JSON.stringify(t2))
  watchState.instances[0].screen.watch.at = new Date(Date.now() - 20000).toISOString()
  const t3 = await screenWatchTick(watchState, () => {}, { getForegroundTitle: fakeRead })
  check('定时感知：到间隔会读第二次', t3.read.length === 1 && readCount === 2, JSON.stringify(t3))
  // 设置页关掉定时感知：下一次 tick 立刻停（不用重建定时器）
  watchState.instances[0].config.screenWatchEnabled = false
  watchState.instances[0].screen.watch.at = new Date(Date.now() - 60000).toISOString()
  const t4 = await screenWatchTick(watchState, () => {}, { getForegroundTitle: fakeRead })
  check('定时感知：关掉后下一次 tick 不读', t4.read.length === 0 && readCount === 2, JSON.stringify(t4))
  // auto 模式：后台定时器也不能读
  watchState.instances[0].config.screenWatchEnabled = true
  watchState.instances[0].config.mode = 'auto'
  const t5 = await screenWatchTick(watchState, () => {}, { getForegroundTitle: fakeRead })
  check('定时感知：auto 模式跳过', t5.read.length === 0 && readCount === 2, JSON.stringify(t5))
  // 读屏总开关关掉也跳过
  watchState.instances[0].config.mode = 'manual'
  watchState.instances[0].config.screenReadEnabled = false
  const t6 = await screenWatchTick(watchState, () => {}, { getForegroundTitle: fakeRead })
  check('定时感知：读屏总开关关闭时跳过', t6.read.length === 0 && readCount === 2, JSON.stringify(t6))
  // 间隔改小（下限仍 15s）：改完立即按新值算
  watchState.instances[0].config.screenReadEnabled = true
  watchState.instances[0].config.screenWatchIntervalMs = 15000
  watchState.instances[0].screen.watch.at = new Date(Date.now() - 16000).toISOString()
  const t7 = await screenWatchTick(watchState, () => {}, { getForegroundTitle: fakeRead })
  check('定时感知：间隔热更新生效', t7.read.length === 1 && readCount === 3, JSON.stringify(t7))

  // 预设交互：点模型/摸头 → 动作 + 冷却；空闲循环受 idlePresets 控制
  const presetSent = []
  const presetState = apply(makeCtx(), {
    autoOpenWindow: false,
    instances: [{ id: 'inst-1', sessionId: 's-auto', mode: 'manual', autoInteract: true, idlePresets: true }],
  })
  presetState.windows = { send: (command) => { presetSent.push(command); return { ok: true } }, status: () => ({}), open: () => ({}), close: () => ({}) }
  presetState.instances[0].window = { ready: true, state: 'rendering' }
  const pinst = presetState.instances[0]
  const headTap = handlePresetTap(presetState, pinst, 'head', () => {})
  check('预设：摸头触发动作', headTap.ok === true && headTap.action === 'happy' && presetSent.length === 1, JSON.stringify(headTap))
  const again = handlePresetTap(presetState, pinst, 'head', () => {})
  check('预设：冷却期内不重复触发', again.ok === false && again.code === 'preset-cooldown', JSON.stringify(again))
  pinst.preset.lastAt = Date.now() - 5000
  const bodyTap = handlePresetTap(presetState, pinst, 'body', () => {})
  check('预设：戳身体走另一组动作', bodyTap.ok === true && ['nod', 'shake', 'surprised'].includes(bodyTap.action), JSON.stringify(bodyTap))
  pinst.config.autoInteract = false
  const offTap = handlePresetTap(presetState, pinst, 'head', () => {})
  check('预设：开关关闭时不触发', offTap.ok === false && offTap.code === 'preset-disabled', JSON.stringify(offTap))
  pinst.config.autoInteract = true
  // 空闲循环：第一次只记基线；关掉 idlePresets 不再发
  const before = presetSent.length
  const loop1 = startPresetLoop(presetState, () => {}, () => {})
  clearInterval(loop1)
  check('预设：空闲循环首轮只记基线', presetSent.length === before && Boolean(pinst.preset.idleAt), String(presetSent.length - before))
  pinst.config.idlePresets = false
  pinst.preset.idleAt = Date.now() - 60000
  const loop2 = startPresetLoop(presetState, () => {}, () => {})
  clearInterval(loop2)
  check('预设：idlePresets 关闭时不动', presetSent.length === before, String(presetSent.length - before))

  // 自定义动作 / 循环序列：校验、菜单构建、播放、启停
  const actWarn = []
  const customOk = normalizeCustomActions([
    { id: 'wave', label: '挥手', durationMs: 1200, tracks: [{ param: 'headZ', keys: [[0, 0], [0.5, 12], [1, 0]] }] },
  ], actWarn)
  check('自定义动作：合法定义通过', customOk.length === 1 && customOk[0].tracks.length === 1 && actWarn.length === 0, JSON.stringify(customOk[0] ?? null))
  const actWarn2 = []
  const customBad = normalizeCustomActions([
    { id: 'Bad Id', tracks: [{ param: 'headX', keys: [[0, 0]] }] },
    { id: 'nod', tracks: [{ param: 'headX', keys: [[0, 0]] }] },
    { id: 'nokeys', tracks: [] },
  ], actWarn2)
  check('自定义动作：非法 id / 内置重名 / 无轨道都被拒', customBad.length === 0 && actWarn2.length === 3, String(actWarn2.length))

  const seqWarn = []
  const seqOk = normalizePresetSequences([{ id: 'loop1', steps: ['happy', 'nod'], intervalMs: 2000, loop: true }], seqWarn)
  check('循环序列：合法定义通过', seqOk.length === 1 && seqOk[0].steps.length === 2 && seqWarn.length === 0, JSON.stringify(seqOk[0] ?? null))
  const seqWarn2 = []
  const seqBad = normalizePresetSequences([{ id: 'loop2', steps: [] }], seqWarn2)
  check('循环序列：空步骤被拒', seqBad.length === 0 && seqWarn2.length === 1, String(seqWarn2.length))

  pinst.config.customActions = customOk
  pinst.config.presetSequences = seqOk
  const presets = buildPresets(pinst)
  check('buildPresets：内置 + 自定义都进菜单', presets.actions.length >= 13 && presets.actions.some((a) => a.id === 'wave') && presets.sequences.length === 1, String(presets.actions.length))

  const played = playPreset(presetState, pinst, 'wave', () => {})
  check('预设动作：自定义动作可播', played.ok === true && played.action === 'wave', JSON.stringify(played))
  const unknownPreset = playPreset(presetState, pinst, 'nope', () => {})
  check('预设动作：未知动作拒绝', unknownPreset.ok === false && unknownPreset.code === 'unknown-action', JSON.stringify({ code: unknownPreset.code }))

  const started = startPresetSequence(presetState, pinst, 'loop1', () => {})
  check('循环：启动后记录运行态', started.ok === true && pinst.presetRun?.id === 'loop1', JSON.stringify(started))
  const stopped = stopPresetSequence(presetState, pinst)
  check('循环：停止后清空运行态', stopped.ok === true && pinst.presetRun === null, JSON.stringify(stopped))
  const missingSeq = startPresetSequence(presetState, pinst, 'no-such', () => {})
  check('循环：未知序列拒绝', missingSeq.ok === false && missingSeq.code === 'no-such-sequence', JSON.stringify({ code: missingSeq.code }))

  // 截图工具：未开「允许截图」→ 拒绝；开了但没确认 → 要求先问；落盘只留最近 10 张
  const captureTool = tools.find((t) => t.name === 'live2d_screen_capture')
  const toolCtx = { agent: { session: { id: 'session-tool-a' } } }
  inst.config.screenCaptureEnabled = false
  const capOff = await captureTool.execute({}, toolCtx)
  check('截图工具：未开允许截图时拒绝', capOff.ok === false && String(capOff.summary).includes('screen-capture-disabled'), capOff.summary)
  inst.config.screenCaptureEnabled = true
  inst.config.screenCaptureAutoConfirm = false
  const capConfirm = await captureTool.execute({}, toolCtx)
  check('截图工具：没确认时要求先问', capConfirm.ok === false && String(capConfirm.summary).includes('needs-confirm'), capConfirm.summary)
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live2d-shot-'))
  const pngPath = saveCapturePng(Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'), shotDir)
  const head = fs.readFileSync(pngPath).subarray(0, 4).toString('hex')
  check('截图落盘：写出 PNG 文件', fs.existsSync(pngPath) && head === '89504e47', head)
  for (let i = 0; i < 14; i += 1) saveCapturePng('AAAA', shotDir, new Date(Date.now() + i * 1000))
  pruneCaptureDir(shotDir, 10)
  const kept = fs.readdirSync(shotDir).filter((name) => name.endsWith('.png')).length
  check('截图落盘：只保留最近 10 张', kept === 10, String(kept))
  fs.rmSync(shotDir, { recursive: true, force: true })

  const noTools = registerLive2dTools({ get() {}, tools: undefined }, state, { info() {}, warn() {}, error() {} })
  check('工具：宿主没有 tools 服务时安全降级', typeof noTools === 'function', typeof noTools)
  noTools()

  const registered = []
  const dispose = registerLive2dTools({ tools: { register: (tool) => { registered.push(tool.name); return () => {} } } }, state, { info() {}, warn() {}, error() {} })
  check('工具：可注册到宿主', registered.length === 9, registered.join(','))
  dispose()
}

// --- 0.13.0：权限四维 / 唤醒额度 / 唤醒计划 --------------------------------
{
  const inst = {
    id: 'inst-1',
    config: { mode: 'semi', sessionId: 's1', aiMoveEnabled: false, wakeMaxPerHour: 60 },
    wake: { state: 'idle', times: [] },
  }
  check('权限：anim 在 auto 拒绝', canControl({ config: { mode: 'auto' } }, 'anim', { source: 'tool' }) === false)
  check('权限：anim 在 semi 允许', canControl(inst, 'anim', { source: 'tool' }) === true)
  check('权限：bubble 在 auto + window-chat 允许', canControl({ config: { mode: 'auto' } }, 'bubble', { source: 'window-chat' }) === true)
  check('权限：bubble 在 auto + wake-button 允许', canControl({ config: { mode: 'auto' } }, 'bubble', { source: 'wake-button' }) === true)
  check('权限：bubble 在 auto + wake-timer 拒绝', canControl({ config: { mode: 'auto' } }, 'bubble', { source: 'wake-timer' }) === false)
  check('权限：bubble 在 auto + external-chat 拒绝', canControl({ config: { mode: 'auto' } }, 'bubble', { source: 'external-chat' }) === false)
  check('权限：screen 按钮唤醒恒允许', canControl({ config: { mode: 'auto' } }, 'screen', { source: 'wake-button' }) === true)
  check('权限：window 需 manual + aiMoveEnabled',
    canControl({ config: { mode: 'manual', aiMoveEnabled: false } }, 'window', { source: 'tool' }) === false
    && canControl({ config: { mode: 'manual', aiMoveEnabled: true } }, 'window', { source: 'tool' }) === true
    && canControl({ config: { mode: 'semi', aiMoveEnabled: true } }, 'window', { source: 'tool' }) === false)

  const now = Date.now()
  const fresh = { config: { wakeMaxPerHour: 3 }, wake: { times: [now - 1000, now - 2000] } }
  check('额度：未满时 ok 且剩余 1', wakeQuota(fresh, now).ok === true && wakeQuota(fresh, now).remaining === 1)

  const full = { config: { wakeMaxPerHour: 2 }, wake: { times: [now - 1000, now - 2000] } }
  const fullQuota = wakeQuota(full, now)
  check('额度：满时返回 nextAt', fullQuota.ok === false && typeof fullQuota.nextAt === 'string', String(fullQuota.nextAt))

  // 滚动窗口：1 小时前的记录不该再占额度
  const old = { config: { wakeMaxPerHour: 2 }, wake: { times: [now - WAKE_HISTORY_MS - 5000, now - 1000] } }
  check('额度：滚动 60 分钟，过期记录不计入', wakeQuota(old, now).used === 1, String(wakeQuota(old, now).used))

  check('唤醒计划：未绑定会话直接拒绝', wakePlan({ config: { mode: 'semi', sessionId: '' } }, 'wake-timer').code === 'wake-no-session')
  check('唤醒计划：auto + 定时拒绝', wakePlan({ config: { mode: 'auto', sessionId: 's1' } }, 'wake-timer').code === 'wake-forbidden')
  check('唤醒计划：auto + 按钮允许', wakePlan({ config: { mode: 'auto', sessionId: 's1', wakeMaxPerHour: 60 } }, 'wake-button').ok === true)
  check('唤醒计划：额度满给 429 与提示',
    wakePlan({ config: { mode: 'semi', sessionId: 's1', wakeMaxPerHour: 1 }, wake: { state: 'idle', times: [now - 1000] } }, 'wake-timer').code === 'wake-quota')
  check('唤醒计划：上一轮未结束 → wake-busy',
    wakePlan({ config: { mode: 'semi', sessionId: 's1', wakeMaxPerHour: 60 }, wake: { state: 'waiting-reply', times: [] } }, 'wake-timer').code === 'wake-busy')

  const text = buildWakeMessage(
    { config: { mode: 'semi' } },
    { title: 'Plain Craft Launcher', process: 'PCL', shots: ['C:\\tmp\\a.png', 'C:\\tmp\\b.png'], mode: 'capture' },
    'wake-timer',
    now,
  )
  check('唤醒消息：带标题、截图路径与语气要求',
    text.includes('Plain Craft Launcher') && text.includes('a.png') && text.includes('read_image') && text.includes('主动'),
    text.slice(0, 80))

  const autoText = buildWakeMessage({ config: { mode: 'auto' } }, { title: '', shots: [], mode: 'none' }, 'wake-button', now)
  check('唤醒消息：auto 下明确要求不做动作', autoText.includes('不要做动作'), autoText.slice(0, 60))

  const quotaInst = { id: 'inst-9', config: { mode: 'semi', sessionId: 's1', wakeMaxPerHour: 1 }, wake: { times: [now - 500] } }
  const blocked = requestWake({ ctx: {}, disposed: false }, quotaInst, 'wake-button', () => {})
  check('按钮唤醒：额度满立刻返回 429', blocked.ok === false && blocked.status === 429, blocked.error)
  check('按钮唤醒：被拦下时不进入 busy', quotaInst.wake.state === 'idle' || quotaInst.wake.state === undefined, String(quotaInst.wake.state))

  // 0.13.3：按说明生成动作（模板匹配 / 回落 / 事件默认启用）
  const angryDraft = designAction('生气', '')
  check('生成动作：命中「生气」模板', angryDraft.matched === 'angry' && angryDraft.tracks.length > 0, String(angryDraft.matched))
  const genericDraft = designAction('xyzzy', '完全匹配不到的说明')
  check('生成动作：无匹配回落通用模板', genericDraft.matched === null && genericDraft.tracks.length > 0, String(genericDraft.matched))
  check('生成动作：id 合法', /^[a-z][a-z0-9_-]{1,23}$/.test(angryDraft.id), angryDraft.id)
  const enabledCfg = normalizeConfig({}).config
  check('实例默认启用', enabledCfg.instances[0].enabled === true, String(enabledCfg.instances[0].enabled))

  // 0.13.4 回归：唤醒运行态 / 回复去重 / 窗口超时参数
  const doneInst = { config: { mode: 'semi', sessionId: 's1', wakeMaxPerHour: 60 }, wake: { state: 'completed', times: [] } }
  check('唤醒计划：completed 不再永久锁死', wakePlan(doneInst, 'wake-button').ok === true, wakePlan(doneInst, 'wake-button').code)
  const stillRunning = { config: { mode: 'semi', sessionId: 's1', wakeMaxPerHour: 60 }, wake: { state: 'waiting-reply', times: [] } }
  check('唤醒计划：waiting-reply 仍算忙', wakePlan(stillRunning, 'wake-button').code === 'wake-busy')

  const claimInst = { bubble: {} }
  check('去重：同 messageId 第二次让出', claimReply(claimInst, 'id:m1') === true && claimReply(claimInst, 'id:m1') === false)
  check('去重：另一个 messageId 可进', claimReply(claimInst, 'id:m2') === true)
  claimInst.bubble.claim = null
  check('去重：文本键 5 秒内重复让出', claimReply(claimInst, 'text:abc', 10000) === true && claimReply(claimInst, 'text:abc', 12000) === false)
  claimInst.bubble.claim = null
  check('去重：文本键过 5 秒可再来', claimReply(claimInst, 'text:abc', 20000) === true || claimReply(claimInst, 'text:abc', 40000) === true)

  const timeoutPayload = windowConfigPayload({ chatTimeoutMs: 150000 })
  check('窗口配置带 chatTimeoutMs', timeoutPayload.chatTimeoutMs === 150000, String(timeoutPayload.chatTimeoutMs))
}

// --- 0.1.0：模式不跨重启保留 ------------------------------------------------
{
  const saved = pickPersisted({
    instances: [
      { id: 'inst-1', mode: 'semi', sessionId: 's1' },
      { id: 'inst-2', mode: 'manual', sessionId: 's2' },
    ],
    modelPath: 'X',
  })
  check('落盘：剥掉实例的 mode', saved.instances.every((item) => item.mode === undefined))
  check('落盘：其它实例字段保留', saved.instances[0].sessionId === 's1' && saved.modelPath === 'X')

  // 加载时强制回到默认「手动」（内部 auto），不继承 config.json 里的旧模式
  const ctx = makeCtx()
  const cfgFile = ctx.__live2dConfigFile
  fs.writeFileSync(cfgFile, JSON.stringify({ instances: [{ id: 'inst-1', mode: 'semi', sessionId: 's1' }] }), 'utf8')
  const state = apply(ctx, { enabled: true, shellSelfTest: false, autoOpenWindow: false })
  check('加载：旧 mode 被复位为默认', state.config.instances[0].mode === 'auto', String(state.config.instances[0].mode))
  try { fs.unlinkSync(cfgFile) } catch { /* 临时文件可能已被清掉 */ }
}

// --- 0.1.4：预设工具暴露 id / 停用实例真的关窗 ------------------------------
{
  const ctx = makeCtx()
  const st = apply(ctx, { enabled: true, shellSelfTest: false, autoOpenWindow: false })
  const tools = createLive2dTools(st, { info() {}, warn() {}, error() {} })
  const preset = (tools ?? []).find((item) => item.name === 'live2d_preset')
  check('预设工具：schema 暴露 id', preset?.parameters?.properties?.id?.type === 'string')

  const inst = st.instances[0]
  const sent = []
  st.windows = { send: (command, id) => { sent.push({ type: command?.type, id }); return { ok: true } } }
  inst.window.state = 'running'
  inst.window.ready = true
  const result = deactivateInstance(st, inst)
  check('停用实例：下发关窗命令', result.ok === true && sent.some((item) => item.type === 'pool:close'), JSON.stringify(sent))
  check('停用实例：窗口状态复位', inst.window.state === 'stopped' && inst.window.ready === false)
}

console.log('')
if (unhandled.length > 0) {
  console.log(`❌ 出现 ${unhandled.length} 次 unhandled rejection：${JSON.stringify(unhandled)}`)
  failed += 1
}
if (failed > 0) {
  console.log(`❌ ${failed} 项未通过`)
  process.exitCode = 1
} else {
  console.log('✅ 阶段 1 自测全部通过')
}

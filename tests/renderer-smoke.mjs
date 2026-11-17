// 渲染层冒烟测试：长文是否真的溢出、滚动条是否真的显示、短文本是否不误报。
// 独立进程跑（起 Electron 窗口，约 15 秒），不进 tests/shell.mjs。
// 用法：node tests/renderer-smoke.mjs
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const pluginDir = path.resolve(import.meta.dirname, '..')
const mod = await import(pathToFileURL(path.join(pluginDir, 'index.js')).href)

const modelPath = process.env.LIVE2D_SMOKE_MODEL || process.argv[2] || ''
if (!modelPath) {
  console.log('SKIP  renderer-smoke：请通过 LIVE2D_SMOKE_MODEL 或第一个参数传入本地测试模型目录')
  process.exit(0)
}
const model = mod.modelProbe(modelPath)
const config = {
  // 故意给一个远超任何工作区的坐标：主进程必须先夹回屏幕，再触发 ready。
  modelPath, windowWidth: 240, windowHeight: 1000, windowX: 99999, windowY: 99999,
  bubbleDurationMs: 8000, bubbleQueueLimit: 3, bubbleMaxChars: 120,
  rendererEnabled: true, clickThrough: true, adjustMode: false,
  replyStyle: 'bubble', bubbleSkin: 'cloud', replyOpacity: 0.9,
  replyFontSize: 16, replyMaxHeightPct: 70,
  // 顺手覆盖预设动作路径：init 里带 presets，applyPresets/右键菜单初始化不能抛错
  presets: {
    actions: [
      { id: 'auto-demo', label: '自动动作', kind: 'custom', auto: true, durationMs: 120, tracks: [{ param: 'headY', keys: [[0, 0], [0.5, 4], [1, 0]] }] },
      { id: 'cap-demo', label: '模型自带', kind: 'custom', capability: true, hold: true, durationMs: 120, tracks: [{ param: 'headZ', keys: [[0, 'current'], [1, 8]] }] },
      { id: 'face-demo', label: '面部保持', kind: 'custom', hold: true, durationMs: 120, tracks: [{ param: 'mouthForm', keys: [[0, 0], [1, 0.8]] }] },
      { id: 'ratio-wave', label: '三段挥手', kind: 'custom', durationMs: 120, tracks: [
        { param: 'shoulderR', keys: [[0, 0], [0.5, -40], [1, 0]] },
        { param: 'elbowR', keys: [[0, 0], [0.5, 38], [1, 0]] },
        { param: 'wristR', keys: [[0, 0], [0.5, 34], [1, 0]] },
      ] },
      { id: 'wave', label: '挥手', kind: 'custom', durationMs: 600, tracks: [{ param: 'headZ', keys: [[0, 0], [0.5, 8], [1, 0]] }] },
    ],
    sequences: [
      { id: 'loop-demo', label: '循环', steps: ['auto-demo'], intervalMs: 1000, loop: true },
      { id: 'user-loop', label: '设置页循环', steps: ['wave'], intervalMs: 2000, loop: true },
    ],
  },
}
const capabilityScan = mod.scanModelCapability(modelPath)
const chestMotion = capabilityScan.motions?.find((item) => item.label === '抚胸')
if (chestMotion) {
  config.presets.actions.push({
    id: 'motion-chest-test',
    label: chestMotion.label,
    kind: 'custom',
    capability: true,
    hold: true,
    durationMs: chestMotion.durationMs,
    tracks: chestMotion.tracks,
  })
}
const chestScreenshotPath = process.env.LIVE2D_CHEST_SCREENSHOT || ''
const life = {
  attention: 'focused', willingness: 'social', energy: 0.72, mood: 0.18, boredom: 0.2,
  closeness: 0.4, dailyShare: 1, dailyShareMax: 5, dailyImportant: 0, dailyImportantMax: 3,
  lastUserActivityAt: Date.now() - 120000, lastEvent: 'focus-milestone', lastDecision: { speak: false, reason: 'nonverbal-only' },
}
const LONG = '这是一段用来验证滚动条与长文溢出的中文测试文本。'.repeat(50)

const exe = mod.resolveElectronExe()
if (!exe.ok) {
  console.error('FAIL 找不到 electron.exe：' + exe.hint)
  process.exit(2)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// 冒烟测试不能碰用户的真实窗口/缓存：给 Electron 一个临时 userData。
// 必须放系统临时目录（LOCALAPPDATA 同盘）：D 盘中文路径下 Chromium 建缓存会被拒（0x80000003 的直接来源）。
const smokeUserData = process.env.LIVE2D_SMOKE_USERDATA
  || fs.mkdtempSync(path.join(os.tmpdir(), 'live2d-smoke-'))
env.LIVE2D_PROBE_USERDATA = smokeUserData
const poseScreenshotPath = process.env.LIVE2D_POSE_SCREENSHOT || ''
let poseProbeParams = null
try {
  const parsed = process.env.LIVE2D_POSE_PARAMS_JSON ? JSON.parse(process.env.LIVE2D_POSE_PARAMS_JSON) : null
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) poseProbeParams = parsed
} catch { poseProbeParams = null }
const childArgs = ['--no-sandbox', path.join(pluginDir, 'electron', 'main.cjs')]
const child = spawn(exe.path, childArgs, {
  cwd: pluginDir, stdio: ['ignore', 'pipe', 'pipe'], env,
})
const stderrLog = []
const rendererLog = []
child.stderr.on('data', (chunk) => stderrLog.push(String(chunk)))

let socket = null
let buf = ''
let phase = 'waiting'
let passed = 0
let failed = 0
let poseVisual = null
const timer = setTimeout(() => finish('TIMEOUT'), Number(process.env.LIVE2D_SMOKE_TIMEOUT_MS) || 60000)

function check(ok, label, detail = '') {
  if (ok) { passed += 1; console.log(`PASS ${label}${detail ? ' ' + detail : ''}`) }
  else { failed += 1; console.log(`FAIL ${label}${detail ? ' ' + detail : ''}`) }
}
function finish(reason) {
  if (phase === 'done') return
  phase = 'done'
  clearTimeout(timer)
  if (reason) {
    failed += 1
    console.log(`FAIL ${reason}`)
    // 失败时把可用信息全打出来：stderr 常为空，只报退出码没法定位（审查 P1-3）
    console.log(`  electron: ${exe.path}`)
    console.log(`  args: ${childArgs.join(' ')}`)
    console.log(`  cwd: ${pluginDir}`)
    console.log(`  userData: ${smokeUserData}`)
    const tail = stderrLog.join('').trim().slice(-2000)
    if (tail) console.log('--- electron stderr ---\n' + tail + '\n--- end stderr ---')
    else console.log('--- electron stderr 为空 ---')
    if (rendererLog.length) {
      console.log('--- renderer messages ---')
      for (const line of rendererLog.slice(-20)) console.log(line)
      console.log('--- end renderer messages ---')
    }
  }
  try {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    else child.kill()
  } catch { /* ignore */ }
  try { fs.rmSync(smokeUserData, { recursive: true, force: true }) } catch { /* 删不掉不影响结论 */ }
  console.log(`RESULT pass=${passed} fail=${failed}`)
  process.exit(failed === 0 ? 0 : 1)
}
child.on('error', (error) => finish(`Electron 启动失败：${error && error.message}`))
child.on('exit', (code, signal) => {
  if (phase === 'done') return
  finish(`Electron 提前退出 code=${code} signal=${signal}`)
})
function send(command) {
  socket?.write(JSON.stringify({ __live2d: 1, ...command }) + '\n')
}
function continueToMenu() {
  phase = 'menu'
  send({ type: 'debug-menu', instanceId: 'inst-1', which: 'preset', x: 40, y: 40, clickFirstAction: true })
}
function continueAfterChest() {
  continueToMenu()
}

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    const m = /\[live2d-window\]\s+port=(\d{2,5})/.exec(line)
    if (m && !socket) connect(Number(m[1]))
  }
})

function connect(port) {
  socket = net.connect({ host: '127.0.0.1', port })
  socket.setEncoding('utf8')
  let buffer = ''
  socket.on('connect', () => {
    send({ type: 'pool:create', instanceId: 'inst-1', config: mod.windowConfigPayload(config, config.presets, life), title: '渲染冒烟' })
  })
  socket.on('data', (chunk) => {
    buffer += chunk
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim()
      buffer = buffer.slice(i + 1)
      if (!line) continue
      let msg = null
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.type === 'console') {
        rendererLog.push(`renderer[${msg.level}] ${msg.message}`)
        continue
      }
      if (msg.type === 'state' && msg.phase === 'model-params') {
        check(msg.paramMeta && Object.keys(msg.paramMeta).length > 0,
          '模型参数范围已上报给设置页和 AI', JSON.stringify({ count: msg.count, metaCount: Object.keys(msg.paramMeta || {}).length, rArm: msg.paramMeta?.RArm, rForearm: msg.paramMeta?.RForearm }))
        continue
      }
      if (msg.type === 'error') {
        const detail = `error ${msg.code ?? ''} ${msg.error ?? ''}`.trim()
        rendererLog.push(detail)
        finish(detail)
        continue
      }
      if (msg.type === 'state') {
        const extra = [
          msg.seq === undefined ? '' : `seq=${msg.seq}`,
          msg.lastSeq === undefined ? '' : `lastSeq=${msg.lastSeq}`,
          msg.overflowing === undefined ? '' : `overflow=${msg.overflowing}`,
          msg.chars === undefined ? '' : `chars=${msg.chars}`,
          msg.replyMode === undefined ? '' : `mode=${msg.replyMode}`,
          msg.wraps === undefined ? '' : `wraps=${msg.wraps}`,
          msg.height === undefined ? '' : `height=${msg.height}`,
          msg.scrollHeight === undefined ? '' : `scrollHeight=${msg.scrollHeight}`,
        ].filter(Boolean).join(' ')
        rendererLog.push(`state ${msg.phase}${extra ? ` ${extra}` : ''}`)
      }
      if (msg.type === 'ready' && phase === 'waiting') {
        check(
          msg.bounds && msg.bounds.x < 90000 && msg.bounds.y < 90000,
          '超界窗口在 ready 前夹回工作区',
          JSON.stringify(msg.bounds),
        )
        phase = 'init'
        send({
          type: 'init', instanceId: 'inst-1', title: '渲染冒烟', sessionId: null,
          config: mod.windowConfigPayload(config, config.presets, life),
          model: mod.initPayload({ config, model, id: 'inst-1' }).model,
        })
        continue
      }
      if (msg.type === 'state' && msg.phase === 'vendor-cubism4-color-compat') {
        check(msg.active === true, 'Cubism 4.2 颜色兼容层已启用')
        continue
      }
      if (msg.type === 'state' && msg.phase === 'rendering' && phase === 'init') {
        phase = 'holds'
        send({ type: 'debug-hold-check', instanceId: 'inst-1' })
        continue
      }
      if (msg.type === 'state' && msg.phase === 'hold-check' && phase === 'holds') {
        check(msg.preserveIndependentHolds === true
          && msg.heldActions.includes('face-demo')
          && msg.heldActions.includes('cap-demo'),
        '不同参数骨架的保持动作可以同时存在', JSON.stringify(msg))
        phase = 'self-capture'
        send({ type: 'screenshot', instanceId: 'inst-1', id: 'self-view-test' })
        continue
      }
      if (msg.type === 'screenshot' && phase === 'self-capture') {
        check(msg.ok === true && String(msg.base64 || '').startsWith('iVBOR'),
          'AI 自检只能通过模型窗口 capturePage 取图', JSON.stringify({ ok: msg.ok, id: msg.id, bytes: String(msg.base64 || '').length }))
        phase = 'action-test'
        send({ type: 'anim', instanceId: 'inst-1', action: 'ratio-wave', performance: null })
        continue
      }
      if (msg.type === 'anim-done' && phase === 'action-test') {
        check(msg.action === 'ratio-wave', '肩肘腕三段挥手能正常执行且无生命感参数不报错', JSON.stringify(msg))
        phase = 'pose-open'
        send({
          type: 'pose-editor-open',
          instanceId: 'inst-1',
          action: config.presets.actions.find((item) => item.id === 'ratio-wave'),
        })
        continue
      }
      if (msg.type === 'state' && msg.phase === 'pose-editor-loaded' && phase === 'pose-open') {
        check(msg.sourceActionId === 'ratio-wave' && msg.steps?.length === 3,
          '姿势设计器可载入已有动作并还原起始/中间/最终步骤', JSON.stringify({ source: msg.sourceActionId, steps: msg.steps?.length }))
        check(msg.steps?.every((step) => step.params === 3) && msg.handles > 0,
          '载入后的每步参数与可拖拽骨架控制点已生成', JSON.stringify({ params: msg.steps?.map((step) => step.params), handles: msg.handles }))
        const screenLeftArm = (msg.handleBindings ?? []).filter((item) => /屏幕左(?:肩|肘|手)/.test(item.label))
        const expectedLeft = msg.armSides?.left === 'L' ? 'L' : 'R'
        check(screenLeftArm.some((item) => item.bindings?.some((binding) => new RegExp(`^(?:shoulder|elbow|wrist|hand)${expectedLeft}$`).test(binding.logical)))
          && !screenLeftArm.some((item) => item.bindings?.some((binding) => new RegExp(`^(?:shoulder|elbow|wrist|hand)${expectedLeft === 'L' ? 'R' : 'L'}$`).test(binding.logical))),
        '屏幕左侧骨架控制点按实际网格位置自适应绑定', JSON.stringify({ side: msg.armSides, calibration: msg.armCalibration, handles: screenLeftArm }))
        check(msg.modelFrozen === true && msg.ignoringMouse === false,
          '姿势编辑期间模型冻结且窗口不再鼠标穿透', JSON.stringify({ frozen: msg.modelFrozen, ignore: msg.ignoringMouse }))
        check(Number(msg.editorOffset) > 0,
          '模型按右侧参数栏之外的可用区域向左重新居中', JSON.stringify({ offset: msg.editorOffset }))
        poseVisual = {
          bounds: msg.modelBounds,
          viewport: msg.viewport,
          before: '',
        }
        phase = 'pose-hit-close'
        send({ type: 'debug-interactive', instanceId: 'inst-1', id: 'hit-close', x: msg.closeCenter?.x, y: msg.closeCenter?.y })
        continue
      }
      if (msg.type === 'state' && msg.phase === 'interactive-probe' && msg.id === 'hit-close' && phase === 'pose-hit-close') {
        check(msg.interactive === true && msg.ignoringMouse === false && msg.element?.id === 'pose-editor-close',
          '设计器关闭按钮可以收到鼠标点击', JSON.stringify({ interactive: msg.interactive, ignore: msg.ignoringMouse, element: msg.element }))
        phase = 'pose-hit-handle'
        send({ type: 'debug-pose-editor', instanceId: 'inst-1', id: 'hit-handle-coords', action: 'snapshot' })
        continue
      }
      if (msg.type === 'pose-editor-debug' && msg.id === 'hit-handle-coords' && phase === 'pose-hit-handle') {
        phase = 'pose-hit-handle-probe'
        send({
          type: 'debug-interactive',
          instanceId: 'inst-1',
          id: 'hit-handle',
          x: msg.result?.firstHandleCenter?.x,
          y: msg.result?.firstHandleCenter?.y,
        })
        continue
      }
      if (msg.type === 'state' && msg.phase === 'interactive-probe' && msg.id === 'hit-handle' && phase === 'pose-hit-handle-probe') {
        check(msg.interactive === true && msg.ignoringMouse === false && String(msg.element?.cls || '').includes('pose-handle'),
          '骨架控制点可以收到鼠标拖动', JSON.stringify({ interactive: msg.interactive, ignore: msg.ignoringMouse, element: msg.element }))
        const bounds = poseVisual?.bounds
        const viewport = poseVisual?.viewport
        const rect = bounds && viewport
          ? {
            x: Math.max(0, Math.floor(bounds.x)),
            y: Math.max(0, Math.floor(bounds.y)),
            width: Math.max(1, Math.min(Math.ceil(bounds.width), viewport.width - Math.max(0, Math.floor(bounds.x)))),
            height: Math.max(1, Math.min(Math.ceil(bounds.height), viewport.height - Math.max(0, Math.floor(bounds.y)))),
          }
          : undefined
        poseVisual = { ...(poseVisual ?? {}), rect }
        phase = 'pose-visual-before'
        send({ type: 'screenshot', instanceId: 'inst-1', id: 'pose-visual-before', rect })
        continue
      }
      if (msg.type === 'screenshot' && msg.id === 'pose-visual-before' && phase === 'pose-visual-before') {
        poseVisual.before = String(msg.base64 || '')
        phase = 'pose-visual-change'
        if (poseProbeParams) {
          send({ type: 'debug-pose-editor', instanceId: 'inst-1', id: 'pose-visual-change', action: 'set-params', params: poseProbeParams })
        } else {
          send({ type: 'debug-pose-editor', instanceId: 'inst-1', id: 'pose-visual-change', action: 'add-param', param: 'headX', value: 25 })
        }
        continue
      }
      if (msg.type === 'pose-editor-debug' && msg.id === 'pose-visual-change' && phase === 'pose-visual-change') {
        phase = 'pose-visual-after'
        send({ type: 'screenshot', instanceId: 'inst-1', id: 'pose-visual-after', rect: poseVisual?.rect })
        continue
      }
      if (msg.type === 'screenshot' && msg.id === 'pose-visual-after' && phase === 'pose-visual-after') {
        check(Boolean(poseVisual?.before) && String(msg.base64 || '') !== poseVisual.before,
          '修改姿势参数后模型画面真实发生变化', JSON.stringify({ beforeBytes: poseVisual?.before?.length ?? 0, afterBytes: String(msg.base64 || '').length }))
        if (poseScreenshotPath) {
          phase = 'pose-screenshot'
          send({ type: 'screenshot', instanceId: 'inst-1', id: 'pose-editor-visual' })
        } else {
          phase = 'pose-add-middle'
          send({ type: 'debug-pose-editor', instanceId: 'inst-1', id: 'pose-add', action: 'add-middle' })
        }
        continue
      }
      if (msg.type === 'screenshot' && msg.id === 'pose-editor-visual' && phase === 'pose-screenshot') {
        let saved = false
        try {
          fs.mkdirSync(path.dirname(poseScreenshotPath), { recursive: true })
          fs.writeFileSync(poseScreenshotPath, Buffer.from(String(msg.base64 || ''), 'base64'))
          saved = fs.statSync(poseScreenshotPath).size > 0
        } catch { saved = false }
        check(saved, '姿势设计器截图已保存供人工核对', poseScreenshotPath)
        phase = 'pose-add-middle'
        send({ type: 'debug-pose-editor', instanceId: 'inst-1', id: 'pose-add', action: 'add-middle' })
        continue
      }
      if (msg.type === 'pose-editor-debug' && msg.id === 'pose-add' && phase === 'pose-add-middle') {
        check(msg.result?.steps?.length === 4 && msg.result?.active === 1,
          '可在当前姿势后插入并复制一个中间姿势', JSON.stringify({ steps: msg.result?.steps?.length, active: msg.result?.active }))
        phase = 'pose-add-param'
        send({ type: 'debug-pose-editor', instanceId: 'inst-1', id: 'pose-param', action: 'add-param', param: 'headX', value: 12 })
        continue
      }
      if (msg.type === 'pose-editor-debug' && msg.id === 'pose-param' && phase === 'pose-add-param') {
        check(msg.result?.steps?.[msg.result?.active]?.params >= 4,
          '未使用参数可手动加入当前姿势并参与微调', JSON.stringify(msg.result?.steps?.[msg.result?.active]))
        phase = 'pose-preview'
        send({ type: 'debug-pose-editor', instanceId: 'inst-1', id: 'pose-preview', action: 'preview', durationMs: 300 })
        continue
      }
      if (msg.type === 'pose-editor-debug' && msg.id === 'pose-preview' && phase === 'pose-preview') {
        check(msg.result?.steps?.length === 4, '未保存的多姿势草稿可发起整段预览', JSON.stringify(msg.result?.steps?.length))
        phase = 'pose-preview-playing'
        continue
      }
      if (msg.type === 'anim-done' && msg.action === 'ratio-wave' && phase === 'pose-preview-playing') {
        check(true, '多姿势草稿通过关键帧平滑播放完成')
        phase = 'pose-close'
        send({ type: 'debug-pose-editor', instanceId: 'inst-1', id: 'pose-close', action: 'close' })
        continue
      }
      if (msg.type === 'pose-editor-debug' && msg.id === 'pose-close' && phase === 'pose-close') {
        check(msg.result?.open === false && msg.result?.editorExpanded === false && msg.result?.modelFrozen === false && msg.result?.editorOffset === 0,
          '关闭设计器后恢复普通模型界面与动态效果')
        if (chestMotion) {
          phase = 'motion-chest'
          send({ type: 'anim', instanceId: 'inst-1', action: 'motion-chest-test' })
        } else {
          continueAfterChest()
        }
        continue
      }
      if (msg.type === 'anim-done' && msg.action === 'motion-chest-test' && phase === 'motion-chest') {
        check(true, '未注册 motion3“抚胸”动画可直接播放完成')
        if (chestScreenshotPath) {
          phase = 'motion-chest-shot'
          send({ type: 'screenshot', instanceId: 'inst-1', id: 'motion-chest-shot' })
        } else {
          continueAfterChest()
        }
        continue
      }
      if (msg.type === 'screenshot' && msg.id === 'motion-chest-shot' && phase === 'motion-chest-shot') {
        let saved = false
        try {
          fs.mkdirSync(path.dirname(chestScreenshotPath), { recursive: true })
          fs.writeFileSync(chestScreenshotPath, Buffer.from(String(msg.base64 || ''), 'base64'))
          saved = fs.statSync(chestScreenshotPath).size > 0
        } catch { saved = false }
        check(saved, '抚胸动作截图已保存供人工核对', chestScreenshotPath)
        continueAfterChest()
        continue
      }
      if (msg.type === 'state' && msg.phase === 'preset-menu' && phase === 'menu') {
        check(JSON.stringify(msg.groups) === JSON.stringify(['动作', '循环', '状态']), '右键菜单只保留三个大类', JSON.stringify(msg.groups))
        check(msg.statusRows >= 8, '状态二级菜单带生命状态', `rows=${msg.statusRows}`)
        check(JSON.stringify(msg.statusGroups) === JSON.stringify(['身心状态', '心情明细', '互动关系', '主动感知']),
          '生命感明细使用三级分类菜单', JSON.stringify(msg.statusGroups))
        check(JSON.stringify(msg.actionEntries) === JSON.stringify(['默认动作', '自定义动作', '模型自带', '停止动作']),
          '动作二级菜单固定为默认/自定义/模型自带/停止四项', JSON.stringify(msg.actionEntries))
        check(msg.nestedSubmenuPosition === 'fixed', '三级动作列表使用独立浮层', String(msg.nestedSubmenuPosition))
        check(msg.menuGeometry?.noOverlap === true, '一、二、三级菜单互不遮挡', JSON.stringify(msg.menuGeometry))
        check(msg.menuGeometry?.insideViewport === true, '三级菜单全部位于窗口内', JSON.stringify(msg.menuGeometry))
        check(Number(msg.menuCloseDelayMs) >= 600, '子菜单关闭留出足够的选择时间', String(msg.menuCloseDelayMs))
        check(msg.preserveIndependentHolds === true, '不同骨架保持动作默认允许共存', String(msg.preserveIndependentHolds))
        check(!msg.actionGroups.includes('内置动作'), '动作菜单不再展示写死的内置动作', JSON.stringify(msg.actionGroups))
        check(JSON.stringify(msg.loopEntries) === JSON.stringify(['循环', '循环设置', '停止循环']),
          '循环菜单保留现有循环并提供设置与停止', JSON.stringify(msg.loopEntries))
        phase = 'menu-click'
        continue
      }
      if (msg.type === 'preset-play' && phase === 'menu-click') {
        check(msg.action === 'auto-demo', '右键动作 pointerdown 能派发到宿主', JSON.stringify(msg))
        phase = 'long'
        send({ type: 'bubble', instanceId: 'inst-1', text: LONG, durationMs: 300, seq: 1 })
        continue
      }
      if (msg.type === 'state' && msg.phase === 'reply-metrics') {
        if (phase === 'long') {
          check(msg.chars >= 1000, '长文全量到达渲染层', `chars=${msg.chars}`)
          check(msg.renderedChars === msg.chars, '渲染层没有二次截断', `rendered=${msg.renderedChars}`)
          check(msg.overflowing === true, '容器判定为溢出', `height=${msg.height} scrollHeight=${msg.scrollHeight}`)
          check(msg.scrollbarVisible === true, '自绘滚动条已显示')
          check(msg.mode === 'long', '进入 long 模式', `mode=${msg.mode}`)
          check(msg.bubbleSkin === 'cloud', '云朵气泡皮肤已应用', `skin=${msg.bubbleSkin}`)
          phase = 'short'
          // 等长气泡按 300ms 自动淡出后再发短句，否则容器里还留着长文、溢出判定必然为真
          setTimeout(() => send({ type: 'bubble', instanceId: 'inst-1', text: '短句测试。', durationMs: 5000, seq: 2 }), 1600)
        } else if (phase === 'short') {
          check(msg.overflowing === false, '短文本不误报溢出', `height=${msg.height} scrollHeight=${msg.scrollHeight}`)
          check(msg.scrollbarVisible === false, '短文本不显示滚动条')
          phase = 'presence'
          send({ type: 'presence', instanceId: 'inst-1', position: 'taskbar', durationMs: 200 })
        }
      }
      if (msg.type === 'bounds' && phase === 'presence' && msg.presence === 'taskbar') {
        check(
          msg.bounds && [msg.bounds.x, msg.bounds.y, msg.bounds.width, msg.bounds.height].every(Number.isFinite)
            && msg.bounds.width >= 120 && msg.bounds.height >= 150,
          'P2 语义移动：任务栏位置回报安全边界',
          JSON.stringify(msg.bounds),
        )
        finish(null)
      }
    }
  })
}

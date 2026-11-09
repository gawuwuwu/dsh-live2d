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

// 需要真实模型才能跑：设置 LIVE2D_MODEL_DIR 指向含 .model3.json 的模型目录
const modelPath = process.env.LIVE2D_MODEL_DIR || ''
if (!modelPath || !fs.existsSync(modelPath)) {
  console.error('SKIP renderer-smoke：未设置 LIVE2D_MODEL_DIR（含 .model3.json 的模型目录）')
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
      { id: 'auto-demo', label: '自动动作', kind: 'custom', auto: true, durationMs: 600, tracks: [{ param: 'headY', keys: [[0, 0], [0.5, 4], [1, 0]] }] },
      { id: 'cap-demo', label: '模型自带', kind: 'custom', capability: true, hold: true, durationMs: 600, tracks: [{ param: 'headZ', keys: [[0, 'current'], [1, 8]] }] },
      { id: 'wave', label: '挥手', kind: 'custom', durationMs: 600, tracks: [{ param: 'headZ', keys: [[0, 0], [0.5, 8], [1, 0]] }] },
    ],
    sequences: [
      { id: 'loop-demo', label: '循环', steps: ['auto-demo'], intervalMs: 1000, loop: true },
      { id: 'user-loop', label: '设置页循环', steps: ['wave'], intervalMs: 2000, loop: true },
    ],
  },
}
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
        phase = 'menu'
        send({ type: 'debug-menu', instanceId: 'inst-1', which: 'preset', x: 40, y: 40, clickFirstAction: true })
        continue
      }
      if (msg.type === 'state' && msg.phase === 'preset-menu' && phase === 'menu') {
        check(JSON.stringify(msg.groups) === JSON.stringify(['动作', '循环', '状态']), '右键菜单只保留三个大类', JSON.stringify(msg.groups))
        check(msg.statusRows >= 8, '状态二级菜单带生命状态', `rows=${msg.statusRows}`)
        check(JSON.stringify(msg.actionEntries) === JSON.stringify(['默认动作', '自定义动作', '模型自带', '停止动作']),
          '动作二级菜单固定为默认/自定义/模型自带/停止四项', JSON.stringify(msg.actionEntries))
        check(msg.nestedSubmenuPosition === 'fixed', '三级动作列表使用独立浮层', String(msg.nestedSubmenuPosition))
        check(msg.menuGeometry?.noOverlap === true, '一、二、三级菜单互不遮挡', JSON.stringify(msg.menuGeometry))
        check(msg.menuGeometry?.insideViewport === true, '三级菜单全部位于窗口内', JSON.stringify(msg.menuGeometry))
        check(Number(msg.menuCloseDelayMs) >= 600, '子菜单关闭留出足够的选择时间', String(msg.menuCloseDelayMs))
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

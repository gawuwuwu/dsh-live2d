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

const modelPath = ''
const model = mod.modelProbe(modelPath)
const config = {
  // 故意给一个远超任何工作区的坐标：主进程必须先夹回屏幕，再触发 ready。
  modelPath, windowWidth: 240, windowHeight: 1000, windowX: 99999, windowY: 99999,
  bubbleDurationMs: 8000, bubbleQueueLimit: 3, bubbleMaxChars: 120,
  rendererEnabled: true, clickThrough: true, adjustMode: false,
  replyStyle: 'bubble', replyOpacity: 0.9,
  replyFontSize: 16, replyMaxHeightPct: 70,
  // 顺手覆盖预设动作路径：init 里带 presets，applyPresets/右键菜单初始化不能抛错
  presets: {
    actions: [
      { id: 'wave', label: '挥手', durationMs: 600, tracks: [{ param: 'headZ', keys: [[0, 0], [0.5, 8], [1, 0]] }] },
    ],
    sequences: [{ id: 'user-loop', label: '循环', steps: ['nod'], intervalMs: 1000, loop: true }],
  },
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
child.stderr.on('data', (chunk) => stderrLog.push(String(chunk)))

let socket = null
let buf = ''
let phase = 'waiting'
let passed = 0
let failed = 0
const timer = setTimeout(() => finish('TIMEOUT'), 60000)

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
    send({ type: 'pool:create', instanceId: 'inst-1', config: mod.windowConfigPayload(config), title: '渲染冒烟' })
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
      if (msg.type === 'ready' && phase === 'waiting') {
        check(
          msg.bounds && msg.bounds.x < 90000 && msg.bounds.y < 90000,
          '超界窗口在 ready 前夹回工作区',
          JSON.stringify(msg.bounds),
        )
        phase = 'init'
        send({
          type: 'init', instanceId: 'inst-1', title: '渲染冒烟', sessionId: null,
          config: mod.windowConfigPayload(config),
          model: mod.initPayload({ config, model, id: 'inst-1' }).model,
        })
        continue
      }
      if (msg.type === 'state' && msg.phase === 'vendor-cubism4-color-compat') {
        check(msg.active === true, 'Cubism 4.2 颜色兼容层已启用')
        continue
      }
      if (msg.type === 'state' && msg.phase === 'rendering' && phase === 'init') {
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
          phase = 'short'
          // 等长气泡按 300ms 自动淡出后再发短句，否则容器里还留着长文、溢出判定必然为真
          setTimeout(() => send({ type: 'bubble', instanceId: 'inst-1', text: '短句测试。', durationMs: 5000, seq: 2 }), 1600)
        } else if (phase === 'short') {
          check(msg.overflowing === false, '短文本不误报溢出', `height=${msg.height} scrollHeight=${msg.scrollHeight}`)
          check(msg.scrollbarVisible === false, '短文本不显示滚动条')
          finish(null)
        }
      }
    }
  })
}

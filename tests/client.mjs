// 网页半边的本地自测（不装 DSH，纯 mock window.__ModuleLoader__ + slots）
// 跑法：node tests/client.mjs
//
// 只验证「模块能注册、槽位参数正确、组件是函数」，不做真实渲染
// （真实渲染需要宿主提供的 React，测试里用最小 stub）。
import fs from 'node:fs'
import path from 'node:path'

let failed = 0
function check(label, condition, detail = '') {
  const ok = Boolean(condition)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}

const loaded = []
globalThis.window = {
  __ModuleLoader__: {
    load(module) { loaded.push(module) },
  },
  open() {},
}

// 最小 React stub：client.js 只在函数体里用 h(...)，模块加载阶段不会真的渲染，
// 所以 createElement 返回 null 就够；hooks 给空实现，防止误调用时抛错。
const ReactStub = {
  createElement: () => null,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

await import('../client.js')

check('调用了 window.__ModuleLoader__.load', loaded.length === 1)
const module = loaded[0]
check('模块 id 正确', module?.id === 'dsh-live2d', String(module?.id))
check('factory 是函数', typeof module?.factory === 'function')

const exportsObject = module.factory((name) => {
  if (name === 'react') return ReactStub
  throw new Error(`未预期的外部依赖：${name}`)
})

check('inject 只依赖 slots', JSON.stringify(exportsObject?.inject) === '["slots"]', JSON.stringify(exportsObject?.inject))
check('apply 是函数', typeof exportsObject?.apply === 'function')

const registrations = []
const injections = []
const ctx = {
  slots: {
    inject(slotName, callback) {
      injections.push(slotName)
      callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

exportsObject.apply(ctx)

check('注册了两个槽位', injections.length === 2, injections.join(','))
check('槽位名正确', injections.includes('settings.section') && injections.includes('plugins.tab'))

const settings = registrations.find((item) => item.options.name === 'settings.section')
const tab = registrations.find((item) => item.options.name === 'plugins.tab')
check('settings.section 参数完整', settings?.options?.id === 'live2d' && settings?.options?.order === 57 && settings?.options?.label === 'Live2D')
check('plugins.tab 参数完整', tab?.options?.id === 'live2d' && tab?.options?.order === 57)
check('两个入口都用同一个组件', typeof settings?.component === 'function' && settings.component === tab?.component)

const clientSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'client.js'), 'utf8')
check('模型设置已分组', ['基础信息', '窗口与模型', '对话与气泡', '模式相关设置', '测试与维护'].every((label) => clientSource.includes(label)))
check('模式设置页带参数输入', ['wakeIntervalMs', 'wakeMaxPerHour', 'screenCaptureIntervalMs', 'screenWatchIntervalMs'].every((key) => clientSource.includes(`num('${key}'`)))
check('数值输入带默认值（毫秒→秒）', clientSource.includes('opts.ms ? raw / 1000 : raw') && clientSource.includes('opts.ms ? Math.round(value * 1000) : value'))
check('长说明默认折叠', clientSource.includes("h('details', { style: S.help }"))
check('模型设置可同步到所有模型', clientSource.includes('syncDisplayToAll(') && clientSource.includes('同步显示设置到所有模型'))
check('动作页不再选目标模型', !clientSource.includes("label: '应用到哪个模型', hint: '动作只是播放一次"))
check('普通保存不覆盖旧坐标', clientSource.includes("if (draft.positionDirty !== true)"))

console.log('')
if (failed > 0) {
  console.log(`❌ ${failed} 项未通过`)
  process.exitCode = 1
} else {
  console.log('✅ 网页半边自测全部通过')
}

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

check('注册了三个槽位', injections.length === 3, injections.join(','))
check('槽位名正确', injections.includes('settings.section') && injections.includes('plugins.tab') && injections.includes('conversation.input.left'))

const settings = registrations.find((item) => item.options.name === 'settings.section')
const tab = registrations.find((item) => item.options.name === 'plugins.tab')
check('settings.section 参数完整', settings?.options?.id === 'live2d' && settings?.options?.order === 57 && settings?.options?.label === 'Live2D')
check('plugins.tab 参数完整', tab?.options?.id === 'live2d' && tab?.options?.order === 57)
check('两个入口都用同一个组件', typeof settings?.component === 'function' && settings.component === tab?.component)

const clientSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'client.js'), 'utf8')
check('模型设置已分组', ['基础信息', '窗口与模型', '对话与气泡', '模式相关设置', '测试与维护'].every((label) => clientSource.includes(label)))
check('模式设置页带参数输入', ['wakeIntervalMs', 'wakeMaxPerHour', 'screenCaptureIntervalMs', 'screenWatchIntervalMs'].every((key) => clientSource.includes(`num('${key}'`)))
check('定时唤醒与事件唤醒改为互斥选择', clientSource.includes("patchInstancePart(target.id, { wakeDriver: event.target.value })")
  && clientSource.includes("h('option', { value: 'timer' }, '定时唤醒')")
  && clientSource.includes("h('option', { value: 'event' }, '事件唤醒')"))
check('不消耗 Token 的陪伴行为归入三模式共享', clientSource.includes('共享 · 不消耗 Token')
  && clientSource.includes("toggle('lifeNonverbalEnabled')"))
check('陪伴额度、静默时段与告别已进设置', clientSource.includes("num('lifeShareBudgetPerDay'")
  && clientSource.includes("toggle('eventQuietEnabled')")
  && clientSource.includes("toggle('lifeFarewellEnabled')"))
check('未开启事件唤醒时事件设置使用可收起分组', clientSource.includes('disclosureGroup(')
  && clientSource.includes("proactiveDriver === 'event'"))
check('设置页可选择气泡皮肤', clientSource.includes("patchDraft(inst.id, 'bubbleSkin'")
  && ['classic', 'cloud', 'signboard', 'note'].every((skin) => clientSource.includes(`value: '${skin}'`)))
check('输入框权限旁注册模型快捷开关', clientSource.includes("name: 'conversation.input.left'")
  && clientSource.includes('Live2DQuickButtons')
  && clientSource.includes("item?.config?.enabled !== false"))
check('陪伴记忆按对话隔离且遗忘不删除', clientSource.includes('MemoryPanel')
  && clientSource.includes("act('forget'")
  && clientSource.includes("act('recall'")
  && !clientSource.includes("act('delete'"))
check('数值输入带默认值（毫秒/分钟换算）', clientSource.includes('raw / scale') && clientSource.includes('Math.round(value * scale)'))
check('长说明默认折叠', clientSource.includes("h('details', { style: S.help }"))
check('模型设置可同步到所有模型', clientSource.includes('syncDisplayToAll(') && clientSource.includes('同步显示设置到所有模型'))
check('动作页不再选目标模型', !clientSource.includes("label: '应用到哪个模型', hint: '动作只是播放一次"))
check('普通保存不覆盖旧坐标', clientSource.includes("if (draft.positionDirty !== true)"))
// 0.3.2：动作/循环改按「模型档案」，循环不再选实例
check('动作页按模型档案编辑', clientSource.includes('当前动作档案')
  && clientSource.includes("call('/profiles')")
  && clientSource.includes('历史档案（'))
check('动作/循环写入走模型档案', clientSource.includes('patchActiveProfile({')
  || clientSource.includes('savePresetsToProfile('))
check('循环不再绑定实例', !clientSource.includes("label: '绑定模型', hint: '不勾 = 只跟随当前模型")
  && !clientSource.includes('seq.targets.length ? seq.targets'))
// 0.4.0：动作页有「按模型能力生成的默认动作」分组 + 重新生成入口
check('动作页有默认动作分组', clientSource.includes("'默认动作'")
  && clientSource.includes('profile?.autoActions')
  && clientSource.includes('重新生成'))
check('默认动作可单独重新生成', clientSource.includes('/auto-actions')
  && clientSource.includes('regenerateAutoActions'))
// 0.5.0：表情 / 换装（模型自带）分组 + 能力说明
check('动作页有表情换装分组', clientSource.includes('表情 / 换装（模型自带）')
  && clientSource.includes('profile?.capabilityActions')
  && clientSource.includes('点一次开，再点一次关'))
check('能力动作进循环候选且不自带写死动作',
  clientSource.includes('for (const item of capabilityActions)')
    && clientSource.includes('loopActions.set')
    && !clientSource.includes('BUILTIN_ACTIONS'))
check('动作页不再展示写死的内置动作',
  !clientSource.includes('BUILTIN_ACTIONS')
    && !clientSource.includes("h('p', { style: { ...S.sub, marginTop: 12 } }, '内置动作')"))
check('动作调整框包含固定模板与自由描述',
  clientSource.includes('动作调整框')
    && clientSource.includes('ACTION_ADJUST_OPTIONS')
    && ['动作幅度', '动作频率', '动作时间', '其它调整'].every((label) => clientSource.includes(label)))
check('动作调整通过绑定会话交给 AI 并提示 Token',
  clientSource.includes("call('/inject'")
    && clientSource.includes('dryRun: false')
    && clientSource.includes('会消耗 Token')
    && clientSource.includes("kind === 'default'"))
check('循环设置可从模型窗口跳回 DSH 动作页',
  clientSource.includes("call('/ui-command')")
    && clientSource.includes('openLive2DSettings')
    && clientSource.includes('live2d:open-actions-settings'))

console.log('')
if (failed > 0) {
  console.log(`❌ ${failed} 项未通过`)
  process.exitCode = 1
} else {
  console.log('✅ 网页半边自测全部通过')
}

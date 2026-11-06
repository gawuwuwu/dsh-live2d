// dsh-live2d —— 网页半边（阶段 3：多实例设置页）
//
// 设置 → Live2D：每个「对话×模型」一张卡片（会话绑定 / 模型 / 窗口几何 / 气泡与回答样式 / 开关），
// 支持两个实例各自独立调整；配置存在宿主侧 config.json（%USERPROFILE%\.dsh\dsh-live2d\config.json）。
//
// 依赖：
//   · window.__ModuleLoader__.load —— DSH 的页面插件加载器
//   · require('react') —— 由 package.json 的 dsh.client.external 声明为外部依赖
//   · ctx.slots.register({ name:'settings.section' }) —— 设置页左侧栏插槽
//   · 宿主接口：/live2d/instances、/live2d/models、/live2d/health、/live2d/sessions、/live2d/window、/live2d/bubble

window.__ModuleLoader__.load({
  id: 'dsh-live2d',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const BASE = '/live2d'

    const call = (path, init) =>
      fetch(`${BASE}${path}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: init?.body ? { 'content-type': 'application/json' } : undefined,
        ...init,
      })
        .then(async (response) => {
          const text = await response.text()
          let data = null
          try {
            data = text ? JSON.parse(text) : null
          } catch {
            data = { ok: false, error: `响应不是 JSON（HTTP ${response.status}）`, raw: text.slice(0, 300) }
          }
          if (!response.ok && data && data.ok !== false) data.ok = false
          return data
        })
        .catch((error) => ({ ok: false, error: String(error?.message || error) }))

    const S = {
      wrap: {
        width: '100%',
        maxWidth: 1040,
        boxSizing: 'border-box',
        padding: '16px 18px 28px',
        fontSize: 13,
        lineHeight: 1.55,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.92))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        borderRadius: 14,
        boxShadow: '0 8px 28px rgba(20,30,60,.06)',
      },
      title: { fontSize: 18, fontWeight: 650, margin: '0 0 4px' },
      sub: { fontSize: 13, fontWeight: 650, margin: '0 0 8px', opacity: 0.9 },
      dim: { opacity: 0.62, fontSize: 12 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))',
        borderRadius: 10,
        padding: '12px 14px',
        marginTop: 12,
        background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))',
      },
      instanceCard: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))',
        borderRadius: 12,
        padding: '14px 16px 16px',
        marginTop: 14,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      toolbar: {
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        position: 'sticky',
        top: 0,
        zIndex: 3,
        padding: '8px 0',
        margin: '4px 0 8px',
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.96))',
        borderBottom: '1px solid rgba(128,128,128,.18)',
      },
      sectionHead: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        margin: '18px 0 4px',
        paddingBottom: 6,
        borderBottom: '1px solid rgba(128,128,128,.18)',
      },
      sectionTitle: { fontSize: 13.5, fontWeight: 650 },
      sectionHint: { fontSize: 11.5, opacity: 0.55 },
      fieldRow: {
        display: 'grid',
        gridTemplateColumns: 'minmax(104px, 142px) minmax(0, 1fr)',
        gap: '8px 14px',
        alignItems: 'start',
        padding: '9px 0',
        borderTop: '1px solid rgba(128,128,128,.12)',
      },
      fieldLabel: { display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 5 },
      fieldControl: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 },
      label: { opacity: 0.76, fontSize: 12.5, fontWeight: 600 },
      input: {
        flex: '1 1 200px',
        minWidth: 160,
        padding: '4px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18))',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12.5,
      },
      num: { width: 92, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18))', background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', font: 'inherit', fontSize: 12.5 },
      select: { padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18))', background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', font: 'inherit', fontSize: 12.5, maxWidth: 320 },
      code: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 },
      btn: {
        padding: '5px 11px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12.5,
      },
      primary: {
        padding: '5px 14px',
        borderRadius: 6,
        border: '1px solid rgba(64,110,220,.55)',
        background: 'rgba(64,110,220,.14)',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12.5,
        fontWeight: 600,
      },
      miniBtn: {
        padding: '3px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 11.5,
      },
      danger: {
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid rgba(180,35,24,.4)',
        background: 'transparent',
        color: '#b42318',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
      },
      badge: {
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 999,
        fontSize: 11.5,
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))',
        opacity: 0.9,
      },
      warn: { color: '#b42318', fontSize: 12 },
      ok: { color: '#067647', fontSize: 12 },
      hint: { opacity: 0.6, fontSize: 11.5, marginTop: 2, lineHeight: 1.45 },
      help: { fontSize: 10.5, opacity: 0.6, cursor: 'pointer' },
      helpText: { display: 'block', marginTop: 4, opacity: 0.72, lineHeight: 1.45 },
    }

    function Row({ label, children }) {
      return h(
        'div',
        { style: { display: 'flex', gap: 8, marginBottom: 3 } },
        h('span', { style: { minWidth: 132, opacity: 0.66, fontSize: 12.5 } }, label),
        h('span', { style: S.code }, children),
      )
    }

    function Field({ label, hint, children }) {
      return h(
        'div',
        { style: S.fieldRow },
        h(
          'div',
          { style: S.fieldLabel },
          h('span', { style: S.label }, label),
          hint ? h('details', { style: S.help }, h('summary', null, '说明'), h('span', { style: S.helpText }, hint)) : null,
        ),
        h('div', { style: S.fieldControl }, children),
      )
    }

    function SectionTitle({ title, hint }) {
      return h(
        'div',
        { style: S.sectionHead },
        h('span', { style: S.sectionTitle }, title),
        hint ? h('span', { style: S.sectionHint }, hint) : null,
      )
    }

    const numToDraft = (value) => (value === null || value === undefined ? '' : String(value))

    function toDraft(config) {
      return {
        modelPath: config.modelPath ?? '',
        sessionId: config.sessionId ?? '',
        windowWidth: config.windowWidth ?? 320,
        windowHeight: config.windowHeight ?? 420,
        windowX: config.windowX ?? '',
        windowY: config.windowY ?? '',
        bubbleDurationSec: (config.bubbleDurationMs ?? 5000) / 1000,
        bubbleQueueLimit: config.bubbleQueueLimit ?? 3,
        bubbleMaxChars: config.bubbleMaxChars ?? 120,
        enabled: config.enabled !== false,
        rendererEnabled: config.rendererEnabled !== false,
        clickThrough: config.clickThrough !== false,
        modelPassthrough: config.modelPassthrough === true,
        autoOpenWindow: config.autoOpenWindow !== false,
        adjustMode: config.adjustMode === true,
        replyStyle: config.replyStyle === 'card' ? 'card' : 'bubble',
        replyOpacity: typeof config.replyOpacity === 'number' ? config.replyOpacity : 0.9,
        replyFontSize: config.replyFontSize ?? 15,
        replyMaxHeightPct: config.replyMaxHeightPct ?? 45,
        replyHeightRatio: config.replyHeightRatio ?? 50,
        bubbleFixedSize: config.bubbleFixedSize === true,
        bubbleHeightPx: config.bubbleHeightPx ?? 200,
        modelScalePct: config.modelScalePct ?? 100,
        modelLayoutMode: config.modelLayoutMode === 'zoom-overlay' ? 'zoom-overlay' : 'fit',
        idleFloat: config.idleFloat !== false,
        lookFollow: config.lookFollow !== false,
        dragInertia: config.dragInertia !== false,
        motionStrength: config.motionStrength ?? 60,
        chatTimeoutSec: (config.chatTimeoutMs ?? 90000) / 1000,
        showLateReply: config.showLateReply === true,
        // 默认「手动」（内部键 auto）：不主动动，只有 ⚡ / 摸模型才回应
        mode: config.mode === 'manual' || config.mode === 'semi' ? config.mode : 'auto',
        autoBubble: config.autoBubble !== false,
        autoInteract: config.autoInteract !== false,
        idlePresets: config.idlePresets !== false,
        customActions: Array.isArray(config.customActions) ? config.customActions : [],
        presetSequencesRaw: Array.isArray(config.presetSequences) ? config.presetSequences : [],
        presetSteps: Array.isArray(config.presetSequences?.[0]?.steps) ? config.presetSequences[0].steps : [],
        presetIntervalSec: (config.presetSequences?.[0]?.intervalMs ?? 2500) / 1000,
        screenReadEnabled: config.screenReadEnabled === true,
        screenWatchEnabled: config.screenWatchEnabled === true,
        screenWatchIntervalSec: (config.screenWatchIntervalMs ?? 30000) / 1000,
        screenCaptureEnabled: config.screenCaptureEnabled === true,
        screenCaptureAutoConfirm: config.screenCaptureAutoConfirm === true,
        screenCaptureIntervalSec: (config.screenCaptureIntervalMs ?? 30000) / 1000,
        // 0.13.0：主动唤醒（开关默认关；间隔秒；额度/小时；截图子开关）
        wakeEnabled: config.wakeEnabled === true,
        wakeIntervalSec: (config.wakeIntervalMs ?? 30000) / 1000,
        wakeCaptureEnabled: config.wakeCaptureEnabled === true,
        wakeMaxPerHour: config.wakeMaxPerHour ?? 60,
        aiMoveEnabled: config.aiMoveEnabled === true,
        ttsEnabled: config.ttsEnabled === true,
        ttsAutoSpeak: config.ttsAutoSpeak === true,
        ttsUrl: config.ttsUrl ?? 'http://127.0.0.1:7890/tts',
        ttsPrompt: config.ttsPrompt ?? '',
        ttsPromptText: config.ttsPromptText ?? '',
      }
    }

    function toPayload(draft) {
      const payload = {
        modelPath: draft.modelPath,
        sessionId: draft.sessionId || '',
        windowWidth: Number(draft.windowWidth),
        windowHeight: Number(draft.windowHeight),
        windowX: draft.windowX === '' ? null : Number(draft.windowX),
        windowY: draft.windowY === '' ? null : Number(draft.windowY),
        bubbleDurationMs: Math.round(Number(draft.bubbleDurationSec) * 1000),
        bubbleQueueLimit: Number(draft.bubbleQueueLimit),
        bubbleMaxChars: Number(draft.bubbleMaxChars),
        rendererEnabled: draft.rendererEnabled,
        enabled: draft.enabled !== false,
        clickThrough: draft.clickThrough,
        modelPassthrough: Boolean(draft.modelPassthrough),
        autoOpenWindow: draft.autoOpenWindow,
        adjustMode: draft.adjustMode,
        replyStyle: draft.replyStyle,
        replyOpacity: Number(draft.replyOpacity),
        replyFontSize: Number(draft.replyFontSize),
        replyMaxHeightPct: Number(draft.replyMaxHeightPct),
        replyHeightRatio: Number(draft.replyHeightRatio),
        bubbleFixedSize: Boolean(draft.bubbleFixedSize),
        bubbleHeightPx: Number(draft.bubbleHeightPx),
        modelScalePct: Number(draft.modelScalePct),
        modelLayoutMode: draft.modelLayoutMode === 'zoom-overlay' ? 'zoom-overlay' : 'fit',
        idleFloat: Boolean(draft.idleFloat),
        lookFollow: Boolean(draft.lookFollow),
        dragInertia: Boolean(draft.dragInertia),
        motionStrength: Number(draft.motionStrength),
        chatTimeoutMs: Math.round(Number(draft.chatTimeoutSec) * 1000),
        showLateReply: Boolean(draft.showLateReply),
        mode: draft.mode,
        autoBubble: Boolean(draft.autoBubble),
        autoInteract: Boolean(draft.autoInteract),
        idlePresets: Boolean(draft.idlePresets),
        customActions: Array.isArray(draft.customActions) ? draft.customActions : [],
        presetSequences: (() => {
          const others = (draft.presetSequencesRaw ?? []).filter((item) => item.id !== 'user-loop')
          const steps = Array.isArray(draft.presetSteps) ? draft.presetSteps : []
          const intervalMs = Math.max(300, Math.round(Number(draft.presetIntervalSec || 2.5) * 1000))
          return steps.length ? [...others, { id: 'user-loop', label: '设置页循环', steps, intervalMs, loop: true }] : others
        })(),
        screenReadEnabled: Boolean(draft.screenReadEnabled),
        screenWatchEnabled: Boolean(draft.screenWatchEnabled),
        screenWatchIntervalMs: Math.round(Number(draft.screenWatchIntervalSec) * 1000),
        screenCaptureEnabled: Boolean(draft.screenCaptureEnabled),
        screenCaptureAutoConfirm: Boolean(draft.screenCaptureAutoConfirm),
        screenCaptureIntervalMs: Math.round(Number(draft.screenCaptureIntervalSec) * 1000),
        // 0.13.0：主动唤醒
        wakeEnabled: Boolean(draft.wakeEnabled),
        wakeIntervalMs: Math.round(Math.min(600, Math.max(15, Number(draft.wakeIntervalSec) || 30)) * 1000),
        wakeCaptureEnabled: Boolean(draft.wakeCaptureEnabled),
        wakeMaxPerHour: Math.min(360, Math.max(1, Math.round(Number(draft.wakeMaxPerHour) || 60))),
        aiMoveEnabled: Boolean(draft.aiMoveEnabled),
        ttsEnabled: Boolean(draft.ttsEnabled),
        ttsAutoSpeak: Boolean(draft.ttsAutoSpeak),
        ttsUrl: draft.ttsUrl,
        ttsPrompt: draft.ttsPrompt,
        ttsPromptText: draft.ttsPromptText,
      }
      // X/Y 是窗口主进程维护的运行态。普通设置保存不能把刷新前读到的旧坐标再写回去，
      // 否则刚被夹回工作区的窗口会在下一次保存无关字段时重新越界并出现白底。
      if (draft.positionDirty !== true) {
        delete payload.windowX
        delete payload.windowY
      }
      return payload
    }

    // 内置动作（与宿主 ANIM_WHITELIST 对齐；中文名只用于设置页展示）
    const BUILTIN_ACTIONS = [
      { id: 'nod', label: '点头' },
      { id: 'shake', label: '摇头' },
      { id: 'tilt', label: '歪头' },
      { id: 'happy', label: '开心' },
      { id: 'shy', label: '害羞' },
      { id: 'surprised', label: '惊讶' },
      { id: 'blink', label: '眨眼' },
      { id: 'angry', label: '生气' },
      { id: 'drool', label: '流口水' },
      { id: 'xx', label: 'X 眼' },
      { id: 'puff', label: '栗子嘴' },
    ]

    const sessionLabel = (item) => `${item.title || '(无标题会话)'} · ${String(item.id).slice(0, 10)}`

    function Live2DSettings() {
      const [instances, setInstances] = React.useState([])
      const [drafts, setDrafts] = React.useState({})
      const [health, setHealth] = React.useState(null)
      const [meta, setMeta] = React.useState(null)
      const [sessions, setSessions] = React.useState([])
      const [models, setModels] = React.useState([])
      const [modelRoots, setModelRoots] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState({ kind: '', text: '' })
      const [createDraft, setCreateDraft] = React.useState({ modelPath: '', sessionId: '' })
      // 0.13.3：设置页改成 tab（动作 / 模型1 / 模型2）
      const [activeTabKey, setActiveTabKey] = React.useState('actions')
      const [actionTargetId, setActionTargetId] = React.useState('')
      const [newAction, setNewAction] = React.useState({ label: '', description: '', draft: null })
      const [newLoop, setNewLoop] = React.useState({ editingId: '', label: '', steps: [], intervalSec: 8, targets: [] })

      const load = React.useCallback(async () => {
        setBusy('load')
        const [instRes, healthData, sessionData, modelData, configData] = await Promise.all([
          call('/instances'), call('/health'), call('/sessions'), call('/models'), call('/config'),
        ])
        const list = Array.isArray(instRes?.instances) ? instRes.instances : []
        setInstances(list)
        // 表单草稿必须用**完整配置**（/config 里的 instances）重建。
        // /instances 返回的是摘要（id/绑定/模型/渲染状态/告警），没有 adjustMode、宽高、气泡等字段，
        // 拿摘要重建会把用户刚保存的值显示成默认值（窗口实际仍是旧值 → 看起来像「保存被重置」）。
        const fullConfigs = Array.isArray(configData?.instances) ? configData.instances : []
        const draftSource = fullConfigs.length ? fullConfigs : list
        setDrafts(Object.fromEntries(draftSource.map((item) => [item.id, toDraft(item.config ?? item)])))
        setHealth(healthData)
        setMeta({ file: configData?.configFile || healthData?.configFile || '', warnings: healthData?.warnings || [] })
        setSessions(Array.isArray(sessionData?.sessions) ? sessionData.sessions : [])
        setModels(Array.isArray(modelData?.models) ? modelData.models : [])
        setModelRoots(Array.isArray(modelData?.roots) ? modelData.roots : [])
        setCreateDraft((current) => ({
          modelPath: current.modelPath || modelData?.models?.[0]?.dir || '',
          sessionId: current.sessionId || '',
        }))
        if (!instRes?.ok) setNotice({ kind: 'warn', text: instRes?.error || '读取实例列表失败（宿主可能是旧版本，重启 DSH）' })
        setBusy('')
      }, [])

      React.useEffect(() => { load() }, [load])

      const draftOf = (id) => drafts[id] || null
      const patchDraft = (id, key, value) =>
        setDrafts((current) => ({
          ...current,
          [id]: {
            ...(current[id] || {}),
            [key]: value,
            ...(key === 'windowX' || key === 'windowY' ? { positionDirty: true } : {}),
          },
        }))

      const refreshHealth = async () => setHealth(await call('/health'))

      // 预设循环：勾选的动作按顺序成为 steps；保存后由 /preset 启停
      const togglePresetStep = (id, action) =>
        setDrafts((current) => {
          const draft = current[id]
          if (!draft) return current
          const steps = Array.isArray(draft.presetSteps) ? draft.presetSteps : []
          const next = steps.includes(action) ? steps.filter((item) => item !== action) : [...steps, action]
          return { ...current, [id]: { ...draft, presetSteps: next } }
        })

      const presetOp = async (id, op, sequenceId) => {
        setBusy(`preset:${id}`)
        const result = await call('/preset', {
          method: 'POST',
          body: JSON.stringify({ op, instanceId: id, sequenceId, action: sequenceId }),
        })
        setNotice(result?.ok === false
          ? { kind: 'warn', text: result?.error || result?.code || '预设操作失败' }
          : { kind: 'ok', text: op === 'stop' ? '循环已停止' : op === 'start' ? '循环已启动' : '动作已发送' })
      }

      // 把「显示类」设置同步到另一台模型（对应「应用到所有模型」）
      const syncDisplayToAll = async (sourceId) => {
        const from = draftOf(sourceId)
        if (!from) return
        const others = instances.filter((item) => item.id !== sourceId)
        if (!others.length) {
          setNotice({ kind: 'warn', text: '只有一个模型，没有可同步的对象' })
          return
        }
        const keys = [
          'windowWidth', 'windowHeight', 'modelScalePct', 'modelLayoutMode',
          'replyFontSize', 'replyOpacity', 'replyHeightRatio', 'replyStyle',
          'bubbleFixedSize', 'bubbleHeightPx',
        ]
        const patch = {}
        for (const key of keys) if (from[key] !== undefined && from[key] !== null) patch[key] = from[key]
        setBusy(`sync:${sourceId}`)
        for (const target of others) {
          await call(`/instances/${encodeURIComponent(target.id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
        }
        setNotice({ kind: 'ok', text: `显示设置已同步到 ${others.length} 个模型` })
        setBusy('')
        await load()
      }

      const saveInstance = async (id) => {        const draft = draftOf(id)
        if (!draft) return
        setBusy(`save:${id}`)
        setNotice({ kind: '', text: '' })
        const result = await call(`/instances/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(toPayload(draft)) })
        if (result?.ok) {
          setNotice({ kind: 'ok', text: `${id} 已保存${result.needsReload ? '（模型已重载）' : ''}` })
        } else {
          setNotice({ kind: 'warn', text: result?.error || '保存失败' })
        }
        await refreshHealth()
        if (result?.ok) await load()
        setBusy('')
      }

      const removeInstance = async (id) => {
        setBusy(`del:${id}`)
        setNotice({ kind: '', text: '' })
        const result = await call(`/instances/${encodeURIComponent(id)}`, { method: 'DELETE' })
        setNotice(result?.ok ? { kind: 'ok', text: `${id} 已删除（窗口已关）` } : { kind: 'warn', text: result?.error || '删除失败' })
        await load()
        setBusy('')
      }

      const createInstance = async () => {
        if (!createDraft.modelPath) {
          setNotice({ kind: 'warn', text: '先选一个模型（新增实例必须指定模型）' })
          return
        }
        setBusy('create')
        setNotice({ kind: '', text: '' })
        const result = await call('/instances', { method: 'POST', body: JSON.stringify({ modelPath: createDraft.modelPath, sessionId: createDraft.sessionId || '' }) })
        if (result?.ok) {
          setNotice({ kind: 'ok', text: `已新增 ${result.instanceId}` })
          setCreateDraft((current) => ({ ...current, sessionId: '' }))
          await load()
          await call('/window', { method: 'POST', body: JSON.stringify({ action: 'open', instanceId: result.instanceId }) })
        } else {
          setNotice({ kind: 'warn', text: result?.error || '新增失败' })
        }
        setBusy('')
      }

      const windowAction = async (id, action) => {
        setBusy(`win:${id}`)
        setNotice({ kind: '', text: '' })
        const result = await call('/window', { method: 'POST', body: JSON.stringify({ action, instanceId: id }) })
        setNotice(result?.ok ? { kind: 'ok', text: `${id} ${action === 'open' ? '窗口已打开' : action === 'close' ? '窗口已关闭' : '已重载'}` } : { kind: 'warn', text: result?.error || '操作失败' })
        await refreshHealth()
        setBusy('')
      }

      const refreshBounds = async (id) => {
        setBusy(`bounds:${id}`)
        const data = await call(`/window?instanceId=${encodeURIComponent(id)}`)
        const bounds = data?.bounds
        if (bounds && Number.isFinite(bounds.width)) {
          setDrafts((current) => ({
            ...current,
            [id]: {
              ...(current[id] || {}),
              windowWidth: bounds.width,
              windowHeight: bounds.height,
              windowX: bounds.x,
              windowY: bounds.y,
              positionDirty: false,
            },
          }))
          // 气泡实际高度也要一起刷新（显示在「实际气泡」处）
          await load()
          setNotice({ kind: 'ok', text: `已读取 ${id} 窗口几何与气泡高度（记得保存）` })
        } else {
          setNotice({ kind: 'warn', text: `${id} 还没上报过位置：先打开窗口、拖一下再刷新` })
        }
        setBusy('')
      }

      const bubble = async (id, body) => {
        setBusy(`bubble:${id}`)
        const result = await call('/bubble', { method: 'POST', body: JSON.stringify({ ...body, instanceId: id }) })
        setNotice(result?.ok ? { kind: 'ok', text: result.shown === false ? '（重复消息，已忽略）' : '气泡已发送' } : { kind: 'warn', text: result?.error || '发送失败' })
        await refreshHealth()
        setBusy('')
      }

      // 表情/动作试玩：设置页点一下就能看到效果（不用等 AI 发）
      const anim = async (id, action) => {
        setBusy(`anim:${id}`)
        const result = await call('/anim', { method: 'POST', body: JSON.stringify({ action, instanceId: id }) })
        setNotice(result?.ok
          ? { kind: 'ok', text: `动作已发送：${result.action || action}` }
          : { kind: 'warn', text: result?.error || '动作失败' })
        setBusy('')
      }

      const probeTts = async (id) => {
        setBusy(`tts:${id}`)
        try {
          const result = await call('/tts', {
            method: 'POST',
            body: JSON.stringify({ text: '你好，我是莉亚，这是一段语音试听。', instanceId: id }),
          })
          if (!result?.ok || !result.audioBase64) {
            setNotice({ kind: 'warn', text: result?.error || '语音合成失败' })
            return
          }
          const audio = new Audio(`data:${result.mime || 'audio/wav'};base64,${result.audioBase64}`)
          audio.play().catch(() => { /* 浏览器可能拦截自动播放 */ })
          setNotice({ kind: 'ok', text: `已合成 ${result.chars ?? ''} 字，正在播放` })
        } catch (error) {
          setNotice({ kind: 'warn', text: String(error?.message || error) })
        } finally {
          setBusy('')
        }
      }

      const checkbox = (id, key) =>
        h('input', {
          type: 'checkbox',
          checked: Boolean(draftOf(id)?.[key]),
          onChange: (event) => patchDraft(id, key, event.target.checked),
        })
      const lblStyle = { display: 'inline-flex', alignItems: 'center', gap: 5, marginRight: 12, fontSize: 13 }

      const renderInstance = (inst) => {
        const draft = draftOf(inst.id)
        if (!draft) return null
        // 窗口最近一次上报的「气泡实际高度」（px）；拖动调整框后点「刷新坐标」更新
        const layoutPx = Number(inst.renderer?.layout?.bubblePx ?? 0)
        const warnList = Array.isArray(inst.warnings) ? inst.warnings : []
        const modelChoices = models.filter((item) => !item.usedBy || item.usedBy === inst.id)
        const usedSession = new Set(instances.filter((item) => item.id !== inst.id && item.sessionId).map((item) => item.sessionId))
        const windowOpen = inst.window?.ready === true || inst.window?.state === 'starting' || inst.window?.state === 'rendering'
        // 已绑定的会话可能不在下拉数据里（没打开过、缓存还没落盘）：补一条，别让它看起来像「未绑定」
        const linkedSession =
          draft.sessionId && !sessions.some((item) => item.id === draft.sessionId)
            ? { id: draft.sessionId, title: inst.title || null }
            : null

        return h(
          'div',
          { key: inst.id, style: S.instanceCard },
          h(
            'div',
            { style: { ...S.row, justifyContent: 'space-between', marginBottom: 6 } },
            h(
              'span',
              { style: { ...S.row, gap: 8 } },
              h('span', { style: { fontWeight: 600 } }, inst.id),
              inst.isDefault ? h('span', { style: S.badge }, '默认') : null,
              h('span', { style: { ...S.badge, color: inst.sessionId ? 'inherit' : '#b54708' } }, inst.boundLabel || (inst.sessionId ? '已绑定' : '未绑定会话')),
              h('span', { style: S.dim }, `渲染：${inst.renderer?.state || '—'} · 窗口：${inst.window?.state || '—'}`),
            ),
            h(
              'div',
              { style: S.row },
              h(
                'button',
                { type: 'button', style: S.primary, disabled: busy === `save:${inst.id}`, onClick: () => saveInstance(inst.id) },
                busy === `save:${inst.id}` ? '保存中…' : '保存设置',
              ),
              h(
                'button',
                { type: 'button', style: S.btn, disabled: busy === `win:${inst.id}`, onClick: () => windowAction(inst.id, windowOpen ? 'close' : 'open') },
                windowOpen ? '关闭窗口' : '打开窗口',
              ),
              instances.length > 1
                ? h('button', { type: 'button', style: S.danger, disabled: busy === `del:${inst.id}`, onClick: () => removeInstance(inst.id) }, busy === `del:${inst.id}` ? '删除中…' : '删除')
                : null,
            ),
          ),

          h(SectionTitle, { title: '基础信息', hint: '绑定会话、选择模型，并决定实例是否启用' }),
          h(
            Field,
            { label: '应用到所有模型', hint: '把这一台的尺寸、缩放、布局、字号、透明度、气泡样式同步到另一台（不同步模型路径与会话绑定）。' },
            h('button', { type: 'button', style: S.btn, disabled: busy === `sync:${inst.id}`, onClick: () => syncDisplayToAll(inst.id) },
              instances.length > 1 ? '同步显示设置到所有模型' : '只有一个模型'),
          ),
          h(
            Field,
            { label: '启用模型', hint: '关掉后不加载窗口、不参与唤醒/空闲动作（配置保留，随时可再开）。' },
            h('label', { style: { ...S.row, gap: 6 } }, checkbox(inst.id, 'enabled'), h('span', { style: S.dim }, draft.enabled === false ? '已停用' : '启用中')),
          ),

          h(
            Field,
            { label: '绑定会话', hint: '「未绑定」= 这个模型先不接任何会话；绑定后窗口底部输入框才能发消息。同一个会话只能绑一个实例。' },
            h(
              'select',
              { style: S.select, value: draft.sessionId || '', onChange: (event) => patchDraft(inst.id, 'sessionId', event.target.value) },
              h('option', { value: '' }, '未绑定'),
              linkedSession ? h('option', { key: 'linked', value: linkedSession.id }, sessionLabel(linkedSession)) : null,
              sessions.map((item) =>
                h(
                  'option',
                  { key: item.id, value: item.id, disabled: usedSession.has(item.id) && item.id !== inst.sessionId },
                  `${sessionLabel(item)}${usedSession.has(item.id) && item.id !== inst.sessionId ? '（已被占用）' : ''}`,
                ),
              ),
            ),
          ),

          h(
            Field,
            { label: '模型', hint: '下拉扫自配置的模型扫描根（默认 D:\\Live2D，最多 3 层）；已被别的实例用掉的模型会置灰。也可以直接填目录。' },
            h(
              'select',
              {
                style: { ...S.select, flex: '0 1 260px' },
                value: modelChoices.some((item) => item.dir === draft.modelPath) ? draft.modelPath : '',
                onChange: (event) => { if (event.target.value) patchDraft(inst.id, 'modelPath', event.target.value) },
              },
              modelChoices.some((item) => item.dir === draft.modelPath) ? null : h('option', { value: '' }, '（自定义路径）'),
              modelChoices.map((item) => h('option', { key: item.key, value: item.dir }, item.name || item.dir)),
            ),
            h('input', { style: S.input, value: draft.modelPath, spellCheck: false, onChange: (event) => patchDraft(inst.id, 'modelPath', event.target.value) }),
          ),
          inst.model && !inst.model.ok
            ? h('p', { style: S.warn }, `模型不可用：${inst.model.reason || '未知'}（窗口会显示占位卡片，不影响 DSH）`)
            : null,

          h(SectionTitle, { title: '窗口与模型', hint: '窗口几何由主进程负责夹取和持久化' }),
          h(
            Field,
            { label: '宽 × 高', hint: '宽 160~800，高 200~1000；越界回落默认值并告警。' },
            h('input', { style: S.num, type: 'number', value: draft.windowWidth, onChange: (event) => patchDraft(inst.id, 'windowWidth', event.target.value) }),
            h('span', { style: S.dim }, '×'),
            h('input', { style: S.num, type: 'number', value: draft.windowHeight, onChange: (event) => patchDraft(inst.id, 'windowHeight', event.target.value) }),
          ),
          h(
            Field,
            { label: '位置 X / Y', hint: '通常不需要手填。留空表示自动摆放；只有主动修改这里才会在保存时覆盖窗口运行态坐标。' },
            h('input', { style: S.num, type: 'number', value: numToDraft(draft.windowX), onChange: (event) => patchDraft(inst.id, 'windowX', event.target.value) }),
            h('input', { style: S.num, type: 'number', value: numToDraft(draft.windowY), onChange: (event) => patchDraft(inst.id, 'windowY', event.target.value) }),
            h(
              'button',
              {
                type: 'button',
                style: S.miniBtn,
                onClick: () => {
                  patchDraft(inst.id, 'windowX', '')
                  patchDraft(inst.id, 'windowY', '')
                },
              },
              '改为自动摆放',
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('button', { type: 'button', style: S.btn, disabled: busy === `win:${inst.id}`, onClick: () => windowAction(inst.id, 'open') }, '打开窗口'),
            h('button', { type: 'button', style: S.btn, disabled: busy === `win:${inst.id}`, onClick: () => windowAction(inst.id, 'close') }, '关闭窗口'),
            h('button', { type: 'button', style: S.btn, disabled: busy === `bounds:${inst.id}`, onClick: () => refreshBounds(inst.id) }, busy === `bounds:${inst.id}` ? '读取中…' : '刷新坐标'),
          ),

          h(SectionTitle, { title: '对话与气泡', hint: '回复样式、显示时长和三种运行模式' }),
          h(
            Field,
            { label: '回答样式', hint: '气泡 = 模型上方的窄气泡；卡片 = 通栏卡片。保存后立即生效。' },
            h(
              'select',
              { style: S.select, value: draft.replyStyle, onChange: (event) => patchDraft(inst.id, 'replyStyle', event.target.value) },
              h('option', { value: 'bubble' }, '气泡'),
              h('option', { value: 'card' }, '方块卡片'),
            ),
            h(
              'span',
              { style: { ...S.row, gap: 6 } },
              h('span', { style: S.dim }, '透明度'),
              h('input', {
                type: 'range', min: '30', max: '100', step: '5', style: { width: 120 },
                value: String(Math.round((draft.replyOpacity ?? 0.9) * 100)),
                onChange: (event) => patchDraft(inst.id, 'replyOpacity', Number(event.target.value) / 100),
              }),
              h('span', { style: S.dim }, `${Math.round((draft.replyOpacity ?? 0.9) * 100)}%`),
            ),
          ),

          h(
            Field,
            { label: '字号 / 气泡高度', hint: '字号 12~24px。气泡高度由调整框的「上下」拖动决定（模型大小由「左右」拖动决定，模型永远等比不变形）；点「刷新坐标」可读到当前实际像素。勾选「固定气泡大小」后气泡锁死为下面填的像素值，上下拖动不再改变它。超出的内容在气泡内部滚动。' },
            h('input', {
              style: S.num, type: 'number', min: '12', max: '24', step: '1',
              value: draft.replyFontSize,
              onChange: (event) => patchDraft(inst.id, 'replyFontSize', event.target.value),
            }),
            h('span', { style: S.dim }, 'px　实际气泡'),
            h('span', { style: { ...S.dim, minWidth: 54, display: 'inline-block' } }, layoutPx > 0 ? `${layoutPx}px` : '—'),
            h(
              'label',
              { style: { ...S.row, gap: 6, marginLeft: 6, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: Boolean(draft.bubbleFixedSize),
                onChange: (event) => patchDraft(inst.id, 'bubbleFixedSize', event.target.checked),
              }),
              h('span', { style: S.dim }, '固定气泡大小'),
            ),
            h('input', {
              style: { ...S.num, opacity: draft.bubbleFixedSize ? 1 : 0.45 },
              type: 'number', min: '80', max: '900', step: '10',
              disabled: !draft.bubbleFixedSize,
              value: draft.bubbleHeightPx ?? 200,
              onChange: (event) => patchDraft(inst.id, 'bubbleHeightPx', event.target.value),
            }),
            h('span', { style: S.dim }, 'px'),
          ),

          h(
            Field,
            { label: '模型缩放', hint: '50%~200%：以「完整装进窗口」为 100%，放大后脚底不动、超出部分被窗口裁切。选择「允许覆盖」时回答区用独立高度，放大不会把气泡压小。' },
            h('input', {
              style: S.num, type: 'number', min: '50', max: '200', step: '5',
              value: draft.modelScalePct,
              onChange: (event) => patchDraft(inst.id, 'modelScalePct', event.target.value),
            }),
            h('span', { style: S.dim }, '%'),
            h('button', {
              style: S.miniBtn,
              onClick: () => patchDraft(inst.id, 'modelScalePct', 100),
            }, '恢复 100%'),
            h('select', {
              style: S.select,
              value: draft.modelLayoutMode,
              onChange: (event) => patchDraft(inst.id, 'modelLayoutMode', event.target.value),
            },
            h('option', { value: 'fit' }, '不覆盖（fit）'),
            h('option', { value: 'zoom-overlay' }, '允许覆盖（zoom-overlay）')),
          ),

          h(
            Field,
            { label: '动态效果', hint: '待机时轻微上下浮动、眼睛和头跟着鼠标看、拖动窗口松手后头部回弹一下。幅度 1~100 控制强弱。' },
            h('label', { style: lblStyle }, checkbox(inst.id, 'idleFloat'), '待机浮动'),
            h('label', { style: lblStyle }, checkbox(inst.id, 'lookFollow'), '视线跟随'),
            h('label', { style: lblStyle }, checkbox(inst.id, 'dragInertia'), '拖拽惯性'),
            h('input', { style: { ...S.num, marginLeft: 8 }, type: 'number', min: '1', max: '100', value: draft.motionStrength ?? 60, onChange: (event) => patchDraft(inst.id, 'motionStrength', event.target.value) }),
            h('span', { style: S.dim }, '幅度'),
          ),

          h(
            Field,
            { label: '显示时长 秒', hint: '1~120 秒，可填小数（如 2.5）；离开输入框就保存（不用再点下方的保存）。超过 120 会回落默认 5 秒并告警。' },
            h('input', {
              style: S.num, type: 'number', step: '0.5', min: '1', max: '120', value: draft.bubbleDurationSec,
              onChange: (event) => patchDraft(inst.id, 'bubbleDurationSec', event.target.value),
              onBlur: (event) => {
                const sec = Number(event.target.value)
                if (!Number.isFinite(sec) || sec <= 0) return
                patchInstancePart(inst.id, { bubbleDurationMs: Math.round(sec * 1000) })
              },
            }),
            h('span', { style: S.dim }, '队列'),
            h('input', { style: S.num, type: 'number', value: draft.bubbleQueueLimit, onChange: (event) => patchDraft(inst.id, 'bubbleQueueLimit', event.target.value) }),
            h('span', { style: S.dim }, '字数'),
            h('input', { style: S.num, type: 'number', value: draft.bubbleMaxChars, onChange: (event) => patchDraft(inst.id, 'bubbleMaxChars', event.target.value) }),
          ),

          h(
            Field,
            { label: '模式', hint: 'AI 自动 = AI 可主动做动作/气泡；AI 半自动 = 自动上气泡 + 思考时自动动作；手动 = 不主动，只有 ⚡/摸模型才回应。' },
            h(
              'select',
              { style: S.select, value: draft.mode, onChange: (event) => patchDraft(inst.id, 'mode', event.target.value) },
              h('option', { value: 'auto' }, '手动'),
              h('option', { value: 'semi' }, 'AI 半自动'),
              h('option', { value: 'manual' }, 'AI 自动'),
            ),
            h(
              'label',
              { style: { ...S.row, gap: 6 } },
              checkbox(inst.id, 'autoBubble'),
              h('span', { style: S.dim }, '自动上气泡'),
            ),
          ),

          h(SectionTitle, { title: '模式相关设置', hint: '读屏、截图、定时唤醒、AI 移动窗口都在「模式设置」页统一管理（按模式分组，带间隔与额度参数）' }),

          h(
            Field,
            { label: '思考最大时间 秒', hint: '10~300 秒。超过这个时间：关掉下面的开关就判失败、不显示回答；打开就继续等，最多再等一倍时间。' },
            h('input', {
              style: S.num, type: 'number', step: '5', min: '10', max: '300',
              value: draft.chatTimeoutSec,
              onChange: (event) => patchDraft(inst.id, 'chatTimeoutSec', event.target.value),
            }),
            h(
              'label',
              { style: { ...S.row, gap: 6 } },
              checkbox(inst.id, 'showLateReply'),
              h('span', { style: S.dim }, '超时后仍输出回答'),
            ),
          ),

          h(
            'div',
            { style: S.row },
            h(Field, { label: '渲染' }, checkbox(inst.id, 'rendererEnabled')),
            h(Field, { label: '穿透' }, checkbox(inst.id, 'clickThrough')),
            h(Field, { label: '模型区也穿透', hint: '开启后模型身体不拦鼠标：置顶时也点得到下面的按钮（代价：摸不到模型，暂停/重开窗口恢复）' }, checkbox(inst.id, 'modelPassthrough')),
            h(Field, { label: '自动开窗' }, checkbox(inst.id, 'autoOpenWindow')),
          ),

          h(SectionTitle, { title: '语音', hint: '本地 CosyVoice2 服务与参考音色' }),
          h(
            Field,
            { label: '语音（CosyVoice2）', hint: '本地服务默认 127.0.0.1:7890/tts；参考音填 wav 路径与对应文本。' },
            h('label', { style: { ...S.row, gap: 6 } }, checkbox(inst.id, 'ttsEnabled'), h('span', { style: S.dim }, '启用')),
            h('label', { style: { ...S.row, gap: 6 } }, checkbox(inst.id, 'ttsAutoSpeak'), h('span', { style: S.dim }, '自动朗读回复')),
            h('input', {
              style: { ...S.num, width: 240 }, type: 'text', placeholder: 'http://127.0.0.1:7890/tts',
              value: draft.ttsUrl,
              onChange: (event) => patchDraft(inst.id, 'ttsUrl', event.target.value),
            }),
          ),
          h(
            Field,
            { label: '参考音 / 参考文本', hint: '参考音是 CosyVoice2 的 prompt（wav 路径）；参考文本是那段音频的内容。' },
            h('input', {
              style: { ...S.num, width: 300 }, type: 'text', placeholder: '你的参考音.wav',
              value: draft.ttsPrompt,
              onChange: (event) => patchDraft(inst.id, 'ttsPrompt', event.target.value),
            }),
            h('input', {
              style: { ...S.num, width: 220 }, type: 'text', placeholder: '参考文本',
              value: draft.ttsPromptText,
              onChange: (event) => patchDraft(inst.id, 'ttsPromptText', event.target.value),
            }),
            h('button', { type: 'button', style: S.btn, disabled: busy === `tts:${inst.id}`, onClick: () => probeTts(inst.id) }, busy === `tts:${inst.id}` ? '合成中…' : '试听'),
          ),

          h(SectionTitle, { title: '测试与维护', hint: '保存、测试气泡/语音、试玩动作和循环' }),
          h(
            'div',
            { style: { ...S.row, marginTop: 6 } },
            h('button', { type: 'button', style: S.primary, disabled: busy === `save:${inst.id}`, onClick: () => saveInstance(inst.id) }, busy === `save:${inst.id}` ? '保存中…' : `保存 ${inst.id}`),
            h('button', { type: 'button', style: S.btn, disabled: busy === `bubble:${inst.id}`, onClick: () => bubble(inst.id, { latest: true }) }, '把最新回复打进气泡'),
            h('button', { type: 'button', style: S.btn, disabled: busy === `bubble:${inst.id}`, onClick: () => bubble(inst.id, { text: 'Live2D 气泡测试：这一句来自设置页。' }) }, '发测试气泡'),
          ),

          // 表情/动作试玩：先点一个看看效果，不用等 AI 发
          // 每只模型参数不同：0 轨 = 这个模型没有对应参数，按钮置灰并说明原因
          (() => {
            const cap = instances.find((item) => item.id === inst.id)?.renderer?.capability ?? null
            const support = cap && Array.isArray(cap.actions)
              ? Object.fromEntries(cap.actions.map((item) => [item.id, item]))
              : {}
            return h(
              'div',
              { style: { ...S.row, marginTop: 6, flexWrap: 'wrap' } },
              h('span', { style: S.dim }, '试玩：'),
              ...['nod', 'tilt', 'happy', 'shy', 'surprised', 'angry', 'drool', 'xx', 'puff'].map((action) => {
                const info = support[action]
                const dead = info && info.usable === 0
                const partial = info && info.usable > 0 && info.missing > 0
                return h('button', {
                  key: action,
                  type: 'button',
                  style: dead ? { ...S.btn, opacity: 0.45 } : S.btn,
                  disabled: busy === `anim:${inst.id}` || Boolean(dead),
                  title: dead
                    ? `这只模型没有这个动作需要的参数（缺 ${info.missing} 个），点不动；可以让 AI 先看 /live2d/params 再设计一个`
                    : (partial ? `部分生效：${info.total} 轨里只有 ${info.usable} 轨能落地` : ''),
                  onClick: () => anim(inst.id, action),
                }, action)
              }),
              cap ? null : h('span', { style: S.dim }, '（还没收到这只模型的参数表，重开窗口后会出现可用性标记）'),
            )
          })(),
          // 0.13.9：循环统一挪到「动作」页管理，这里只留单次试玩
          h('p', { style: { ...S.dim, marginTop: 8 } }, '动作循环已移到「动作」页统一管理（可同时绑定两个模型）。'),
          warnList.length
            ? h('ul', { style: { margin: '6px 0 0', paddingLeft: 18 } }, warnList.map((item, index) => h('li', { key: index, style: S.warn }, item)))
            : null,
        )
      }

      // ---- 0.13.3 动作页：直接改实例的 customActions / presetSequences（不走整表保存）----
      const patchInstancePart = async (id, patch) => {
        setBusy(`patch:${id}`)
        const result = await call(`/instances/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
        setNotice(result?.ok ? { kind: 'ok', text: '已保存' } : { kind: 'warn', text: result?.error || '保存失败' })
        await load()
        setBusy('')
      }

      const designDraft = async () => {
        const target = instances.find((item) => item.id === actionTargetId) || instances[0]
        if (!target) return
        if (!newAction.label && !newAction.description) {
          setNotice({ kind: 'warn', text: '先写动作名或一句说明' })
          return
        }
        setBusy('design')
        const result = await call('/preset', {
          method: 'POST',
          body: JSON.stringify({ op: 'design', instanceId: target.id, label: newAction.label, description: newAction.description }),
        })
        if (result?.ok && result.draft) {
          setNewAction((current) => ({ ...current, draft: result.draft, label: current.label || result.draft.label }))
          setNotice({ kind: result.draft.matched ? 'ok' : 'warn', text: result.hint || '已生成草稿' })
        } else {
          setNotice({ kind: 'warn', text: result?.error || '生成失败' })
        }
        setBusy('')
      }

      const previewDraft = async () => {
        if (!instances.length || !newAction.draft) return
        setBusy('preview')
        let okCount = 0
        for (const inst of instances) {
          const result = await call('/preset', {
            method: 'POST',
            body: JSON.stringify({ op: 'preview', instanceId: inst.id, draft: newAction.draft }),
          })
          if (result?.ok) okCount += 1
        }
        setNotice(okCount
          ? { kind: 'ok', text: `正在 ${okCount} 个窗口里播放这次草稿` }
          : { kind: 'warn', text: '预览失败（窗口没开？）' })
        setBusy('')
      }

      const saveDraft = async () => {
        if (!instances.length || !newAction.draft) return
        // 动作默认对所有模型生效（不再有「应用到哪个模型」）
        for (const inst of instances) {
          const draft = draftOf(inst.id)
          const existing = Array.isArray(draft?.customActions) ? draft.customActions : []
          const next = [...existing.filter((item) => item.id !== newAction.draft.id), newAction.draft]
          await patchInstancePart(inst.id, { customActions: next })
        }
        setNewAction({ label: '', description: '', draft: null })
      }

      const instanceTitleOf = (id) => {
        const found = instances.find((item) => item.id === id)
        if (!found) return id
        return found.title || `模型 ${instances.indexOf(found) + 1}`
      }

      const toggleNewLoopStep = (action) => setNewLoop((current) => ({
        ...current,
        steps: current.steps.includes(action) ? current.steps.filter((item) => item !== action) : [...current.steps, action],
      }))

      const editLoop = (seq) => {
        setNewLoop({
          editingId: seq.id,
          label: seq.label || '',
          steps: Array.isArray(seq.steps) ? [...seq.steps] : [],
          intervalSec: Math.max(0.3, Math.round((Number(seq.intervalMs) || 8000) / 100) / 10),
          targets: Array.isArray(seq.targets) ? [...seq.targets] : [],
        })
      }

      const deleteLoop = async (seq) => {
        await call('/preset', { method: 'POST', body: JSON.stringify({ op: 'stop', instanceId: instances[0]?.id }) }).catch(() => null)
        for (const inst of instances) {
          const draft = draftOf(inst.id)
          const existing = Array.isArray(draft?.presetSequencesRaw) ? draft.presetSequencesRaw : []
          if (!existing.some((item) => item.id === seq.id)) continue
          await patchInstancePart(inst.id, { presetSequences: existing.filter((item) => item.id !== seq.id) })
        }
        if (newLoop.editingId === seq.id) setNewLoop({ editingId: '', label: '', steps: [], intervalSec: 8, targets: [] })
      }

      // 预览：让第一台模型把整条循环走一遍（宿主 op:'preview'，once）
      const previewLoop = (seq) => {
        // 按循环自己绑定的模型预览；没勾（= 全部）就每台都走一遍
        const bound = Array.isArray(seq.targets) && seq.targets.length ? seq.targets : instances.map((item) => item.id)
        const targets = instances.filter((item) => bound.includes(item.id))
        if (!targets.length) {
          setNotice({ kind: 'warn', text: '这个循环绑定的模型不在列表里，先去「改」里重新选' })
          return
        }
        setBusy(`preset:${targets.map((item) => item.id).join(',')}`)
        Promise.all(targets.map((target) => call('/preset', {
          method: 'POST',
          body: JSON.stringify({ op: 'preview', instanceId: target.id, sequenceId: seq.id }),
        })))
          .then((results) => {
            const bad = results.find((result) => result?.ok === false)
            setNotice(bad
              ? { kind: 'warn', text: bad?.error || bad?.code || '预览失败' }
              : { kind: 'ok', text: `正在预览「${seq.label || seq.id}」（${targets.map((item) => instanceTitleOf(item.id)).join(' + ')}，走一遍就停）` })
          })
          .finally(() => setBusy(''))
      }

      const saveLoop = async () => {
        if (!instances.length) return
        if (!newLoop.steps.length) {
          setNotice({ kind: 'warn', text: '至少勾一个动作' })
          return
        }
        const id = newLoop.editingId || `loop-${Date.now().toString(36).slice(-5)}`
        const firstDraft = draftOf(instances[0].id)
        const firstExisting = Array.isArray(firstDraft?.presetSequencesRaw) ? firstDraft.presetSequencesRaw : []
        const seq = {
          id,
          label: (newLoop.label || `循环 ${firstExisting.length + 1}`).slice(0, 24),
          steps: newLoop.steps,
          intervalMs: Math.min(60000, Math.max(300, Math.round(Number(newLoop.intervalSec || 8) * 1000))),
          loop: true,
          // 空 = 所有模型都播；勾了就只播勾中的
          targets: (newLoop.targets?.length ? newLoop.targets : []).slice(0, 2),
        }
        // 循环本身写到每个模型上（这样在哪台都能看到/编辑），播放范围由 targets 决定
        for (const inst of instances) {
          const draft = draftOf(inst.id)
          const existing = Array.isArray(draft?.presetSequencesRaw) ? draft.presetSequencesRaw : []
          await patchInstancePart(inst.id, { presetSequences: [...existing.filter((item) => item.id !== id), seq] })
        }
        setNewLoop({ editingId: '', label: '', steps: [], intervalSec: 8, targets: [] })
      }

      const renderActionTab = () => {
        const target = instances.find((item) => item.id === actionTargetId) || instances[0] || null
        if (!target) return h('p', { style: S.warn }, '还没有模型实例（宿主可能是旧版本：重启 DSH）')
        const draft = draftOf(target.id) || {}
        const customActions = Array.isArray(draft.customActions) ? draft.customActions : []
        const sequences = Array.isArray(draft.presetSequencesRaw) ? draft.presetSequencesRaw : []
        const allActions = [
          ...BUILTIN_ACTIONS.map((item) => ({ id: item.id, label: item.label })),
          ...customActions.map((item) => ({ id: item.id, label: item.label || item.id })),
        ]
        return h(
          'div',
          null,
          h('p', { style: S.hint }, '动作与循环默认对所有模型生效；循环可以在下面单独选「播放到哪些模型」。'),

          h('p', { style: S.sub }, '默认动作'),
          h(
            'div',
            { style: { ...S.row, flexWrap: 'wrap' } },
            ...BUILTIN_ACTIONS.map((item) => h(
              'button',
              {
                key: item.id, type: 'button', style: S.btn,
                disabled: busy.startsWith('anim:'),
                onClick: () => anim(target.id, item.id),
              },
              item.label,
            )),
          ),
          customActions.length
            ? h('div', { style: { ...S.row, flexWrap: 'wrap', marginTop: 6 } },
              h('span', { style: S.dim }, '自定义：'),
              ...customActions.map((item) => h('button', {
                key: item.id, type: 'button', style: S.btn,
                disabled: busy.startsWith('anim:'),
                onClick: () => anim(target.id, item.id),
              }, item.label || item.id)))
            : null,

          h(
            'div',
            { style: { ...S.card, marginTop: 12 } },
            h('p', { style: S.sub }, '新增动作'),
            h(Field, { label: '动作名' },
              h('input', {
                style: S.input, value: newAction.label, placeholder: '例如：得意',
                onChange: (event) => setNewAction((current) => ({ ...current, label: event.target.value })),
              })),
            h(Field, { label: '动作说明', hint: '一句话描述想要的动作/情绪；点「生成」得到关键帧草稿，可先预览再保存。' },
              h('textarea', {
                style: { ...S.input, minHeight: 48 }, rows: 2,
                value: newAction.description,
                placeholder: '例如：抬起头、眯起眼睛，一副很得意的样子',
                onChange: (event) => setNewAction((current) => ({ ...current, description: event.target.value })),
              })),
            h(
              'div',
              { style: S.row },
              h('button', { type: 'button', style: S.btn, disabled: busy === 'design', onClick: designDraft }, busy === 'design' ? '生成中…' : '生成'),
              h('button', { type: 'button', style: S.btn, disabled: !newAction.draft || busy === 'preview', onClick: previewDraft }, '预览'),
              h('button', { type: 'button', style: S.primary, disabled: !newAction.draft || busy.startsWith('patch:'), onClick: saveDraft }, '保存动作'),
            ),
            newAction.draft
              ? h('p', { style: S.dim },
                `草稿：${newAction.draft.id}「${newAction.draft.label}」 · ${newAction.draft.tracks.length} 条轨道 · ${newAction.draft.durationMs}ms` +
                (newAction.draft.matched ? `（模板：${newAction.draft.matched}）` : '（通用模板）'))
              : h('p', { style: S.hint }, '提示：现成模板覆盖开心/难过/生气/惊讶/害羞/困倦/思考/招手；更细的可以由 AI 在对话里用 live2d_preset 自己设计。'),
          ),

          h(
            'div',
            { style: { ...S.card, marginTop: 12 } },
            h('p', { style: S.sub }, '动作循环'),
            sequences.length
              ? sequences.map((seq) => h(
                'div',
                { key: seq.id, style: { ...S.row, marginTop: 4, flexWrap: 'wrap' } },
                h('span', { style: S.dim },
                  `${seq.label || seq.id} · ${Array.isArray(seq.steps) ? seq.steps.length : 0} 步 · ${Math.round((Number(seq.intervalMs) || 3000) / 1000)}s` +
                  (Array.isArray(seq.targets) && seq.targets.length
                    ? ` · 绑定 ${seq.targets.map((id) => instanceTitleOf(id)).join(' + ')}`
                    : ' · 跟随当前模型')),
                h('button', {
                  type: 'button',
                  style: S.btn,
                  onClick: () => {
                    // 绑定了多模型就都启起来（同一个循环在两台模型上各跑一遍）
                    // 勾了播放模型就只播那几个；没勾 = 所有模型都跑
                    const targets = Array.isArray(seq.targets) && seq.targets.length ? seq.targets : instances.map((item) => item.id)
                    targets.forEach((id) => presetOp(id, 'start', seq.id))
                  },
                }, '启用'),
                h('button', { type: 'button', style: S.btn, onClick: () => previewLoop(seq) }, '预览'),
                h('button', { type: 'button', style: S.btn, onClick: () => editLoop(seq) }, '改'),
                h('button', { type: 'button', style: S.btn, onClick: () => deleteLoop(seq) }, '删'),
              ))
              : h('p', { style: S.dim }, '还没有循环'),
            h('button', {
              type: 'button',
              style: S.btn,
              // 循环可能同时跑在多台模型上：停止要对所有实例发一遍，只停一台会「关不掉」
              onClick: () => instances.forEach((item) => presetOp(item.id, 'stop')),
            }, '停止循环'),
            h('p', { style: { ...S.sub, marginTop: 10 } }, newLoop.editingId ? '修改循环' : '新建循环'),
            h(Field, { label: '名称' },
              h('input', {
                style: S.input, value: newLoop.label, placeholder: '例如：开心循环',
                onChange: (event) => setNewLoop((current) => ({ ...current, label: event.target.value })),
              })),
            h('div', { style: { ...S.row, flexWrap: 'wrap' } },
              ...allActions.map((item) => h('label', { key: item.id, style: { ...S.row, gap: 4 } },
                h('input', {
                  type: 'checkbox', checked: newLoop.steps.includes(item.id),
                  onChange: () => toggleNewLoopStep(item.id),
                }),
                h('span', { style: S.dim }, item.label)))),
            h(Field, { label: '绑定模型', hint: '不勾 = 只跟随当前模型；勾两个 = 两台模型同时跑这个循环（最多 2 个）' },
              h('div', { style: { ...S.row, flexWrap: 'wrap' } },
                ...instances.map((inst) => h('label', { key: inst.id, style: { ...S.row, gap: 4 } },
                  h('input', {
                    type: 'checkbox',
                    checked: (newLoop.targets || []).includes(inst.id),
                    onChange: () => setNewLoop((current) => {
                      const list = current.targets || []
                      const next = list.includes(inst.id) ? list.filter((item) => item !== inst.id) : [...list, inst.id].slice(0, 2)
                      return { ...current, targets: next }
                    }),
                  }),
                  h('span', { style: S.dim }, instanceTitleOf(inst.id)))))),
            h(Field, { label: '间隔 秒', hint: '两个动作之间停多久（0.3~60s）' },
              h('input', {
                style: S.num, type: 'number', min: '0.3', max: '60', step: '0.5',
                value: newLoop.intervalSec,
                onChange: (event) => setNewLoop((current) => ({ ...current, intervalSec: event.target.value })),
              })),
            h('div', { style: S.row },
              h('button', { type: 'button', style: S.primary, disabled: busy.startsWith('patch:'), onClick: saveLoop },
                newLoop.editingId ? '保存修改' : '保存循环'),
              h('button', {
                type: 'button',
                style: S.btn,
                onClick: () => {
                  const seq = newLoop.editingId ? sequences.find((item) => item.id === newLoop.editingId) : null
                  if (!seq) { setNotice({ kind: 'warn', text: '先保存这条循环，再点预览' }); return }
                  previewLoop(seq)
                },
              }, '预览这条循环'),
              newLoop.editingId
                ? h('button', { type: 'button', style: S.btn, onClick: () => setNewLoop({ editingId: '', label: '', steps: [], intervalSec: 8, targets: [] }) }, '取消修改')
                : null,
              h('span', { style: S.dim }, newLoop.editingId ? `正在修改「${newLoop.label || newLoop.editingId}」` : '保存后在窗口右键菜单里也能选到'),
            ),
          ),
        )
      }

      const renderer = health?.renderer || {}
      const model = health?.model || {}
      const warnList = Array.isArray(meta?.warnings) ? meta.warnings : []

      // ---- 0.13.9 模式设置页：把「模式依赖的开关」集中到一处，勾了立即生效 ----
      const renderModeTab = () => {
        const target = instances.find((item) => item.id === actionTargetId) || instances[0] || null
        if (!target) {
          return h('div', { style: S.card }, h('p', { style: S.dim }, '还没有模型实例，去「模型1」页启用一个。'))
        }
        const cfg = target.config || {}
        const current = { auto: '手动', semi: 'AI 半自动', manual: 'AI 自动' }[cfg.mode] || '手动'
        const toggle = (key) => h('input', {
          type: 'checkbox',
          checked: Boolean(draftOf(target.id)?.[key] ?? cfg[key]),
          disabled: busy === `patch:${target.id}`,
          onChange: (event) => patchInstancePart(target.id, { [key]: event.target.checked }),
        })
        // 参数输入：失焦时提交（避免边打字边 PATCH）；opts.ms = 配置存毫秒、界面按秒显示
        const num = (key, min, max, step, unit, opts = {}) => {
          const raw = Number(cfg[key])
          const shown = Number.isFinite(raw) ? (opts.ms ? raw / 1000 : raw) : ''
          return h(
            'label',
            { style: { ...S.row, gap: 6, marginLeft: 10 }, key: `${target.id}:${key}:${shown}` },
            h('input', {
              style: { ...S.num, width: 72 }, type: 'number', min: String(min), max: String(max), step: String(step),
              defaultValue: String(shown),
              onBlur: (event) => {
                const value = Number(event.target.value)
                if (!Number.isFinite(value)) return
                const next = opts.ms ? Math.round(value * 1000) : value
                if (Number.isFinite(raw) && next === raw) return
                patchInstancePart(target.id, { [key]: next })
              },
            }),
            h('span', { style: S.dim }, unit),
          )
        }
        const group = (title, hint, children) => h(
          'div',
          { style: { ...S.card, marginTop: 10 } },
          h('p', { style: S.sub }, title),
          h('p', { style: { ...S.hint, marginTop: 2 } }, hint),
          ...children,
        )
        const enableAll = () => patchInstancePart(target.id, {
          screenReadEnabled: true,
          screenCaptureEnabled: true,
          wakeCaptureEnabled: true,
          wakeEnabled: true,
          aiMoveEnabled: true,
        })
        const allOff = cfg.screenReadEnabled !== true || cfg.screenCaptureEnabled !== true || cfg.wakeEnabled !== true
        return h(
          'div',
          {},
          h(
            'div',
            { style: S.card },
            h(Field, { label: '调整哪个模型' },
              h('select', {
                style: S.input,
                value: target.id,
                onChange: (event) => setActionTargetId(event.target.value),
              }, ...instances.map((inst) => h('option', { key: inst.id, value: inst.id }, instanceTitleOf(inst.id))))),
            h('p', { style: { ...S.hint, marginTop: 6 } }, `当前模式：${current}（在窗口工具栏或「模型」页切换）`),
            h('div', { style: { ...S.row, marginTop: 8, flexWrap: 'wrap', gap: 8 } },
              h('button', { type: 'button', style: S.primary, disabled: busy === `patch:${target.id}`, onClick: enableAll }, '一键开启模式所需开关'),
              allOff ? h('span', { style: S.warn }, '当前有开关是关的，模式会「看起来没区别」') : null),
            h('p', { style: { ...S.hint, marginTop: 6 } }, '说明：这些开关默认已开（0.13.9 起）；关掉后对应模式的能力会失效，按需逐个关。'),
          ),
          group('手动', '不主动：只有你点 ⚡ 或摸模型才回应。这里的读屏/截图也是 ⚡ 唤醒时用的。', [
            h(Field, { label: '读屏 · 前台标题', hint: '只读当前窗口标题（不截图），用来说明你在什么软件里。数字是读取间隔；⚡ 唤醒每次都会现读一次，不需要定时。' },
              toggle('screenReadEnabled'), num('screenWatchIntervalMs', 15, 300, 15, '秒一次', { ms: true })),
            h(Field, { label: '允许截图', hint: '开启后 ⚡ / 定时唤醒可以截一张全屏（可能含别的窗口，注意隐私）；这是总开关，关掉后「唤醒时截图」也不生效' },
              toggle('screenCaptureEnabled'), num('screenCaptureIntervalMs', 5, 300, 5, '秒最短间隔', { ms: true })),
            h(Field, { label: '截图免确认', hint: '开启后唤醒/工具截图不再先问一句；总开关关掉时不生效' }, toggle('screenCaptureAutoConfirm')),
            h(Field, { label: '点模型有反应' }, toggle('autoInteract')),
            h(Field, { label: '空闲小动作', hint: '闲着时随机眨眼/歪头' }, toggle('idlePresets')),
          ]),
          group('AI 半自动', '自动上气泡 + 思考/回答时自动做动作，并按间隔主动唤醒。', [
            h(Field, { label: '定时唤醒', hint: '关掉时半自动只剩「上气泡」，不会主动看你' },
              toggle('wakeEnabled'), num('wakeIntervalMs', 15, 600, 5, '秒一次', { ms: true }), num('wakeMaxPerHour', 1, 360, 10, '次/滚动小时')),
            h(Field, { label: '唤醒时截图', hint: '关 = 只读窗口标题；开 = 唤醒时截一张一起给我看' }, toggle('wakeCaptureEnabled')),
          ]),
          group('AI 自动', '在半自动基础上，AI 还能自己移动/缩放窗口（会保证工具栏留在屏内、单次不超半屏）。', [
            h(Field, { label: '交给 AI 移动窗口' }, toggle('aiMoveEnabled')),
          ]),
        )
      }

      // 顶部 tab：动作 / 模式设置 / 模型1 / 模型2（固定两槽，模型2 未创建时在页内启用）
      const tabDefs = [
        { key: 'actions', label: '动作' },
        { key: 'modes', label: '模式设置' },
        { key: 'model:0', label: '模型1' },
        { key: 'model:1', label: '模型2' },
      ]
      const activeTab = tabDefs.some((item) => item.key === activeTabKey) ? activeTabKey : 'actions'
      const slotIndex = activeTab.startsWith('model:') ? Number(activeTab.slice(6)) : -1
      const slotInst = slotIndex >= 0 ? instances[slotIndex] : null

      const renderModelTab = () => {
        if (slotInst) return renderInstance(slotInst)
        if (slotIndex === 1) {
          return h(
            'div',
            { style: { ...S.card, borderStyle: 'dashed' } },
            h('p', { style: S.sub }, '启用模型 2'),
            h('p', { style: S.hint }, '最多两个模型。启用后这里会出现完整设置；同一个模型不能两个实例共用。'),
            h(
              Field,
              { label: '模型' },
              h(
                'select',
                { style: S.select, value: createDraft.modelPath, onChange: (event) => setCreateDraft((current) => ({ ...current, modelPath: event.target.value })) },
                h('option', { value: '' }, '（选择模型）'),
                models.map((item) => h('option', { key: item.key, value: item.dir, disabled: Boolean(item.usedBy) }, `${item.name || item.dir}${item.usedBy ? `（已被 ${item.usedBy} 用）` : ''}`)),
              ),
            ),
            h(
              Field,
              { label: '绑定会话', hint: '可以先不绑，之后在卡片里绑。' },
              h(
                'select',
                { style: S.select, value: createDraft.sessionId, onChange: (event) => setCreateDraft((current) => ({ ...current, sessionId: event.target.value })) },
                h('option', { value: '' }, '未绑定'),
                sessions.map((item) => h('option', { key: item.id, value: item.id, disabled: instances.some((inst) => inst.sessionId === item.id) }, `${sessionLabel(item)}${instances.some((inst) => inst.sessionId === item.id) ? '（已被占用）' : ''}`)),
              ),
            ),
            h(
              'div',
              { style: S.row },
              h('button', { type: 'button', style: S.primary, disabled: busy === 'create', onClick: createInstance }, busy === 'create' ? '启用中…' : '启用模型 2'),
            ),
          )
        }
        return h('p', { style: S.warn }, '没有实例（宿主可能是旧版本：重启 DSH）')
      }

      return h(
        'div',
        { style: S.wrap },
        h('p', { style: S.title }, 'Live2D 模型接入'),
        h('p', { style: S.dim }, '每个实例是一个独立的透明置顶窗口（单 Electron 进程、多窗口）。窗口跟插件生命周期走：禁用/卸载/退出 DSH 会自动关掉。配置存 config.json，重启后仍生效。'),

        h(
          'div',
          {
            style: {
              ...S.row,
              borderBottom: '1px solid rgba(128,128,128,.25)',
              marginTop: 8,
              gap: 2,
              position: 'sticky',
              top: 0,
              zIndex: 4,
              background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.96))',
            },
          },
          tabDefs.map((item) => h(
            'button',
            {
              key: item.key,
              type: 'button',
              style: {
                ...S.btn,
                border: 'none',
                borderRadius: 0,
                background: 'transparent',
                borderBottom: activeTab === item.key ? '2px solid #5b8cff' : '2px solid transparent',
                color: activeTab === item.key ? 'inherit' : 'inherit',
                opacity: activeTab === item.key ? 1 : 0.65,
              },
              onClick: () => setActiveTabKey(item.key),
            },
            item.label,
          )),
        ),

        activeTab === 'actions' ? renderActionTab() : activeTab === 'modes' ? renderModeTab() : renderModelTab(),

        h(
          'div',
          { style: { ...S.card, marginTop: 14 } },
          h('p', { style: S.sub }, '宿主状态'),
          h(Row, { label: '阶段 / 版本', children: `${health?.stage || '—'} / ${health?.version || '—'}` }),
          h(Row, { label: '运行状态', children: health?.phase || '—' }),
          h(Row, { label: '实例数', children: `${instances.length} / 2` }),
          h(Row, { label: '窗口进程', children: health?.windowRunning ? '在跑' : '未运行' }),
          h(Row, { label: '默认实例模型', children: model.ok ? `ok · ${model.entry || ''}` : `不可用：${model.reason || '未探测'}` }),
          h(Row, { label: '模型扫描根', children: modelRoots.length ? modelRoots.join('、') : 'D:\\Live2D（默认）' }),
          renderer.lastError ? h('p', { style: S.warn }, `最近渲染错误：${renderer.lastError}`) : null,
        ),

        h(
          'div',
          { style: { ...S.row, marginTop: 14 } },
          h('button', { type: 'button', style: S.btn, disabled: busy === 'load', onClick: load }, busy === 'load' ? '刷新中…' : '刷新'),
          notice.text ? h('span', { style: notice.kind === 'warn' ? S.warn : S.ok }, notice.text) : null,
        ),
        warnList.length
          ? h('div', { style: S.card }, h('p', { style: S.sub }, '告警'), h('ul', { style: { margin: '4px 0 0', paddingLeft: 18 } }, warnList.map((item, index) => h('li', { key: index, style: S.warn }, item))))
          : null,
        meta?.file ? h('p', { style: S.hint }, `配置文件：${meta.file}`) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 设置 → 左侧栏「Live2D」。order 57 排在「插件治理 56」之后，避免和现有条目抢位。
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'live2d', order: 57, label: 'Live2D' },
            Live2DSettings,
          ),
        )

        // 插件管理页也放一个入口，方便「装了但找不到设置」的情况。
        ctx.slots.inject('plugins.tab', () =>
          ctx.slots.register(
            { name: 'plugins.tab', id: 'live2d', order: 57, label: 'Live2D' },
            Live2DSettings,
          ),
        )
      },
    }
  },
})

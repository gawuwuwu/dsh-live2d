// 独立姿势设计器：复用当前 Live2D 模型窗口，按“起始 → 中间 → 最终”拖骨架并保存动作。
(() => {
  const bridge = window.Live2DPoseEditorBridge
  if (!bridge) return

  const editor = document.getElementById('pose-editor')
  const handles = document.getElementById('pose-editor-handles')
  const sidebar = document.getElementById('pose-editor-sidebar')
  const sidebarToggle = document.getElementById('pose-editor-sidebar-toggle')
  const stepsEl = document.getElementById('pose-editor-steps')
  const toastsEl = document.getElementById('pose-editor-toasts')
  const usedEl = document.getElementById('pose-editor-used')
  const unusedEl = document.getElementById('pose-editor-unused')
  const summaryEl = document.getElementById('pose-editor-summary')
  const idInput = document.getElementById('pose-editor-id')
  const labelInput = document.getElementById('pose-editor-label')
  const durationInput = document.getElementById('pose-editor-duration')
  const previewButton = document.getElementById('pose-editor-preview')
  const saveButton = document.getElementById('pose-editor-save')
  const closeButton = document.getElementById('pose-editor-close')
  const addStepButton = document.getElementById('pose-editor-add-step')
  const removeStepButton = document.getElementById('pose-editor-remove-step')

  let session = null
  let current = null
  let drag = null
  let renderedHandles = []

  const MAX_POSE_STEPS = 32
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

  function paramInfo(name, meta = null) {
    const raw = String(name || '')
    const lower = raw.toLowerCase()
    let label = `模型作者自定义参数：${raw}`
    let unit = '模型单位/开关值'
    let step = 1
    if (/bodyanglex/.test(lower)) { label = '身体左右倾斜'; unit = '度（+1 = +1°）' }
    else if (/bodyangley/.test(lower)) { label = '身体前后倾斜'; unit = '度（+1 = +1°）' }
    else if (/bodyanglez/.test(lower)) { label = '身体扭转'; unit = '度（+1 = +1°）' }
    else if (/anglex|headx/.test(lower)) { label = '头部左右转动'; unit = '度（+1 = +1°）' }
    else if (/angley|heady/.test(lower)) { label = '头部上下俯仰'; unit = '度（+1 = +1°）' }
    else if (/anglez|headz/.test(lower)) { label = '头部左右倾斜'; unit = '度（+1 = +1°）' }
    else if (/eyeballx/i.test(raw)) { label = '眼球左右'; unit = '比例'; step = 0.05 }
    else if (/eyebally/i.test(raw)) { label = '眼球上下'; unit = '比例'; step = 0.05 }
    else if (/eye[lr]open/i.test(raw)) { label = /l/i.test(raw) ? '左眼开合' : '右眼开合'; unit = '比例'; step = 0.05 }
    else if (/mouthopen/i.test(raw)) { label = '嘴巴开合'; unit = '比例'; step = 0.05 }
    else if (/mouthform/i.test(raw)) { label = '嘴角表情'; unit = '比例'; step = 0.05 }
    else if (/brow/i.test(raw)) { label = '眉毛形状/高度/角度'; unit = '模型单位'; step = 0.05 }
    else if (/armz/i.test(raw)) { label = '上臂横向摆动（手臂Z轴）'; unit = '模型单位/度' }
    else if (/shoulder/i.test(raw) || /^[lr]arm$/i.test(raw)) { label = '肩部/上臂'; unit = '模型单位/度' }
    else if (/forearm|elbow/i.test(raw)) { label = '手肘/前臂弯曲'; unit = '模型单位/度' }
    else if (/wrist/i.test(raw)) { label = '手腕摆动'; unit = '模型单位/度' }
    else if (/hand/i.test(raw)) { label = '手掌/手指姿态'; unit = '模型单位' }
    else if (/hip/i.test(raw)) { label = '髋部转动'; unit = '模型单位/度' }
    else if (/leg/i.test(raw)) { label = '腿部关节'; unit = '模型单位/度' }
    else if (/^param_exp/i.test(raw)) { label = '表情贴图/表情开关'; unit = '模型开关值' }
    else if (/^paramcol_/i.test(raw)) { label = '部件颜色或显示开关'; unit = '模型开关值' }
    else if (/^key\d+/i.test(raw)) { label = '模型作者的部件切换键'; unit = '模型开关值' }
    else if (/paramhf_/i.test(raw)) { label = '前发/发丝摆动'; unit = '模型单位/度' }
    else if (/paramtwl/i.test(raw)) { label = '尾部/发束/飘带摆动'; unit = '模型单位/度' }
    else if (/paramyfwl/i.test(raw)) { label = '衣发/飘带次级摆动'; unit = '模型单位/度' }
    else if (/paramgsfwl/i.test(raw)) { label = '衣物/头发摇摆'; unit = '模型单位/度' }
    else if (/artmesh/i.test(raw)) { label = '特定 ArtMesh 旋转控制'; unit = '模型单位/度' }
    return {
      label,
      unit,
      step,
      min: Number.isFinite(Number(meta?.min)) ? Number(meta.min) : null,
      max: Number.isFinite(Number(meta?.max)) ? Number(meta.max) : null,
      default: Number.isFinite(Number(meta?.default)) ? Number(meta.default) : 0,
    }
  }

  function defaultValue(name, context = current?.context) {
    return paramInfo(name, context?.paramMeta?.[name]).default
  }

  function valueRange(name, context = current?.context) {
    const meta = context?.paramMeta?.[name] ?? {}
    const min = Number.isFinite(Number(meta.min)) ? Number(meta.min) : -1
    const max = Number.isFinite(Number(meta.max)) ? Number(meta.max) : 1
    return { min, max, span: Math.max(0.001, max - min) }
  }

  function normalizeValue(name, value, context = current?.context) {
    const range = valueRange(name, context)
    return clamp(Number(value) || 0, range.min, range.max)
  }

  function makeStep(kind) {
    return { kind, params: {}, toggles: {} }
  }

  function cloneStep(step, kind = step?.kind || 'middle') {
    return {
      kind,
      params: { ...(step?.params ?? {}) },
      toggles: { ...(step?.toggles ?? {}) },
    }
  }

  function actionValue(track, t, context) {
    const keys = (Array.isArray(track?.keys) ? track.keys : [])
      .map((pair) => [Number(pair?.[0]), pair?.[1]])
      .filter((pair) => Number.isFinite(pair[0]))
      .sort((a, b) => a[0] - b[0])
    if (!keys.length) return defaultValue(track?.param, context)
    const valueOf = (raw) => {
      if (raw !== 'current') return Number(raw) || 0
      return bridge.currentValue(track.param) ?? defaultValue(track.param, context)
    }
    if (t <= keys[0][0]) return valueOf(keys[0][1])
    for (let index = 1; index < keys.length; index += 1) {
      const [t0, raw0] = keys[index - 1]
      const [t1, raw1] = keys[index]
      if (t <= t1) {
        const v0 = valueOf(raw0)
        const v1 = valueOf(raw1)
        const k = (t - t0) / (t1 - t0 || 1)
        const eased = k * k * (3 - 2 * k)
        return v0 + (v1 - v0) * eased
      }
    }
    return valueOf(keys.at(-1)[1])
  }

  /** 把已有动作的所有轨道按时间并集还原成可拖拽的姿势步骤。 */
  function importAction(action, context) {
    const tracks = (Array.isArray(action?.tracks) ? action.tracks : [])
      .filter((track) => track && typeof track.param === 'string')
    if (!tracks.length) {
      return { steps: null, note: '这个动作没有可编辑的关键帧轨道，已打开空白设计器。' }
    }
    const times = new Set([0, 1])
    for (const track of tracks) {
      for (const pair of Array.isArray(track.keys) ? track.keys : []) {
        const t = Number(pair?.[0])
        if (Number.isFinite(t)) times.add(clamp(t, 0, 1))
      }
    }
    let ordered = [...times].sort((a, b) => a - b)
      .filter((t, index, list) => index === 0 || Math.abs(t - list[index - 1]) > 0.0001)
    let note = ''
    if (ordered.length > MAX_POSE_STEPS) {
      const compact = []
      for (let index = 0; index < MAX_POSE_STEPS; index += 1) {
        compact.push(ordered[Math.round(index * (ordered.length - 1) / (MAX_POSE_STEPS - 1))])
      }
      ordered = [...new Set(compact)]
      note = `原动作有 ${times.size} 个关键时间点，设计器最多显示 ${MAX_POSE_STEPS} 步，已保留首尾并等距采样。`
    }
    const steps = ordered.map((t, index) => {
      const kind = index === 0 ? 'start' : index === ordered.length - 1 ? 'end' : 'middle'
      const step = makeStep(kind)
      for (const track of tracks) {
        const actual = bridge.resolveParam(track.param) || track.param
        step.params[actual] = normalizeValue(actual, actionValue(track, t, context), context)
      }
      return step
    })
    return { steps, note }
  }

  function newSession(command = {}) {
    const context = bridge.getContext()
    const action = command.action && typeof command.action === 'object' ? command.action : null
    const imported = action ? importAction(action, context) : { steps: null, note: '' }
    return {
      profileId: command.profileId ?? null,
      context,
      steps: imported.steps ?? [makeStep('start'), makeStep('middle'), makeStep('end')],
      active: 0,
      originalBounds: null,
      originalIgnoreMouse: false,
      sourceAction: action,
      id: action?.id || `custom-pose-${Date.now().toString(36).slice(-6)}`,
      label: action?.label || '自定义姿势动作',
      durationMs: clamp(Number(action?.durationMs) || ((imported.steps?.length ?? 3) - 1) * 1200, 200, 10000),
      meta: action ? {
        hold: action.hold === true,
        repeat: Math.max(1, Math.min(6, Math.round(Number(action.repeat) || 1))),
        body: action.body === true,
        desc: typeof action.desc === 'string' ? action.desc : '',
        group: typeof action.group === 'string' ? action.group : '',
        auto: action.auto === true,
      } : {},
      loadNote: imported.note,
      truncated: Boolean(imported.note),
    }
  }

  function stepLabel(step, index) {
    if (step.kind === 'start') return '起始'
    if (step.kind === 'end') return '最终'
    return `中间${current.steps.slice(1, index + 1).filter((item) => item.kind === 'middle').length}`
  }

  function activeStep() {
    return current?.steps?.[current.active] ?? null
  }

  function allStepParams() {
    const out = new Set()
    for (const step of current?.steps ?? []) for (const name of Object.keys(step.params ?? {})) out.add(name)
    return [...out]
  }

  function buildDraft() {
    const params = allStepParams()
    const steps = current?.steps ?? []
    if (!current || steps.length < 2 || !params.length) return null
    const durationMs = clamp(Number(durationInput.value) || (steps.length - 1) * 1200, 200, 10000)
    const tracks = params.map((param) => ({
      param,
      keys: steps.map((step, index) => [
        index / Math.max(1, steps.length - 1),
        normalizeValue(param, step.params[param] ?? defaultValue(param)),
      ]),
    }))
    return {
      ...current.meta,
      id: idInput.value.trim() || current.id || `custom-pose-${Date.now().toString(36).slice(-6)}`,
      label: labelInput.value.trim() || '自定义姿势动作',
      durationMs,
      tracks,
    }
  }

  function previewCurrentPose() {
    const step = activeStep()
    if (!step) return
    bridge.previewPose(step.params)
  }

  function addOrUpdateParam(name, value) {
    const step = activeStep()
    if (!step || !name) return
    step.params[name] = normalizeValue(name, value ?? defaultValue(name))
    previewCurrentPose()
    render()
  }

  function renderSteps() {
    stepsEl.textContent = ''
    current.steps.forEach((step, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = index === current.active ? 'active' : ''
      button.textContent = stepLabel(step, index)
      button.onclick = () => {
        current.active = index
        render()
        previewCurrentPose()
      }
      stepsEl.appendChild(button)
    })
    removeStepButton.disabled = activeStep()?.kind !== 'middle'
    addStepButton.disabled = current.steps.length >= MAX_POSE_STEPS
    addStepButton.title = current.steps.length >= MAX_POSE_STEPS
      ? `最多 ${MAX_POSE_STEPS} 个姿势步骤`
      : '在当前姿势之后插入一个复制当前姿态的中间姿势'
  }

  function renderToggles() {
    toastsEl.textContent = ''
    const step = activeStep()
    const actions = current.context.capabilities ?? []
    if (!actions.length) {
      toastsEl.textContent = '当前模型没有扫描到可切换的表情、换装或手势。'
      return
    }
    const labels = { face: '表情', clothes: '换装', gesture: '手势', other: '其它切换' }
    const order = ['face', 'clothes', 'gesture', 'other']
    const grouped = actions.reduce((result, action) => {
      const group = order.includes(action.group) ? action.group : 'other'
      ;(result[group] ??= []).push(action)
      return result
    }, {})
    for (const group of order) {
      const list = grouped[group] ?? []
      if (!list.length) continue
      const box = document.createElement('div')
      box.className = 'pose-toggle-group'
      const heading = document.createElement('div')
      heading.className = 'pose-toggle-label'
      heading.textContent = labels[group]
      box.appendChild(heading)
      for (const action of list) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = step.toggles[action.id] ? 'active' : ''
        button.textContent = action.label || action.id
        button.title = `${labels[group]}：${action.desc || '只切换当前姿势；切换步骤后仍会保持该姿势自己的选择'}`
        button.onclick = () => {
          const saved = step.toggles[action.id]
          if (saved) {
            for (const [param, item] of Object.entries(saved)) {
              if (item.present) step.params[param] = item.value
              else delete step.params[param]
            }
            delete step.toggles[action.id]
          } else {
            const before = {}
            for (const track of action.tracks ?? []) {
              const actual = bridge.resolveParam(track.param) || track.param
              before[actual] = {
                present: Object.prototype.hasOwnProperty.call(step.params, actual),
                value: step.params[actual] ?? defaultValue(actual),
              }
              const last = track.keys?.at(-1)?.[1]
              const raw = last === 'current' ? bridge.currentValue(actual) : last
              step.params[actual] = normalizeValue(actual, raw ?? defaultValue(actual))
            }
            step.toggles[action.id] = before
          }
          previewCurrentPose()
          render()
        }
        box.appendChild(button)
      }
      toastsEl.appendChild(box)
    }
  }

  function renderUsedParams() {
    const step = activeStep()
    usedEl.textContent = ''
    const names = Object.keys(step?.params ?? {})
    if (!names.length) {
      usedEl.textContent = '当前姿势还没有参数。拖动模型上的骨架圆点，或在下方展开未使用参数手动添加。'
      return
    }
    const table = document.createElement('table')
    const head = document.createElement('tr')
    for (const label of ['骨架 / 参数', '单位', '范围', '数值', '']) {
      const th = document.createElement('th')
      th.textContent = label
      head.appendChild(th)
    }
    table.appendChild(head)
    for (const name of names) {
      const info = paramInfo(name, current.context.paramMeta?.[name])
      const row = document.createElement('tr')
      const identity = document.createElement('td')
      const label = document.createElement('div')
      label.textContent = info.label
      const raw = document.createElement('div')
      raw.style.opacity = '.55'
      raw.style.fontFamily = 'monospace'
      raw.textContent = name
      identity.append(label, raw)
      const unit = document.createElement('td')
      unit.textContent = info.unit
      const range = document.createElement('td')
      range.textContent = `${info.min ?? '?'} ~ ${info.max ?? '?'}`
      const valueCell = document.createElement('td')
      const input = document.createElement('input')
      input.type = 'number'
      input.step = String(info.step)
      input.value = String(step.params[name])
      input.oninput = () => {
        step.params[name] = normalizeValue(name, input.value)
        previewCurrentPose()
      }
      valueCell.appendChild(input)
      const removeCell = document.createElement('td')
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = '删'
      remove.onclick = () => {
        delete step.params[name]
        previewCurrentPose()
        render()
      }
      removeCell.appendChild(remove)
      row.append(identity, unit, range, valueCell, removeCell)
      table.appendChild(row)
    }
    usedEl.appendChild(table)
  }

  function renderUnusedParams() {
    const step = activeStep()
    const used = new Set(Object.keys(step?.params ?? {}))
    const unused = (current.context.params ?? []).filter((name) => !used.has(name))
    unusedEl.textContent = ''
    if (!unused.length) {
      unusedEl.textContent = '全部参数都已加入当前姿势。'
      return
    }
    const select = document.createElement('select')
    select.style.maxWidth = '100%'
    select.innerHTML = '<option value="">选择要添加的参数</option>'
    for (const name of unused) {
      const info = paramInfo(name, current.context.paramMeta?.[name])
      const option = document.createElement('option')
      option.value = name
      option.textContent = `${info.label}｜${name}`
      select.appendChild(option)
    }
    const add = document.createElement('button')
    add.type = 'button'
    add.textContent = '加入当前姿势'
    add.onclick = () => addOrUpdateParam(select.value)
    unusedEl.append(select, add)
  }

  function renderHandles() {
    handles.textContent = ''
    renderedHandles = []
    const box = current?.context?.bounds
    if (!box || !Number.isFinite(box.width) || !Number.isFinite(box.height)) return
    const armSides = current?.context?.armSides ?? { left: 'R', right: 'L' }
    const screenLeft = armSides.left === 'L' ? 'L' : 'R'
    const screenRight = screenLeft === 'R' ? 'L' : 'R'
    const controls = [
      { label: '头', x: 0.5, y: 0.16, params: [['headX', 'x'], ['headY', 'y']] },
      { label: '身体', x: 0.5, y: 0.46, params: [['bodyX', 'x'], ['bodyY', 'y']] },
      { label: '髋', x: 0.5, y: 0.67, params: [['hipX', 'x']] },
      // 正面角色的解剖左臂显示在屏幕右侧。控制点按玩家看到的屏幕方向命名，
      // 并把肩/肘/腕拆开，避免拖肩时连带改肘、无法独立摆出抵胸姿势。
      { label: '屏幕左肩', x: 0.36, y: 0.38, params: [[`shoulder${screenLeft}`, 'y'], [`armZ${screenLeft}`, 'x']] },
      { label: '屏幕右肩', x: 0.64, y: 0.38, params: [[`shoulder${screenRight}`, 'y'], [`armZ${screenRight}`, 'x']] },
      { label: '屏幕左肘', x: 0.30, y: 0.50, params: [[`elbow${screenLeft}`, 'y']] },
      { label: '屏幕右肘', x: 0.70, y: 0.50, params: [[`elbow${screenRight}`, 'y']] },
      { label: '屏幕左手', x: 0.25, y: 0.61, params: [[`wrist${screenLeft}`, 'x'], [`hand${screenLeft}`, 'y']] },
      { label: '屏幕右手', x: 0.75, y: 0.61, params: [[`wrist${screenRight}`, 'x'], [`hand${screenRight}`, 'y']] },
      { label: '屏幕左腿', x: 0.42, y: 0.82, params: [['legR', 'y']] },
      { label: '屏幕右腿', x: 0.58, y: 0.82, params: [['legL', 'y']] },
    ]
    for (const item of controls) {
      const mapped = item.params
        .map(([logical, axis]) => ({ logical, axis, actual: bridge.resolveParam(logical) }))
        .filter((entry) => entry.actual)
      if (!mapped.length) continue
      renderedHandles.push({
        label: item.label,
        bindings: mapped.map((entry) => ({ logical: entry.logical, actual: entry.actual, axis: entry.axis })),
      })
      const handle = document.createElement('div')
      handle.className = 'pose-handle'
      const sidebarLeft = sidebar?.getBoundingClientRect?.().left ?? window.innerWidth - 8
      const left = clamp(box.x + box.width * item.x, 10, Math.max(10, sidebarLeft - 16))
      handle.style.left = `${left}px`
      handle.style.top = `${clamp(box.y + box.height * item.y, 58, window.innerHeight - 10)}px`
      if (left + 110 > sidebarLeft) handle.classList.add('label-left')
      const label = document.createElement('span')
      label.textContent = item.label
      handle.appendChild(label)
      handle.onpointerdown = (event) => {
        const step = activeStep()
        drag = {
          x: event.clientX, y: event.clientY, handle, step,
          values: Object.fromEntries(mapped.map((entry) => [
            entry.actual,
            step.params[entry.actual] ?? defaultValue(entry.actual),
          ])),
          mapped,
        }
        handle.classList.add('dragging')
        handle.setPointerCapture(event.pointerId)
        event.preventDefault()
        event.stopPropagation()
      }
      handle.onpointermove = (event) => {
        if (!drag || drag.handle !== handle) return
        const dx = event.clientX - drag.x
        const dy = event.clientY - drag.y
        for (const entry of drag.mapped) {
          const range = valueRange(entry.actual)
          const delta = entry.axis === 'x' ? dx : -dy
          const divisor = entry.axis === 'x' ? Math.max(80, box.width * 0.45) : Math.max(80, box.height * 0.35)
          drag.step.params[entry.actual] = normalizeValue(entry.actual, drag.values[entry.actual] + (delta / divisor) * range.span)
        }
        previewCurrentPose()
        renderUsedParams()
      }
      handle.onpointerup = handle.onpointercancel = () => {
        handle.classList.remove('dragging')
        drag = null
      }
      handles.appendChild(handle)
    }
  }

  function render() {
    if (!current) return
    current.context = bridge.getContext()
    renderSteps()
    renderToggles()
    renderUsedParams()
    renderUnusedParams()
    renderHandles()
    const draft = buildDraft()
    const base = draft
      ? `${current.steps.length} 步 · ${draft.tracks.length} 个参数 · ${(draft.durationMs / 1000).toFixed(1)}s`
      : '拖动骨架或添加参数开始设计'
    summaryEl.textContent = current.loadNote ? `${base} · ${current.loadNote}` : base
  }

  function snapshot() {
    const editorState = bridge.getEditorState?.() ?? {}
    const centerOf = (element) => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    }
    return {
      open: Boolean(current),
      sourceActionId: current?.sourceAction?.id ?? null,
      active: current?.active ?? null,
      steps: (current?.steps ?? []).map((step, index) => ({
        index,
        kind: step.kind,
        label: stepLabel(step, index),
        params: Object.keys(step.params ?? {}).length,
        toggles: Object.keys(step.toggles ?? {}).length,
      })),
      handles: handles.querySelectorAll('.pose-handle').length,
      handleBindings: renderedHandles,
      capabilities: current?.context?.capabilities?.length ?? 0,
      modelBounds: current?.context?.bounds ?? null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      durationMs: current?.durationMs ?? null,
      editorExpanded: editor.classList.contains('hidden') === false,
      closeCenter: centerOf(closeButton),
      firstHandleCenter: centerOf(handles.querySelector('.pose-handle')),
      ignoringMouse: editorState.ignoringMouse,
      modelFrozen: editorState.frozen === true,
      editorOffset: editorState.offset ?? 0,
      armSides: editorState.armSides ?? current?.context?.armSides ?? null,
      armCalibration: editorState.armCalibration ?? null,
    }
  }

  function notifyEditor(phase, extra = {}) {
    try {
      window.live2dWindow?.report?.({ type: 'state', phase, ...snapshot(), ...extra })
    } catch { /* 诊断上报不影响编辑 */ }
  }

  async function open(command = {}) {
    editor.classList.remove('hidden')
    sidebar.classList.remove('collapsed')
    sidebarToggle.textContent = '收起参数面板'
    document.body.classList.add('pose-editing')
    let originalBounds = null
    let originalIgnoreMouse = false
    try {
      const state = await window.live2dWindow?.state?.()
      originalBounds = state?.bounds ?? null
      originalIgnoreMouse = state?.ignoreMouse === true
    } catch { /* 保持默认 */ }
    bridge.setEditorBounds(true)
    bridge.setEditorActive(true)
    session = newSession(command)
    session.originalBounds = originalBounds
    session.originalIgnoreMouse = originalIgnoreMouse
    current = session
    idInput.value = current.id
    labelInput.value = current.label
    durationInput.value = String(Math.round(current.durationMs))
    render()
    previewCurrentPose()
    setTimeout(() => {
      if (!current) return
      bridge.layoutEditor?.()
      render()
      notifyEditor('pose-editor-loaded')
    }, 350)
  }

  function close() {
    if (!current) return
    bridge.stopPreview()
    bridge.setEditorActive(false)
    bridge.setEditorBounds(false, current.originalBounds)
    bridge.setEditorIgnore(current.originalIgnoreMouse)
    editor.classList.add('hidden')
    document.body.classList.remove('pose-editing')
    current = null
    session = null
  }

  function onSaveResult(command) {
    if (!current) return
    summaryEl.textContent = command?.ok
      ? `已保存：${command.actionId || buildDraft()?.id || ''}`
      : `保存失败：${command?.error || '未知原因'}`
  }

  addStepButton.onclick = () => {
    if (!current || current.steps.length >= MAX_POSE_STEPS) return
    const active = activeStep()
    const insert = active?.kind === 'end'
      ? Math.max(1, current.steps.length - 1)
      : Math.max(1, current.active + 1)
    current.steps.splice(insert, 0, cloneStep(active, 'middle'))
    current.active = insert
    render()
  }
  removeStepButton.onclick = () => {
    const step = activeStep()
    if (!current || step?.kind !== 'middle') return
    current.steps.splice(current.active, 1)
    current.active = Math.max(0, current.active - 1)
    render()
  }
  previewButton.onclick = () => {
    if (!current) return
    current.durationMs = clamp(Number(durationInput.value) || 2400, 200, 10000)
    const draft = buildDraft()
    if (!draft) {
      summaryEl.textContent = '至少拖动一个参数，并保留起始和最终两个姿势。'
      return
    }
    bridge.previewDraft(draft)
    summaryEl.textContent = `正在预览 ${draft.tracks.length} 个参数、${current.steps.length} 个姿势`
  }
  saveButton.onclick = () => {
    if (!current) return
    current.durationMs = clamp(Number(durationInput.value) || 2400, 200, 10000)
    const draft = buildDraft()
    if (!draft) {
      summaryEl.textContent = '至少拖动一个参数，并保留起始和最终两个姿势。'
      return
    }
    if (!/^[a-z][a-z0-9_-]{1,23}$/.test(String(draft.id || ''))) {
      summaryEl.textContent = '动作 ID 需要以小写字母开头，长度 2~24，只使用 a-z、0-9、_、-'
      return
    }
    bridge.saveDraft(draft)
    summaryEl.textContent = '正在保存…'
  }
  closeButton.onclick = close
  sidebarToggle.onclick = () => {
    const collapsed = sidebar.classList.toggle('collapsed')
    sidebarToggle.textContent = collapsed ? '展开参数面板' : '收起参数面板'
    bridge.layoutEditor?.()
    renderHandles()
  }

  durationInput.addEventListener('input', () => {
    if (!current) return
    current.durationMs = clamp(Number(durationInput.value) || 2400, 200, 10000)
    const draft = buildDraft()
    if (draft) summaryEl.textContent = `${current.steps.length} 步 · ${draft.tracks.length} 个参数 · ${(draft.durationMs / 1000).toFixed(1)}s`
  })
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && current) close()
  })
  window.addEventListener('resize', () => {
    if (!current) return
    setTimeout(() => {
      if (!current) return
      bridge.layoutEditor?.()
      renderUsedParams()
      renderHandles()
    }, 80)
  })
  window.addEventListener('live2d-pose-layout', () => {
    if (current) renderHandles()
  })

  function debug(command = {}) {
    if (!current) return snapshot()
    if (command.action === 'add-middle') addStepButton.click()
    else if (command.action === 'remove-middle') removeStepButton.click()
    else if (command.action === 'close') close()
    else if (command.action === 'select') {
      const index = clamp(Number(command.index) || 0, 0, current.steps.length - 1)
      current.active = index
      render()
      previewCurrentPose()
    } else if (command.action === 'add-param' && command.param) {
      addOrUpdateParam(String(command.param), command.value)
    } else if (command.action === 'set-params' && command.params && typeof command.params === 'object') {
      const step = activeStep()
      for (const [name, value] of Object.entries(command.params)) {
        const actual = bridge.resolveParam(name) || name
        step.params[actual] = normalizeValue(actual, value)
      }
      previewCurrentPose()
      render()
    } else if (command.action === 'preview') {
      if (Number(command.durationMs)) durationInput.value = String(Number(command.durationMs))
      previewButton.click()
    }
    return snapshot()
  }

  window.Live2DPoseEditor = { open, close, onSaveResult, debug, snapshot }
})()

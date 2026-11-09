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
        bubbleSkin: ['classic', 'cloud', 'signboard', 'note'].includes(config.bubbleSkin) ? config.bubbleSkin : 'classic',
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
        audienceAwareEnabled: config.audienceAwareEnabled !== false,
        memoryEnabled: config.memoryEnabled === true,
        memoryMaxEntries: config.memoryMaxEntries ?? 100,
        dualRelationEnabled: config.dualRelationEnabled !== false,
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
        wakeDriver: ['off', 'timer', 'event'].includes(config.wakeDriver) ? config.wakeDriver : 'off',
        wakeEnabled: config.wakeEnabled === true,
        wakeIntervalSec: (config.wakeIntervalMs ?? 30000) / 1000,
        wakeCaptureEnabled: config.wakeCaptureEnabled === true,
        wakeMaxPerHour: config.wakeMaxPerHour ?? 60,
        lifeEnabled: config.lifeEnabled !== false,
        lifeNonverbalEnabled: config.lifeNonverbalEnabled !== false,
        lifeNonverbalCooldownSec: (config.lifeNonverbalCooldownMs ?? 12000) / 1000,
        eventWakeEnabled: config.eventWakeEnabled === true,
        eventWakeFocusMin: (config.eventWakeFocusMs ?? 2700000) / 60000,
        eventWakeAwayMin: (config.eventWakeAwayMs ?? 600000) / 60000,
        eventWakeTitleIntervalSec: (config.eventWakeTitleIntervalMs ?? 30000) / 1000,
        eventWakeCooldownSec: (config.eventWakeCooldownMs ?? 180000) / 1000,
        eventWakeMaxPerHour: config.eventWakeMaxPerHour ?? 8,
        lifeShareBudgetPerDay: config.lifeShareBudgetPerDay ?? 5,
        lifeImportantBudgetPerDay: config.lifeImportantBudgetPerDay ?? 3,
        eventQuietEnabled: config.eventQuietEnabled === true,
        eventQuietStart: config.eventQuietStart ?? '23:00',
        eventQuietEnd: config.eventQuietEnd ?? '08:00',
        lifeFarewellEnabled: config.lifeFarewellEnabled !== false,
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
        bubbleSkin: draft.bubbleSkin,
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
        audienceAwareEnabled: Boolean(draft.audienceAwareEnabled),
        memoryEnabled: Boolean(draft.memoryEnabled),
        memoryMaxEntries: Math.min(500, Math.max(20, Math.round(Number(draft.memoryMaxEntries) || 100))),
        dualRelationEnabled: Boolean(draft.dualRelationEnabled),
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
        wakeDriver: ['off', 'timer', 'event'].includes(draft.wakeDriver) ? draft.wakeDriver : 'off',
        wakeEnabled: draft.wakeDriver === 'timer',
        wakeIntervalMs: Math.round(Math.min(600, Math.max(15, Number(draft.wakeIntervalSec) || 30)) * 1000),
        wakeCaptureEnabled: Boolean(draft.wakeCaptureEnabled),
        wakeMaxPerHour: Math.min(360, Math.max(1, Math.round(Number(draft.wakeMaxPerHour) || 60))),
        lifeEnabled: Boolean(draft.lifeEnabled),
        lifeNonverbalEnabled: Boolean(draft.lifeNonverbalEnabled),
        lifeNonverbalCooldownMs: Math.round(Math.min(300, Math.max(3, Number(draft.lifeNonverbalCooldownSec) || 12)) * 1000),
        eventWakeEnabled: draft.wakeDriver === 'event',
        eventWakeFocusMs: Math.round(Math.min(120, Math.max(1, Number(draft.eventWakeFocusMin) || 45)) * 60_000),
        eventWakeAwayMs: Math.round(Math.min(120, Math.max(1, Number(draft.eventWakeAwayMin) || 10)) * 60_000),
        eventWakeTitleIntervalMs: Math.round(Math.min(300, Math.max(10, Number(draft.eventWakeTitleIntervalSec) || 30)) * 1000),
        eventWakeCooldownMs: Math.round(Math.min(3600, Math.max(30, Number(draft.eventWakeCooldownSec) || 180)) * 1000),
        eventWakeMaxPerHour: Math.min(120, Math.max(1, Math.round(Number(draft.eventWakeMaxPerHour) || 8))),
        lifeShareBudgetPerDay: Math.min(50, Math.max(0, Number.isFinite(Number(draft.lifeShareBudgetPerDay)) ? Math.round(Number(draft.lifeShareBudgetPerDay)) : 5)),
        lifeImportantBudgetPerDay: Math.min(30, Math.max(0, Number.isFinite(Number(draft.lifeImportantBudgetPerDay)) ? Math.round(Number(draft.lifeImportantBudgetPerDay)) : 3)),
        eventQuietEnabled: Boolean(draft.eventQuietEnabled),
        eventQuietStart: draft.eventQuietStart,
        eventQuietEnd: draft.eventQuietEnd,
        lifeFarewellEnabled: Boolean(draft.lifeFarewellEnabled),
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

    // 动作调整模板：固定选项只负责组织可读需求，真正适配模型参数由 AI + live2d_preset 完成。
    const ACTION_ADJUST_OPTIONS = {
      amplitude: ['很小', '稍小', '适中', '较大', '很大'],
      frequency: ['更慢', '稍慢', '适中', '较快', '很快'],
      duration: ['很短', '稍短', '适中', '稍长', '很长'],
    }

    function buildActionAdjustPrompt({ profile, target, action, kind, amplitude, frequency, duration, note }) {
      const fixed = [
        amplitude ? `- 动作幅度：${amplitude}` : '',
        frequency ? `- 动作频率：${frequency}` : '',
        duration ? `- 动作时间：${duration}` : '',
      ].filter(Boolean)
      const actionKind = kind === 'default' ? '默认动作' : '自定义动作'
      return [
        '[Live2D 动作调整请求]',
        `模型档案：${profile?.label || profile?.id || '未命名'}（${profile?.pathKey || '未知路径'}）`,
        `实例：${target?.id || '未知'}${target?.title ? ` / ${target.title}` : ''}`,
        `要调整的动作：${action?.label || action?.id || '未知'}（${actionKind}）`,
        `动作 ID：${action?.id || '未知'}`,
        `当前时长：${Number(action?.durationMs) || '未知'}ms`,
        '当前动作定义：',
        '```json',
        JSON.stringify({ id: action?.id, label: action?.label, durationMs: action?.durationMs, tracks: action?.tracks ?? [] }, null, 2),
        '```',
        '',
        '用户要求：',
        ...(fixed.length ? fixed : ['- 未选择固定模板']),
        note ? `- 其他调整：${note}` : '',
        '',
        '执行要求：',
        '1. 先调用 live2d_preset list 核对当前档案，再调用 live2d_params 查这只模型真实存在的参数。',
        '2. 保留原动作的意图，只调整用户指定的幅度、频率、时长或其它要求；不要写模型不存在的参数。',
        `3. 用 live2d_preset define 保存调整后的动作，id 必须继续使用 "${action?.id || ''}"。如果这是默认动作，就创建一个同 ID 的自定义覆盖层，让菜单用调整后的版本替换默认版本。`,
        '4. 保存后简要说明改了哪些参数，不要只回复计划。',
      ].filter((line) => line !== '').join('\n')
    }

    const sessionLabel = (item) => `${item.title || '(无标题会话)'} · ${String(item.id).slice(0, 10)}`

    function findVisibleControl(pattern) {
      const nodes = document.querySelectorAll('button, [role="button"], a')
      for (const node of nodes) {
        if (node.disabled || node.getClientRects().length === 0) continue
        const text = [
          node.getAttribute('aria-label'),
          node.getAttribute('title'),
          node.textContent,
        ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
        if (pattern.test(text)) return node
      }
      return null
    }

    /**
     * 从模型窗口的“循环设置”跳回 DSH 主界面的 Live2D 动作页。
     * DSH 没有提供跨窗口的 settings.open 客户端 API，因此用可见控件导航：
     * 先打开“设置”，再点 Live2D，并派发事件把页面切回“动作”标签。
     */
    function openLive2DSettings() {
      window.focus?.()
      let attempts = 0
      const choose = () => {
        const live2d = findVisibleControl(/^Live2D(?:\s|$)/i)
        if (live2d) {
          live2d.click()
          window.dispatchEvent(new CustomEvent('live2d:open-actions-settings'))
          setTimeout(() => window.dispatchEvent(new CustomEvent('live2d:open-actions-settings')), 180)
          return
        }
        if (attempts === 0) {
          const settings = findVisibleControl(/^(设置|Settings)(?:\s|$)/i)
          settings?.click()
        }
        attempts += 1
        if (attempts < 24) setTimeout(choose, 100)
      }
      choose()
    }

    /**
     * 输入框权限按钮旁的模型快捷开关。
     * 复用 /instances + /window；只显示 config.enabled !== false 的模型。
     */
    function Live2DQuickButtons() {
      const [instances, setInstances] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const load = React.useCallback(async () => {
        const result = await call('/instances')
        setInstances(Array.isArray(result?.instances) ? result.instances : [])
      }, [])
      React.useEffect(() => {
        load()
        const timer = setInterval(() => {
          if (document.visibilityState !== 'hidden') load()
        }, 5000)
        const onVisible = () => { if (document.visibilityState === 'visible') load() }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [load])
      React.useEffect(() => {
        let alive = true
        let timer = null
        const poll = async () => {
          const result = await call('/ui-command')
          if (alive && result?.ok && result.command?.type === 'open-settings') openLive2DSettings()
          if (alive) timer = setTimeout(poll, 1200)
        }
        timer = setTimeout(poll, 700)
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [])
      const enabled = instances
        .map((item, index) => ({ item, slot: index + 1 }))
        .filter(({ item }) => item?.config?.enabled !== false)
      if (!enabled.length) return null
      const toggle = async (item, slot) => {
        const open = item.window?.ready === true || ['starting', 'rendering', 'running'].includes(item.window?.state)
        setBusy(item.id)
        const result = await call('/window', {
          method: 'POST',
          body: JSON.stringify({ action: open ? 'close' : 'open', instanceId: item.id }),
        })
        if (result?.ok !== true) {
          setBusy('')
          return
        }
        setTimeout(() => {
          setBusy('')
          load()
        }, open ? 1500 : 500)
      }
      return h(
        'div',
        {
          style: { display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 4 },
          'data-live2d-quick-toggle': '1',
        },
        ...enabled.map(({ item, slot }) => {
          const open = item.window?.ready === true || ['starting', 'rendering', 'running'].includes(item.window?.state)
          return h(
            'button',
            {
              key: item.id,
              type: 'button',
              title: `${open ? '关闭' : '打开'}模型 ${slot}`,
              'aria-label': `${open ? '关闭' : '打开'}模型 ${slot}`,
              disabled: busy === item.id,
              onClick: () => toggle(item, slot),
              style: {
                height: 24,
                padding: '0 8px',
                borderRadius: 7,
                border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14))',
                background: open ? 'rgba(86,132,230,.16)' : 'var(--dsw-alias-bg-layer-1)',
                color: 'inherit',
                cursor: busy === item.id ? 'default' : 'pointer',
                font: 'inherit',
                fontSize: 11,
                opacity: busy === item.id ? 0.55 : 1,
                whiteSpace: 'nowrap',
              },
            },
            `模型${slot} ${open ? '■' : '▷'}`,
          )
        }),
      )
    }

    function MemoryPanel({ instanceId, sessionId, enabled }) {
      const [entries, setEntries] = React.useState([])
      const [text, setText] = React.useState('')
      const [kind, setKind] = React.useState('preference')
      const [tags, setTags] = React.useState('')
      const [editingId, setEditingId] = React.useState('')
      const [editingText, setEditingText] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const load = React.useCallback(async () => {
        if (!sessionId) {
          setEntries([])
          return
        }
        const result = await call(`/memory?instanceId=${encodeURIComponent(instanceId)}`)
        setEntries(Array.isArray(result?.entries) ? result.entries : [])
        if (!result?.ok) setNotice(result?.error || '读取记忆失败')
      }, [instanceId, sessionId])
      React.useEffect(() => { load() }, [load])
      const act = async (op, extra = {}) => {
        setBusy(op)
        setNotice('')
        const result = await call('/memory', {
          method: 'POST',
          body: JSON.stringify({ instanceId, op, ...extra }),
        })
        setNotice(result?.ok ? '已更新' : (result?.error || '操作失败'))
        await load()
        setBusy('')
      }
      const add = async () => {
        if (!text.trim()) return
        await act('remember', { text, kind, tags, importance: 3 })
        setText('')
        setTags('')
      }
      return h(
        'div',
        { style: { ...S.card, marginTop: 10 }, 'data-live2d-memory': '1' },
        h('p', { style: S.sub }, '陪伴记忆 · 按对话隔离'),
        h('p', { style: S.hint }, sessionId
          ? `当前绑定：${String(sessionId).slice(0, 18)}…。切换对话会切换整套记忆；“遗忘”只休眠，不提删数据。`
          : '当前实例还没有绑定对话。绑定后才能为这个对话建立记忆。'),
        !enabled
          ? h('p', { style: S.warn }, '记忆已关闭：不会注入提示词，也不会接受 AI 写入。你当前机器的存量配置默认关闭。')
          : null,
        enabled && sessionId
          ? h(
            'div',
            { style: { ...S.row, marginTop: 8, flexWrap: 'wrap' } },
            h('select', { style: S.select, value: kind, onChange: (event) => setKind(event.target.value) },
              h('option', { value: 'preference' }, '偏好'),
              h('option', { value: 'fact' }, '事实'),
              h('option', { value: 'event' }, '共同经历'),
              h('option', { value: 'promise' }, '约定'),
              h('option', { value: 'relationship' }, '关系')),
            h('input', {
              style: { ...S.input, flex: '1 1 260px' },
              value: text,
              maxLength: 500,
              placeholder: '例如：不喜欢被叫全名；答应周末提醒她休息',
              onChange: (event) => setText(event.target.value),
            }),
            h('input', {
              style: { ...S.num, width: 118 },
              value: tags,
              placeholder: '标签,逗号分隔',
              onChange: (event) => setTags(event.target.value),
            }),
            h('button', { type: 'button', style: S.primary, disabled: busy === 'remember' || !text.trim(), onClick: add }, '记住'),
          )
          : null,
        entries.length
          ? h(
            'div',
            { style: { marginTop: 8, display: 'grid', gap: 7 } },
            ...entries.map((entry) => h(
              'div',
              {
                key: entry.id,
                style: {
                  padding: '7px 9px',
                  borderRadius: 8,
                  border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))',
                  opacity: entry.dormant ? 0.56 : 1,
                },
              },
              h('div', { style: { ...S.row, justifyContent: 'space-between', gap: 8 } },
                h('span', { style: S.hint }, `${entry.kind}${entry.dormant ? ' · 已遗忘，重新提起可想起' : ' · 活跃'}`),
                h('span', { style: S.hint }, new Date(entry.updatedAt).toLocaleString())),
              editingId === entry.id
                ? h('div', { style: { ...S.row, marginTop: 5 } },
                  h('input', {
                    style: { ...S.input, flex: '1 1 260px' },
                    value: editingText,
                    maxLength: 500,
                    onChange: (event) => setEditingText(event.target.value),
                  }),
                  h('button', {
                    type: 'button', style: S.btn, disabled: busy === 'update',
                    onClick: async () => {
                      await act('update', { id: entry.id, text: editingText })
                      setEditingId('')
                    },
                  }, '保存'),
                  h('button', { type: 'button', style: S.miniBtn, onClick: () => setEditingId('') }, '取消'))
                : h('p', { style: { margin: '5px 0 0', whiteSpace: 'pre-wrap', userSelect: 'text' } }, entry.text),
              entry.tags?.length ? h('p', { style: S.hint }, entry.tags.join(' · ')) : null,
              h('div', { style: { ...S.row, marginTop: 4 } },
                h('button', {
                  type: 'button', style: S.miniBtn,
                  onClick: () => {
                    setEditingId(entry.id)
                    setEditingText(entry.text)
                  },
                }, '编辑'),
                entry.dormant
                  ? h('button', { type: 'button', style: S.miniBtn, disabled: busy === 'recall', onClick: () => act('recall', { id: entry.id }) }, '重新想起')
                  : h('button', { type: 'button', style: S.miniBtn, disabled: busy === 'forget', onClick: () => act('forget', { id: entry.id }) }, '遗忘'),
              ),
            )),
          )
          : h('p', { style: { ...S.hint, marginTop: 8 } }, sessionId ? '这个对话还没有记忆。' : ''),
        enabled && sessionId && entries.some((entry) => !entry.dormant)
          ? h('button', {
            type: 'button', style: { ...S.miniBtn, marginTop: 8 }, disabled: busy === 'forget-old',
            onClick: () => act('forget-old', { olderThanDays: 90 }),
          }, '把 90 天未更新的记忆转为“已遗忘”')
          : null,
        notice ? h('p', { style: S.hint }, notice) : null,
      )
    }

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
      // 0.3.2：动作/循环按「模型档案」共享（同一模型共用一份，不同模型各用各的）
      const [profiles, setProfiles] = React.useState([])
      const [activeProfileId, setActiveProfileId] = React.useState('')
      const [profileDetail, setProfileDetail] = React.useState(null)
      const [profileTick, setProfileTick] = React.useState(0)
      const [historyOpen, setHistoryOpen] = React.useState(false)
      const [newAction, setNewAction] = React.useState({ label: '', description: '', draft: null })
      const [actionAdjust, setActionAdjust] = React.useState({
        actionKey: '', amplitude: '', frequency: '', duration: '', note: '',
      })
      const [newLoop, setNewLoop] = React.useState({ editingId: '', label: '', steps: [], intervalSec: 8, targets: [] })

      React.useEffect(() => {
        const openActions = () => setActiveTabKey('actions')
        window.addEventListener('live2d:open-actions-settings', openActions)
        return () => window.removeEventListener('live2d:open-actions-settings', openActions)
      }, [])

      const load = React.useCallback(async () => {
        setBusy('load')
        const [instRes, healthData, sessionData, modelData, configData, profileRes] = await Promise.all([
          call('/instances'), call('/health'), call('/sessions'), call('/models'), call('/config'), call('/profiles'),
        ])
        const list = Array.isArray(instRes?.instances) ? instRes.instances : []
        setInstances(list)
        const profileList = Array.isArray(profileRes?.profiles) ? profileRes.profiles : []
        setProfiles(profileList)
        setActiveProfileId((current) => (current && profileList.some((item) => item.id === current)
          ? current
          : (profileList.find((item) => item.inUse)?.id ?? profileList[0]?.id ?? '')))
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

      // 0.3.2：动作/循环住在「模型档案」里（按模型共享，不同模型各用各的）
      React.useEffect(() => {
        let alive = true
        if (!activeProfileId) {
          setProfileDetail(null)
          return () => { alive = false }
        }
        call(`/profiles/${encodeURIComponent(activeProfileId)}`)
          .then((data) => { if (alive) setProfileDetail(data?.ok ? data : null) })
          .catch(() => { if (alive) setProfileDetail(null) })
        return () => { alive = false }
      }, [activeProfileId, profileTick])

      const profile = profileDetail?.profile ?? null
      // 绑定该档案的实例（没有就用第一个实例兜底，保证预览/播放有窗口可发）
      const profileInstanceIds = Array.isArray(profileDetail?.boundInstanceIds) && profileDetail.boundInstanceIds.length
        ? profileDetail.boundInstanceIds
        : instances.slice(0, 1).map((item) => item.id)

      const patchActiveProfile = async (patch) => {
        if (!activeProfileId) {
          setNotice({ kind: 'warn', text: '先在上面选一个模型档案（没有的话先添加模型）' })
          return null
        }
        setBusy(`profile:${activeProfileId}`)
        const result = await call(`/profiles/${encodeURIComponent(activeProfileId)}`, { method: 'PATCH', body: JSON.stringify(patch) })
        setNotice(result?.ok
          ? { kind: 'ok', text: `已保存到模型档案「${profile?.label || activeProfileId}」` }
          : { kind: 'warn', text: result?.error || result?.code || '保存失败' })
        setProfileTick((value) => value + 1)
        await load()
        setBusy('')
        return result
      }

      const savePresetsToProfile = (customActions, presetSequences) => patchActiveProfile(
        customActions === undefined ? { presetSequences } : { customActions, presetSequences },
      )

      // 0.4.0：让宿主按这只模型真实有的参数重挑 10 个默认动作
      const regenerateAutoActions = async () => {
        if (!activeProfileId) {
          setNotice({ kind: 'warn', text: '先在上面选一个模型档案' })
          return
        }
        setBusy('auto-actions')
        const result = await call(`/profiles/${encodeURIComponent(activeProfileId)}/auto-actions`, {
          method: 'POST',
          body: JSON.stringify({ force: true }),
        })
        setNotice(result?.ok
          ? { kind: 'ok', text: `已按模型能力生成 ${result.count ?? 0} 个默认动作` }
          : { kind: 'warn', text: result?.error || result?.code || '生成失败' })
        setProfileTick((value) => value + 1)
        setBusy('')
      }

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
          'replyFontSize', 'replyOpacity', 'replyHeightRatio', 'replyStyle', 'bubbleSkin',
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
            { label: '回答版式 / 气泡外观', hint: '版式决定气泡或卡片；气泡外观只在「气泡」版式下生效。保存后立即应用。' },
            h(
              'select',
              { style: S.select, value: draft.replyStyle, onChange: (event) => patchDraft(inst.id, 'replyStyle', event.target.value) },
              h('option', { value: 'bubble' }, '气泡 / 对话'),
              h('option', { value: 'card' }, '方块卡片'),
            ),
            h(
              'select',
              {
                style: { ...S.select, opacity: draft.replyStyle === 'bubble' ? 1 : 0.45 },
                value: draft.bubbleSkin,
                disabled: draft.replyStyle !== 'bubble',
                onChange: (event) => patchDraft(inst.id, 'bubbleSkin', event.target.value),
              },
              h('option', { value: 'classic' }, '经典气泡'),
              h('option', { value: 'cloud' }, '云朵气泡'),
              h('option', { value: 'signboard' }, '告示牌'),
              h('option', { value: 'note' }, '便签纸'),
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
              style: { ...S.num, width: 300 }, type: 'text', placeholder: 'D:\\…\\liuying.wav',
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

          h(SectionTitle, { title: '测试与维护', hint: '保存、测试气泡与语音；动作统一在「动作」页管理' }),
          h(
            'div',
            { style: { ...S.row, marginTop: 6 } },
            h('button', { type: 'button', style: S.primary, disabled: busy === `save:${inst.id}`, onClick: () => saveInstance(inst.id) }, busy === `save:${inst.id}` ? '保存中…' : `保存 ${inst.id}`),
            h('button', { type: 'button', style: S.btn, disabled: busy === `bubble:${inst.id}`, onClick: () => bubble(inst.id, { latest: true }) }, '把最新回复打进气泡'),
            h('button', { type: 'button', style: S.btn, disabled: busy === `bubble:${inst.id}`, onClick: () => bubble(inst.id, { text: 'Live2D 气泡测试：这一句来自设置页。' }) }, '发测试气泡'),
          ),

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
        const target = instances.find((item) => profileInstanceIds.includes(item.id)) || instances[0]
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
        if (!newAction.draft) return
        // 只在该档案绑定的窗口里预览（没有绑定实例时退回第一个实例）
        const ids = profileInstanceIds.length ? profileInstanceIds : instances.slice(0, 1).map((item) => item.id)
        if (!ids.length) {
          setNotice({ kind: 'warn', text: '没有可用的模型窗口' })
          return
        }
        setBusy('preview')
        let okCount = 0
        for (const id of ids) {
          const result = await call('/preset', {
            method: 'POST',
            body: JSON.stringify({ op: 'preview', instanceId: id, draft: newAction.draft }),
          })
          if (result?.ok) okCount += 1
        }
        setNotice(okCount
          ? { kind: 'ok', text: `正在 ${okCount} 个窗口里播放这次草稿` }
          : { kind: 'warn', text: '预览失败（窗口没开？）' })
        setBusy('')
      }

      const saveDraft = async () => {
        if (!newAction.draft) return
        if (!profile) {
          setNotice({ kind: 'warn', text: '先选一个模型档案' })
          return
        }
        const existing = Array.isArray(profile.customActions) ? profile.customActions : []
        const next = [...existing.filter((item) => item.id !== newAction.draft.id), newAction.draft]
        const saved = await savePresetsToProfile(next, Array.isArray(profile.presetSequences) ? profile.presetSequences : [])
        if (saved?.ok) setNewAction({ label: '', description: '', draft: null })
      }

      const sendActionAdjustment = async (action, kind) => {
        if (!action) {
          setNotice({ kind: 'warn', text: '先在动作调整框里选择要调整的动作' })
          return
        }
        if (!actionAdjust.amplitude && !actionAdjust.frequency && !actionAdjust.duration && !actionAdjust.note.trim()) {
          setNotice({ kind: 'warn', text: '至少选择一个固定调整，或填写其它调整要求' })
          return
        }
        const boundIds = Array.isArray(profileDetail?.boundInstanceIds) ? profileDetail.boundInstanceIds : []
        const target = instances.find((item) => boundIds.includes(item.id)) || null
        const sessionId = target?.config?.sessionId || target?.sessionId || ''
        if (!target || !sessionId) {
          setNotice({ kind: 'warn', text: '这张动作档案的模型还没有绑定会话，无法把调整交给 AI' })
          return
        }
        if (!window.confirm('这次调整会调用 AI，会消耗 Token。确定发送吗？')) return

        setBusy('action-adjust')
        const text = buildActionAdjustPrompt({
          profile,
          target,
          action,
          kind,
          amplitude: actionAdjust.amplitude,
          frequency: actionAdjust.frequency,
          duration: actionAdjust.duration,
          note: actionAdjust.note.trim(),
        })
        const result = await call('/inject', {
          method: 'POST',
          body: JSON.stringify({ sessionId, text, dryRun: false, mode: 'followup' }),
        })
        const dispatched = result?.ok === true && result?.dispatched === true && result?.settled?.ok !== false
        setNotice(dispatched
          ? { kind: 'ok', text: '调整要求已发给 AI；保存动作后刷新本页即可看到同 ID 的覆盖版本。' }
          : { kind: 'warn', text: result?.error || result?.settled?.error || '发送失败：会话可能还没激活，先打开对应对话再试' })
        setBusy('')
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
        await call('/preset', { method: 'POST', body: JSON.stringify({ op: 'stop', instanceId: profileInstanceIds[0] || instances[0]?.id }) }).catch(() => null)
        if (!profile) return
        const next = (Array.isArray(profile.presetSequences) ? profile.presetSequences : []).filter((item) => item.id !== seq.id)
        await savePresetsToProfile(Array.isArray(profile.customActions) ? profile.customActions : [], next)
        if (newLoop.editingId === seq.id) setNewLoop({ editingId: '', label: '', steps: [], intervalSec: 8, targets: [] })
      }

      // 预览：让绑定该档案的实例把整条循环走一遍（宿主 op:'preview' + sequenceId，once）
      const previewLoop = (seq) => {
        const targets = profileInstanceIds.length
          ? instances.filter((item) => profileInstanceIds.includes(item.id))
          : instances.slice(0, 1)
        if (!targets.length) {
          setNotice({ kind: 'warn', text: '没有可用的模型窗口' })
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
        if (!profile) {
          setNotice({ kind: 'warn', text: '先选一个模型档案' })
          return
        }
        if (!newLoop.steps.length) {
          setNotice({ kind: 'warn', text: '至少勾一个动作' })
          return
        }
        const existing = Array.isArray(profile.presetSequences) ? profile.presetSequences : []
        const id = newLoop.editingId || `loop-${Date.now().toString(36).slice(-5)}`
        const seq = {
          id,
          label: (newLoop.label || `循环 ${existing.length + 1}`).slice(0, 24),
          steps: newLoop.steps,
          intervalMs: Math.min(60000, Math.max(300, Math.round(Number(newLoop.intervalSec || 8) * 1000))),
          loop: true,
        }
        const next = [...existing.filter((item) => item.id !== id), seq]
        const saved = await savePresetsToProfile(Array.isArray(profile.customActions) ? profile.customActions : [], next)
        if (saved?.ok) setNewLoop({ editingId: '', label: '', steps: [], intervalSec: 8, targets: [] })
      }

      const renderActionTab = () => {
        const target = instances.find((item) => profileInstanceIds.includes(item.id)) || instances[0] || null
        if (!target) return h('p', { style: S.warn }, '还没有模型实例（宿主可能是旧版本：重启 DSH）')
        // 动作/循环住在「模型档案」里：同一模型共用一个档案，不同模型各用各的
        const customActions = Array.isArray(profile?.customActions) ? profile.customActions : []
        // 0.4.0：按这只模型真实能力挑出来的默认动作（宿主在窗口上报参数后自动生成）
        const autoActions = Array.isArray(profile?.autoActions) ? profile.autoActions : []
        // 0.5.0：扫模型目录得到的表情 / 换装 / 手势（hold 类，点一次开、再点一次关）
        const capabilityActions = Array.isArray(profile?.capabilityActions) ? profile.capabilityActions : []
        const capabilities = profile?.capabilities ?? null
        const capGroups = capabilityActions.reduce((acc, item) => {
          const key = item.group === 'clothes' ? 'clothes' : item.group === 'gesture' ? 'gesture' : item.group === 'face' ? 'face' : 'other'
          ;(acc[key] ??= []).push(item)
          return acc
        }, {})
        const sequences = Array.isArray(profile?.presetSequences) ? profile.presetSequences : []
        const activeProfiles = profiles.filter((item) => item.inUse)
        const historyProfiles = profiles.filter((item) => !item.inUse)
        const customIds = new Set(customActions.map((item) => item.id))
        // 循环候选同样不再包含写死的内置动作；同 ID 自定义动作覆盖默认动作。
        const loopActions = new Map()
        for (const item of autoActions) {
          if (!customIds.has(item.id)) loopActions.set(item.id, { id: item.id, label: `[默认] ${item.label || item.id}` })
        }
        for (const item of capabilityActions) {
          if (!customIds.has(item.id)) loopActions.set(item.id, { id: item.id, label: `[模型] ${item.label || item.id}` })
        }
        for (const item of customActions) loopActions.set(item.id, { id: item.id, label: `[自定义] ${item.label || item.id}` })
        const allActions = [...loopActions.values()]
        const adjustableActions = [
          ...autoActions
            .filter((item) => !customIds.has(item.id))
            .map((item) => ({ key: `default:${item.id}`, kind: 'default', action: item, label: `默认 · ${item.label || item.id}` })),
          ...customActions.map((item) => ({ key: `custom:${item.id}`, kind: 'custom', action: item, label: `自定义 · ${item.label || item.id}` })),
        ]
        const selectedAdjust = adjustableActions.find((item) => item.key === actionAdjust.actionKey) || null
        return h(
          'div',
          null,
          // 档案选择器（历史档案可以在这里重新选/改名/删除）
          h(
            'div',
            { style: { ...S.card, marginBottom: 12 } },
            h('p', { style: S.sub }, '当前动作档案'),
            h(
              'div',
              { style: S.row },
              h('select', {
                style: { ...S.input, flex: '1 1 220px' },
                value: activeProfileId,
                onChange: (event) => setActiveProfileId(event.target.value),
              },
              ...(activeProfiles.length ? activeProfiles : profiles).map((item) => h(
                'option', { key: item.id, value: item.id },
                `${item.label || item.id}${item.inUse ? '' : '（历史）'}${item.boundInstanceIds?.length ? ` · ${item.boundInstanceIds.map((id) => instanceTitleOf(id)).join(' + ')}` : ''}`,
              ))),
              h('button', {
                type: 'button', style: S.miniBtn, onClick: () => setHistoryOpen((value) => !value),
              }, historyOpen ? '收起历史' : `历史档案（${historyProfiles.length}）`),
            ),
            h('p', { style: S.hint }, activeProfiles.length
              ? '同一只模型共用一份动作/循环；换了模型路径会新建一份档案。'
              : '还没有绑定模型的活动档案；下面看到的是历史档案里的内容。'),
            activeProfileId
              ? h('div', { style: { ...S.row, marginTop: 6 } },
                h('input', {
                  style: { ...S.input, flex: '1 1 160px' },
                  value: profile?.label || '', placeholder: '档案名',
                  onChange: (event) => setProfileDetail((current) => (current?.profile
                    ? { ...current, profile: { ...current.profile, label: event.target.value } }
                    : current)),
                }),
                h('button', {
                  type: 'button', style: S.miniBtn,
                  onClick: () => patchActiveProfile({ label: profile?.label || '' }),
                }, '改名'),
                h('button', {
                  type: 'button', style: S.miniBtn,
                  onClick: async () => {
                    if (!window.confirm('删除这个模型档案？里面的自定义动作和循环会一起删掉。')) return
                    const result = await call(`/profiles/${encodeURIComponent(activeProfileId)}?force=1`, { method: 'DELETE' })
                    setNotice(result?.ok ? { kind: 'ok', text: '档案已删除' } : { kind: 'warn', text: result?.error || '删除失败' })
                    setProfileTick((value) => value + 1)
                    await load()
                  },
                }, '删除档案'),
              )
              : null,
            historyOpen && historyProfiles.length
              ? h('div', { style: { marginTop: 8 } },
                ...historyProfiles.map((item) => h('div', { key: item.id, style: { ...S.row, marginTop: 4 } },
                  h('span', { style: { ...S.hint, flex: '1 1 auto' } }, `${item.label || item.id} · ${item.pathKey}`),
                  h('button', { type: 'button', style: S.miniBtn, onClick: () => { setActiveProfileId(item.id); setHistoryOpen(false) } }, '查看'),
                )))
              : null,
          ),
          h('p', { style: S.hint }, '动作与循环只对「当前档案」那只模型生效。'),

          h('p', { style: S.sub }, '默认动作'),
          h('p', { style: S.hint }, autoActions.length
            ? `按这只模型真实参数生成（${autoActions.length} 个），点一下就能做出来。`
            : '还没生成：模型窗口加载完成后会自动生成，也可以点「重新生成」。'),
          h(
            'div',
            { style: { ...S.row, flexWrap: 'wrap' } },
            h('button', {
              type: 'button', style: S.miniBtn,
              disabled: busy === 'auto-actions' || !activeProfileId,
              onClick: regenerateAutoActions,
            }, busy === 'auto-actions' ? '生成中…' : '重新生成'),
            ...autoActions.map((item) => h('button', {
              key: item.id, type: 'button', style: S.btn,
              disabled: busy.startsWith('anim:'),
              title: Array.isArray(item.tracks) && item.tracks.length
                ? `参数：${item.tracks.map((track) => track.param).join(' / ')}`
                : '',
              onClick: () => anim(target.id, item.id),
            }, item.label || item.id)),
          ),
          h('p', { style: { ...S.sub, marginTop: 12 } }, '表情 / 换装（模型自带）'),
          capabilities
            ? h('p', { style: S.hint }, `从模型包扫到 ${capabilities.expressions.length} 个表情/换装，${capabilityActions.length} 个能直接用（点一次开，再点一次关）。` +
              (capabilities.motions.length ? ` 另有 ${capabilities.motions.length} 个动画文件（model3.json 没登记，暂不播）：${capabilities.motions.slice(0, 4).map((item) => item.label).join('、')}${capabilities.motions.length > 4 ? '…' : ''}` : ''))
            : h('p', { style: S.hint }, '还没扫描模型包：点一次上面「重新生成」，会同时扫 Exp3/Animation 目录。'),
          ...['clothes', 'face', 'gesture', 'other'].map((key) => {
            const list = capGroups[key] ?? []
            if (!list.length) return null
            const label = key === 'clothes' ? '换装' : key === 'face' ? '表情' : key === 'gesture' ? '手势' : '其它'
            return h('div', { key, style: { ...S.row, flexWrap: 'wrap', marginTop: 4 } },
              h('span', { style: S.dim }, `${label}：`),
              ...list.map((item) => h('button', {
                key: item.id, type: 'button', style: S.btn,
                disabled: busy.startsWith('anim:'),
                title: item.desc || (Array.isArray(item.tracks) ? `参数：${item.tracks.map((track) => track.param).join(' / ')}` : ''),
                onClick: () => anim(target.id, item.id),
              }, item.label || item.id)))
          }),
          h('p', { style: { ...S.sub, marginTop: 12 } }, '自定义动作'),
          h('p', { style: S.hint }, '这里放你和 AI 为当前模型设计的动作。默认动作也可以调整：AI 会保存一个同 ID 的自定义覆盖版本，模型参数重新生成时不会弄丢。'),
          h('p', { style: S.warn }, '注意：让 AI 新增或调整自定义动作会调用模型，消耗 Token。'),
          customActions.length
            ? h('div', { style: { ...S.row, flexWrap: 'wrap', marginTop: 6 } },
              ...customActions.map((item) => h('button', {
                key: item.id, type: 'button', style: S.btn,
                title: `ID：${item.id} · ${item.durationMs || 0}ms`,
                disabled: busy.startsWith('anim:'),
                onClick: () => anim(target.id, item.id),
              }, item.label || item.id)))
            : h('p', { style: S.dim }, '还没有自定义动作。'),

          h(
            'div',
            { style: { ...S.card, marginTop: 12 } },
            h('p', { style: S.sub }, '动作调整框'),
            h('p', { style: S.hint }, '选择默认动作或自定义动作，再用固定选项或自由描述告诉 AI 怎么改。默认动作会生成同 ID 覆盖层，不改动自动生成的原定义。'),
            h('p', { style: S.warn }, '每次发送都会调用 AI，消耗 Token。'),
            h(Field, { label: '选择要调整的动作' },
              h('select', {
                style: S.select,
                value: actionAdjust.actionKey,
                disabled: !adjustableActions.length || busy === 'action-adjust',
                onChange: (event) => setActionAdjust((current) => ({ ...current, actionKey: event.target.value })),
              },
              h('option', { value: '' }, adjustableActions.length ? '（选择动作）' : '（暂无可调整动作）'),
              ...adjustableActions.map((item) => h('option', { key: item.key, value: item.key }, item.label)))),
            h(Field, { label: '动作幅度' },
              h('select', {
                style: S.select,
                value: actionAdjust.amplitude,
                onChange: (event) => setActionAdjust((current) => ({ ...current, amplitude: event.target.value })),
              },
              h('option', { value: '' }, '不调整'),
              ...ACTION_ADJUST_OPTIONS.amplitude.map((value) => h('option', { key: value, value }, value)))),
            h(Field, { label: '动作频率' },
              h('select', {
                style: S.select,
                value: actionAdjust.frequency,
                onChange: (event) => setActionAdjust((current) => ({ ...current, frequency: event.target.value })),
              },
              h('option', { value: '' }, '不调整'),
              ...ACTION_ADJUST_OPTIONS.frequency.map((value) => h('option', { key: value, value }, value)))),
            h(Field, { label: '动作时间' },
              h('select', {
                style: S.select,
                value: actionAdjust.duration,
                onChange: (event) => setActionAdjust((current) => ({ ...current, duration: event.target.value })),
              },
              h('option', { value: '' }, '不调整'),
              ...ACTION_ADJUST_OPTIONS.duration.map((value) => h('option', { key: value, value }, value)))),
            h(Field, { label: '其它调整', hint: '可以描述生活化、幅度曲线、停顿、左右方向或具体效果；AI 会先查当前模型参数再保存。' },
              h('textarea', {
                style: { ...S.input, minHeight: 58 },
                rows: 3,
                value: actionAdjust.note,
                placeholder: '例如：开头停半拍，再慢慢低头；只动头和眼睛，不要让身体位移',
                onChange: (event) => setActionAdjust((current) => ({ ...current, note: event.target.value })),
              })),
            h('div', { style: S.row },
              h('button', {
                type: 'button',
                style: S.primary,
                disabled: !selectedAdjust || busy === 'action-adjust',
                onClick: () => selectedAdjust && sendActionAdjustment(selectedAdjust.action, selectedAdjust.kind),
              }, busy === 'action-adjust' ? '发送中…' : '发给 AI 调整'),
              selectedAdjust
                ? h('span', { style: S.dim }, `将调整「${selectedAdjust.action.label || selectedAdjust.action.id}」；${selectedAdjust.kind === 'default' ? '会保存为同 ID 自定义覆盖层' : '会覆盖同名自定义动作'}`)
                : null),
          ),

          h(
            'div',
            { style: { ...S.card, marginTop: 12 } },
            h('p', { style: S.sub }, '新增动作'),
            h('p', { style: S.warn }, '让 AI 设计自定义动作会消耗 Token；下面的「生成」只使用本地模板草稿，不调用模型。'),
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
                  (Array.isArray(seq.legacyTargets) && seq.legacyTargets.length
                    ? ` · 旧绑定 ${seq.legacyTargets.map((id) => instanceTitleOf(id)).join(' + ')}（已按模型档案共享）`
                    : '')),
                h('button', {
                  type: 'button',
                  style: S.btn,
                  onClick: () => {
                    // 循环属于模型档案：只在该档案绑定的实例上启动；没有活动实例就提示
                    const ids = profileInstanceIds.length ? profileInstanceIds : []
                    if (!ids.length) {
                      setNotice({ kind: 'warn', text: '这只模型现在没有打开窗口，先打开窗口再启用循环' })
                      return
                    }
                    ids.forEach((id) => presetOp(id, 'start', seq.id))
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
              onClick: () => (profileInstanceIds.length ? profileInstanceIds : instances.map((item) => item.id)).forEach((id) => presetOp(id, 'stop')),
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
            h(Field, { label: '作用范围', hint: `当前档案「${profile?.label || activeProfileId || '—'}」绑定的模型：${profileInstanceIds.length ? profileInstanceIds.map((id) => instanceTitleOf(id)).join(' + ') : '（没有活动实例，只保存定义）'}` },
              h('span', { style: S.dim }, '循环属于模型档案，不再单独选模型')),            h(Field, { label: '间隔 秒', hint: '两个动作之间停多久（0.3~60s）' },
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
          const scale = Number(opts.scale) || (opts.ms ? 1000 : 1)
          const shown = Number.isFinite(raw) ? raw / scale : ''
          return h(
            'label',
            { style: { ...S.row, gap: 6, marginLeft: 10 }, key: `${target.id}:${key}:${shown}` },
            h('input', {
              style: { ...S.num, width: 72 }, type: 'number', min: String(min), max: String(max), step: String(step),
              defaultValue: String(shown),
              onBlur: (event) => {
                const value = Number(event.target.value)
                if (!Number.isFinite(value)) return
                const next = Math.round(value * scale)
                if (Number.isFinite(raw) && next === raw) return
                patchInstancePart(target.id, { [key]: next })
              },
            }),
            h('span', { style: S.dim }, unit),
          )
        }
        const clock = (key, label) => h(
          'label',
          { style: { ...S.row, gap: 6, marginLeft: 10 }, key: `${target.id}:${key}:${cfg[key] ?? ''}` },
          h('span', { style: S.dim }, label),
          h('input', {
            style: { ...S.num, width: 78 },
            type: 'time',
            defaultValue: String(cfg[key] ?? (key === 'eventQuietStart' ? '23:00' : '08:00')),
            disabled: busy === `patch:${target.id}`,
            onBlur: (event) => {
              const value = String(event.target.value || '')
              if (/^([01]\d|2[0-3]):[0-5]\d$/.test(value) && value !== cfg[key]) patchInstancePart(target.id, { [key]: value })
            },
          }),
        )
        const group = (title, hint, children) => h(
          'div',
          { style: { ...S.card, marginTop: 10 } },
          h('p', { style: S.sub }, title),
          h('p', { style: { ...S.hint, marginTop: 2 } }, hint),
          ...children,
        )
        const disclosureGroup = (title, hint, open, children) => h(
          'details',
          { style: { ...S.card, marginTop: 10 }, open: open ? true : undefined },
          h('summary', { style: { ...S.sub, cursor: 'pointer' } }, title),
          h('p', { style: { ...S.hint, marginTop: 2 } }, hint),
          ...children,
        )
        const proactiveDriver = ['off', 'timer', 'event'].includes(cfg.wakeDriver)
          ? cfg.wakeDriver
          : (cfg.eventWakeEnabled === true ? 'event' : cfg.wakeEnabled === true ? 'timer' : 'off')
        const enableAll = () => patchInstancePart(target.id, {
          screenReadEnabled: true,
          screenCaptureEnabled: true,
          wakeCaptureEnabled: true,
          wakeDriver: 'timer',
          lifeEnabled: true,
          lifeNonverbalEnabled: true,
          lifeFarewellEnabled: true,
          aiMoveEnabled: true,
        })
        const allOff = cfg.screenReadEnabled !== true || cfg.screenCaptureEnabled !== true || proactiveDriver === 'off' || cfg.lifeEnabled === false
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
            target.life
              ? h('p', { style: { ...S.hint, marginTop: 4 } },
                `陪伴状态：${target.life.attention || '未知'} · 意愿 ${target.life.willingness || 'social'} · 精力 ${Math.round(Number(target.life.energy) * 100)}% · 心情 ${Number(target.life.mood).toFixed(2)} · 今日分享 ${target.life.dailyShare}/${target.life.dailyShareMax}`)
              : null,
            h('div', { style: { ...S.row, marginTop: 8, flexWrap: 'wrap', gap: 8 } },
              h('button', { type: 'button', style: S.primary, disabled: busy === `patch:${target.id}`, onClick: enableAll }, '一键开启模式所需开关'),
              allOff ? h('span', { style: S.warn }, '当前有开关是关的，模式会「看起来没区别」') : null),
            h('p', { style: { ...S.hint, marginTop: 6 } }, '说明：这些开关默认已开（0.13.9 起）；关掉后对应模式的能力会失效，按需逐个关。'),
          ),
          group('共享 · 不消耗 Token', '启用后由「手动 / AI 半自动 / AI 自动」三种模式共享：只看状态并做静默反应，不调用模型。', [
            h(Field, { label: '生命感循环', hint: '关闭后不计算陪伴状态，也不做静默回应。' }, toggle('lifeEnabled')),
            h(Field, { label: '静默非语言回应', hint: '回来、专注、应用切换、长时间独处时，自动看向/点头/眨眼，不发气泡。' },
              toggle('lifeNonverbalEnabled'), num('lifeNonverbalCooldownMs', 3, 300, 1, '秒冷却', { ms: true })),
            h(Field, { label: '观众在场判断', hint: '你离开或长时间无输入时，不再对着空气做大幅动作，只保留呼吸和少量眨眼。' },
              toggle('audienceAwareEnabled')),
            h(Field, { label: '双模型关系互动', hint: '摸其中一个模型时，另一个可能看过来、点头或吃醋；不调用 AI。' },
              toggle('dualRelationEnabled')),
            h(Field, { label: '事件判断阈值', hint: '这些只决定宿主何时观察到“离开 / 专注 / 应用切换”，读取窗口标题本身不经过 AI，不消耗 Token。' },
              num('eventWakeFocusMs', 1, 120, 1, '分钟专注', { scale: 60000 }),
              num('eventWakeAwayMs', 1, 120, 1, '分钟离开', { scale: 60000 }),
              num('eventWakeTitleIntervalMs', 10, 300, 5, '秒读标题', { ms: true })),
            h(Field, { label: '陪伴记忆', hint: '按当前对话隔离，不跨会话。代码默认开启；已有安装首次升级会默认关闭，避免和鱼记忆/喵记忆重复。' },
              toggle('memoryEnabled'), num('memoryMaxEntries', 20, 500, 10, '条上限')),
            h(MemoryPanel, { instanceId: target.id, sessionId: cfg.sessionId || '', enabled: cfg.memoryEnabled === true }),
            h(Field, { label: '停机告别', hint: '窗口关闭、模型停用或插件卸载时，先显示一句本地告别再退出。' }, toggle('lifeFarewellEnabled')),
          ]),
          group('手动', `内部模式 auto。只有你点 ⚡ 或摸模型才与 AI 交互；不消耗 Token 的共享陪伴行为仍可运行。`, [
            h(Field, { label: '读屏 · 前台标题', hint: '只读当前窗口标题（不截图），用来说明你在什么软件里。数字是读取间隔；⚡ 唤醒每次都会现读一次，不需要定时。' },
              toggle('screenReadEnabled'), num('screenWatchIntervalMs', 15, 300, 15, '秒一次', { ms: true })),
            h(Field, { label: '允许截图', hint: '开启后 ⚡ / 定时唤醒可以截一张全屏（可能含别的窗口，注意隐私）；这是总开关，关掉后「唤醒时截图」也不生效' },
              toggle('screenCaptureEnabled'), num('screenCaptureIntervalMs', 5, 300, 5, '秒最短间隔', { ms: true })),
            h(Field, { label: '截图免确认', hint: '开启后唤醒/工具截图不再先问一句；总开关关掉时不生效' }, toggle('screenCaptureAutoConfirm')),
            h(Field, { label: '点模型有反应' }, toggle('autoInteract')),
            h(Field, { label: '空闲小动作', hint: '闲着时随机眨眼/歪头' }, toggle('idlePresets')),
          ]),
          group('AI 半自动 / AI 自动 · 消耗 Token 的主动感知', '两种 AI 模式共用的主动说话方式。只能选择「定时唤醒」或「事件唤醒」之一；切换模式不会自动打开它，仍由下面单独控制。', [
            h(Field, { label: '主动感知方式', hint: '关闭 = 不主动调用 AI；定时 = 每隔一段时间看一眼；事件 = 回来或专注达到阈值时才看一眼。按钮 ⚡ 随时仍可使用。' },
              h('select', {
                style: S.select,
                value: proactiveDriver,
                disabled: busy === `patch:${target.id}`,
                onChange: (event) => patchInstancePart(target.id, { wakeDriver: event.target.value }),
              },
              h('option', { value: 'off' }, '关闭'),
              h('option', { value: 'timer' }, '定时唤醒'),
              h('option', { value: 'event' }, '事件唤醒'))),
            h(Field, { label: '唤醒时截图', hint: '关 = 只读窗口标题；开 = 唤醒时截一张一起给我看' }, toggle('wakeCaptureEnabled')),
            disclosureGroup('定时唤醒设置', '只有主动感知方式选择“定时唤醒”时才会运行。', proactiveDriver === 'timer', [
              h(Field, { label: '定时间隔与额度' }, 
                num('wakeIntervalMs', 15, 600, 5, '秒一次', { ms: true }),
                num('wakeMaxPerHour', 1, 360, 10, '次/滚动小时')),
            ]),
            disclosureGroup('事件唤醒设置', '只有主动感知方式选择“事件唤醒”时才会运行。未启用事件唤醒时这里默认收起。', proactiveDriver === 'event', [
              h(Field, { label: '打断额度', hint: '分享额度每天 5 次、重要消息每天 3 次，跨天静默归零；连续主动说话没有用户回应时会自动收敛。' },
                num('eventWakeCooldownMs', 30, 3600, 30, '秒冷却', { ms: true }),
                num('eventWakeMaxPerHour', 1, 120, 1, '次/小时'),
                num('lifeShareBudgetPerDay', 0, 50, 1, '次分享/天'),
                num('lifeImportantBudgetPerDay', 0, 30, 1, '次重要/天')),
              h(Field, { label: '静默时段', hint: '静默时段只保留非语言回应，不主动说话。支持跨午夜。' },
                toggle('eventQuietEnabled'), clock('eventQuietStart', '从'), clock('eventQuietEnd', '到')),
            ]),
          ]),
          group('AI 自动 · 窗口控制', '内部模式 manual。除 AI 半自动的能力外，AI 还能自己移动/缩放窗口（会保证工具栏留在屏内、单次不超半屏）。', [
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

        // DSH 对话输入框下方、权限/Plan 之后的可追加区域。
        // conversation.input.permission 是 single 槽，追加注册会把权限插件挤掉。
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'live2d-quick-toggle', order: 58 },
            Live2DQuickButtons,
          ),
        )
      },
    }
  },
})

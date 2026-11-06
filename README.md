# dsh-live2d

把 **Live2D（Cubism 4）模型**接进 [DeepSeek Harness](https://github.com/deepseek-ai) 桌面端的插件。

每个「对话 × 模型」是一个独立的**透明、置顶**小窗口：模型站在桌面上，底部可以直接打字聊天，回复以气泡或卡片显示在模型头顶；模型会眨眼、点头、脸红、跟着鼠标看，能用 TTS 说话并同步口型，还能在定时唤醒时自己看一眼屏幕，主动跟你说一句。

> 本仓库**不含任何 Live2D 模型与语音素材**（版权与隐私原因）。首次安装后请选择你自己的模型目录。
>
> 版本变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 目录

- [它能做什么](#它能做什么)
- [快速开始](#快速开始)
- [窗口与操作](#窗口与操作)
- [对话与气泡](#对话与气泡)
- [三种模式](#三种模式)
- [动作与表情](#动作与表情)
- [主动唤醒](#主动唤醒)
- [读屏（隐私相关）](#读屏隐私相关)
- [语音与口型](#语音与口型)
- [设置页](#设置页)
- [配置项](#配置项)
- [给 AI 的工具](#给-ai-的工具)
- [HTTP 接口](#http-接口)
- [故障排查](#故障排查)
- [卸载与回滚](#卸载与回滚)
- [开发与自测](#开发与自测)
- [许可证与第三方](#许可证与第三方)

---

## 它能做什么

| 能力 | 说明 |
| --- | --- |
| 多实例 | 最多 2 个窗口，各自绑定不同会话、不同模型、不同外观参数 |
| 透明置顶窗口 | 无边框、可拖动、可调大小、可置顶；透明区域点击穿透到桌面 |
| 窗口内对话 | 底部输入框直接给绑定的会话发消息，回复显示在模型头顶 |
| 气泡 / 卡片 | 两种回答样式、透明度与字号可调；超长内容自绘滚动条 |
| Markdown | 标题、列表、引用、代码块都按富文本渲染（纯 DOM，不执行 HTML） |
| 三种模式 | 手动 / AI 半自动 / AI 自动，权限逐级放宽 |
| 动作与表情 | 12 个内置动作 + 自定义动作 + 动作循环 + 右键菜单 |
| 点击互动 | 摸头/戳身体有反应；空闲时会自己眨眼、歪头 |
| 动态效果 | 待机浮动、视线跟随鼠标、拖动惯性 |
| 主动唤醒 | ⚡ 按钮或定时器让 AI 主动看一眼屏幕并说一句 |
| 读屏 | 第一层读前台窗口标题；第二层按需截全屏（默认关） |
| 语音 | 接本地 CosyVoice2，回答自动朗读并同步口型 |
| AI 工具 | 9 个工具，让 AI 在对话里直接控制模型 |

---

## 快速开始

**要求**：DSH 桌面端；一个 Cubism 4 模型目录（含 `*.model3.json`）。

```powershell
# 1) 备份 profile（可选但建议）
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$profile\package.json" "$profile\package.json.bak"
Copy-Item "$profile\pnpm-lock.yaml" "$profile\pnpm-lock.yaml.bak"

# 2) 完全退出 DSH，再安装
dsh plugin --profile desktop add "<插件目录>"

# 3) 启动 DSH → 设置 → Live2D
```

装好后 DSH 会自动把 `dsh-live2d` 加进 `dsh.profile.bundles`，不用手改。

**第一次配置（设置 → Live2D）**

1. 打开「模型 1」页，把「模型路径」填成你的模型目录（例如 `D:\Live2D\我的模型`），或先把模型放进「扫描根」让它出现在下拉里；
2. 选「绑定会话」——建议先绑一个你常开的对话，之后窗口里的输入才会发到它；
3. 保存 → 点「打开窗口」。模型出现在桌面上就成功了。

> 路径填错不会崩：窗口显示占位卡片，设置页与 `/live2d/health` 会给出告警。

---

## 窗口与操作

顶部工具栏从左到右：

| 按钮 | 作用 |
| --- | --- |
| ✥ | 调整模式：出现边框与 8 个手柄，可拖边/角改大小、拖中间改位置（松手写盘） |
| 模式 ▾ | 切换三种模式（见下文） |
| ⚡ | 主动唤醒：截一次屏（或只读标题）并让 AI 主动说一句 |
| 📌 | 置顶开关，开启时常亮 |
| ◐ | 模型区穿透：开启后点模型会穿到下面的窗口（此时摸不到模型） |
| × | 关闭窗口 |

- **拖动**：在模型身体上按住拖，窗口跟手；松手后有点惯性摆头。
- **点击互动**：轻点头部/身体触发对应动作（可在设置里关）。
- **透明区穿透**：模型外的空白处点击会落到桌面，不挡你操作。
- **多实例**：设置页有「模型 1 / 模型 2」两个页签，每个实例独立配置；取消「启用模型」会立刻关闭它的窗口，重新启用会自动开窗。

---

## 对话与气泡

- **窗口内输入**：底部输入框发送给该实例绑定的会话，回复显示在模型头顶。
- **回答样式**：`气泡`（窄气泡）或 `卡片`（整行卡片），透明度、字号、高度都可调。
- **长度**：短回答贴着头顶，长回答向上生长；超过可用高度时出现自绘滚动条与「↕ 还有约 N 字」提示。
- **Markdown**：标题、列表、引用、代码块、行内代码、加粗/斜体、分隔线；链接只显示文字，HTML 标签按文字显示（不会执行）。
- **思考提示**：AI 思考时窗口显示「思考中…」，结束后自动消失。
- **时长**：气泡默认 5 秒收起，可在设置里 1~120 秒；语音开启时改为「播完才收」。

---

## 三种模式

> 注意：**界面显示的名字**才是给你看的；配置文件里的内部值是反过来的（历史原因）。

| 界面显示 | 内部值 | 会做什么 | 不会做什么 |
| --- | --- | --- | --- |
| **手动** | `auto` | 只播放动作、响应摸头/点击，可以读屏/截图；⚡ 只回气泡 | 不自作主张说话、不自动上气泡、不移动窗口 |
| **AI 半自动** | `semi` | 回答时自动上气泡、思考时眨眼等；可开定时唤醒 | 不移动窗口 |
| **AI 自动** | `manual` | 全权限：动作、气泡、读屏、**可以让 AI 移动/缩放窗口** | —— |

- 权限按「谁发起」判定：**你自己点设置页的按钮永远放行**；只有 AI 工具调用受模式限制（例如「手动」模式下 AI 不能播动作）。
- 切模式时会弹一条说明，告诉你这个模式会做什么、还缺哪些开关。
- 「自动模式相关开关」（读屏、截图、定时唤醒、AI 移动窗口）全部集中在设置页的 **「模式设置」** 页签，模型页不再重复出现。

---

## 动作与表情

- **12 个内置动作**：`idle` 待机、`nod` 点头、`shake` 摇头、`tilt` 歪头、`happy` 开心、`shy` 害羞、`surprised` 惊讶、`blink` 眨眼、`angry` 生气、`drool` 流口水、`xx` 圆圈眼、`puff` 鼓嘴。
- **参数关键帧实现**：模型没有 Motion/Expression 也能动——插件按逻辑参数名（`headX/headY/headZ/eyeOpenL/eyeOpenR/mouthOpen/mouthForm/eyeBallX/eyeBallY/bodyX`）写关键帧；模型缺哪个参数就自动跳过哪条轨道，**换模型不用改代码**。
- **自定义动作**：设置页「动作」页可以写名称 + 说明，让 AI 生成一套关键帧，先「预览」再「保存」；保存后进入右键菜单，AI 也能调用。
- **动作循环**：把若干动作串成循环，设定间隔与绑定模型（可绑两个模型），一键启用/停止；循环播放时**不会抢 AI 正在做的动作**（1.6 秒内刚播过就跳过这一拍）。
- **右键菜单**：在模型上右键，列出所有动作与循环，点一下立刻播放。
- **能力提示**：设置页的「试玩」按钮会按模型实际参数置灰不可用的动作（例如这只模型没有 `PARAM_EXP4`，脸红就点不了），鼠标悬停会写缺几个参数。

---

## 主动唤醒

让 AI 在没人说话时主动看一眼你在干什么，然后说一句。

- **⚡ 按钮**：立刻唤醒一次，三种模式都能用。
- **定时唤醒**：在「模式设置」页打开，设定间隔（默认 30 秒），只对绑定了会话的实例生效。
- **额度**：滚动 60 分钟最多 60 次（约半小时一次/半小时冷却）；额度用尽时设置页和 ⚡ 会提示「额度已满，预计 HH:MM 可再次唤醒」，不会静默。
- **唤醒时看什么**：
  - 默认只读前台窗口标题（便宜、隐私成本极低）；
  - 打开「唤醒时截图」后，每次唤醒附带最多 2 张截图（较旧的会在下次唤醒时一起给）；
  - 两个开关都关时，定时唤醒会跳过并记录原因，不会发空消息刷你的会话。
- **忙时行为**：AI 上一轮还没答完时，本次唤醒只把截图存进待用队列，不打断它；下一次唤醒会把两张一起带上。
- **安全**：额度、间隔、截图开关都可调；「AI 自动」模式还能让 AI 移动/缩放窗口，但**不能关闭窗口**，也不能把窗口移出屏幕。

---

## 读屏（隐私相关）

两层，默认都关：

| 层 | 做什么 | 默认 | 说明 |
| --- | --- | --- | --- |
| 第一层 | 读前台窗口标题 + 进程名 | 关 | 不含画面内容，可定时（间隔 15~300 秒） |
| 第二层 | 截全屏并交给 AI 看 | 关 | 需要显式打开；再开「免确认」才能自主截；否则每次先问你 |

- 截图**不落盘**（临时 PNG 只保留最近 10 张），也不会出现在会话历史里以外的位置；
- 截图有 30 秒最短间隔、并发闸，模式不允许时直接拒绝；
- 你自己在设置页触发的截图/读标题不受 AI 模式限制。

---

## 语音与口型

- 接本地 [CosyVoice2](https://github.com/FunAudioLLM/CosyVoice) HTTP 服务（默认 `http://127.0.0.1:7890/tts`），零样本音色：填参考音 `.wav` 路径 + 参考文本即可。
- 打开「自动朗读」后：气泡先上屏 → 合成完成开始播放 → **播完才收起**；合成期间气泡顶部显示「语音合成中…」。
- 播放时按音节开合嘴部（`ParamMouthOpenY`），频率约每秒一次。
- 长回答只朗读前 500 字（超出部分气泡里仍完整显示，并标注「语音仅前 500 字」）。
- 合成结果有 8 条 LRU 缓存，重复句子立即返回；冷启动第一次可能较慢（超时默认 60 秒）。
- 参考音文件不存在时给明确错误（`tts-prompt-missing`），并提示留空用服务端默认音色。

---

## 设置页

「设置 → Live2D」下有四个页签：

| 页签 | 内容 |
| --- | --- |
| **动作** | 默认动作试玩、自定义动作（名称 + 说明 → 生成 → 预览 → 保存）、动作循环（启用/预览/改/删，绑定模型） |
| **模型 1 / 模型 2** | 每个实例的：模型路径、窗口尺寸位置、模型缩放、回答样式（气泡/卡片、字号、高度、透明度）、气泡时长、语音、启用开关。底部有「同步显示设置到所有模型」 |
| **模式设置** | 按模式分组的所有开关：读屏标题与间隔、允许截图与间隔、免确认、定时唤醒与间隔/额度、唤醒时截图、点模型有反应、空闲小动作、AI 移动窗口；顶部有「一键开启模式所需开关」 |

- 数值输入**离开输入框即保存**（不用再点下面的保存）；
- 出错的字段会回落默认值并在页面顶部黄条、`/live2d/health` 的 `warnings`、宿主日志三处同时告警；
- 配置文件：`%USERPROFILE%\.dsh\dsh-live2d\config.json`（原子写；卸载插件不删）。

---

## 配置项

大部分不需要手改，设置页就是它的界面。完整字段（越界一律回落默认 + 告警）：

| 参数 | 默认 | 范围 / 取值 |
| --- | --- | --- |
| `modelPath` | 空 | 模型目录（探测不到只降级成占位，不改值） |
| `modelScalePct` | 100 | 50 ~ 200（以完整装进窗口为 100%，脚底锚定） |
| `modelLayoutMode` | `fit` | `fit` 气泡不压模型 / `zoom-overlay` 允许放大后盖住 |
| `windowWidth` / `windowHeight` | 320 / 420 | 160~800 / 200~1000 |
| `windowX` / `windowY` | null | ±10000 |
| `bubbleDurationMs` | 5000 | 1000 ~ 120000 |
| `bubbleFixedSize` / `bubbleHeightPx` | false / 200 | 布尔 / 80~900 |
| `replyStyle` | `bubble` | `bubble` / `card` |
| `replyFontSize` / `replyOpacity` | 15 / 0.9 | 12~24 / 0.3~1 |
| `mode` | `auto` | `auto`（界面「手动」）/ `semi` / `manual`（界面「AI 自动」） |
| `boundSessionId` | 空 | 绑定的会话 id；空 = 绑定的会话优先 |
| `chatTimeoutMs` / `showLateReply` | 90000 / false | 10~300 秒 / 布尔 |
| `animCooldownMs` / `animTimeoutMs` | 3000 / 2000 | 0~10000 / 1000~5000 |
| `screenReadEnabled` | false | 读前台标题 |
| `screenWatchIntervalMs` | 30000 | 15000~300000 |
| `screenCaptureEnabled` | false | 允许截图 |
| `screenCaptureAutoConfirm` | false | 免确认（需先开总开关） |
| `screenCaptureIntervalMs` | 30000 | 5000~300000 |
| `wakeEnabled` / `wakeIntervalMs` | false / 30000 | 定时唤醒 / 15000~600000 |
| `wakeCaptureEnabled` | true | 唤醒时是否附图 |
| `wakeMaxPerHour` | 60 | 1~360（滚动 60 分钟） |
| `autoInteract` / `idlePresets` | true / true | 点模型有反应 / 空闲小动作 |
| `ttsEnabled` / `ttsAutoSpeak` | false / false | 语音 / 自动朗读 |
| `ttsUrl` | `http://127.0.0.1:7890/tts` | CosyVoice2 地址 |
| `ttsPrompt` / `ttsPromptText` | 空 / 空 | 参考音 `.wav` / 参考文本 |
| `aiMoveEnabled` | false | 允许 AI 移动/缩放窗口（仅「AI 自动」模式） |

> 两种「越界」语义不同：**配置里**越界 → 回落默认 + 告警；**拖动窗口**越界 → 夹到屏幕边界。

---

## 给 AI 的工具

插件向宿主注册了 9 个工具（AI 在对话里能直接调用）：

| 工具 | 作用 |
| --- | --- |
| `live2d_status` | 有哪些实例、绑定哪个会话、模式、渲染状态 |
| `live2d_bubble` | 让气泡显示一段文字（不传就发本会话最新回复） |
| `live2d_anim` | 播一个内置动作 |
| `live2d_window` | 打开/重载；「AI 自动」模式下可移动、改大小、缩放、复位（**不能关窗**） |
| `live2d_screen` | 读前台窗口标题与进程名 |
| `live2d_screen_capture` | 截一张全屏，返回临时 PNG 路径供 AI 查看 |
| `live2d_preset` | 列动作/循环、播放、**自己设计**新动作、删除、设置并启停循环 |
| `live2d_params` | 列出当前模型真实可用的参数名（设计动作前先查） |
| `live2d_wake` | 只读：唤醒开关、间隔、上次结果、额度、待用截图数（**不能自己触发唤醒**） |

工具按「当前会话」唯一解析目标实例：会话没绑定实例就明确报错，不会错投到别的窗口。

---

## HTTP 接口

插件运行在 DSH 宿主进程里，通过本地 HTTP 暴露管理接口（端口随宿主，见 `/live2d/health` 或窗口控制通道）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/live2d/instances` | 列出 / 新增实例（上限 2） |
| POST/PATCH | `/live2d/instances/:id` | 改实例参数（含唯一性校验） |
| DELETE | `/live2d/instances/:id` | 删除（先关窗再写盘，最后一个不能删） |
| GET/POST | `/live2d/instances/:id/window` | 单实例窗口 open / close / reload |
| GET | `/live2d/models` | 扫模型扫描根（≤3 层）里的 `*.model3.json` |
| GET | `/live2d/health` | 状态总览 + 告警 |
| GET/POST | `/live2d/config` | 读配置 / 批量替换 |
| POST | `/live2d/model/reload` | 重新探测模型并让窗口重载 |
| POST | `/live2d/bubble` | 推气泡（`latest` 或 `text`） |
| POST/GET | `/live2d/chat` | 窗口对话发送 / 查看 pending |
| POST | `/live2d/chat/cancel` | 清掉卡住的 pending |
| POST/GET | `/live2d/anim` | 播动作 / 看台账 |
| GET | `/live2d/sessions` | 绑定会话下拉的数据源 |
| POST | `/live2d/tts` | 合成语音（返回 `audio_base64`） |
| GET | `/live2d/screen` | 读前台标题 |
| POST | `/live2d/screen/capture` | 截全屏 |
| GET/POST | `/live2d/preset` | 动作/循环的查询与管理 |
| GET/POST | `/live2d/wake` | 唤醒状态 / 触发一次唤醒 |
| GET | `/live2d/window` | 窗口状态（含控制端口与日志尾巴） |
| GET | `/live2d/diag` | 诊断快照 |
| GET | `/live2d/panel` | 排查用 HTML 面板 |

---

## 故障排查

**窗口是白底 / 不显示模型**
路径错、`model3.json` 坏、或模型是 Cubism 2 → 窗口显示占位卡片，设置页有黄条。先确认目录里有 `*.model3.json`，且是 Cubism 4 导出。

**窗口位置跑到屏幕外，或露白边**
窗口会被夹回工作区（多屏、分辨率变化也会重新夹取）。如果仍有白边，用「模型设置 → 刷新坐标」或拖回屏幕内。

**模型上有黑块（鼻尖、局部变黑）**
这是 Cubism 4.2 的 `MultiplyColor` / `ScreenColor` 特性，插件已内置兼容层（`electron/assets/vendor/cubism4-color-compat.js`），**更新后需要完全重启 DSH 并关掉旧窗口**才会加载。

**点模型没反应、窗口像被锁住**
检查工具栏 ◐ 是否开了「模型区穿透」——开着时点击会穿到桌面。关掉即可。

**输入框一直「思考中」**
AI 那轮还没结束（可能在调工具）。超时默认 90 秒；也可以在设置里调「思考最大时间」，或关掉「超时后仍输出回答」。

**模型不动 / 动作没反应**
「手动」模式（内部 `auto`）下 AI 工具被拒是设计行为，但设置页的「试玩」不受限。另外动作有 3 秒冷却，连点会被拒。

**语音不响**
确认 CosyVoice2 已启动在 `127.0.0.1:7890`；首次冷启动可能 20 秒以上。参考音路径写错会返回 `tts-prompt-missing`。

**定时唤醒不生效**
「模式设置」里要同时满足：定时唤醒开、绑定了会话、模式不是「手动」、额度未用尽。

**卸载后想彻底清干净**
删 `%USERPROFILE%\.dsh\dsh-live2d\`（配置）和 `%LOCALAPPDATA%\dsh-live2d\`（窗口缓存）。插件不写 profile 的其它文件。

---

## 卸载与回滚

插件是 `link:` 安装，正常卸载不需要跑 pnpm。但 GUI 卸载会先摘 bundle 再跑 pnpm，若卡在联网校验，可能留下「半卸载」状态。建议用自带的无网络工具：

```powershell
# DSH 必须完全退出
cd "<插件目录>\tools"

.\uninstall-drill.cmd            # 完整卸载 + 残留检查
.\uninstall-drill.cmd -restore   # 重新 link 安装 + 四项校验
.\uninstall-drill.cmd -check     # 只看当前状态
```

它会同时处理 `bundle`、`dependency`、`pnpm-lock.yaml` importer 和 `node_modules\dsh-live2d` junction；每次写盘前备份到 profile 的 `.uninstall-backups/`，不联网、不调用 pnpm、不删用户配置。

需要回到安装前的 package/lock 时：

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$profile\package.json.bak-<时间戳>" "$profile\package.json"
```

> 如果你只想在 DSH 里禁用：插件管理里关掉即可，窗口会随之关闭。

---

## 开发与自测

```powershell
cd "<插件目录>"
node tests\shell.mjs            # 宿主半边（约 300+ 项）
node tests\client.mjs           # 网页半边
node tests\renderer-smoke.mjs   # 渲染层冒烟（起 Electron，约 15 秒）
```

目录结构：

```
dsh-live2d/
├─ index.js              宿主半边：实例池 / 模型探测 / 气泡 / 路由 / 窗口进程
├─ client.js             网页半边：设置页（动作 / 模型 / 模式）
├─ lib.js                设置页纯逻辑（toDraft / toPayload，可单测）
├─ cordis.patch.yml      插件入口（id: dsh-live2d）
├─ electron/
│  ├─ main.cjs           窗口池、live2d-asset://<instance>、控制通道
│  ├─ preload.cjs        contextBridge（不开 Node）
│  ├─ renderer.js        渲染：vendor → 模型 → 气泡/回答 → 降级
│  ├─ index.html         窗口页面（CSP 封闭）
│  ├─ foreground.ps1     读屏第一层
│  ├─ capture.ps1        读屏第二层
│  └─ assets/vendor/     pixi / Cubism Core / cubism4（内置，不走 npm）
├─ tests/
└─ tools/                卸载与安装校验
```

技术要点：单 Electron 进程 + 多 `BrowserWindow`；窗口与宿主之间用随机端口的本地 TCP 控制通道（GUI 模式下 stdin 会立刻 EOF）；资产通过自定义协议 `live2d-asset://<instanceId>/…` 提供，只放行 `.json/.moc3/.png/.webp`；渲染库与 Cubism Core 作为静态资源随插件分发，**不引入 npm 依赖**。

---

## 许可证与第三方

本插件代码以 **MIT** 许可发布，详见 [LICENSE](./LICENSE)。

内置第三方组件：

- [pixi.js](https://github.com/pixi/pixi) — MIT
- [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) — MIT
- **Live2D Cubism Core** — Live2D Inc. 专有许可，随插件以原始文件分发，版权声明保留在文件头与 `NOTICE.md`

模型、纹理、语音素材**不在本仓库内**，也不在 MIT 许可范围内——请自行确认你所使用模型的授权。

# Live2D 渲染 runtime（内置静态资源）

这些文件**不是 npm 依赖**，不参与 pnpm 解析，只作为插件静态资源随包分发。
放进 `electron/assets/vendor/` 后由 `electron/index.html` 里的 `renderer.js` 依次加载：

```
pixi.min.js → live2dcubismcore.min.js → cubism4.min.js → cubism4-color-compat.js
```

| 文件 | 来源 | 版本 | 体积 | SHA-256 | 许可 |
| --- | --- | --- | --- | --- | --- |
| `pixi.min.js` | npm `pixi.js@7` 的 `dist/`（用 `npm pack` 取，不安装） | 7.4.3 | 456,150 B | `712a3e19…6d30a24c6` | MIT |
| `cubism4.min.js` | npm `pixi-live2d-display@0.4` 的 `dist/`（同上） | 0.4.0 | 119,922 B | `af1267e6…c4409e21b` | MIT |
| `live2dcubismcore.min.js` | Live2D 官方直链 `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`（下载日 2026-11-02） | Core 5.1.0 | 207,155 B（202.3 KB） | `25ae938c…3cdc792f` | Live2D 自有许可（随应用分发允许，**保留文件头版权声明**） |
| `cubism4-color-compat.js` | 本项目编写，为 pld 0.4 补 Cubism 4.2 MultiplyColor / ScreenColor | 1 | 约 10 KB | 随源码维护 | MIT（本项目） |

完整 SHA-256：

```
712a3e1943b062a907d86c5bb56b67c7b32a3f03b3654768b00b7016d30a24c6  pixi.min.js
af1267e6d52759b245766c578d905bfa025b532d5c3cc727c370957c4409e21b  cubism4.min.js
25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f  live2dcubismcore.min.js
```

> core 不用 SDK zip：GitHub `Live2D/CubismWebSamples` 的 release 没有附件（5-r.5 assets=0），
> 官网 zip 还要先同意许可协议；官方直链实测可直接下，文件头自带版权块（见下）。
> 未来升级版 core 时，重新下载后同步更新上表的体积/SHA-256/下载日期。

## 许可说明

- `live2dcubismcore.min.js` 文件头自带：

  ```
  /**
   * Live2D Cubism Core
   * (C) 2019 Live2D Inc. All rights reserved.
   * This file is licensed pursuant to the license agreement...
   */
  ```

  该注释必须原样保留，不得删除或修改。分发包请同时附上 Live2D 的许可说明（Cubism SDK Release License）。
- pixi.js 与 pixi-live2d-display 为 MIT，保留各自 dist 内的许可头即可。

## 为什么内置而不装 npm 包

`pnpm` 重算依赖树时曾剪掉宿主 peer，导致 DSH 启动崩溃（历史事故）。这三个文件只被
Electron 窗口的 `<script>` 读取，与宿主 Node 进程无关，内置最安全。

## 缺失时的表现

插件仍然正常加载（`phase: 'ready'`），窗口显示占位卡片「渲染组件缺失」，
`/live2d/health` 的 `warnings` 里会给出具体缺哪个文件。

# link 插件卸载/安装修复

## 根因

desktop profile 使用 `link:` 安装 `dsh-live2d`。GUI 卸载会先移除 bundle，
再调用 pnpm 重算依赖。pnpm 在联网或 lockfile 解析阶段中断时，会留下半卸载状态：

- `dsh.profile.bundles` 已没有 `dsh-live2d`；
- `dependencies.dsh-live2d` 仍存在；
- `pnpm-lock.yaml` importer 可能缺失或残留；
- `node_modules/dsh-live2d` junction 仍存在。

下一次安装或卸载会再次进入完整依赖解析，表现为长时间等待、重复弹出操作窗口，
甚至因为未锁 commit 的 GitHub 引用而升级其他插件。

## 工具修复

`tools/uninstall-drill.mjs` 现在是无网络、幂等的 link 生命周期工具：

- 完整移除 bundle / dependency / lock importer / junction；
- 完整恢复同样的四项；
- 删除 junction 前校验目标确实是当前插件，拒绝递归删除实体目录；
- 写入前备份 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`；
- 支持 `--check`、`--before`、`--after`、`--manual-remove --yes`、
  `--manual-install --yes`、`--verify-installed`、`--verify-uninstalled`；
- 全程不调用 pnpm，不联网，不修改其他插件依赖。

`uninstall-drill.cmd` 改为纯 ASCII 启动器，避免中文注释在部分 Windows
控制台代码页下被拆成命令；失败时保留窗口显示错误。

## 使用

DSH 完全退出后：

```powershell
cd "<插件目录>\tools"
.\uninstall-drill.cmd
.\uninstall-drill.cmd -restore
```

## 实测

已在 desktop profile 完成：

1. 半卸载状态检测；
2. 完整卸载，四项状态全部为空；
3. `--after` 检查无残留；
4. 无 pnpm 重新安装；
5. bundle / dependency / lock importer / junction 全部恢复；
6. `pnpm install --lockfile-only --frozen-lockfile` 通过。

用户配置 `%USERPROFILE%\.dsh\dsh-live2d\config.json` 保留。

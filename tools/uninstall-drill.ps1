# 无 pnpm、无联网的完整卸载/恢复脚本（DSH 必须完全退出后再跑）
#
#   .\tools\uninstall-drill.ps1            # 快照 → 完整卸载 → 体检
#   .\tools\uninstall-drill.ps1 -Restore   # 重新 link 安装并验证
#
# 不调用 dsh plugin remove，因此不会触发 pnpm、联网解析或下载 tarball。
# 工具会同时清理 bundle、dependency、lock importer 和 node_modules junction。
#
# 注意：Windows 默认执行策略是 Restricted，直接跑 .ps1 会报
#   「无法加载文件 ... 因为在此系统上禁止运行脚本」
# 可以改用同目录的 uninstall-drill.cmd（cmd 不受执行策略限制），
# 或本终端临时放开：
#   powershell -ExecutionPolicy Bypass -File .\tools\uninstall-drill.ps1

param([switch]$Restore)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if ($Restore) {
  Write-Host '== 重新安装 ==' -ForegroundColor Cyan
  node uninstall-drill.mjs --manual-install --yes
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  node uninstall-drill.mjs --verify-installed
  exit $LASTEXITCODE
}

Write-Host '== 1/3 卸载前快照 ==' -ForegroundColor Cyan
node uninstall-drill.mjs --before
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '== 2/3 完整手动卸载 ==' -ForegroundColor Cyan
node uninstall-drill.mjs --manual-remove --yes
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '== 3/3 卸载后体检 ==' -ForegroundColor Cyan
node uninstall-drill.mjs --after
$code = $LASTEXITCODE

if ($code -eq 0) {
  Write-Host ''
  Write-Host '结论：没有残留。可以 .\tools\uninstall-drill.ps1 -Restore 装回去。' -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host '结论：有残留，查看 profile/.uninstall-backups 与上面输出。' -ForegroundColor Yellow
}
exit $code

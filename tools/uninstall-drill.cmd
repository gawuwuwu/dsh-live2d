@echo off
setlocal
cd /d "%~dp0"

rem Complete dsh-live2d uninstall/install without pnpm or network.
rem Exit DSH completely before running this file.
rem   uninstall-drill.cmd            uninstall
rem   uninstall-drill.cmd -restore   install again
rem   uninstall-drill.cmd -check     show current state

if /i "%~1"=="-restore" goto restore
if /i "%~1"=="-check" goto check

where node >nul 2>nul
if errorlevel 1 goto no_node

echo == 1/3 Snapshot ==
node uninstall-drill.mjs --before
if errorlevel 1 goto fail

echo.
echo == 2/3 Complete uninstall ==
node uninstall-drill.mjs --manual-remove --yes
if errorlevel 1 goto fail

echo.
echo == 3/3 Verify ==
node uninstall-drill.mjs --after
set "CODE=%errorlevel%"
if "%CODE%"=="0" (
  echo.
  echo Result: no leftovers.
  echo Run "uninstall-drill.cmd -restore" to install it again.
) else (
  echo.
  echo Result: leftovers found.
)
if not defined LIVE2D_NO_PAUSE pause
exit /b %CODE%

:restore
where node >nul 2>nul
if errorlevel 1 goto no_node
echo == Restore link installation ==
node uninstall-drill.mjs --manual-install --yes
if errorlevel 1 goto fail
node uninstall-drill.mjs --verify-installed
set "CODE=%errorlevel%"
if not defined LIVE2D_NO_PAUSE pause
exit /b %CODE%

:check
where node >nul 2>nul
if errorlevel 1 goto no_node
node uninstall-drill.mjs --check
set "CODE=%errorlevel%"
if not defined LIVE2D_NO_PAUSE pause
exit /b %CODE%

:no_node
echo Node.js was not found on PATH.
goto fail

:fail
echo.
echo Operation failed. Backups are under the DSH profile .uninstall-backups folder.
if not defined LIVE2D_NO_PAUSE pause
exit /b 1

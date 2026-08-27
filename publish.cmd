@echo off
rem publish.cmd — 双击运行一键打包发布（等价于 .\publish.ps1，出错时窗口停留）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1" %*
if errorlevel 1 (
  echo.
  echo 发布失败，按任意键退出...
  pause >nul
)

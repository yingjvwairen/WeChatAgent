@echo off
cd /d "%~dp0"
title WeChatAgent Voice Service
echo Keep this window open while using voice replies. Use Ctrl+C to stop.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ui-runtime.ps1" -Task dania-start
pause

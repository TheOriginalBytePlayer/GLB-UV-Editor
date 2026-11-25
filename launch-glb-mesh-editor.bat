@echo off
setlocal
title GLB UV Editor
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed or not in PATH & pause & exit /b 1)
if not exist node_modules (call npm install || (echo npm install failed & pause & exit /b 1))
start "GLB UV Editor (5191)" cmd /k npx vite --config vite.config.ts --host 127.0.0.1 --port 5191 --strictPort
timeout /t 3 /nobreak >nul
start http://127.0.0.1:5191
endlocal

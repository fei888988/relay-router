@echo off
chcp 65001 >nul
title Smart Router
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22.5+ is required: https://nodejs.org & pause & exit /b 1)
node --disable-warning=ExperimentalWarning src\index.js
pause

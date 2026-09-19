@echo off
title A4KU Discord Server Cloner v2.0 - Local Launcher
color 0f
cls
echo ====================================================================
echo   A4KU // Discord Server Cloner Engine v2.0
echo   Multi-User Concurrency Queue + Anti-429 Rate-Limit Engine
echo   Stealth Cyber Monochromatic Edition
echo ====================================================================
echo.

cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [!] Node.js is not installed or not in PATH.
    echo     Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [*] Installing dependencies for first-time launch...
    call npm install --prefer-offline --no-audit
)

echo [*] Launching A4KU Server Cloner on http://localhost:3002...
echo.

start "" "http://localhost:3002"

node server.js

pause

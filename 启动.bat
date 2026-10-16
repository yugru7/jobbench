@echo off
chcp 65001 >nul
title Job Search Workbench
cd /d "%~dp0"

rem Find node: PATH first, then common install locations.
rem (2026-10-14: original had hardcoded node path — broken for clones)
set "NODE="
where node >nul 2>&1 && set "NODE=node"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE goto :nonode

rem First run: auto-install deps if node_modules missing
if not exist "node_modules" (
  echo.
  echo  === First run: installing dependencies... ===
  echo.
  where npm >nul 2>&1
  if errorlevel 1 (
    echo [ERROR] npm not found. Node.js install may be incomplete.
    echo Install Node.js 18 or newer:  https://nodejs.org/
    pause
    exit /b 1
  )
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Check your network and try again.
    pause
    exit /b 1
  )
  echo.
  echo  === Dependencies ready. Starting... ===
  echo.
)

netstat -ano | findstr ":7788" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto :already

"%NODE%" server.js --open
echo.
echo   Server stopped. Press any key to close.
pause >nul
exit /b 0

:already
echo.
echo   Already running - opening browser...
start "" "http://127.0.0.1:7788"
timeout /t 2 >nul
exit /b 0

:nonode
echo.
echo   [ERROR] Node.js not found.
echo.
echo   Install Node.js 18 or newer:  https://nodejs.org/
echo   If Node.js is already installed, add it to PATH, or restart Windows
echo   Explorer (sign out and back in) so the new PATH takes effect, then retry.
echo.
choice /c YN /m "Open the download page now?"
if not errorlevel 2 start "" "https://nodejs.org/"
echo.
pause
exit /b 1

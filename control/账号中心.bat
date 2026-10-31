@echo off
chcp 65001 >nul
title QQ Account Center
cd /d "%~dp0.."
set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
rem Portable or custom install: point QQ_BRIDGE_NODE at your node.exe
if not defined NODE_EXE if defined QQ_BRIDGE_NODE set "NODE_EXE=%QQ_BRIDGE_NODE%"
if not defined NODE_EXE (
  echo [x] Node.js not found. Install Node.js or add it to PATH.
  pause
  exit /b 1
)
echo Opening the QQ account center (local page)...
echo (The console keeps running in this window. Close it to stop the console.)
echo.
"%NODE_EXE%" "%~dp0bin\qq-control.mjs" --open --accounts
if errorlevel 1 (
  echo.
  echo [x] Account center exited with an error. See the message above.
  pause
)

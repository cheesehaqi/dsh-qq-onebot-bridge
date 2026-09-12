@echo off
chcp 65001 >nul
title QQ Bot Control Console
cd /d "%~dp0.."
set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "D:\node.js\node.exe" set "NODE_EXE=D:\node.js\node.exe"
if not defined NODE_EXE (
  echo [x] Node.js not found. Install Node.js or add it to PATH.
  pause
  exit /b 1
)
echo Starting the QQ bot control console...
echo (Close this window to stop the console. A running host is NOT affected.)
echo.
"%NODE_EXE%" "%~dp0bin\qq-control.mjs" --open
if errorlevel 1 (
  echo.
  echo [x] Console exited with an error. See the message above.
  pause
)

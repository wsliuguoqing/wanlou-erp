@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo  ==========================================
echo      Wanlou Inventory System  -  starting
echo  ==========================================
echo.

set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
)
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
    echo  [ERROR] Node.js not found on this computer.
    echo.
    echo  Please install Node.js 18 or newer from: https://nodejs.org
    echo  Then double-click this file again.
    echo.
    pause
    exit /b 1
)

echo  Node.js:
"%NODE_EXE%" --version
echo.
echo  Starting server ...
echo  Keep this window OPEN. Closing it will stop the system.
echo.
echo  ------------------------------------------
echo.

"%NODE_EXE%" src\server\server.js

echo.
echo  ------------------------------------------
echo  Server stopped.
echo.
pause

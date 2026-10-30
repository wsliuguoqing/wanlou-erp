@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PORT=3000"

echo.
echo  ==========================================
echo      万楼进销存系统  -  启动中
echo  ==========================================
echo.

REM ---------- 1. 找 Node.js ----------
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE goto :no_node

echo  Node.js 版本：
"%NODE_EXE%" --version
echo.

REM Node 21 起才支持 --disable-warning，低版本就别带这个参数
set "NODE_MAJOR="
for /f "tokens=1 delims=." %%v in ('"%NODE_EXE%" --version') do set "NODE_MAJOR=%%v"
set "NODE_MAJOR=!NODE_MAJOR:v=!"
set "WARNFLAG="
if !NODE_MAJOR! GEQ 21 set "WARNFLAG=--disable-warning=ExperimentalWarning"

REM ---------- 2. 检查 3000 端口是不是已经被占 ----------
REM 最常见的情况：系统已经在另一个窗口跑着，再启动就抢端口失败。
set "BUSY="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do if not defined BUSY set "BUSY=%%p"

if not defined BUSY goto :start

echo  [提示] 端口 %PORT% 已经被占用，占用进程 PID = %BUSY%
for /f "tokens=1 delims=," %%n in ('tasklist /FI "PID eq %BUSY%" /FO CSV /NH 2^>nul') do echo         进程名 = %%~n
echo.
echo  这说明系统很可能已经在另一个窗口里运行了。
echo  直接打开浏览器访问：http://localhost:%PORT%
echo.
choice /c YN /n /m "  要结束旧进程并重新启动吗？[Y=重启 / N=退出] "
if errorlevel 2 goto :quit

echo.
echo  正在结束旧进程 %BUSY% ...
taskkill /PID %BUSY% /T /F >nul 2>&1
ping -n 3 127.0.0.1 >nul
echo  已结束旧进程。
echo.

REM ---------- 3. 启动服务 ----------
:start
echo  Starting server ...
echo  Keep this window OPEN. Closing it will stop the system.
echo.
echo  ------------------------------------------
echo.

REM Node 输出是 UTF-8，这里把控制台切到 65001，否则启动信息里的中文和边框会乱码
chcp 65001 >nul
set "PORT=%PORT%"
"%NODE_EXE%" %WARNFLAG% src\server\server.js
chcp 936 >nul

echo.
echo  ------------------------------------------
echo  Server stopped.
echo.
pause
exit /b 0

:no_node
echo  [错误] 这台电脑上没有找到 Node.js。
echo.
echo  请先安装 Node.js 18 或更高版本：https://nodejs.org
echo  装好后再双击本文件。
echo.
pause
exit /b 1

:quit
echo.
echo  已退出。旧服务继续运行，浏览器打开 http://localhost:%PORT% 就能用。
echo.
pause
exit /b 0

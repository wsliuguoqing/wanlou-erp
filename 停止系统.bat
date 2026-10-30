@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PORT=3000"

echo.
echo  ==========================================
echo      万楼进销存系统  -  停止服务
echo  ==========================================
echo.

set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do if not defined FOUND set "FOUND=%%p"

if not defined FOUND goto :none

echo  发现占用端口 %PORT% 的进程 PID = %FOUND%
for /f "tokens=1 delims=," %%n in ('tasklist /FI "PID eq %FOUND%" /FO CSV /NH 2^>nul') do echo  进程名 = %%~n
echo.
choice /c YN /n /m "  确定结束这个进程吗？[Y=结束 / N=取消] "
if errorlevel 2 goto :cancel

echo.
echo  正在结束进程 %FOUND% ...
taskkill /PID %FOUND% /T /F >nul 2>&1
ping -n 3 127.0.0.1 >nul

REM 再查一次，确认端口已经释放
set "LEFT="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do set "LEFT=%%p"

if defined LEFT goto :still
echo  已停止。现在可以双击 启动系统.bat 重新启动。
echo.
pause
exit /b 0

:still
echo  [警告] 端口 %PORT% 仍被 PID %LEFT% 占用，可能没有权限结束它。
echo         可以右键本文件选「以管理员身份运行」再试一次。
echo.
pause
exit /b 1

:none
echo  没有发现正在运行的系统，端口 %PORT% 是空闲的。
echo.
pause
exit /b 0

:cancel
echo.
echo  已取消，服务继续运行。
echo.
pause
exit /b 0

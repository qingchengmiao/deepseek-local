@echo off
chcp 65001 >nul
title DeepSeek 对话（本地版）
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto no_node

echo   正在启动，浏览器会自动打开……
echo   这个窗口就是服务，关掉它服务就停了。
echo.
node server.mjs --open
if errorlevel 3 goto already
echo.
echo   服务已退出（上面是原因）。
pause
goto :eof

:already
echo   已经在跑的那个窗口已经帮你打开了，这个窗口可以关掉。
timeout /t 3 >nul
goto :eof

:no_node
echo.
echo   [!] 没找到 Node.js。
echo       先去 https://nodejs.org/ 装 Node.js 18 或更高版本，装完再双击我。
echo.
pause
goto :eof

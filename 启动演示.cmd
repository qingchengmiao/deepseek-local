@echo off
chcp 65001 >nul
setlocal
rem 演示沙盒：独立数据目录 + 独立端口，不碰你自己的对话
cd /d "%~dp0"
set "DSAPP_DATA=%~dp0demo-data"
set "PORT=8899"
set "DEMO_URL=http://127.0.0.1:8899"

echo 正在启动演示沙盒…
echo   数据目录：%DSAPP_DATA%
echo   地址：%DEMO_URL%
echo.

if not exist "%DSAPP_DATA%" mkdir "%DSAPP_DATA%"

rem 演示沙盒不自动导入工作区里的导出记录（那是真数据，不该出现在演示里）
if not exist "%DSAPP_DATA%\settings.json" (
  echo {"autoImport":false}> "%DSAPP_DATA%\settings.json"
)

rem 先起服务，等它就绪再开窗口
start "DeepSeek Local 演示" /min cmd /c ""C:\Program Files\nodejs\node.exe" server.mjs"

echo 等服务就绪（最多 20 秒）…
set /a tries=0
:wait
set /a tries+=1
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '%DEMO_URL%/api/state' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 goto ready
if %tries% geq 20 goto timeout
powershell -NoProfile -Command "Start-Sleep -Milliseconds 900" >nul
goto wait

:timeout
echo 服务没起来，看看有没有端口占用：%DEMO_URL%
pause
exit /b 1

:ready
if not exist "%~dp0demo-data\seeded.marker" (
  echo 第一次启动，灌一点演示数据…
  "C:\Program Files\nodejs\node.exe" tools\seed-demo.mjs %DEMO_URL%
  if %errorlevel%==0 echo seeded> "%~dp0demo-data\seeded.marker"
)

echo 打开浏览器…
start "" "%DEMO_URL%"
echo.
echo 演示实例在跑（关掉本窗口不会停服务；要停就关掉那个最小化的 node 窗口，或运行 停止演示.cmd）。
timeout /t 3 >nul

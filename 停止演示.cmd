@echo off
chcp 65001 >nul
rem 停掉演示沙盒（只认 8899 端口上那个 node 进程）
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8899" ^| findstr "LISTENING"') do (
  echo 正在结束 pid=%%p
  taskkill /PID %%p /T /F >nul 2>&1
)
echo 演示实例已停。演示数据留在 demo-data\ 里，下次启动会接着用。
timeout /t 2 >nul

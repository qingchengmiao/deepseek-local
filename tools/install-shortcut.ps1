# 在桌面和开始菜单放一个「DeepSeek」快捷方式
# 优先指向打包好的应用（dist\DeepSeek-win32-x64\DeepSeek.exe）；
# 没打包过就退回 启动应用.vbs（它会起 node 服务 + 打开浏览器应用窗口）。
# 用法：powershell -ExecutionPolicy Bypass -File tools\install-shortcut.ps1
$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $PSScriptRoot
$packagedExe = Join-Path $appDir 'dist\DeepSeek-win32-x64\DeepSeek.exe'
$vbs = Join-Path $appDir '启动应用.vbs'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$icon = Join-Path $appDir 'assets\app.ico'

$shell = New-Object -ComObject WScript.Shell
$places = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'DeepSeek.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'DeepSeek.lnk')
)

if (Test-Path $packagedExe) {
  foreach ($lnkPath in $places) {
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = $packagedExe
    # --no-sandbox 是必须的：这台机器上 Chromium 沙箱初始化会让进程静默退出（表现为双击没反应）
    $lnk.Arguments = '--no-sandbox'
    $lnk.WorkingDirectory = Split-Path -Parent $packagedExe
    $lnk.IconLocation = "$packagedExe,0"
    $lnk.Description = 'DeepSeek 对话（本地版）'
    $lnk.WindowStyle = 1
    $lnk.Save()
    Write-Host "已创建（应用版）：$lnkPath"
  }
} else {
  if (-not (Test-Path $vbs)) { throw "既没有打包好的 exe，也找不到 $vbs" }
  if (-not (Test-Path $wscript)) { throw "找不到 wscript.exe：$wscript" }
  foreach ($lnkPath in $places) {
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = $wscript
    $lnk.Arguments = '"{0}"' -f $vbs
    $lnk.WorkingDirectory = $appDir
    if (Test-Path $icon) { $lnk.IconLocation = "$icon,0" }
    $lnk.Description = 'DeepSeek 对话（本地版）'
    $lnk.WindowStyle = 7
    $lnk.Save()
    Write-Host "已创建（脚本版）：$lnkPath"
  }
}

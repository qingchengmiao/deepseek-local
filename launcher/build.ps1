# 编译原生启动器：launcher\build.ps1
# 需要 MSVC（vcvars64.bat）。产物：dist\DeepSeek-win32-x64\DeepSeekLauncher.exe 与 launcher\out\DeepSeekLauncher.exe
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) { throw "找不到 vcvars64.bat：$vcvars" }

$out = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force $out | Out-Null

# 在 vcvars 环境里跑 cl；用 cmd /c 串起来，避免 PowerShell 环境无法继承
$cmd = @"
call "$vcvars" >nul
cd /d "$PSScriptRoot"
rc /nologo /fo out\launcher.res launcher.rc || exit /b 1
cl /nologo /std:c++17 /EHsc /O2 /MT /W3 /utf-8 /DUNICODE /D_UNICODE launcher.cpp out\launcher.res ^
   /Fe:out\DeepSeekLauncher.exe /Fo:out\ ^
   /link /SUBSYSTEM:WINDOWS user32.lib shell32.lib advapi32.lib psapi.lib ws2_32.lib || exit /b 1
"@
$bat = Join-Path $env:TEMP 'build-launcher.bat'
Set-Content -Path $bat -Value $cmd -Encoding ASCII
& cmd /c "`"$bat`""
if ($LASTEXITCODE -ne 0) { throw "编译失败（exit $LASTEXITCODE）" }

$exe = Join-Path $out 'DeepSeekLauncher.exe'
if (-not (Test-Path $exe)) { throw "没生成 $exe" }
"编译完成：$exe（$([math]::Round((Get-Item $exe).Length / 1KB, 1)) KB）"

# 顺手拷到打包目录，安装包直接用
$dist = Join-Path $root 'dist\DeepSeek-win32-x64'
if (Test-Path $dist) {
  Copy-Item $exe (Join-Path $dist 'DeepSeekLauncher.exe') -Force
  "已拷到：$dist\DeepSeekLauncher.exe"
}

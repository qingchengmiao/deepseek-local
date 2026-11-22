# 编译 NapCat 宿主：napcat\build.ps1
# 需要 MSVC（vcvars64.bat）。产物：napcat\out\DSLNapCatHost.exe 与 dist\DeepSeek-win32-x64\resources\app\napcat\DSLNapCatHost.exe
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) { throw "找不到 vcvars64.bat：$vcvars" }

$out = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force $out | Out-Null

$cmd = @"
call "$vcvars" >nul
cd /d "$PSScriptRoot"
cl /nologo /std:c++17 /EHsc /O2 /MT /W3 /utf-8 /DUNICODE /D_UNICODE host.cpp ^
   /Fe:out\DSLNapCatHost.exe /Fo:out\ ^
   /link /SUBSYSTEM:CONSOLE advapi32.lib psapi.lib ws2_32.lib || exit /b 1
"@
$bat = Join-Path $env:TEMP 'build-napcat-host.bat'
Set-Content -Path $bat -Value $cmd -Encoding ASCII
& cmd /c "`"$bat`""
if ($LASTEXITCODE -ne 0) { throw "编译失败（exit $LASTEXITCODE）" }

$exe = Join-Path $out 'DSLNapCatHost.exe'
if (-not (Test-Path $exe)) { throw "没生成 $exe" }
"编译完成：$exe（$([math]::Round((Get-Item $exe).Length / 1KB, 1)) KB）"

$distDir = Join-Path $root 'dist\DeepSeek-win32-x64\resources\app\napcat'
if (Test-Path (Join-Path $root 'dist\DeepSeek-win32-x64')) {
  New-Item -ItemType Directory -Force $distDir | Out-Null
  Copy-Item $exe (Join-Path $distDir 'DSLNapCatHost.exe') -Force
  "已拷到：$distDir\DSLNapCatHost.exe"
}

param(
  [string]$Base = 'http://127.0.0.1:8790',
  [string]$Tests = '',
  [string]$Data = ''
)
# 跑一组测试，每个单独起进程、单独超时，把结果汇总成一行。
# 用法：pwsh -File tools\_run-suite.ps1 -Base http://127.0.0.1:8790 -Tests smoke,integration,context-test
$ErrorActionPreference = 'Continue'
$app = Split-Path -Parent $PSScriptRoot
$env:BASE = $Base
$env:APP_BASE = $Base
if ($Data) { $env:DSAPP_DATA = $Data }
$names = @($Tests.Split(',') | ForEach-Object { $_.Trim() -replace '\.mjs$', '' } | Where-Object { $_ })
$results = @()
foreach ($name in $names) {
  $file = Join-Path $app "tools\$name.mjs"
  if (-not (Test-Path $file)) { Write-Output ("{0,-26} missing" -f $name); $results += [pscustomobject]@{ test = $name; exit = 'missing' }; continue }
  $out = Join-Path $env:TEMP ("smk_" + $name + ".out")
  $err = Join-Path $env:TEMP ("smk_" + $name + ".err")
  $p = Start-Process 'C:\Program Files\nodejs\node.exe' -ArgumentList "`"$file`"" -WorkingDirectory $app -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
  $ok = $p.WaitForExit(240000)
  if (-not $ok) { try { $p.Kill() } catch {} }
  $code = if ($ok) { $p.ExitCode } else { 'timeout' }
  $text = ((Get-Content $out -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $err -Raw -ErrorAction SilentlyContinue))
  $pass = ([regex]::Matches($text, '(?m)^\s*(✓|\[pass\])')).Count
  $fail = ([regex]::Matches($text, '(?m)^\s*(✗|\[fail\])')).Count
  $last = ($text -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
  Write-Output ("{0,-26} exit={1,-8} 通过={2,-3} 失败={3,-3} {4}" -f $name, $code, $pass, $fail, $last)
  $results += [pscustomobject]@{ test = $name; exit = $code; pass = $pass; fail = $fail }
}
$bad = @($results | Where-Object { $_.exit -ne 0 })
Write-Output ""
Write-Output ("=== 汇总：{0} 项，全过 {1}，有问题 {2} ===" -f $results.Count, ($results.Count - $bad.Count), $bad.Count)
$bad | ForEach-Object { Write-Output ("  ✗ {0} exit={1}" -f $_.test, $_.exit) }

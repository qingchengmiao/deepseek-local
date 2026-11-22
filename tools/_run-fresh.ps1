param(
  [string]$Tests = '',
  [string]$PortBase = '8790'
)
# 每个测试一个全新隔离实例（避免 mock Key 污染后续测试），跑完就拆。
$ErrorActionPreference = 'Continue'
$app = Split-Path -Parent $PSScriptRoot
$names = @($Tests.Split(',') | ForEach-Object { $_.Trim() -replace '\.mjs$', '' } | Where-Object { $_ })
$port = [int]$PortBase
$bad = @()
foreach ($name in $names) {
  $data = Join-Path $app ("data\_fresh_" + $name)
  Remove-Item $data -Recurse -Force -EA SilentlyContinue
  New-Item -ItemType Directory $data -Force | Out-Null
  '{"autoImport":false}' | Set-Content (Join-Path $data 'settings.json') -Encoding utf8
  $env:DSAPP_DATA = $data
  $env:PORT = "$port"
  $srv = Start-Process 'C:\Program Files\nodejs\node.exe' -ArgumentList 'server.mjs' -WorkingDirectory $app -PassThru -WindowStyle Hidden
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 400
    try { if ((Invoke-WebRequest ("http://127.0.0.1:" + $port + "/api/state") -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $ok = $true; break } } catch {}
  }
  if (-not $ok) { Write-Output ("{0,-24} 实例没起来 port={1}" -f $name, $port); $bad += $name; continue }

  $env:BASE = "http://127.0.0.1:$port"
  $out = Join-Path $env:TEMP ("fr_" + $name + ".out")
  $err = Join-Path $env:TEMP ("fr_" + $name + ".err")
  $p = Start-Process 'C:\Program Files\nodejs\node.exe' -ArgumentList ("`"" + (Join-Path $app ("tools\" + $name + ".mjs")) + "`"") -WorkingDirectory $app -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
  $fin = $p.WaitForExit(300000)
  if (-not $fin) { try { $p.Kill() } catch {} }
  $code = if ($fin) { $p.ExitCode } else { 'timeout' }
  $text = ((Get-Content $out -Raw -EA SilentlyContinue) + "`n" + (Get-Content $err -Raw -EA SilentlyContinue))
  $pass = ([regex]::Matches($text, '(?m)^\s*(✓|\[pass\])')).Count
  $fail = ([regex]::Matches($text, '(?m)^\s*(✗|\[fail\])')).Count
  $last = ($text -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
  Write-Output ("{0,-24} exit={1,-8} 通过={2,-3} 失败={3,-3} {4}" -f $name, $code, $pass, $fail, $last)
  if ($code -ne 0) { $bad += $name }

  try { $srv.Kill() } catch {}
  Start-Sleep -Milliseconds 400
  Remove-Item $data -Recurse -Force -EA SilentlyContinue
  $port++
}
Write-Output ""
Write-Output ("=== 全新实例逐个跑：{0} 项，有问题 {1} ===" -f $names.Count, $bad.Count)
$bad | ForEach-Object { Write-Output ("  ✗ " + $_) }

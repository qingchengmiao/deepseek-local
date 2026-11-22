# 发布到 GitHub（v1.0.1）
# 前置：先在你自己的终端登录一次——
#   & 'C:\Program Files\GitHub CLI\gh.exe' auth login
#   选 GitHub.com → HTTPS → Login with a web browser，粘一次性代码即可。
# 然后在本目录执行：
#   pwsh -NoProfile -File tools\publish-github.ps1
# 想换仓库名/可见性：传参数，例如 -Repo deepseek-local -Private
param(
  [string]$Owner = 'qingchengmiao',
  [string]$Repo = 'deepseek-local',
  [string]$Tag = 'v1.0.1',
  [switch]$Private
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$gh = 'C:\Program Files\GitHub CLI\gh.exe'
if (-not (Test-Path $gh)) { $gh = 'gh' }

& $gh auth status 2>&1 | Out-String | Write-Host
if ($LASTEXITCODE -ne 0) {
  throw "gh 还没登录。先运行：`"$gh`" auth login（GitHub.com → HTTPS → 浏览器登录）"
}

$rel = Join-Path $root 'dist\release-1.0.1'
if (-not (Test-Path $rel)) { throw "找不到发布目录：$rel" }

# 1) 仓库（存在就跳过）
$exists = (& $gh repo view "$Owner/$Repo" --json name 2>$null)
if ($LASTEXITCODE -ne 0) {
  $vis = if ($Private) { '--private' } else { '--public' }
  & $gh repo create "$Owner/$Repo" $vis --description '把官方 App 的体验接到你自己的 DeepSeek API 上：本地优先、无框架前端、C++ 启动器' --disable-wiki
  if ($LASTEXITCODE -ne 0) { throw "建仓库失败：$Owner/$Repo" }
} else {
  Write-Host "仓库已存在：$Owner/$Repo"
}

# 2) 推代码
$remote = "https://github.com/$Owner/$Repo.git"
& git remote remove origin 2>$null
& git remote add origin $remote
& git push -u origin HEAD
if ($LASTEXITCODE -ne 0) { throw "推送失败（检查 gh auth login 是否包含 repo 权限）" }

# 3) 发 Release 并传附件
# 注意：两个 PDF 的源文件名是中文，GitHub 的 uploads API 对 CJK 文件名会回 404，
# 所以先复制到临时目录改成 ASCII 名再上传（SHA256SUMS.txt 里也用 ASCII 名）。
$stage = Join-Path $env:TEMP 'dsrel_ascii'
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $stage | Out-Null

$map = @(
  @('DeepSeekLocal-Setup-1.0.1.exe',   'DeepSeekLocal-Setup-1.0.1.exe'),
  @('DeepSeek-Local-1.0.1-source.zip', 'DeepSeek-Local-1.0.1-source.zip'),
  @('DeepSeek-Local-1.0.1.bundle',     'DeepSeek-Local-1.0.1.bundle'),
  @('DeepSeek-Local-功能介绍.pdf',      'DeepSeek-Local-Features.pdf'),
  @('DeepSeek-Local-功能演示.pdf',      'DeepSeek-Local-Feature-Demo.pdf'),
  @('SHA256SUMS.txt',                  'SHA256SUMS.txt')
)
$assets = @()
foreach ($m in $map) {
  $src = Join-Path $rel $m[0]
  if (-not (Test-Path $src)) { continue }
  $dst = Join-Path $stage $m[1]
  Copy-Item $src $dst -Force
  $assets += $dst
}

$already = (& $gh release view $Tag --repo "$Owner/$Repo" --json tagName 2>$null)
if ($LASTEXITCODE -eq 0) {
  Write-Host "Release $Tag 已存在，改为补传附件"
  & $gh release upload $Tag @assets --repo "$Owner/$Repo" --clobber
} else {
  & $gh release create $Tag @assets --repo "$Owner/$Repo" --title "DeepSeek Local $Tag" --notes-file (Join-Path $rel 'RELEASE_NOTES.md')
  if ($LASTEXITCODE -ne 0) { throw "发 Release 失败" }
}

& $gh release view $Tag --repo "$Owner/$Repo" --json url,assets | Out-String | Write-Host
Write-Host "`n完成：https://github.com/$Owner/$Repo/releases/tag/$Tag"

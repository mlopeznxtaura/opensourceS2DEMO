# Publish opensourceS2DEMO as a clean public GitHub repo (offline-only, no deploy configs).
param(
    [string]$RepoName = "opensourceS2DEMO",
    [string]$Visibility = "public"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "Install GitHub CLI: https://cli.github.com/"
}

if (-not (Test-Path .git)) {
    git init
    git branch -M main
}

$files = @(
    "index.html",
    "README.md",
    "LICENSE",
    ".gitignore",
    "css",
    "js",
    "scripts/publish-public.ps1"
)

git add @files
$status = git status --porcelain
if (-not $status) {
    Write-Host "Nothing to commit." -ForegroundColor Yellow
} else {
    git commit -m "opensourceS2DEMO: offline browser recorder with PiP, captions, and voice export"
}

$owner = (gh api user -q .login)
$full = "$owner/$RepoName"

$exists = $false
try {
    gh repo view $full --json name -q .name 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $exists = $true }
} catch { $exists = $false }

if ($exists) {
    Write-Host "Pushing to existing repo $full" -ForegroundColor Cyan
    if (-not (git remote get-url origin 2>$null)) {
        git remote add origin "https://github.com/$full.git"
    }
    git push -u origin main
} else {
    gh repo create $RepoName --$Visibility --source=. --remote=origin --push
}

Write-Host "`nPublic repo: https://github.com/$owner/$RepoName" -ForegroundColor Green
Write-Host "Clone and run: python -m http.server 8080" -ForegroundColor Green

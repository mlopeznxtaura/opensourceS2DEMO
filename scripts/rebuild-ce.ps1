# Rebuild app6-nextaura-fit on IBM Code Engine from GitHub (same app, new code).
param(
    [string]$CeProject = "nextaura-workflows",
    [string]$CeRegion = "us-south",
    [string]$AppName = "app6-nextaura-fit",
    [string]$Repo = "https://github.com/mlopeznxtaura/opensourceS2DEMO"
)

$ErrorActionPreference = "Stop"
Write-Host "=== Rebuild $AppName on Code Engine ($CeRegion) ===" -ForegroundColor Cyan

ibmcloud target -g Default | Out-Null
ibmcloud target -r $CeRegion | Out-Null
ibmcloud ce project select -n $CeProject | Out-Null

ibmcloud ce app update -n $AppName `
    --build-source $Repo `
    --build-dockerfile Dockerfile `
    --build-strategy dockerfile `
    --rebuild

$url = (ibmcloud ce app get -n $AppName --output json | ConvertFrom-Json).url
Write-Host "`nLive: $url" -ForegroundColor Green
Write-Host "Custom: https://app6.nextaura.fit (via Cloudflare proxy)" -ForegroundColor Green

<#
  baixar-sensores.ps1
  Baixa o LibreHardwareMonitor (codigo aberto, MPL-2.0) do GitHub oficial e
  extrai na pasta "sensores" ao lado deste script. Com ele o diagnostico.ps1
  passa a ler as tensoes da fonte (+12V, +5V, +3.3V), a rotacao das ventoinhas
  e as temperaturas de processador, placa-mae, video e discos.

  Uso:  powershell -ExecutionPolicy Bypass -File .\baixar-sensores.ps1

  Observacoes:
  - Leva a pasta "sensores" junto com o diagnostico.bat/.ps1 no pendrive.
  - No servidor, copie-a para diag-viewer\web\coleta\sensores: o pacote
    diag-diagnostico.zip da pagina Downloads passa a inclui-la.
  - A partir da versao 0.9.5 o LibreHardwareMonitor le os sensores da
    placa-mae pelo driver PawnIO (https://pawnio.eu). Sem o PawnIO instalado
    no PC testado, tensoes e ventoinhas podem nao aparecer.
#>
param([string]$Versao = 'latest')
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$api = 'https://api.github.com/repos/LibreHardwareMonitor/LibreHardwareMonitor/releases/'
$rel = Invoke-RestMethod ($api + $(if ($Versao -eq 'latest') { 'latest' } else { "tags/$Versao" })) -Headers @{ 'User-Agent' = 'diag-toolkit' }
# o PowerShell 5.1 precisa da versao .NET Framework: LibreHardwareMonitor.zip (nao a .NET.10)
$asset = $rel.assets | Where-Object { $_.name -eq 'LibreHardwareMonitor.zip' } | Select-Object -First 1
if (-not $asset) { $asset = $rel.assets | Where-Object { $_.name -match '\.zip$' -and $_.name -notmatch 'NET\.\d' } | Select-Object -First 1 }
if (-not $asset) { throw "Nao achei o .zip na versao $($rel.tag_name)." }
$dest = Join-Path $PSScriptRoot 'sensores'
$zip = Join-Path $env:TEMP $asset.name
Write-Host "Baixando $($asset.name) $($rel.tag_name) ($([math]::Round($asset.size / 1MB, 1)) MB)..."
Invoke-WebRequest $asset.browser_download_url -OutFile $zip -UseBasicParsing
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Expand-Archive $zip -DestinationPath $dest
Remove-Item $zip -Force
Get-ChildItem $dest -Recurse -File | Unblock-File
if (-not (Test-Path (Join-Path $dest 'LibreHardwareMonitorLib.dll'))) { throw "LibreHardwareMonitorLib.dll nao veio no pacote. Veja $dest" }
"$($rel.tag_name)  $($asset.browser_download_url)" | Set-Content (Join-Path $dest 'VERSAO.txt')
Write-Host "Pronto: $dest" -ForegroundColor Green

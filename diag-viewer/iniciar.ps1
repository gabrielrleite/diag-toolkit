<#
  iniciar.ps1 - primeira execucao / atualizacao do servidor diag-viewer
  - Cria o .env com tokens aleatorios (so se ainda nao existir)
  - Copia o UPLOAD_TOKEN para ..\diag-scripts\diag-servidor.cfg
  - Sobe o container (docker compose up -d --build) e abre o navegador

  Uso:  powershell -ExecutionPolicy Bypass -File .\iniciar.ps1
#>
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Novo-Token {
  $b = New-Object byte[] 30
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host 'Docker nao encontrado. Instale/abra o Docker Desktop e rode de novo.' -ForegroundColor Red
  exit 1
}

$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path $envFile) {
  Write-Host '.env ja existe - mantendo os tokens atuais.'
} else {
  $up = Novo-Token; $rd = Novo-Token
  "UPLOAD_TOKEN=$up`nREAD_TOKEN=$rd`nMAX_MB=500`n" | Set-Content -Path $envFile -Encoding ASCII -NoNewline
  Write-Host '.env criado com tokens novos.' -ForegroundColor Green
}

$vals = @{}
foreach ($l in Get-Content $envFile) { if ($l -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $vals[$Matches[1]] = $Matches[2].Trim() } }

$cfg = Join-Path $PSScriptRoot '..\diag-scripts\diag-servidor.cfg'
if (Test-Path (Split-Path $cfg)) {
  $srv = 'http://localhost:8080'
  if (Test-Path $cfg) {
    $m = Select-String -Path $cfg -Pattern '^\s*SERVIDOR\s*=\s*(.+)$' | Select-Object -First 1
    if ($m -and $m.Matches[0].Groups[1].Value -notmatch 'IP-DO-SERVIDOR') { $srv = $m.Matches[0].Groups[1].Value.Trim() }
  }
  "SERVIDOR=$srv`r`nTOKEN=$($vals.UPLOAD_TOKEN)`r`n" | Set-Content -Path $cfg -Encoding ASCII -NoNewline
  Write-Host "diag-servidor.cfg atualizado (SERVIDOR=$srv)." -ForegroundColor Green
}

Write-Host ''
Write-Host 'Subindo o container...'
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Write-Host 'Falha no docker compose. Veja as mensagens acima.' -ForegroundColor Red; exit 1 }

Start-Sleep -Seconds 2
Write-Host ''
Write-Host 'Servidor no ar: http://localhost:8080' -ForegroundColor Green
Write-Host "Token de leitura (pedido na interface): $($vals.READ_TOKEN)" -ForegroundColor Yellow
Write-Host 'Nos outros PCs, use SERVIDOR=http://IP-DESTE-PC:8080 no diag-servidor.cfg.'
Start-Process 'http://localhost:8080'

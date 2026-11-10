<#
  diag-hardware.ps1
  Coleta evidencias de remocao/troca de hardware no Windows e empacota tudo
  em um .zip com hashes SHA256 (diagnostico tecnico).

  Uso (PowerShell como Administrador):
    powershell -ExecutionPolicy Bypass -File .\diag-hardware.ps1
    powershell -ExecutionPolicy Bypass -File .\diag-hardware.ps1 -Dias 90
    powershell -ExecutionPolicy Bypass -File .\diag-hardware.ps1 -Tudo -Destino D:\Coletas

  Parametros:
    -Dias     Quantos dias de eventos coletar (padrao 60; 0 = todo o historico)
    -Tudo     Lista TODOS os dispositivos (padrao: video, disco, rede, audio,
              monitor + qualquer dispositivo PCI que nao esteja mais presente)
    -Destino  Pasta onde salvar (padrao: Area de Trabalho)
    -Enviar   Depois da coleta, envia o .zip ao servidor do visualizador
    -EnviarArquivo <zip>  So envia um .zip ja existente (reenvio) e sai
    -Servidor / -Token    Sobrescrevem o que estiver no diag-servidor.cfg
    -Patrimonio <num>     Informa o patrimonio quando o nome do PC nao segue o padrao PC+patrimonio

  diag-servidor.cfg (mesma pasta do script):
    SERVIDOR=http://10.0.0.10:8080
    TOKEN=token-de-envio

  Nao altera nada no sistema: so le e exporta.
#>
param(
  [ValidateRange(0, 36500)][int]$Dias = 60,
  [switch]$Tudo,
  [string]$Destino = [Environment]::GetFolderPath('Desktop'),
  [switch]$Enviar,
  [string]$EnviarArquivo,
  [string]$Servidor,
  [string]$Token,
  [string]$Patrimonio,
  [switch]$EscolherPasta,
  [switch]$ListarRemoviveis
)

$ErrorActionPreference = 'Continue'

# =====================================================================
# Ajudantes do menu (.bat): escolher pasta e listar pendrives. Saem logo.
# =====================================================================
if ($EscolherPasta) {
  Add-Type -AssemblyName System.Windows.Forms
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = 'Escolha a pasta onde a coleta sera salva'
  $dlg.ShowNewFolderButton = $true
  if ($Destino -and (Test-Path -LiteralPath $Destino)) { $dlg.SelectedPath = $Destino }
  $dono = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
  if ($dlg.ShowDialog($dono) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }
  $dono.Dispose()
  exit 0
}
if ($ListarRemoviveis) {
  Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | Where-Object { $_.Size } | ForEach-Object {
    $nome = if ($_.VolumeName) { $_.VolumeName } else { 'sem nome' }
    '{0}|{1} - {2:N1} GB livres de {3:N1} GB' -f $_.DeviceID, $nome, ($_.FreeSpace / 1GB), ($_.Size / 1GB)
  }
  exit 0
}

# Patrimonio: informado (-Patrimonio) > nome do PC (padrao PC + patrimonio, ex.: PC012345) > pergunta
function Limpa-Patrimonio([string]$v) { ($v -replace '[^\w\.\-/ ]', '').Trim() | ForEach-Object { if ($_.Length -gt 30) { $_.Substring(0, 30) } else { $_ } } }
$patrOrigem = ''
if ($PSBoundParameters.ContainsKey('Patrimonio')) {
  $patrimonio = if ($Patrimonio -in @('-', 'NAO_INFORMADO')) { '' } else { Limpa-Patrimonio $Patrimonio }
  $patrOrigem = 'informado manualmente'
} elseif ($env:COMPUTERNAME -match '^PC-?(.+)$') {
  $patrimonio = $Matches[1]
  $patrOrigem = 'nome do computador'
} elseif (-not $EnviarArquivo -and [Environment]::UserInteractive) {
  Write-Host "O nome '$env:COMPUTERNAME' nao segue o padrao PC+patrimonio." -ForegroundColor Yellow
  $patrimonio = Limpa-Patrimonio (Read-Host 'Informe o numero do patrimonio (Enter para deixar em branco)')
  $patrOrigem = 'informado manualmente'
}
if (-not $patrimonio) { $patrimonio = 'NAO INFORMADO'; $patrOrigem = 'nome fora do padrao PC+patrimonio' }

# =====================================================================
# Envio ao servidor
# =====================================================================
function Get-ServidorCfg {
  $cfg = @{ Servidor = $Servidor; Token = $Token }
  $arq = Join-Path $PSScriptRoot 'diag-servidor.cfg'
  if (Test-Path $arq) {
    foreach ($l in Get-Content $arq) {
      if ($l -match '^\s*SERVIDOR\s*=\s*(.+?)\s*$' -and -not $cfg.Servidor) { $cfg.Servidor = $Matches[1] }
      if ($l -match '^\s*TOKEN\s*=\s*(.+?)\s*$'    -and -not $cfg.Token)    { $cfg.Token    = $Matches[1] }
    }
  }
  $cfg
}

function Send-Coleta([string]$zipPath) {
  $cfg = Get-ServidorCfg
  if (-not $cfg.Servidor) { Write-Warning 'Servidor nao configurado (diag-servidor.cfg ou -Servidor).'; return $false }
  if (-not $cfg.Token)    { Write-Warning 'Token de envio nao configurado (diag-servidor.cfg ou -Token).'; return $false }
  if (-not (Test-Path -LiteralPath $zipPath)) { Write-Warning "Arquivo nao encontrado: $zipPath"; return $false }

  $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
  $url  = $cfg.Servidor.TrimEnd('/') + '/api/coletas'
  $e    = { param($v) [uri]::EscapeDataString([string]$v) }
  $headers = @{
    'X-Token'      = $cfg.Token
    'X-Sha256'     = $hash
    'X-Arquivo'    = & $e (Split-Path $zipPath -Leaf)
    'X-Computador' = & $e $env:COMPUTERNAME
    'X-Patrimonio' = & $e $patrimonio
    'X-Usuario'    = & $e "$env:USERDOMAIN\$env:USERNAME"
  }
  Write-Host "Enviando para $($cfg.Servidor) ..."
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $r = Invoke-RestMethod -Uri $url -Method Post -InFile $zipPath -ContentType 'application/zip' -Headers $headers -TimeoutSec 600
  } catch {
    $msg = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      try { $msg = ($_.ErrorDetails.Message | ConvertFrom-Json).erro } catch { $msg = $_.ErrorDetails.Message }
    }
    Write-Host "FALHA NO ENVIO: $msg" -ForegroundColor Red
    "FALHA $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $($cfg.Servidor)  $msg" | Add-Content "$zipPath.envio.txt"
    return $false
  }
  if ($r.sha256 -ne $hash) {
    Write-Host 'FALHA: o servidor recebeu um arquivo com hash diferente.' -ForegroundColor Red
    return $false
  }
  $situacao = if ($r.duplicado) { 'JA EXISTIA no servidor' } else { 'RECEBIDO' }
  Write-Host "Envio OK - $situacao" -ForegroundColor Green
  Write-Host "  Id no servidor : $($r.id)"
  Write-Host "  Recebido em    : $($r.recebidoEm) (UTC)"
  Write-Host "  SHA256 conferido pelo servidor: $($r.sha256)"
  @(
    "ENVIADO  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    "Servidor : $($cfg.Servidor)"
    "Id       : $($r.id)"
    "Recebido : $($r.recebidoEm) (UTC)"
    "Situacao : $situacao"
    "SHA256   : $($r.sha256)"
  ) | Add-Content "$zipPath.envio.txt"
  return $true
}

# Modo so reenvio
if ($EnviarArquivo) {
  if (Send-Coleta $EnviarArquivo) { exit 0 } else { exit 2 }
}

# --- Precisa de admin (log de Seguranca e exportacao de .evtx)
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Warning 'Execute o PowerShell como Administrador.'; exit 1 }

$inicio = Get-Date
$stamp  = $inicio.ToString('yyyyMMdd_HHmmss')
$pasta  = Join-Path $Destino ("diag_{0}_{1}" -f $env:COMPUTERNAME, $stamp)
$evtx   = Join-Path $pasta 'evtx'
New-Item -ItemType Directory -Path $evtx -Force | Out-Null
$desde  = if ($Dias -eq 0) { [datetime]'1990-01-01' } else { $inicio.AddDays(-$Dias) }
$periodoTxt = if ($Dias -eq 0) { 'todo o historico' } else { "ultimos $Dias dias" }
$classesFoco = 'Display','DiskDrive','Net','Media','Monitor'

function Log([string]$msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  Add-Content -Path (Join-Path $pasta 'coleta.log') -Value $line
}
function Tabela($obj) { ($obj | Format-Table -AutoSize | Out-String -Width 400).TrimEnd() }

Log "Inicio da coleta em $env:COMPUTERNAME ($periodoTxt)"

# =====================================================================
# 1. Maquina e relogio
# =====================================================================
Log 'Coletando dados da maquina e do relogio'
$cs   = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$os   = Get-CimInstance Win32_OperatingSystem
$enc  = Get-CimInstance Win32_SystemEnclosure | Select-Object -First 1
$breachMap = @{ 1='Outro'; 2='Desconhecido'; 3='Sem violacao'; 4='Tentativa de violacao'; 5='Violacao detectada' }
$breach = if ($null -ne $enc.SecurityBreach) { $breachMap[[int]$enc.SecurityBreach] } else { 'Nao informado pela BIOS' }

$info = [ordered]@{
  'Computador'          = $env:COMPUTERNAME
  'Patrimonio'          = $patrimonio
  'Origem patrimonio'   = $patrOrigem
  'Coletado por'        = "$env:USERDOMAIN\$env:USERNAME"
  'Hora da coleta'      = $inicio.ToString('yyyy-MM-dd HH:mm:ss')
  'Fuso horario'        = (Get-TimeZone).Id
  'Fabricante / Modelo' = "$($cs.Manufacturer) / $($cs.Model)"
  'Serial (BIOS)'       = $bios.SerialNumber
  'Versao BIOS'         = $bios.SMBIOSBIOSVersion
  'Sistema'             = "$($os.Caption) $($os.Version)"
  'Instalacao do SO'    = $os.InstallDate
  'Ultimo boot'         = $os.LastBootUpTime
  'Intrusao no chassis' = $breach
}
$maqTxt = Join-Path $pasta '01_maquina.txt'
$info.GetEnumerator() | ForEach-Object { '{0,-20}: {1}' -f $_.Key, $_.Value } | Set-Content $maqTxt
Add-Content $maqTxt "`r`n--- Sincronizacao de horario (w32tm) ---"
(w32tm /query /status 2>&1) | Out-String | Add-Content $maqTxt

# =====================================================================
# 2. Dispositivos (presentes e removidos) com datas
# =====================================================================
Log 'Levantando dispositivos e datas de instalacao/chegada/remocao'
$keys = 'DEVPKEY_Device_FirstInstallDate','DEVPKEY_Device_InstallDate',
        'DEVPKEY_Device_LastArrivalDate','DEVPKEY_Device_LastRemovalDate'

$devs = Get-PnpDevice -ErrorAction SilentlyContinue
if (-not $Tudo) {
  $devs = $devs | Where-Object {
    ($classesFoco -contains $_.Class) -or ((-not $_.Present) -and $_.InstanceId -like 'PCI\*')
  }
}

$lista = foreach ($d in $devs) {
  $p = @{}
  Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName $keys -ErrorAction SilentlyContinue |
    ForEach-Object { $p[$_.KeyName] = $_.Data }
  [pscustomobject]@{
    Classe             = $d.Class
    Nome               = $d.FriendlyName
    Presente           = $d.Present
    PrimeiraInstalacao = $p['DEVPKEY_Device_FirstInstallDate']
    UltimaChegada      = $p['DEVPKEY_Device_LastArrivalDate']
    UltimaRemocao      = $p['DEVPKEY_Device_LastRemovalDate']
    InstanceId         = $d.InstanceId
  }
}
$lista | Sort-Object Classe, UltimaChegada |
  Export-Csv (Join-Path $pasta '02_dispositivos.csv') -NoTypeInformation -Encoding UTF8
$removidos = $lista | Where-Object { -not $_.Presente } | Sort-Object UltimaChegada -Descending

# =====================================================================
# 3. Boots e desligamentos
# =====================================================================
Log 'Coletando eventos de boot/desligamento'
$bootDesc = @{
  6005 = 'Sistema iniciado'
  6006 = 'Desligamento normal'
  6008 = 'Desligamento inesperado'
  41   = 'Reinicio sem desligamento limpo (Kernel-Power)'
}
$boot = Get-WinEvent -FilterHashtable @{ LogName='System'; Id=@(6005,6006,6008,41,1074); StartTime=$desde } -ErrorAction SilentlyContinue |
  Sort-Object TimeCreated |
  Select-Object TimeCreated, Id,
    @{n='Descricao'; e={ $bootDesc[$_.Id] }}
$boot | Export-Csv (Join-Path $pasta '03_boots.csv') -NoTypeInformation -Encoding UTF8

# =====================================================================
# 4. Kernel-PnP (configuracao de dispositivos)
# =====================================================================
Log 'Coletando eventos Kernel-PnP'
$pnpDesc = @{ 400='Configurado'; 410='Iniciado'; 420='Excluido'; 430='Requer instalacao' }
$pnp = Get-WinEvent -FilterHashtable @{ LogName='Microsoft-Windows-Kernel-PnP/Configuration'; Id=@(400,410,420,430); StartTime=$desde } -ErrorAction SilentlyContinue |
  Sort-Object TimeCreated |
  Select-Object TimeCreated, Id,
    @{n='Evento';      e={ $pnpDesc[$_.Id] }},
    @{n='Dispositivo'; e={ $_.Properties[0].Value }}
$pnp | Export-Csv (Join-Path $pasta '04_kernel_pnp.csv') -NoTypeInformation -Encoding UTF8

# =====================================================================
# 5. Logons de usuarios
# =====================================================================
Log 'Coletando logons (pode demorar se o log de Seguranca for grande)'
$tipos = @{ 2='Local'; 7='Desbloqueio'; 10='Remoto (RDP)'; 11='Cache (offline)' }
$logons = Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4624; StartTime=$desde } -ErrorAction SilentlyContinue |
  ForEach-Object {
    $t = [int]$_.Properties[8].Value
    $u = [string]$_.Properties[5].Value
    if ($tipos.ContainsKey($t) -and $u -notmatch '^(DWM-|UMFD-)' -and $u -notlike '*$') {
      [pscustomobject]@{
        Hora    = $_.TimeCreated
        Usuario = '{0}\{1}' -f $_.Properties[6].Value, $u
        Tipo    = $tipos[$t]
        Origem  = $_.Properties[18].Value
      }
    }
  } | Sort-Object Hora
$logons | Export-Csv (Join-Path $pasta '05_logons.csv') -NoTypeInformation -Encoding UTF8

# =====================================================================
# 5b. Saude do equipamento (06_saude.json) - usada nos laudos de manutencao
# =====================================================================
Log 'Coletando saude do equipamento (discos, memoria, eventos criticos)'
function Fmt-Data($d) { if ($d) { try { ([datetime]$d).ToString('yyyy-MM-dd HH:mm:ss') } catch { $null } } else { $null } }
function Primeira-Linha($m) { if ($m) { (($m -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1).Trim() } else { '' } }
function Busca-Eventos([string]$log, [string[]]$provs, [int[]]$ids) {
  $out = @()
  foreach ($p in $provs) {
    $f = @{ LogName = $log; ProviderName = $p; StartTime = $desde }
    if ($ids) { $f.Id = $ids }
    try { $out += @(Get-WinEvent -FilterHashtable $f -ErrorAction Stop) } catch { }
  }
  @($out | Sort-Object TimeCreated -Descending)
}
function Resumo-Eventos($evs, [int]$max = 10) {
  $evs = @($evs | Where-Object { $_ })
  [ordered]@{
    total    = @($evs).Count
    primeiro = Fmt-Data (@($evs) | Select-Object -Last 1).TimeCreated
    ultimo   = Fmt-Data (@($evs) | Select-Object -First 1).TimeCreated
    recentes = @(@($evs) | Select-Object -First $max | ForEach-Object {
      [ordered]@{ hora = Fmt-Data $_.TimeCreated; id = $_.Id; origem = $_.ProviderName; mensagem = Primeira-Linha $_.Message }
    })
  }
}

$saude = [ordered]@{ versao = 1; geradoEm = Fmt-Data (Get-Date) }

try {
  $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
  $saude.cpu = [ordered]@{ nome = ($cpu.Name -replace '\s+', ' ').Trim(); nucleos = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors; cargaPct = $cpu.LoadPercentage }
} catch { }

try {
  $saude.memoria = [ordered]@{
    totalGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
    livreGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
    modulos = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
      [ordered]@{ slot = $_.DeviceLocator; gb = [math]::Round($_.Capacity / 1GB, 1); mhz = $(if ($_.ConfiguredClockSpeed) { $_.ConfiguredClockSpeed } else { $_.Speed }); fabricante = "$($_.Manufacturer)".Trim(); modelo = "$($_.PartNumber)".Trim() }
    })
  }
} catch { }

try {
  $saude.discos = @(Get-PhysicalDisk | ForEach-Object {
    $rc = $null
    try { $rc = $_ | Get-StorageReliabilityCounter -ErrorAction Stop } catch { }
    [ordered]@{
      nome = $_.FriendlyName; tipo = "$($_.MediaType)"; barramento = "$($_.BusType)"
      gb = [math]::Round($_.Size / 1GB, 1); saude = "$($_.HealthStatus)"; status = (@($_.OperationalStatus) -join ', ')
      serial = "$($_.SerialNumber)".Trim()
      temperatura = $(if ($rc) { $rc.Temperature }); temperaturaMax = $(if ($rc) { $rc.TemperatureMax })
      desgastePct = $(if ($rc) { $rc.Wear }); horasLigado = $(if ($rc) { $rc.PowerOnHours })
      errosLeitura = $(if ($rc) { $rc.ReadErrorsTotal }); errosEscrita = $(if ($rc) { $rc.WriteErrorsTotal })
    }
  })
} catch { $saude.discos = @() }

try {
  $saude.smart = @(Get-CimInstance -Namespace root\wmi -ClassName MSStorageDriver_FailurePredictStatus -ErrorAction Stop | ForEach-Object {
    [ordered]@{ instancia = $_.InstanceName; falhaPrevista = [bool]$_.PredictFailure; motivo = $_.Reason }
  })
} catch { $saude.smart = @() }

try {
  $saude.volumes = @(Get-Volume | Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Fixed' -and $_.Size -gt 0 } | ForEach-Object {
    [ordered]@{ letra = "$($_.DriveLetter):"; rotulo = $_.FileSystemLabel; sistemaArquivos = $_.FileSystem; totalGB = [math]::Round($_.Size / 1GB, 1); livreGB = [math]::Round($_.SizeRemaining / 1GB, 1); livrePct = [math]::Round(100 * $_.SizeRemaining / $_.Size, 1); saude = "$($_.HealthStatus)" }
  })
} catch { $saude.volumes = @() }

try {
  $hf = Get-HotFix -ErrorAction Stop | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 1
  $saude.sistema = [ordered]@{
    nome = $os.Caption; versao = $os.Version; arquitetura = $os.OSArchitecture
    ultimoBoot = Fmt-Data $os.LastBootUpTime
    horasLigado = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
    ultimaAtualizacao = $(if ($hf) { Fmt-Data $hf.InstalledOn }); ultimaAtualizacaoId = $(if ($hf) { $hf.HotFixID })
    inicializacaoRapida = $(try { [int](Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -ErrorAction Stop).HiberbootEnabled } catch { $null })
  }
} catch { }

try {
  $mp = Get-MpComputerStatus -ErrorAction Stop
  $saude.antivirus = [ordered]@{ produto = 'Microsoft Defender'; ativo = [bool]$mp.AntivirusEnabled; tempoReal = [bool]$mp.RealTimeProtectionEnabled; assinatura = Fmt-Data $mp.AntivirusSignatureLastUpdated }
} catch {
  try {
    $av = Get-CimInstance -Namespace root\SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop | Select-Object -First 1
    if ($av) { $saude.antivirus = [ordered]@{ produto = $av.displayName; ativo = $null; tempoReal = $null; assinatura = $null } }
  } catch { }
}

try {
  $bat = Get-CimInstance Win32_Battery -ErrorAction Stop | Select-Object -First 1
  if ($bat) {
    $proj = (Get-CimInstance -Namespace root\wmi -ClassName BatteryStaticData -ErrorAction SilentlyContinue | Select-Object -First 1).DesignedCapacity
    $full = (Get-CimInstance -Namespace root\wmi -ClassName BatteryFullChargedCapacity -ErrorAction SilentlyContinue | Select-Object -First 1).FullChargedCapacity
    $saude.bateria = [ordered]@{ cargaPct = $bat.EstimatedChargeRemaining; capacidadeProjetada = $proj; capacidadeAtual = $full; desgastePct = $(if ($proj -and $full) { [math]::Round(100 - 100 * $full / $proj, 1) }) }
  }
} catch { }

try {
  $saude.rede = @(Get-NetAdapter -Physical -ErrorAction Stop | ForEach-Object {
    [ordered]@{ nome = $_.Name; descricao = $_.InterfaceDescription; status = "$($_.Status)"; velocidade = $_.LinkSpeed; mac = $_.MacAddress }
  })
} catch { $saude.rede = @() }

$ev = [ordered]@{}
$ev.telaAzul = Resumo-Eventos (Busca-Eventos 'System' @('Microsoft-Windows-WER-SystemErrorReporting', 'BugCheck') @(1001))
$ev.desligamentoInesperado = Resumo-Eventos (@(Busca-Eventos 'System' @('Microsoft-Windows-Kernel-Power') @(41)) + @(Busca-Eventos 'System' @('EventLog') @(6008)) | Sort-Object TimeCreated -Descending)
$ev.erroDisco = Resumo-Eventos (Busca-Eventos 'System' @('disk', 'Ntfs', 'Microsoft-Windows-Ntfs', 'storahci', 'stornvme', 'iaStorA', 'iaStorAC', 'iaStorAVC') @(7, 11, 51, 55, 98, 129, 153, 157))
$ev.erroHardware = Resumo-Eventos (Busca-Eventos 'System' @('Microsoft-Windows-WHEA-Logger') $null)
$ev.driverVideo = Resumo-Eventos (Busca-Eventos 'System' @('Display') @(4101))
$apps = @(Busca-Eventos 'Application' @('Application Error') @(1000) | Where-Object { $_ })
$ev.falhaAplicativo = [ordered]@{
  total = $apps.Count
  porAplicativo = @($apps | Group-Object { $_.Properties[0].Value } | Sort-Object Count -Descending | Select-Object -First 10 | ForEach-Object {
    [ordered]@{ aplicativo = $_.Name; total = $_.Count; ultimo = Fmt-Data ($_.Group | Select-Object -First 1).TimeCreated }
  })
}
$saude.eventos = $ev
$saude.minidumps = @(Get-ChildItem "$env:SystemRoot\Minidump\*.dmp" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 20 | ForEach-Object {
  [ordered]@{ arquivo = $_.Name; data = Fmt-Data $_.LastWriteTime; kb = [math]::Round($_.Length / 1KB) }
})

$saude | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $pasta '06_saude.json') -Encoding UTF8

# =====================================================================
# 6. Copia bruta dos logs (.evtx)
# =====================================================================
Log 'Exportando logs brutos (.evtx)'
foreach ($l in 'System','Security','Setup','Microsoft-Windows-Kernel-PnP/Configuration') {
  $arq = Join-Path $evtx (($l -replace '[\\/]','_') + '.evtx')
  wevtutil epl $l $arq 2>&1 | Out-Null
  if (-not (Test-Path $arq)) { Log "AVISO: nao foi possivel exportar o log $l" }
}

# =====================================================================
# 7. Resumo legivel
# =====================================================================
Log 'Gerando resumo'
$r = New-Object System.Collections.Generic.List[string]
$r.Add("RESUMO - $env:COMPUTERNAME - coleta em $($inicio.ToString('yyyy-MM-dd HH:mm:ss')) ($((Get-TimeZone).Id))")
$r.Add("Patrimonio: $patrimonio   Serial BIOS: $($bios.SerialNumber)   Intrusao no chassis: $breach")
$r.Add($(if ($Dias -eq 0) { "Periodo dos eventos: todo o historico disponivel nos logs" } else { "Periodo dos eventos: $($desde.ToString('yyyy-MM-dd')) ate hoje" }))
$r.Add('')
$r.Add('=== DISPOSITIVOS NAO PRESENTES (possivelmente removidos) ===')
if ($removidos) { $r.Add((Tabela ($removidos | Select-Object Classe, Nome, PrimeiraInstalacao, UltimaChegada, UltimaRemocao))) }
else { $r.Add('Nenhum.') }
$r.Add('')
$r.Add('=== PLACAS DE VIDEO (todas) ===')
$r.Add((Tabela ($lista | Where-Object Classe -eq 'Display' | Select-Object Nome, Presente, PrimeiraInstalacao, UltimaChegada, UltimaRemocao)))
$r.Add('')
$r.Add('=== EVENTOS KERNEL-PNP DE DISPOSITIVOS PCI ===')
$pnpPci = $pnp | Where-Object { $_.Dispositivo -like 'PCI\*' }
if ($pnpPci) { $r.Add((Tabela $pnpPci)) } else { $r.Add('Nenhum no periodo (ou log ja sobrescrito).') }
$r.Add('')
$r.Add('=== BOOTS E DESLIGAMENTOS ===')
if ($boot) { $r.Add((Tabela $boot)) } else { $r.Add('Nenhum no periodo.') }
$r.Add('')
$r.Add('=== ULTIMOS 40 LOGONS ===')
if ($logons) { $r.Add((Tabela ($logons | Select-Object -Last 40))) } else { $r.Add('Nenhum (auditoria desativada ou log sobrescrito).') }
$r.Add('')
$r.Add('=== SAUDE DO EQUIPAMENTO ===')
if ($saude.cpu) { $r.Add("CPU: $($saude.cpu.nome)") }
if ($saude.memoria) { $r.Add("Memoria: $($saude.memoria.totalGB) GB ($(@($saude.memoria.modulos).Count) modulo(s))") }
foreach ($d in @($saude.discos)) { $r.Add("Disco: $($d.nome) - $($d.tipo) $($d.gb) GB - saude: $($d.saude) - temp: $($d.temperatura) C - desgaste: $($d.desgastePct)% - horas: $($d.horasLigado)") }
foreach ($v in @($saude.volumes)) { $r.Add("Volume $($v.letra) $($v.livreGB) GB livres de $($v.totalGB) GB ($($v.livrePct)%)") }
$r.Add("Telas azuis: $($ev.telaAzul.total)  Desligamentos inesperados: $($ev.desligamentoInesperado.total)  Erros de disco: $($ev.erroDisco.total)  Erros de hardware (WHEA): $($ev.erroHardware.total)  Falhas do driver de video: $($ev.driverVideo.total)")
$r.Add('')
$r.Add('Como ler: a peca saiu entre a UltimaChegada dela e o primeiro boot seguinte.')
$r.Add('Compare a hora deste PC com a do DVR das cameras antes de buscar a gravacao.')
$r | Set-Content (Join-Path $pasta '00_RESUMO.txt') -Encoding UTF8

# =====================================================================
# 8. Hashes e empacotamento
# =====================================================================
Log 'Calculando hashes e compactando'
# Lista os arquivos ANTES de criar o CSV de hashes, para ele nao tentar hashear a si mesmo
$hashCsv = Join-Path $pasta 'hashes_sha256.csv'
$arquivos = @(Get-ChildItem $pasta -Recurse -File | Where-Object { $_.FullName -ne $hashCsv })
$hashes = foreach ($f in $arquivos) {
  $h = Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256
  [pscustomobject]@{ Arquivo = $f.FullName.Substring($pasta.Length + 1); Hash = $h.Hash }
}
$hashes | Export-Csv $hashCsv -NoTypeInformation -Encoding UTF8

$zip = "$pasta.zip"
Compress-Archive -Path (Join-Path $pasta '*') -DestinationPath $zip -Force
$zipHash = (Get-FileHash $zip -Algorithm SHA256).Hash
"SHA256  $zipHash  $(Split-Path $zip -Leaf)" | Set-Content "$zip.sha256.txt"

Write-Host ''
Write-Host 'Coleta concluida.' -ForegroundColor Green
Write-Host "Pasta : $pasta"
Write-Host "Zip   : $zip"
Write-Host "SHA256: $zipHash" -ForegroundColor Yellow
Write-Host 'Anote o SHA256 do zip no laudo/memorando.'

if ($Enviar) {
  Write-Host ''
  if (-not (Send-Coleta $zip)) {
    Write-Host 'A coleta foi salva localmente, mas NAO foi enviada. Reenvie depois.' -ForegroundColor Yellow
    exit 2
  }
}
exit 0

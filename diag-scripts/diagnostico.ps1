<#
  diagnostico.ps1
  Diagnostico de manutencao do computador: hardware, discos, memoria, telas
  azuis, erros, drivers, rede, sistema e desempenho. Gera um .zip com hashes
  SHA256 e (opcional) envia ao servidor do diag-viewer, onde a coleta pode
  ser vinculada a um laudo de manutencao.

  Uso (PowerShell como Administrador):
    powershell -ExecutionPolicy Bypass -File .\diagnostico.ps1
    powershell -ExecutionPolicy Bypass -File .\diagnostico.ps1 -Dias 90 -Enviar

  Parametros:
    -Dias     Dias de eventos analisados (padrao 30; 0 = todo o historico)
    -Destino  Pasta onde salvar (padrao: Area de Trabalho)
    -Enviar   Envia o .zip ao servidor (diag-servidor.cfg)
    -EnviarArquivo <zip>  So reenvia um .zip ja existente e sai
    -Servidor / -Token    Sobrescrevem o diag-servidor.cfg
    -Patrimonio <num>     Quando o nome do PC nao segue o padrao PC+patrimonio
    -SemRede              Nao faz os testes de conectividade (ping/DNS)

  Testes profundos (opcionais, -Testes separados por virgula):
    sistema       DISM /ScanHealth + SFC /VERIFYONLY (10 a 40 min)
    disco         chkdsk somente leitura em cada unidade NTFS: so analisa e relata
    disco-corrigir  analisa e, onde houver erro, corrige sozinho (chkdsk /scan,
                  correcao online). ALTERA o sistema de arquivos da unidade.
    superficie    leitura completa do disco do sistema (-SuperficieTodos = todos)
    desempenho    WinSAT formal (notas de CPU, memoria, disco, video)
    benchmark     pontuacao propria: CPU (1 thread e todas), copia de memoria,
                  disco (escrita/leitura sequencial e leitura aleatoria 4K)
    memoria       grava e confere padroes na RAM livre por -Minutos
    estresse      CPU a 100% por -Minutos com conferencia de calculo,
                  frequencia, temperatura e limitacao termica
    rede          ping continuo no gateway e na internet por -Minutos + tracert
    antivirus     verificacao rapida do Defender (antivirus-completo = completa)
    energia       powercfg /energy (60 s)
    logs          copia dos logs do Windows (.evtx)
    -Minutos <n>  duracao de memoria/estresse/rede (padrao 10)
    -TempLimite <C>  interrompe o estresse se o processador passar disso (padrao 100)
  Exemplo: .\diagnostico.ps1 -Enviar -Testes sistema,disco,estresse,memoria -Minutos 15

  Perfis prontos (-Perfil), do mais basico ao mais completo:
    rapido    so o diagnostico (1 a 3 min)
    basico    benchmark, estresse, memoria e chkdsk, 3 min cada (~12 min)
    padrao    integridade, chkdsk, benchmark, WinSAT, memoria, estresse, rede,
              antivirus rapido e energia, 10 min cada (~1 h 15)
    completo  padrao + superficie do disco do sistema + logs, 20 min cada
    burnin    completo com todos os discos, antivirus completo e 60 min cada
  -Testes e -Minutos, se informados, valem mais que o perfil.

  Sensores: durante os testes, temperaturas, tensoes da fonte, ventoinhas e
  potencia sao gravados a cada 5 s em 10_sensores.csv. Tensoes e ventoinhas
  dependem do LibreHardwareMonitorLib.dll na pasta "sensores" ao lado do
  script (veja baixar-sensores.ps1). Sem ele, so o que o Windows informa:
  zona termica ACPI, temperatura dos discos, GPU NVIDIA (nvidia-smi), bateria.

  So le o sistema. O benchmark grava um arquivo temporario (ate 1 GB) e apaga.
#>
param(
  [ValidateRange(0, 36500)][int]$Dias = 30,
  [string]$Destino = [Environment]::GetFolderPath('Desktop'),
  [switch]$Enviar,
  [string]$EnviarArquivo,
  [string]$Servidor,
  [string]$Token,
  [string]$Patrimonio,
  [switch]$SemRede,
  [string[]]$Testes,
  [ValidateRange(1, 600)][int]$Minutos = 10,
  [ValidateSet('rapido', 'basico', 'padrao', 'completo', 'burnin')][string]$Perfil,
  [ValidateRange(60, 130)][int]$TempLimite = 100,
  [switch]$SuperficieTodos,
  [switch]$EscolherPasta,
  [switch]$ListarRemoviveis
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------- perfis de teste
$perfis = @{
  basico   = @('benchmark,estresse,memoria,disco', 3)
  padrao   = @('sistema,disco,benchmark,desempenho,memoria,estresse,rede,antivirus,energia', 10)
  completo = @('sistema,disco,benchmark,desempenho,memoria,estresse,rede,antivirus,energia,superficie,logs', 20)
  burnin   = @('sistema,disco,benchmark,desempenho,memoria,estresse,rede,antivirus-completo,energia,superficie,logs', 60)
}
if ($Perfil -and $perfis[$Perfil]) {
  if (-not $Testes) { $Testes = $perfis[$Perfil][0] }
  if (-not $PSBoundParameters.ContainsKey('Minutos')) { $Minutos = $perfis[$Perfil][1] }
  if ($Perfil -eq 'burnin') { $SuperficieTodos = $true }
}

# ---------------------------------------------------------------- ajudantes do menu
if ($EscolherPasta) {
  Add-Type -AssemblyName System.Windows.Forms
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = 'Escolha a pasta onde o diagnostico sera salvo'
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

# ---------------------------------------------------------------- patrimonio
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

# ---------------------------------------------------------------- envio
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
    'X-Tipo'       = 'diagnostico'
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
  if ($r.sha256 -ne $hash) { Write-Host 'FALHA: o servidor recebeu um arquivo com hash diferente.' -ForegroundColor Red; return $false }
  $situacao = if ($r.duplicado) { 'JA EXISTIA no servidor' } else { 'RECEBIDO' }
  Write-Host "Envio OK - $situacao" -ForegroundColor Green
  Write-Host "  Id no servidor : $($r.id)"
  @(
    "ENVIADO  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    "Servidor : $($cfg.Servidor)"
    "Id       : $($r.id)"
    "Situacao : $situacao"
    "SHA256   : $($r.sha256)"
  ) | Add-Content "$zipPath.envio.txt"
  return $true
}

if ($EnviarArquivo) { if (Send-Coleta $EnviarArquivo) { exit 0 } else { exit 2 } }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Warning 'Execute o PowerShell como Administrador.'; exit 1 }

$inicio = Get-Date
$stamp  = $inicio.ToString('yyyyMMdd_HHmmss')
$pasta  = Join-Path $Destino ("diagnostico_{0}_{1}" -f $env:COMPUTERNAME, $stamp)
New-Item -ItemType Directory -Path $pasta -Force | Out-Null
$desde  = if ($Dias -eq 0) { [datetime]'1990-01-01' } else { $inicio.AddDays(-$Dias) }
$periodoTxt = if ($Dias -eq 0) { 'todo o historico' } else { "ultimos $Dias dias" }

function Log([string]$msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  Add-Content -Path (Join-Path $pasta 'coleta.log') -Value $line
}
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

Log "Inicio do diagnostico em $env:COMPUTERNAME ($periodoTxt)"

# ================================================================ 1. maquina
Log 'Identificacao do equipamento'
$cs   = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$os   = Get-CimInstance Win32_OperatingSystem
$base = Get-CimInstance Win32_BaseBoard -ErrorAction SilentlyContinue | Select-Object -First 1
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
  'Placa-mae'           = "$($base.Manufacturer) $($base.Product)".Trim()
  'Sistema'             = "$($os.Caption) $($os.Version)"
  'Instalacao do SO'    = $os.InstallDate
  'Ultimo boot'         = $os.LastBootUpTime
  'Intrusao no chassis' = $breach
  'Dominio'             = $(if ($cs.PartOfDomain) { $cs.Domain } else { "grupo de trabalho $($cs.Domain)" })
  'Tipo de coleta'      = 'Diagnostico de manutencao'
}
$maqTxt = Join-Path $pasta '01_maquina.txt'
$info.GetEnumerator() | ForEach-Object { '{0,-20}: {1}' -f $_.Key, $_.Value } | Set-Content $maqTxt
Add-Content $maqTxt "`r`n--- Sincronizacao de horario (w32tm) ---"
(w32tm /query /status 2>&1) | Out-String | Add-Content $maqTxt

$saude = [ordered]@{ versao = 2; tipo = 'diagnostico'; geradoEm = Fmt-Data (Get-Date); periodoDias = $Dias }
if ($Perfil) { $saude.perfil = $Perfil }

# ================================================================ 1b. sensores
# Amostra temperaturas, tensoes, ventoinhas e potencia. Roda uma vez no
# diagnostico rapido e em segundo plano (a cada $intervaloSensor s) durante os
# testes profundos, marcando em cada linha qual teste estava rodando.
$intervaloSensor = 5
$sensorCsv = Join-Path $pasta '10_sensores.csv'
$sensorDll = @((Join-Path $PSScriptRoot 'sensores\LibreHardwareMonitorLib.dll'), (Join-Path $PSScriptRoot 'LibreHardwareMonitorLib.dll')) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
# arquivos extraidos de um .zip baixado vem "bloqueados" e o .NET se recusa a carregar
if ($sensorDll) { Get-ChildItem (Split-Path $sensorDll) -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue }
$mon = [hashtable]::Synchronized(@{ parar = $false; fase = 'ocioso'; fonte = ''; erro = $null; amostras = 0; cpuTemp = $null })
$sensorLoop = {
  param($sync, $csv, $dll, $intervalo, $uma)
  $inv = [Globalization.CultureInfo]::InvariantCulture
  $lhm = $null
  if ($dll) {
    try {
      Add-Type -Path $dll -ErrorAction Stop
      $lhm = New-Object LibreHardwareMonitor.Hardware.Computer
      # nem toda versao tem todas as propriedades
      foreach ($p in 'IsCpuEnabled', 'IsGpuEnabled', 'IsMotherboardEnabled', 'IsMemoryEnabled', 'IsStorageEnabled', 'IsControllerEnabled', 'IsPsuEnabled', 'IsBatteryEnabled') { try { $lhm.$p = $true } catch { } }
      $lhm.Open()
      $sync.fonte = 'LibreHardwareMonitor ' + (([Diagnostics.FileVersionInfo]::GetVersionInfo($dll).ProductVersion) -split '\+')[0]
    } catch { $sync.erro = "LibreHardwareMonitor nao carregou: $($_.Exception.Message)"; $lhm = $null }
  }
  if (-not $lhm) { $sync.fonte = 'Windows (ACPI, discos, nvidia-smi, bateria)' }
  $tipos = @{ Temperature = 'temperatura'; Voltage = 'tensao'; Fan = 'ventoinha'; Power = 'potencia'; Current = 'corrente'; Control = 'controle'; Load = 'carga' }
  $nvsmi = (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue).Source
  $num = { param($x) $d = 0.0; if ([double]::TryParse("$x".Trim(), [Globalization.NumberStyles]::Float, $inv, [ref]$d)) { $d } }
  $discoTemps = @()
  $w = New-Object IO.StreamWriter($csv, $false, (New-Object Text.UTF8Encoding($true)))
  $w.WriteLine('hora;fase;hw;hwTipo;tipo;nome;valor')
  $n = 0
  try {
    do {
      $lista = New-Object System.Collections.Generic.List[object]
      $add = { param($hw, $hwTipo, $tipo, $nome, $valor) if ($null -ne $valor) { $lista.Add(@("$hw", "$hwTipo", $tipo, "$nome", [double]$valor)) } }
      if ($lhm) {
        $pilha = New-Object System.Collections.Stack
        foreach ($h in $lhm.Hardware) { $pilha.Push($h) }
        while ($pilha.Count) {
          $h = $pilha.Pop()
          try { $h.Update() } catch { }
          foreach ($sh in $h.SubHardware) { $pilha.Push($sh) }
          foreach ($s in $h.Sensors) {
            $t = $tipos["$($s.SensorType)"]
            if (-not $t -or $null -eq $s.Value) { continue }
            if ($t -eq 'carga' -and $s.Name -notmatch 'Total|GPU Core') { continue }
            # sem acesso ao driver (nao administrador / sem PawnIO) o processador devolve 0
            if ($t -eq 'temperatura' -and ($s.Value -le 0 -or $s.Value -gt 150)) { continue }
            # limites de alarme do NVMe (Warning/Critical Temperature) nao sao leituras
            if ($t -eq 'temperatura' -and $s.Name -match 'Warning|Critical') { continue }
            if ($t -in 'potencia', 'tensao' -and $s.Value -le 0) { continue }
            & $add $h.Name $h.HardwareType $t $s.Name $s.Value
          }
        }
      }
      # zona termica ACPI: sempre, e a unica temperatura quando o LibreHardwareMonitor nao le o processador
      $i = 0
      foreach ($z in @(Get-CimInstance -Namespace root\wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue)) {
        $i++; $c = [math]::Round($z.CurrentTemperature / 10 - 273.15, 1)
        # abaixo de 20 C e valor falso da BIOS (comum em desktops AMD: 16.9 C fixos)
        if ($c -ge 20 -and $c -lt 130) { & $add 'Placa-mae (ACPI)' 'Acpi' 'temperatura' "Zona termica $i" $c }
      }
      if (-not $lhm) {
        if ($nvsmi) {
          foreach ($l in @(& $nvsmi --query-gpu=name,temperature.gpu,fan.speed,power.draw,utilization.gpu --format=csv,noheader,nounits 2>$null)) {
            $c = @("$l" -split '\s*,\s*'); if ($c.Count -lt 5) { continue }
            & $add $c[0] 'GpuNvidia' 'temperatura' 'GPU Core' (& $num $c[1])
            & $add $c[0] 'GpuNvidia' 'controle' 'Ventoinha' (& $num $c[2])
            & $add $c[0] 'GpuNvidia' 'potencia' 'GPU Power' (& $num $c[3])
            & $add $c[0] 'GpuNvidia' 'carga' 'GPU Core' (& $num $c[4])
          }
        }
        # a consulta aos discos e lenta: so a cada 6 amostras
        if ($n % 6 -eq 0) {
          $discoTemps = @(Get-PhysicalDisk -ErrorAction SilentlyContinue | ForEach-Object {
            $rc = $null; try { $rc = $_ | Get-StorageReliabilityCounter -ErrorAction Stop } catch { }
            if ($rc -and $rc.Temperature) { , @($_.FriendlyName, [double]$rc.Temperature) }
          })
        }
        foreach ($d in $discoTemps) { & $add $d[0] 'Storage' 'temperatura' 'Temperatura' $d[1] }
        foreach ($b in @(Get-CimInstance -Namespace root\wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue)) {
          if ($b.Voltage) { & $add 'Bateria' 'Battery' 'tensao' 'Tensao' ($b.Voltage / 1000) }
        }
      }
      $pi = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'" -ErrorAction SilentlyContinue
      if ($pi) {
        & $add 'Processador (Windows)' 'Windows' 'carga' 'Uso' $pi.PercentProcessorTime
        & $add 'Processador (Windows)' 'Windows' 'carga' 'Desempenho' $pi.PercentProcessorPerformance
        & $add 'Processador (Windows)' 'Windows' 'frequencia' 'Frequencia' $pi.ProcessorFrequency
      }
      $ct = @($lista | Where-Object { $_[2] -eq 'temperatura' -and $_[1] -eq 'Cpu' } | ForEach-Object { $_[4] })
      if (-not $ct) { $ct = @($lista | Where-Object { $_[2] -eq 'temperatura' -and $_[1] -eq 'Acpi' } | ForEach-Object { $_[4] }) }
      $sync.cpuTemp = if ($ct) { ($ct | Measure-Object -Maximum).Maximum } else { $null }
      $hora = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); $fase = $sync.fase
      foreach ($x in $lista) {
        $w.WriteLine(($hora, $fase, ($x[0] -replace ';', ','), $x[1], $x[2], ($x[3] -replace ';', ','), $x[4].ToString('0.###', $inv)) -join ';')
      }
      $w.Flush(); $n++; $sync.amostras = $n
      if ($uma) { break }
      $ate = (Get-Date).AddSeconds($intervalo)
      while (-not $sync.parar -and (Get-Date) -lt $ate) { Start-Sleep -Milliseconds 250 }
    } while (-not $sync.parar)
  } finally {
    $w.Dispose()
    if ($lhm) { try { $lhm.Close() } catch { } }
  }
}
function Resumo-Sensores {
  if (-not (Test-Path -LiteralPath $sensorCsv)) { return $null }
  $inv = [Globalization.CultureInfo]::InvariantCulture
  $uni = @{ temperatura = 'C'; tensao = 'V'; ventoinha = 'RPM'; potencia = 'W'; corrente = 'A'; controle = '%'; carga = '%'; frequencia = 'MHz' }
  $linhas = @(Import-Csv -LiteralPath $sensorCsv -Delimiter ';')
  $semPlaca = -not @($linhas | Where-Object { $_.hwTipo -notmatch '^(Cpu|Gpu|Windows|Acpi|Storage|Battery)' -and $_.tipo -in 'tensao', 'ventoinha' })
  $semCpu = -not @($linhas | Where-Object { $_.hwTipo -eq 'Cpu' -and $_.tipo -eq 'temperatura' })
  if ($sensorDll -and -not $mon.erro -and ($semPlaca -or $semCpu)) {
    $falta = (@($(if ($semCpu) { 'a temperatura do processador' }), $(if ($semPlaca) { 'as tensoes da fonte e as ventoinhas' })) | Where-Object { $_ }) -join ', '
    $pawn = [bool](Get-Service '*PawnIO*' -ErrorAction SilentlyContinue) -or (Test-Path "$env:ProgramFiles\PawnIO")
    $mon.erro = if ($pawn) { "O LibreHardwareMonitor nao leu $falta. O driver PawnIO esta instalado; o chip de sensores desta placa pode nao ser suportado." }
                else { "O LibreHardwareMonitor nao leu ${falta}: o driver PawnIO nao esta instalado neste PC. Instale em https://pawnio.eu e rode o diagnostico de novo." }
  }
  # zona ACPI que nao varia em 1 min ou mais de amostras e valor fixo da BIOS, nao temperatura
  $fixas = @($linhas | Where-Object { $_.hwTipo -eq 'Acpi' } | Group-Object nome | Where-Object { $_.Count -ge 12 -and @($_.Group.valor | Select-Object -Unique).Count -eq 1 } | ForEach-Object { $_.Name })
  if ($fixas) { $linhas = @($linhas | Where-Object { -not ($_.hwTipo -eq 'Acpi' -and $_.nome -in $fixas) }) }
  [ordered]@{
    fonte = $mon.fonte; aviso = $mon.erro; intervaloSeg = $intervaloSensor; amostras = $mon.amostras; arquivo = '10_sensores.csv'
    itens = @($linhas | Group-Object hw, tipo, nome | ForEach-Object {
      $g = @($_.Group); $v = @($g | ForEach-Object { [double]::Parse($_.valor, $inv) })
      $m = $v | Measure-Object -Minimum -Maximum -Average
      $pico = 0; for ($i = 1; $i -lt $v.Count; $i++) { if ($v[$i] -gt $v[$pico]) { $pico = $i } }
      [ordered]@{ hw = $g[0].hw; hwTipo = $g[0].hwTipo; tipo = $g[0].tipo; nome = $g[0].nome; unidade = $uni[$g[0].tipo]
        inicial = $v[0]; min = $m.Minimum; media = [math]::Round($m.Average, 2); max = $m.Maximum; faseMax = $g[$pico].fase }
    })
  }
}
# tensao nominal de uma linha da fonte pelo nome do sensor (+12V, +5V, +3.3V); standby fica de fora
function Tensao-Nominal([string]$n) {
  if ($n -match 'SB|standby') { return $null }
  # "(?![a-z])": "Core #5 VID" nao e a linha de 5 V
  if ($n -match '(^|[^\d.#])12\s*V(?![a-z])') { 12 } elseif ($n -match '3[.,]3\s*V(?![a-z])|3V3') { 3.3 } elseif ($n -match '(^|[^\d.#])5\s*V(?![a-z])') { 5 }
}

# ================================================================ 2. hardware
Log 'Processador, memoria e video'
try {
  $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
  $cargas = @(1..3 | ForEach-Object { (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average; Start-Sleep -Milliseconds 700 })
  $saude.cpu = [ordered]@{
    nome = ($cpu.Name -replace '\s+', ' ').Trim(); nucleos = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors
    cargaPct = [math]::Round(($cargas | Measure-Object -Average).Average)
    clockMaxMHz = $cpu.MaxClockSpeed; clockAtualMHz = $cpu.CurrentClockSpeed
  }
} catch { }

try {
  $saude.memoria = [ordered]@{
    totalGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
    livreGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
    usoPct  = [math]::Round(100 - 100 * $os.FreePhysicalMemory / $os.TotalVisibleMemorySize)
    slotsTotal = (Get-CimInstance Win32_PhysicalMemoryArray -ErrorAction SilentlyContinue | Measure-Object MemoryDevices -Sum).Sum
    modulos = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
      [ordered]@{ slot = $_.DeviceLocator; gb = [math]::Round($_.Capacity / 1GB, 1); mhz = $(if ($_.ConfiguredClockSpeed) { $_.ConfiguredClockSpeed } else { $_.Speed }); fabricante = "$($_.Manufacturer)".Trim(); modelo = "$($_.PartNumber)".Trim() }
    })
  }
} catch { }

try {
  $saude.video = @(Get-CimInstance Win32_VideoController | ForEach-Object {
    [ordered]@{
      nome = $_.Name; status = $_.Status; driverVersao = $_.DriverVersion; driverData = Fmt-Data $_.DriverDate
      resolucao = $(if ($_.CurrentHorizontalResolution) { "$($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution)" })
      codigoErro = $_.ConfigManagerErrorCode
    }
  })
} catch { $saude.video = @() }

try {
  $saude.monitores = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction Stop | ForEach-Object {
    $dec = { param($a) if ($a) { (-join ($a | Where-Object { $_ } | ForEach-Object { [char]$_ })).Trim() } }
    [ordered]@{ fabricante = & $dec $_.ManufacturerName; modelo = & $dec $_.UserFriendlyName; serial = & $dec $_.SerialNumberID }
  })
} catch { $saude.monitores = @() }

try {
  $tz = @(Get-CimInstance -Namespace root\wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop |
    ForEach-Object { [math]::Round($_.CurrentTemperature / 10 - 273.15, 1) } | Where-Object { $_ -ge 20 -and $_ -lt 130 })
  if ($tz) { $saude.temperaturaCpu = ($tz | Measure-Object -Maximum).Maximum }
} catch { }

# ================================================================ 3. armazenamento
Log 'Discos e unidades'
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
    $sujo = $null
    try { $fs = (fsutil dirty query "$($_.DriveLetter):" 2>&1) -join ' '; if ($fs -match 'NOT Dirty|n.o est. sujo') { $sujo = $false } elseif ($fs -match 'Dirty|sujo') { $sujo = $true } } catch { }
    [ordered]@{ letra = "$($_.DriveLetter):"; rotulo = $_.FileSystemLabel; sistemaArquivos = $_.FileSystem; totalGB = [math]::Round($_.Size / 1GB, 1); livreGB = [math]::Round($_.SizeRemaining / 1GB, 1); livrePct = [math]::Round(100 * $_.SizeRemaining / $_.Size, 1); saude = "$($_.HealthStatus)"; verificacaoPendente = $sujo }
  })
} catch { $saude.volumes = @() }

# ================================================================ 4. sistema
Log 'Sistema, atualizacoes, ativacao e protecao'
try {
  $hf = Get-HotFix -ErrorAction Stop | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 1
  $pend = @(
    (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'),
    (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
  ) -contains $true
  $plano = (powercfg /getactivescheme 2>$null) -replace '^.*\((.+)\)\s*\*?\s*$', '$1'
  $saude.sistema = [ordered]@{
    nome = $os.Caption; versao = $os.Version; arquitetura = $os.OSArchitecture
    build = $(try { (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop).DisplayVersion } catch { $null })
    ultimoBoot = Fmt-Data $os.LastBootUpTime
    horasLigado = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
    ultimaAtualizacao = $(if ($hf) { Fmt-Data $hf.InstalledOn }); ultimaAtualizacaoId = $(if ($hf) { $hf.HotFixID })
    inicializacaoRapida = $(try { [int](Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -ErrorAction Stop).HiberbootEnabled } catch { $null })
    reinicioPendente = $pend
    planoEnergia = "$plano".Trim()
  }
} catch { }

try {
  $lic = Get-CimInstance SoftwareLicensingProduct -Filter "ApplicationID='55c92734-d682-4d71-983e-d6ec3f16059f' AND PartialProductKey IS NOT NULL" -ErrorAction Stop | Select-Object -First 1
  $licMap = @{ 0='Nao licenciado'; 1='Ativado'; 2='Periodo de carencia'; 3='Carencia adicional'; 4='Carencia nao original'; 5='Notificacao'; 6='Carencia estendida' }
  if ($lic) { $saude.ativacao = [ordered]@{ ativado = ($lic.LicenseStatus -eq 1); status = $licMap[[int]$lic.LicenseStatus]; canal = $lic.ProductKeyChannel } }
} catch { }

try {
  $mp = Get-MpComputerStatus -ErrorAction Stop
  $saude.antivirus = [ordered]@{ produto = 'Microsoft Defender'; ativo = [bool]$mp.AntivirusEnabled; tempoReal = [bool]$mp.RealTimeProtectionEnabled; assinatura = Fmt-Data $mp.AntivirusSignatureLastUpdated; ultimaVerificacao = Fmt-Data $mp.QuickScanEndTime }
  try {
    $saude.antivirus.ameacas = @(Get-MpThreatDetection -ErrorAction Stop | Where-Object { $_.InitialDetectionTime -ge $desde } | Sort-Object InitialDetectionTime -Descending | Select-Object -First 10 | ForEach-Object {
      [ordered]@{ data = Fmt-Data $_.InitialDetectionTime; recurso = (@($_.Resources) | Select-Object -First 1); acaoOk = [bool]$_.ActionSuccess }
    })
  } catch { }
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
    powercfg /batteryreport /output (Join-Path $pasta 'bateria.html') 2>&1 | Out-Null
  }
} catch { }

# ================================================================ 5. dispositivos, drivers, servicos
Log 'Dispositivos com problema, servicos e impressoras'
$cmErro = @{ 1='Nao configurado corretamente'; 3='Driver corrompido ou falta de memoria'; 10='Nao pode ser iniciado'; 12='Recursos insuficientes'; 14='Requer reinicio'; 18='Reinstalar drivers'; 19='Registro corrompido'; 21='Sendo removido'; 22='Desativado'; 24='Ausente ou nao funcionando'; 28='Driver nao instalado'; 29='Desativado pelo firmware'; 31='Nao funciona corretamente'; 32='Servico do driver desativado'; 37='Falha ao inicializar o driver'; 39='Driver ausente ou corrompido'; 43='Parou e informou problema'; 45='Nao conectado'; 47='Preparado para remocao'; 48='Driver bloqueado'; 52='Assinatura do driver nao verificada' }
try {
  $saude.dispositivosProblema = @(Get-CimInstance Win32_PnPEntity -ErrorAction Stop | Where-Object { $_.ConfigManagerErrorCode -and $_.ConfigManagerErrorCode -notin 22, 45 } | ForEach-Object {
    [ordered]@{ nome = $(if ($_.Name) { $_.Name } else { $_.DeviceID }); classe = $_.PNPClass; codigo = [int]$_.ConfigManagerErrorCode; descricao = $cmErro[[int]$_.ConfigManagerErrorCode]; id = $_.DeviceID }
  })
} catch { $saude.dispositivosProblema = @() }

$servImportantes = [ordered]@{ Dhcp='Cliente DHCP'; Dnscache='Cliente DNS'; LanmanWorkstation='Estacao de trabalho (compartilhamentos)'; Spooler='Spooler de impressao'; W32Time='Horario do Windows'; WinDefend='Microsoft Defender'; wuauserv='Windows Update'; EventLog='Log de eventos'; Netlogon='Netlogon (dominio)'; AudioSrv='Audio do Windows' }
try {
  $saude.servicos = @(foreach ($k in $servImportantes.Keys) {
    $s = Get-CimInstance Win32_Service -Filter "Name='$k'" -ErrorAction SilentlyContinue
    if ($s) { [ordered]@{ nome = $k; descricao = $servImportantes[$k]; estado = $s.State; inicio = $s.StartMode } }
  })
} catch { $saude.servicos = @() }

try {
  $saude.impressoras = @(Get-CimInstance Win32_Printer -ErrorAction Stop | Where-Object { $_.Name -notmatch 'PDF|XPS|OneNote|Fax' } | ForEach-Object {
    [ordered]@{ nome = $_.Name; driver = $_.DriverName; porta = $_.PortName; padrao = [bool]$_.Default; status = $(if ($_.WorkOffline) { 'Offline' } elseif ($_.PrinterStatus -in 1, 2) { 'Desconhecido' } elseif ($_.PrinterStatus -eq 3) { 'Pronta' } else { "Codigo $($_.PrinterStatus)" }) }
  })
} catch { $saude.impressoras = @() }

try {
  $saude.inicializacao = @(Get-CimInstance Win32_StartupCommand -ErrorAction Stop | ForEach-Object {
    [ordered]@{ nome = $_.Name; comando = $_.Command; local = $_.Location; usuario = $_.User }
  })
} catch { $saude.inicializacao = @() }

# ================================================================ 6. desempenho
Log 'Processos que mais usam memoria e CPU'
try {
  $procs = Get-Process -ErrorAction SilentlyContinue
  $saude.processos = [ordered]@{
    total = @($procs).Count
    memoria = @($procs | Sort-Object WorkingSet64 -Descending | Select-Object -First 8 | ForEach-Object { [ordered]@{ nome = $_.ProcessName; mb = [math]::Round($_.WorkingSet64 / 1MB) } })
    cpu = @($procs | Where-Object { $_.CPU } | Sort-Object CPU -Descending | Select-Object -First 8 | ForEach-Object { [ordered]@{ nome = $_.ProcessName; segundosCpu = [math]::Round($_.CPU) } })
  }
} catch { }

# ================================================================ 7. rede
Log 'Rede e conectividade'
try {
  $saude.rede = @(Get-NetAdapter -Physical -ErrorAction Stop | ForEach-Object {
    $cfgIp = Get-NetIPConfiguration -InterfaceIndex $_.ifIndex -ErrorAction SilentlyContinue
    [ordered]@{
      nome = $_.Name; descricao = $_.InterfaceDescription; status = "$($_.Status)"; velocidade = $_.LinkSpeed; mac = $_.MacAddress
      ip = (@($cfgIp.IPv4Address.IPAddress) -join ', '); gateway = (@($cfgIp.IPv4DefaultGateway.NextHop) -join ', ')
      dns = (@($cfgIp.DNSServer | Where-Object AddressFamily -eq 2 | ForEach-Object { $_.ServerAddresses }) -join ', ')
      dhcp = $(try { "$((Get-NetIPInterface -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction Stop).Dhcp)" } catch { $null })
    }
  })
} catch { $saude.rede = @() }

if (-not $SemRede) {
  $conexoes = @()
  $gw = @($saude.rede | Where-Object { $_.gateway } | ForEach-Object { ($_.gateway -split ',\s*')[0] }) | Select-Object -First 1
  function Testa-Ping([string]$nome, [string]$alvo) {
    if (-not $alvo) { return }
    $ok = $false; $ms = $null
    try {
      $p = New-Object System.Net.NetworkInformation.Ping
      $res = @(1..3 | ForEach-Object { try { $p.Send($alvo, 1500) } catch { $null } }) | Where-Object { $_ -and $_.Status -eq 'Success' }
      if ($res) { $ok = $true; $ms = [math]::Round(($res | Measure-Object RoundtripTime -Average).Average) }
    } catch { }
    [ordered]@{ teste = $nome; alvo = $alvo; ok = $ok; ms = $ms }
  }
  $conexoes += Testa-Ping 'Gateway' $gw
  if ($cs.PartOfDomain) {
    $dc = $null
    try { $dc = ((nltest /dsgetdc:$($cs.Domain) 2>$null) | Select-String 'DC: \\\\(.+)$').Matches[0].Groups[1].Value.Trim() } catch { }
    if ($dc) { $conexoes += Testa-Ping 'Controlador de dominio' $dc }
    $canal = $null
    try { $canal = Test-ComputerSecureChannel -ErrorAction Stop } catch { }
    $conexoes += [ordered]@{ teste = 'Relacao de confianca com o dominio'; alvo = $cs.Domain; ok = [bool]$canal; ms = $null }
  }
  $dnsAlvo = if ($cs.PartOfDomain) { $cs.Domain } else { 'www.google.com' }
  $dnsOk = $false
  try { $dnsOk = [bool](Resolve-DnsName $dnsAlvo -ErrorAction Stop -QuickTimeout | Select-Object -First 1) } catch { }
  $conexoes += [ordered]@{ teste = 'Resolucao DNS'; alvo = $dnsAlvo; ok = $dnsOk; ms = $null }
  $conexoes += Testa-Ping 'Internet' '8.8.8.8'
  $saude.conectividade = @($conexoes | Where-Object { $_ })
}

# ================================================================ 7b. complementos
Log 'SMART detalhado, tempo de inicializacao, confiabilidade e seguranca'
$smartNomes = @{ 1='Taxa de erros de leitura'; 5='Setores realocados'; 9='Horas ligado'; 10='Tentativas de rotacao'; 12='Ciclos liga/desliga'; 177='Nivelamento de desgaste'; 184='Erros ponta a ponta'; 187='Erros incorrigiveis reportados'; 188='Timeouts de comando'; 194='Temperatura'; 196='Eventos de realocacao'; 197='Setores pendentes'; 198='Setores incorrigiveis (offline)'; 199='Erros CRC (cabo/conector)'; 231='Vida util restante (SSD)'; 233='Indicador de desgaste (SSD)'; 241='Total gravado (LBAs)'; 242='Total lido (LBAs)' }
try {
  $saude.smartAtributos = @(Get-CimInstance -Namespace root\wmi -ClassName MSStorageDriver_FailurePredictData -ErrorAction Stop | ForEach-Object {
    $vs = [byte[]]$_.VendorSpecific
    $attrs = @(for ($i = 2; $i + 12 -le $vs.Length; $i += 12) {
      $id = $vs[$i]
      if ($id -eq 0) { continue }
      $raw = [long]0
      for ($b = 5; $b -ge 0; $b--) { $raw = ($raw -shl 8) + $vs[$i + 5 + $b] }
      if ($id -eq 194 -or $id -eq 190) { $raw = $raw -band 0xFF }
      [ordered]@{ id = [int]$id; nome = $(if ($smartNomes[[int]$id]) { $smartNomes[[int]$id] } else { "Atributo $id" }); valor = [int]$vs[$i + 3]; pior = [int]$vs[$i + 4]; bruto = $raw }
    })
    [ordered]@{ instancia = $_.InstanceName; atributos = $attrs }
  })
} catch { $saude.smartAtributos = @() }

try {
  $bootEv = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Diagnostics-Performance/Operational'; Id = 100; StartTime = $desde } -ErrorAction Stop)
  $tempos = @($bootEv | ForEach-Object {
    $d = @{}; ([xml]$_.ToXml()).Event.EventData.Data | ForEach-Object { $d[$_.Name] = $_.'#text' }
    [pscustomobject]@{ hora = $_.TimeCreated; seg = [math]::Round([double]$d['BootTime'] / 1000, 1); posBoot = [math]::Round([double]$d['MainPathBootTime'] / 1000, 1) }
  } | Where-Object { $_.seg -gt 0 })
  $lentos = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Diagnostics-Performance/Operational'; Id = 101, 102, 103, 106, 109; StartTime = $desde } -ErrorAction SilentlyContinue | ForEach-Object {
    $d = @{}; ([xml]$_.ToXml()).Event.EventData.Data | ForEach-Object { $d[$_.Name] = $_.'#text' }
    $n = @($d['FriendlyName'], $d['Name'], $d['File']) | Where-Object { $_ } | Select-Object -First 1
    [pscustomobject]@{ nome = $n; atrasoMs = [double]$d['DegradationTime'] }
  } | Where-Object { $_.nome })
  if ($tempos) {
    $saude.inicializacaoTempo = [ordered]@{
      boots = $tempos.Count
      mediaSeg = [math]::Round(($tempos | Measure-Object seg -Average).Average, 1)
      maxSeg = ($tempos | Measure-Object seg -Maximum).Maximum
      ultimoSeg = ($tempos | Sort-Object hora -Descending | Select-Object -First 1).seg
      atrasos = @($lentos | Group-Object nome | ForEach-Object { [ordered]@{ nome = $_.Name; vezes = $_.Count; mediaAtrasoSeg = [math]::Round(($_.Group | Measure-Object atrasoMs -Average).Average / 1000, 1) } } | Sort-Object { $_.vezes * $_.mediaAtrasoSeg } -Descending | Select-Object -First 8)
    }
  }
} catch { }

try {
  $rel = Get-CimInstance Win32_ReliabilityStabilityMetrics -ErrorAction Stop | Sort-Object TimeGenerated -Descending | Select-Object -First 1
  if ($rel) { $saude.confiabilidade = [ordered]@{ indice = [math]::Round($rel.SystemStabilityIndex, 1); em = Fmt-Data $rel.TimeGenerated } }
} catch { }

$seg = [ordered]@{ firmware = $env:firmware_type }
try { $seg.secureBoot = [bool](Confirm-SecureBootUEFI -ErrorAction Stop) } catch { $seg.secureBoot = $null }
try {
  $t = Get-CimInstance -Namespace root\cimv2\Security\MicrosoftTpm -ClassName Win32_Tpm -ErrorAction Stop | Select-Object -First 1
  $seg.tpm = $(if ($t) { [ordered]@{ presente = $true; ativo = [bool]$t.IsEnabled_InitialValue; versao = ("$($t.SpecVersion)" -split ',')[0].Trim() } } else { [ordered]@{ presente = $false } })
} catch { }
try {
  $seg.bitlocker = @(Get-BitLockerVolume -ErrorAction Stop | ForEach-Object { [ordered]@{ unidade = $_.MountPoint; protecao = "$($_.ProtectionStatus)"; status = "$($_.VolumeStatus)"; criptografadoPct = $_.EncryptionPercentage } })
} catch { }
$saude.seguranca = $seg

try {
  $pf = @(Get-CimInstance Win32_PageFileUsage -ErrorAction Stop)
  if ($pf) { $saude.memoriaVirtual = [ordered]@{ arquivos = @($pf | ForEach-Object { $_.Name }); totalMB = ($pf | Measure-Object AllocatedBaseSize -Sum).Sum; usoMB = ($pf | Measure-Object CurrentUsage -Sum).Sum; picoMB = ($pf | Measure-Object PeakUsage -Sum).Sum } }
} catch { }

try {
  $wl = netsh wlan show interfaces 2>$null
  if ($LASTEXITCODE -eq 0 -and $wl -match 'SSID') {
    $w = @{}
    foreach ($l in $wl) { if ($l -match '^\s*(.+?)\s+:\s(.*)$') { $k = $Matches[1].Trim(); if (-not $w.ContainsKey($k)) { $w[$k] = $Matches[2].Trim() } } }
    $pega = { param($re) foreach ($k in $w.Keys) { if ($k -match $re) { return $w[$k] } } }
    $sinal = & $pega '^(Sinal|Signal)$'
    $saude.wifi = [ordered]@{
      ssid = & $pega '^SSID$'; estado = & $pega '^(Estado|State)$'; sinalPct = $(if ($sinal) { [int]($sinal -replace '\D', '') })
      radio = & $pega '^(Tipo de r.dio|Radio type)$'; canal = & $pega '^(Canal|Channel)$'
      recepcaoMbps = & $pega '^(Taxa de recep..o|Receive rate)'
    }
  }
} catch { }

Log 'Drivers, historico de atualizacoes e testes de memoria anteriores'
try {
  $drv = @(Get-CimInstance Win32_PnPSignedDriver -ErrorAction Stop | Where-Object { $_.DeviceName })
  $drv | Sort-Object DeviceClass, DeviceName | Select-Object @{n='Dispositivo'; e={ $_.DeviceName }}, @{n='Classe'; e={ $_.DeviceClass }}, @{n='Fabricante'; e={ $_.Manufacturer }}, @{n='Versao'; e={ $_.DriverVersion }}, @{n='Data'; e={ Fmt-Data $_.DriverDate }}, @{n='Assinado'; e={ $_.IsSigned }}, @{n='Inf'; e={ $_.InfName }} |
    Export-Csv (Join-Path $pasta '09_drivers.csv') -NoTypeInformation -Encoding UTF8
  $saude.drivers = [ordered]@{
    total = $drv.Count
    naoAssinados = @($drv | Where-Object { $_.IsSigned -eq $false } | ForEach-Object { [ordered]@{ dispositivo = $_.DeviceName; versao = $_.DriverVersion; inf = $_.InfName } })
  }
} catch { }

try {
  $us = New-Object -ComObject Microsoft.Update.Session
  $sr = $us.CreateUpdateSearcher()
  $n = $sr.GetTotalHistoryCount()
  $res = @{ 1 = 'Em andamento'; 2 = 'Sucesso'; 3 = 'Sucesso com erros'; 4 = 'Falhou'; 5 = 'Cancelado' }
  if ($n -gt 0) {
    $hist = @($sr.QueryHistory(0, [math]::Min($n, 60)) | Where-Object { $_.Title } | ForEach-Object {
      [ordered]@{ data = Fmt-Data $_.Date; titulo = $_.Title; resultado = $res[[int]$_.ResultCode]; codigo = $(if ($_.HResult) { '0x{0:X8}' -f $_.HResult }) }
    })
    $saude.atualizacoes = [ordered]@{ total = $n; recentes = @($hist | Select-Object -First 15); falhas = @($hist | Where-Object { $_.resultado -eq 'Falhou' } | Select-Object -First 10) }
  }
} catch { }

try {
  $md = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-MemoryDiagnostics-Results' } -MaxEvents 5 -ErrorAction Stop)
  $saude.testeMemoriaWindows = @($md | ForEach-Object {
    $msg = Primeira-Linha $_.Message
    [ordered]@{ hora = Fmt-Data $_.TimeCreated; id = $_.Id; mensagem = $msg; comErros = [bool]($msg -match 'detect(ou|ed) (erros|errors)|hardware errors|erros de hardware') -and -not ($msg -match 'n.o detectou|no errors|nenhum erro') }
  })
} catch { $saude.testeMemoriaWindows = @() }

# ================================================================ 8. eventos
Log "Eventos criticos ($periodoTxt)"
$ev = [ordered]@{}
$ev.telaAzul = Resumo-Eventos (Busca-Eventos 'System' @('Microsoft-Windows-WER-SystemErrorReporting', 'BugCheck') @(1001))
$ev.desligamentoInesperado = Resumo-Eventos (@(Busca-Eventos 'System' @('Microsoft-Windows-Kernel-Power') @(41)) + @(Busca-Eventos 'System' @('EventLog') @(6008)) | Sort-Object TimeCreated -Descending)
# Ntfs 98 tambem sai como informativo ("volume is healthy"): so aviso, erro e critico contam
$ev.erroDisco = Resumo-Eventos (Busca-Eventos 'System' @('disk', 'Ntfs', 'Microsoft-Windows-Ntfs', 'storahci', 'stornvme', 'iaStorA', 'iaStorAC', 'iaStorAVC') @(7, 11, 51, 55, 98, 129, 153, 157) | Where-Object { $_.Level -in 1, 2, 3 })
$ev.erroHardware = Resumo-Eventos (Busca-Eventos 'System' @('Microsoft-Windows-WHEA-Logger') $null)
$ev.driverVideo = Resumo-Eventos (Busca-Eventos 'System' @('Display') @(4101))
$ev.falhaAtualizacao = Resumo-Eventos (Busca-Eventos 'System' @('Microsoft-Windows-WindowsUpdateClient') @(20))
$ev.travamentoAplicativo = Resumo-Eventos (Busca-Eventos 'Application' @('Application Hang') @(1002))
$ev.servicoFalhou = Resumo-Eventos (Busca-Eventos 'System' @('Service Control Manager') @(7031, 7034))
$ev.limitacaoCpu = Resumo-Eventos (Busca-Eventos 'System' @('Microsoft-Windows-Kernel-Processor-Power') @(37))
$ev.reinicios = Resumo-Eventos (Busca-Eventos 'System' @('EventLog') @(6005)) 3
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

# Todos os erros/criticos do periodo (System e Application), para consulta
$todos = foreach ($l in 'System', 'Application') {
  try { Get-WinEvent -FilterHashtable @{ LogName = $l; Level = 1, 2; StartTime = $desde } -MaxEvents 1500 -ErrorAction Stop } catch { }
}
@($todos | Where-Object { $_ } | Sort-Object TimeCreated -Descending | ForEach-Object {
  [pscustomobject]@{ Hora = $_.TimeCreated; Log = $_.LogName; Nivel = $_.LevelDisplayName; Id = $_.Id; Origem = $_.ProviderName; Mensagem = Primeira-Linha $_.Message }
}) | Export-Csv (Join-Path $pasta '07_eventos_erros.csv') -NoTypeInformation -Encoding UTF8

# ================================================================ 8b. testes profundos (opcionais)
if ($Testes) {
  $Testes = @($Testes | ForEach-Object { $_ -split '[,; ]+' } | Where-Object { $_ } | ForEach-Object { $_.ToLower() })
  $prof = [ordered]@{ inicio = Fmt-Data (Get-Date); minutos = $Minutos; solicitados = $Testes; testes = [ordered]@{} }
  $saude.profundo = $prof
  Log "Testes profundos: $($Testes -join ', ')"
  function Etapa([string]$nome, [string]$fase) { Write-Host ''; Log "== $nome =="; if ($fase) { $mon.fase = $fase } }
  function Duracao($t0) { [math]::Round(((Get-Date) - $t0).TotalMinutes, 1) }
  $csFonte = @'
using System;
using System.IO;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public class DiagLeitura {
  public long Lidos;
  public long Erros;
  public long Lentos;
  public double MinMBs = double.MaxValue;
  public double SomaSeg;
  public string PrimeirosErros = "";
}

public static class DiagNativo {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);

  // Abre o disco fisico SO PARA LEITURA (GENERIC_READ, compartilhado)
  public static FileStream AbrirDisco(int numero) {
    SafeFileHandle h = CreateFile("\\\\.\\PhysicalDrive" + numero, 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h.IsInvalid) throw new IOException("Nao foi possivel abrir o disco " + numero + " (erro " + Marshal.GetLastWin32Error() + ")");
    return new FileStream(h, FileAccess.Read, 4096, false);
  }

  // Le [inicio, inicio+tamanho) em blocos; se um bloco falha, rele em pedacos de 64 KB para medir a area com erro
  public static void LerFaixa(FileStream fs, long inicio, long tamanho, int bloco, DiagLeitura r) {
    byte[] buf = new byte[bloco];
    long pos = inicio, fim = inicio + tamanho;
    Stopwatch sw = new Stopwatch();
    while (pos < fim) {
      int n = (int)Math.Min((long)bloco, fim - pos);
      bool ok = true;
      sw.Reset(); sw.Start();
      try {
        fs.Position = pos;
        int lidos = 0;
        while (lidos < n) { int k = fs.Read(buf, lidos, n - lidos); if (k <= 0) break; lidos += k; }
      } catch (IOException) { ok = false; }
      sw.Stop();
      double seg = sw.Elapsed.TotalSeconds;
      if (ok) {
        r.SomaSeg += seg; r.Lidos += n;
        double mbs = n / 1048576.0 / Math.Max(seg, 0.000001);
        if (n == bloco && mbs < r.MinMBs) r.MinMBs = mbs;
        if (seg > 1.5) r.Lentos++;
      } else {
        int sub = 65536;
        for (long p = pos; p < pos + n; p += sub) {
          int m = (int)Math.Min((long)sub, pos + n - p);
          try { fs.Position = p; fs.Read(buf, 0, m); r.Lidos += m; }
          catch (IOException) {
            r.Erros++;
            if (r.PrimeirosErros.Length < 300) r.PrimeirosErros += (p / 1073741824.0).ToString("F2") + " GB; ";
          }
        }
      }
      pos += n;
    }
  }

  // ---------------- energia: impedir suspensao e o modo de economia (EcoQoS) durante os testes
  [StructLayout(LayoutKind.Sequential)]
  struct PowerThrottlingState { public uint Version; public uint ControlMask; public uint StateMask; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentThread();
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern UIntPtr SetThreadAffinityMask(IntPtr h, UIntPtr mask);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetThreadInformation(IntPtr h, int classe, ref PowerThrottlingState info, uint tamanho);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetProcessInformation(IntPtr h, int classe, ref PowerThrottlingState info, uint tamanho);
  [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);

  // ES_CONTINUOUS | ES_SYSTEM_REQUIRED (| ES_DISPLAY_REQUIRED): o PC nao suspende durante os testes longos
  public static void ManterAcordado(bool sim) {
    try { SetThreadExecutionState(sim ? 0x80000003u : 0x80000000u); } catch { }
  }
  // Desliga o "modo de eficiencia"/EcoQoS do Windows 11, que reduz a velocidade de threads de fundo
  static PowerThrottlingState SemEconomia() { PowerThrottlingState st = new PowerThrottlingState(); st.Version = 1; st.ControlMask = 1; st.StateMask = 0; return st; }
  public static void ProcessoSemEconomia() {
    try { PowerThrottlingState st = SemEconomia(); SetProcessInformation(GetCurrentProcess(), 4, ref st, (uint)Marshal.SizeOf(typeof(PowerThrottlingState))); } catch { }
  }
  static void ThreadSemEconomia() {
    try { PowerThrottlingState st = SemEconomia(); SetThreadInformation(GetCurrentThread(), 3, ref st, (uint)Marshal.SizeOf(typeof(PowerThrottlingState))); } catch { }
  }

  // ---------------- estresse do processador com verificacao de calculo
  static volatile bool parar;
  static Thread[] threads;
  static long errosCalculo;
  static long ciclos;
  public static long ErrosCalculo { get { return Interlocked.Read(ref errosCalculo); } }
  public static long Ciclos { get { return Interlocked.Read(ref ciclos); } }

  static double Calcula() {
    double x = 1.000001, acc = 0;
    for (int i = 1; i < 200000; i++) { x = Math.Sqrt(x * x + i) * 0.9999993 + Math.Sin(x) * Math.Cos(i); acc += x / i; }
    return acc;
  }
  static void Trabalho(object indice) {
    int i = (int)indice;
    ThreadSemEconomia();
    // uma thread fixa em cada processador logico (ate 64), para todos ficarem em 100%
    if (Environment.ProcessorCount <= 64) {
      try { Thread.BeginThreadAffinity(); SetThreadAffinityMask(GetCurrentThread(), new UIntPtr(1UL << i)); } catch { }
    }
    double referencia = Calcula();
    while (!parar) {
      if (Calcula() != referencia) Interlocked.Increment(ref errosCalculo);
      Interlocked.Increment(ref ciclos);
    }
  }
  public static void IniciarEstresse(int n) {
    parar = false; errosCalculo = 0; ciclos = 0;
    ProcessoSemEconomia();
    threads = new Thread[n];
    for (int i = 0; i < n; i++) {
      threads[i] = new Thread(Trabalho);
      threads[i].IsBackground = true;
      threads[i].Priority = ThreadPriority.Normal;
      threads[i].Start(i);
    }
  }
  public static void PararEstresse() {
    parar = true;
    if (threads != null) foreach (Thread t in threads) t.Join(5000);
  }

  // ---------------- benchmark
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr VirtualAlloc(IntPtr addr, UIntPtr size, uint type, uint protect);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool VirtualFree(IntPtr addr, UIntPtr size, uint type);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(SafeFileHandle h, IntPtr buf, uint n, out uint lidos, IntPtr ov);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(SafeFileHandle h, IntPtr buf, uint n, out uint escritos, IntPtr ov);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFilePointerEx(SafeFileHandle h, long dist, out long novo, uint metodo);

  // ciclos de calculo por segundo com n threads (mesma carga do estresse, com conferencia)
  public static double BenchCpu(int n, int segundos) {
    IniciarEstresse(n);
    Stopwatch sw = Stopwatch.StartNew();
    Thread.Sleep(segundos * 1000);
    long c = Ciclos; double s = sw.Elapsed.TotalSeconds;
    PararEstresse();
    return c / s;
  }

  // MB/s copiando um bloco de mb MB de um lugar para outro da RAM
  public static double BenchMemoria(int mb, int segundos) {
    byte[] a = new byte[mb * 1048576], b = new byte[mb * 1048576];
    for (int i = 0; i < a.Length; i += 4096) a[i] = (byte)i;
    Buffer.BlockCopy(a, 0, b, 0, a.Length);
    long copiados = 0;
    Stopwatch sw = Stopwatch.StartNew();
    while (sw.Elapsed.TotalSeconds < segundos) { Buffer.BlockCopy(a, 0, b, 0, a.Length); copiados += a.Length; }
    return copiados / 1048576.0 / sw.Elapsed.TotalSeconds;
  }

  // Arquivo temporario sem cache do Windows (NO_BUFFERING + WRITE_THROUGH), apagado ao fechar.
  // Retorna {escrita MB/s, leitura MB/s, leituras aleatorias de 4K por segundo}
  public static double[] BenchDisco(string arquivo, int mb, int segundos4k) {
    const int BL = 1048576;
    IntPtr buf = VirtualAlloc(IntPtr.Zero, new UIntPtr((uint)BL), 0x3000, 4);
    if (buf == IntPtr.Zero) throw new IOException("Sem memoria para o teste de disco");
    SafeFileHandle h = null;
    try {
      byte[] rnd = new byte[BL]; new Random(12345).NextBytes(rnd); Marshal.Copy(rnd, 0, buf, BL);
      h = CreateFile(arquivo, 0xC0010000, 0, IntPtr.Zero, 2, 0x20000000u | 0x80000000u | 0x04000000u, IntPtr.Zero);
      if (h.IsInvalid) throw new IOException("Nao foi possivel criar " + arquivo + " (erro " + Marshal.GetLastWin32Error() + ")");
      uint k; long novo;
      Stopwatch sw = Stopwatch.StartNew();
      for (int i = 0; i < mb; i++) if (!WriteFile(h, buf, (uint)BL, out k, IntPtr.Zero) || k != BL) throw new IOException("Erro de escrita " + Marshal.GetLastWin32Error());
      double escrita = mb / sw.Elapsed.TotalSeconds;
      SetFilePointerEx(h, 0, out novo, 0);
      sw.Reset(); sw.Start();
      for (int i = 0; i < mb; i++) if (!ReadFile(h, buf, (uint)BL, out k, IntPtr.Zero) || k != BL) throw new IOException("Erro de leitura " + Marshal.GetLastWin32Error());
      double leitura = mb / sw.Elapsed.TotalSeconds;
      Random r = new Random(7); long ops = 0;
      sw.Reset(); sw.Start();
      while (sw.Elapsed.TotalSeconds < segundos4k) {
        SetFilePointerEx(h, (long)r.Next(0, mb * 256) * 4096, out novo, 0);
        if (!ReadFile(h, buf, 4096, out k, IntPtr.Zero)) throw new IOException("Erro de leitura " + Marshal.GetLastWin32Error());
        ops++;
      }
      return new double[] { escrita, leitura, ops / sw.Elapsed.TotalSeconds };
    } finally {
      if (h != null) h.Dispose();
      VirtualFree(buf, UIntPtr.Zero, 0x8000);
    }
  }

  // ---------------- memoria: grava padroes e confere; retorna {passadas, erros, MB testados}
  public static long[] TestarMemoria(long mb, int segundos) {
    const int MBBLOCO = 64;
    List<ulong[]> blocos = new List<ulong[]>();
    try { for (long i = 0; i < mb / MBBLOCO; i++) blocos.Add(new ulong[MBBLOCO * 1024 * 1024 / 8]); }
    catch (OutOfMemoryException) { }
    ulong[] padroes = new ulong[] { 0x5555555555555555UL, 0xAAAAAAAAAAAAAAAAUL, 0UL, 0xFFFFFFFFFFFFFFFFUL, 0x0F0F0F0F0F0F0F0FUL };
    long erros = 0, passadas = 0;
    Stopwatch sw = Stopwatch.StartNew();
    int pi = 0;
    while (sw.Elapsed.TotalSeconds < segundos && blocos.Count > 0) {
      bool porEndereco = (pi % 6 == 5);
      ulong pad = padroes[pi % padroes.Length];
      for (int b = 0; b < blocos.Count; b++) {
        ulong[] a = blocos[b];
        for (int j = 0; j < a.Length; j++) a[j] = porEndereco ? ((ulong)j * 0x9E3779B97F4A7C15UL) ^ (ulong)b : pad;
      }
      for (int b = 0; b < blocos.Count; b++) {
        ulong[] a = blocos[b];
        for (int j = 0; j < a.Length; j++) {
          ulong esperado = porEndereco ? ((ulong)j * 0x9E3779B97F4A7C15UL) ^ (ulong)b : pad;
          if (a[j] != esperado) erros++;
        }
      }
      passadas++; pi++;
    }
    long testados = (long)blocos.Count * MBBLOCO;
    blocos.Clear(); GC.Collect();
    return new long[] { passadas, erros, testados };
  }
}
'@
  try { if (-not ('DiagNativo' -as [type])) { Add-Type -TypeDefinition $csFonte -Language CSharp -ErrorAction Stop } } catch { Log "AVISO: rotinas de teste nao compilaram: $($_.Exception.Message)" }
  # impede o PC de suspender/desligar a tela enquanto os testes rodam
  if ('DiagNativo' -as [type]) { [DiagNativo]::ManterAcordado($true) }

  # ---- monitor de sensores em segundo plano; espera a 1a amostra (referencia em repouso)
  $psMon = [powershell]::Create()
  [void]$psMon.AddScript($sensorLoop.ToString()).AddArgument($mon).AddArgument($sensorCsv).AddArgument($sensorDll).AddArgument($intervaloSensor).AddArgument($false)
  $hMon = $psMon.BeginInvoke()
  $esp = Get-Date
  while ($mon.amostras -lt 1 -and -not $hMon.IsCompleted -and ((Get-Date) - $esp).TotalSeconds -lt 60) { Start-Sleep -Milliseconds 300 }
  Log "Sensores: $($mon.fonte)$(if ($mon.erro) { " - $($mon.erro)" })"

  # ---- logs completos
  if ($Testes -contains 'logs') {
    Etapa 'Copia dos logs do Windows (.evtx)' 'logs'
    $ev2 = Join-Path $pasta 'evtx'; New-Item -ItemType Directory $ev2 -Force | Out-Null
    foreach ($l in 'System', 'Application', 'Setup', 'Microsoft-Windows-Diagnostics-Performance/Operational') {
      wevtutil epl $l (Join-Path $ev2 (($l -replace '[\\/]', '_') + '.evtx')) 2>&1 | Out-Null
    }
    $prof.testes.logs = [ordered]@{ ok = $true; arquivos = @(Get-ChildItem $ev2 -File | ForEach-Object { $_.Name }) }
  }

  # ---- relatorio de energia
  if ($Testes -contains 'energia') {
    Etapa 'Relatorio de energia (powercfg /energy, 60 s)' 'energia'
    $t0 = Get-Date
    $out = (powercfg /energy /duration 60 /output (Join-Path $pasta 'energia.html') 2>&1) -join ' '
    $er = if ($out -match '(\d+)\s+(Erros|Errors)') { [int]$Matches[1] } else { $null }
    $av = if ($out -match '(\d+)\s+(Avisos|Warnings)') { [int]$Matches[1] } else { $null }
    $prof.testes.energia = [ordered]@{ erros = $er; avisos = $av; minutos = Duracao $t0; arquivo = 'energia.html' }
  }

  # ---- verificacao das unidades
  # 'disco': chkdsk sem parametros = somente leitura (codigo 0 = sem erros; 2 ou 3 = erros nao corrigidos).
  # 'disco-corrigir': a mesma analise e, so nas unidades com erro, Repair-Volume -Scan (chkdsk /scan, corrige online).
  $corrigirDisco = $Testes -contains 'disco-corrigir'
  if ($Testes -contains 'disco' -or $corrigirDisco) {
    Etapa "Verificacao das unidades (chkdsk $(if ($corrigirDisco) { 'com correcao automatica dos erros encontrados' } else { 'somente leitura' }))" 'disco'
    $t0 = Get-Date
    $prof.testes.disco = [ordered]@{ modo = $(if ($corrigirDisco) { 'corrigir' } else { 'leitura' }); unidades = @(Get-Volume | Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Fixed' -and $_.FileSystem -eq 'NTFS' } | ForEach-Object {
      $L = "$($_.DriveLetter)"
      Log "Analisando ${L}: (somente leitura)"
      $arq = "chkdsk_$L.txt"
      # se o chkdsk nem iniciar (sem permissao), o erro nao pode derrubar as outras unidades
      $cod = $null
      try { $saida = & chkdsk.exe "${L}:" 2>&1; $cod = $LASTEXITCODE } catch { $saida = "chkdsk nao executou: $(Primeira-Linha $_.Exception.Message)" }
      $saida | Out-File (Join-Path $pasta $arq) -Encoding UTF8
      $res = if ($cod -eq 0) { 'NoErrorsFound' } elseif ($cod -in 2, 3) { 'ErrorsFoundNotFixed' } elseif ($null -eq $cod) { "Erro: $saida" } else { "Erro: chkdsk terminou com codigo $cod" }
      $achou = $cod -in 2, 3
      $corrigido = $false
      if ($achou -and $corrigirDisco) {
        Log "  Erros em ${L}: - corrigindo (chkdsk /scan)"
        $res = try { "$(Repair-Volume -DriveLetter $L -Scan -ErrorAction Stop)" } catch { "Erro: $($_.Exception.Message)" }
        $corrigido = $res -in 'ScanErrorsFoundAndFixedOnline', 'NoErrorsFound'
        if ($res -eq 'NoErrorsFound') { $res = 'ScanErrorsFoundAndFixedOnline' }
      }
      Log "  ${L}: $res"
      [ordered]@{ unidade = "${L}:"; resultado = $res; ok = ($cod -eq 0); encontrouErros = $achou; corrigido = $corrigido; codigo = $cod; arquivo = $arq }
    }); minutos = 0 }
    $prof.testes.disco.minutos = Duracao $t0
  }

  # ---- integridade do Windows (DISM + SFC em modo verificacao)
  if ($Testes -contains 'sistema') {
    Etapa 'Integridade da imagem do Windows (DISM /ScanHealth) - pode levar 10 a 30 min' 'sistema'
    $t0 = Get-Date
    $dism = try { "$((Repair-WindowsImage -Online -ScanHealth -ErrorAction Stop).ImageHealthState)" } catch { "Erro: $($_.Exception.Message)" }
    Log "DISM: $dism"
    Etapa 'Arquivos do sistema (SFC /VERIFYONLY) - pode levar 10 a 20 min'
    $sfcTxt = Join-Path $pasta 'sfc.txt'
    $proc = Start-Process sfc.exe -ArgumentList '/verifyonly' -NoNewWindow -Wait -PassThru -RedirectStandardOutput $sfcTxt
    $txt = ((Get-Content $sfcTxt -Encoding Unicode -Raw) -replace "`0", '') -replace "`r", "`n"
    $txt | Set-Content $sfcTxt -Encoding UTF8
    $sfc = if ($txt -match 'n.o encontrou nenhuma viola|did not find any integrity violations') { 'Sem violacoes' }
           elseif ($txt -match 'encontrou viola|found integrity violations|arquivos corrompidos|corrupt files') { 'Violacoes de integridade encontradas' }
           else { "Indeterminado (codigo $($proc.ExitCode))" }
    Log "SFC: $sfc"
    $prof.testes.sistema = [ordered]@{ dism = $dism; sfc = $sfc; sfcCodigo = $proc.ExitCode; minutos = Duracao $t0 }
  }

  # ---- desempenho (WinSAT)
  if ($Testes -contains 'desempenho') {
    Etapa 'Avaliacao de desempenho (WinSAT formal) - cerca de 5 min' 'desempenho'
    $t0 = Get-Date
    winsat formal > (Join-Path $pasta 'winsat.txt') 2>&1
    $ws = Get-CimInstance Win32_WinSAT -ErrorAction SilentlyContinue | Select-Object -First 1
    $prof.testes.desempenho = [ordered]@{
      codigo = $LASTEXITCODE; minutos = Duracao $t0
      processador = $ws.CPUScore; memoria = $ws.MemoryScore; disco = $ws.DiskScore; graficos = $ws.GraphicsScore; jogos = $ws.D3DScore; geral = $ws.WinSPRLevel
    }
  }

  # ---- benchmark proprio (CPU, memoria, disco)
  if ($Testes -contains 'benchmark' -and ('DiagNativo' -as [type])) {
    $nThreads = [Environment]::ProcessorCount
    Etapa "Benchmark: processador (1 e $nThreads threads), memoria e disco - cerca de 1 min" 'benchmark'
    $t0 = Get-Date
    $bm = [ordered]@{ threads = $nThreads }
    $bm.cpuMono = [math]::Round([DiagNativo]::BenchCpu(1, 5), 1)
    $bm.cpuMulti = [math]::Round([DiagNativo]::BenchCpu($nThreads, 8), 1)
    $bm.errosCalculo = [DiagNativo]::ErrosCalculo
    $bm.escala = $(if ($bm.cpuMono -gt 0) { [math]::Round($bm.cpuMulti / $bm.cpuMono, 1) })
    Log "  CPU: $($bm.cpuMono) ciclos/s com 1 thread, $($bm.cpuMulti) com $nThreads ($($bm.escala)x)"
    $livreMB = [math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1KB)
    $mbMem = [int][math]::Max(32, [math]::Min(256, [math]::Floor($livreMB / 6)))
    try { $bm.memoriaMBs = [math]::Round([DiagNativo]::BenchMemoria($mbMem, 4)); Log "  Memoria: $($bm.memoriaMBs) MB/s (copia de blocos de $mbMem MB)" } catch { Log "  AVISO: benchmark de memoria falhou: $($_.Exception.Message)" }
    $arqB = Join-Path $env:TEMP "diag_bench_$stamp.tmp"
    $unB = Split-Path $arqB -Qualifier
    $livreD = (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$unB'" -ErrorAction SilentlyContinue).FreeSpace
    $mbD = if ($livreD -gt 4GB) { 1024 } elseif ($livreD -gt 1GB) { 256 } else { 0 }
    $bm.disco = [ordered]@{ unidade = $unB; mb = $mbD }
    if ($mbD) {
      try {
        $rd = [DiagNativo]::BenchDisco($arqB, $mbD, 5)
        $bm.disco.escritaMBs = [math]::Round($rd[0], 1); $bm.disco.leituraMBs = [math]::Round($rd[1], 1); $bm.disco.leitura4kIops = [math]::Round($rd[2])
        Log "  Disco ${unB} escrita $($bm.disco.escritaMBs) MB/s, leitura $($bm.disco.leituraMBs) MB/s, 4K aleatorio $($bm.disco.leitura4kIops) IOPS"
      } catch { $bm.disco.erro = $_.Exception.Message; Log "  AVISO: benchmark de disco falhou: $($bm.disco.erro)" }
      Remove-Item -LiteralPath $arqB -Force -ErrorAction SilentlyContinue
    } else { $bm.disco.erro = 'Pouco espaco livre para o teste' }
    $bm.minutos = Duracao $t0
    $prof.testes.benchmark = $bm
  }

  # ---- memoria RAM dentro do Windows
  if ($Testes -contains 'memoria' -and ('DiagNativo' -as [type])) {
    $livreMB = [math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1KB)
    $alvo = [math]::Max(256, [math]::Min($livreMB - 1536, [math]::Floor($livreMB * 0.85)))
    Etapa "Memoria RAM: $alvo MB livres testados por $Minutos min (padroes gravados e conferidos)" 'memoria'
    $t0 = Get-Date
    $r = [DiagNativo]::TestarMemoria([long]$alvo, $Minutos * 60)
    $prof.testes.memoria = [ordered]@{ mbTestados = $r[2]; mbLivres = $livreMB; passadas = $r[0]; erros = $r[1]; minutos = Duracao $t0 }
    Log "Memoria: $($r[0]) passada(s), $($r[1]) erro(s) em $($r[2]) MB"
  }

  # ---- estresse do processador + temperatura e frequencia
  if ($Testes -contains 'estresse' -and ('DiagNativo' -as [type])) {
    Etapa "Estresse do processador por $Minutos min: $([Environment]::ProcessorCount) threads a 100%, uma por processador logico (o PC fica lento)" 'estresse'
    $t0 = Get-Date
    $amostra = {
      $pi = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'" -ErrorAction SilentlyContinue
      # temperatura: ultima leitura do monitor de sensores (processador; zona ACPI sem o LibreHardwareMonitor)
      [pscustomobject]@{ desempenhoPct = $pi.PercentProcessorPerformance; mhz = $pi.ProcessorFrequency; usoPct = $pi.PercentProcessorTime; temp = $mon.cpuTemp }
    }
    $base = & $amostra
    [DiagNativo]::IniciarEstresse([Environment]::ProcessorCount)
    $amostras = New-Object System.Collections.Generic.List[object]
    $abortado = $null
    try {
      while (((Get-Date) - $t0).TotalSeconds -lt $Minutos * 60) {
        Start-Sleep -Seconds 5
        $a = & $amostra; $amostras.Add($a)
        if ($a.temp -and $a.temp -ge $TempLimite) { $abortado = "Interrompido: $($a.temp) C, limite de $TempLimite C"; Log "  $abortado"; break }
        if ($amostras.Count % 12 -eq 0) { Log ("  {0:N0} min - uso {1}% - desempenho {2}% - {3}" -f ((Get-Date) - $t0).TotalMinutes, $a.usoPct, $a.desempenhoPct, $(if ($a.temp) { "$($a.temp) C" } else { 'temperatura n/d' })) }
      }
    } finally { [DiagNativo]::PararEstresse() }
    $med = { param($p) $v = @($amostras | ForEach-Object { $_.$p } | Where-Object { $_ -ne $null }); if ($v) { [math]::Round(($v | Measure-Object -Average).Average, 1) } }
    $limit = @(try { Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Processor-Power'; Id = 37; StartTime = $t0 } -ErrorAction Stop } catch { }).Count
    $whea = @(try { Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-WHEA-Logger'; StartTime = $t0 } -ErrorAction Stop } catch { }).Count
    $des = @($amostras | ForEach-Object { $_.desempenhoPct } | Where-Object { $_ -ne $null })
    # temperatura identica do inicio ao fim sob 100% de carga e valor fixo (zona ACPI falsa): descarta
    $temps = @($amostras | ForEach-Object { $_.temp } | Where-Object { $_ })
    if ($amostras.Count -ge 6 -and @($temps | Select-Object -Unique).Count -le 1) { $amostras | ForEach-Object { $_.temp = $null }; $base.temp = $null }
    $prof.testes.estresse = [ordered]@{
      minutos = Duracao $t0; threads = [Environment]::ProcessorCount; ciclos = [DiagNativo]::Ciclos; errosCalculo = [DiagNativo]::ErrosCalculo
      usoMedioPct = & $med 'usoPct'; desempenhoInicialPct = $base.desempenhoPct; desempenhoMedioPct = & $med 'desempenhoPct'
      desempenhoMinPct = $(if ($des) { ($des | Measure-Object -Minimum).Minimum }); mhzMedio = & $med 'mhz'
      tempInicial = $base.temp; tempMax = $(($amostras | Where-Object temp | Measure-Object temp -Maximum).Maximum); eventosLimitacao = $limit; errosWhea = $whea
      abortado = $abortado
    }
    Log "Estresse: erros de calculo $([DiagNativo]::ErrosCalculo), desempenho medio $($prof.testes.estresse.desempenhoMedioPct)%, temp max $($prof.testes.estresse.tempMax)"
  }

  # ---- rede prolongada
  if ($Testes -contains 'rede') {
    $gw = @($saude.rede | Where-Object { $_.gateway } | ForEach-Object { ($_.gateway -split ',\s*')[0] }) | Select-Object -First 1
    $alvos = @(@($gw, '8.8.8.8') | Where-Object { $_ })
    Etapa "Rede: ping continuo por $Minutos min em $($alvos -join ' e ')" 'rede'
    $t0 = Get-Date
    $res = @{}; foreach ($a in $alvos) { $res[$a] = New-Object System.Collections.Generic.List[object] }
    while (((Get-Date) - $t0).TotalSeconds -lt $Minutos * 60) {
      $t1 = Get-Date
      $tarefas = @{}
      foreach ($a in $alvos) { $tarefas[$a] = (New-Object System.Net.NetworkInformation.Ping).SendPingAsync($a, 1000) }
      foreach ($a in $alvos) { try { $rp = $tarefas[$a].Result; $res[$a].Add($(if ($rp.Status -eq 'Success') { [int]$rp.RoundtripTime } else { $null })) } catch { $res[$a].Add($null) } }
      $resto = 1000 - ((Get-Date) - $t1).TotalMilliseconds
      if ($resto -gt 0) { Start-Sleep -Milliseconds $resto }
    }
    $prof.testes.rede = [ordered]@{ minutos = Duracao $t0; alvos = @(foreach ($a in $alvos) {
      $lst = $res[$a]; $ok = @($lst | Where-Object { $_ -ne $null })
      $jit = if ($ok.Count -gt 1) { [math]::Round((@(for ($i = 1; $i -lt $ok.Count; $i++) { [math]::Abs($ok[$i] - $ok[$i - 1]) }) | Measure-Object -Average).Average, 1) } else { $null }
      [ordered]@{
        alvo = $a; nome = $(if ($a -eq $gw) { 'Gateway' } else { 'Internet' }); enviados = $lst.Count; recebidos = $ok.Count
        perdaPct = $(if ($lst.Count) { [math]::Round(100 * ($lst.Count - $ok.Count) / $lst.Count, 1) }); mediaMs = $(if ($ok) { [math]::Round(($ok | Measure-Object -Average).Average, 1) }); maxMs = $(if ($ok) { ($ok | Measure-Object -Maximum).Maximum }); jitterMs = $jit
      }
    }) }
    Log 'Rota ate a internet (tracert)'
    tracert -d -h 15 -w 800 8.8.8.8 2>&1 | Out-File (Join-Path $pasta 'tracert.txt') -Encoding UTF8
  }

  # ---- antivirus
  $tipoAv = if ($Testes -contains 'antivirus-completo') { 'FullScan' } elseif ($Testes -contains 'antivirus') { 'QuickScan' }
  if ($tipoAv) {
    Etapa "Microsoft Defender: verificacao $(if ($tipoAv -eq 'FullScan') { 'COMPLETA (pode levar horas)' } else { 'rapida' })" 'antivirus'
    $t0 = Get-Date
    $erroAv = $null
    try { Start-MpScan -ScanType $tipoAv -ErrorAction Stop } catch { $erroAv = $_.Exception.Message }
    $ameacas = @(try { Get-MpThreatDetection -ErrorAction Stop | Where-Object { $_.InitialDetectionTime -ge $t0 } } catch { })
    $prof.testes.antivirus = [ordered]@{ tipo = $(if ($tipoAv -eq 'FullScan') { 'Completa' } else { 'Rapida' }); minutos = Duracao $t0; erro = $erroAv
      ameacas = @($ameacas | ForEach-Object { [ordered]@{ recurso = (@($_.Resources) | Select-Object -First 1); acaoOk = [bool]$_.ActionSuccess } }) }
  }

  # ---- superficie dos discos (leitura completa) - por ultimo, e o mais longo
  if ($Testes -contains 'superficie' -and ('DiagNativo' -as [type])) {
    $dd = @(Get-CimInstance Win32_DiskDrive | Where-Object { $_.InterfaceType -ne 'USB' -and $_.MediaType -match 'Fixed' -and $_.Size -gt 0 })
    if (-not $SuperficieTodos) {
      $sysNum = try { (Get-Partition -DriveLetter ($env:SystemDrive.TrimEnd(':')) -ErrorAction Stop).DiskNumber } catch { 0 }
      $dd = @($dd | Where-Object { $_.Index -eq $sysNum })
    }
    $prof.testes.superficie = [ordered]@{ discos = @() }
    foreach ($d in $dd) {
      $gb = [math]::Round($d.Size / 1GB, 1)
      Etapa "Superficie do disco $($d.Index) - $($d.Model) ($gb GB): leitura completa, somente leitura" 'superficie'
      $t0 = Get-Date
      $r = New-Object DiagLeitura
      $erroAbrir = $null
      try {
        $fs = [DiagNativo]::AbrirDisco([int]$d.Index)
        try {
          $setor = [math]::Max(4096, [int]$d.BytesPerSector)
          $total = [long]([math]::Floor($d.Size / $setor) * $setor)
          $faixa = [long]1GB; $pos = [long]0; $ultimoPct = -1
          while ($pos -lt $total) {
            $len = [long][math]::Min($faixa, $total - $pos)
            [DiagNativo]::LerFaixa($fs, $pos, $len, 4MB, $r)
            $pos += $len
            $pct = [math]::Floor(100 * $pos / $total)
            if ($pct -ge $ultimoPct + 5) {
              $ultimoPct = $pct
              $vel = if ($r.SomaSeg -gt 0) { [math]::Round($r.Lidos / 1MB / $r.SomaSeg) } else { 0 }
              $rest = if ($vel -gt 0) { [math]::Round(($total - $pos) / 1MB / $vel / 60) } else { '?' }
              Log ("  {0}% - {1} MB/s - erros {2} - lentos {3} - faltam ~{4} min" -f $pct, $vel, $r.Erros, $r.Lentos, $rest)
            }
          }
        } finally { $fs.Dispose() }
      } catch { $erroAbrir = $_.Exception.Message; Log "AVISO: $erroAbrir" }
      $prof.testes.superficie.discos += [ordered]@{
        disco = $d.Index; modelo = $d.Model; gb = $gb; lidoGB = [math]::Round($r.Lidos / 1GB, 1); minutos = Duracao $t0
        mediaMBs = $(if ($r.SomaSeg -gt 0) { [math]::Round($r.Lidos / 1MB / $r.SomaSeg, 1) }); minMBs = $(if ($r.MinMBs -lt [double]::MaxValue) { [math]::Round($r.MinMBs, 1) })
        blocosLentos = $r.Lentos; areasComErro = $r.Erros; locaisErro = $r.PrimeirosErros; erro = $erroAbrir
      }
    }
  }

  $mon.fase = 'fim'; $mon.parar = $true
  try { [void]$psMon.EndInvoke($hMon) } catch { Log "AVISO: monitor de sensores: $($_.Exception.Message)" }
  $psMon.Dispose()
  if ('DiagNativo' -as [type]) { [DiagNativo]::ManterAcordado($false) }
  $prof.fim = Fmt-Data (Get-Date)
  $prof.minutosTotal = [math]::Round(((Get-Date) - [datetime]$prof.inicio).TotalMinutes, 1)
}

if (-not $Testes) {
  Log 'Sensores (temperaturas, tensoes, ventoinhas)'
  try { & $sensorLoop $mon $sensorCsv $sensorDll $intervaloSensor $true } catch { $mon.erro = $_.Exception.Message }
}
try { $saude.sensores = Resumo-Sensores } catch { Log "AVISO: resumo dos sensores: $($_.Exception.Message)" }

$saude | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $pasta '06_saude.json') -Encoding UTF8

# ================================================================ 9. programas instalados
Log 'Programas instalados'
# Le chave a chave: um valor corrompido em uma delas (comum em instaladores
# antigos) fazia o Get-ItemProperty falhar com "Conversao especificada nao e valida".
$progs = foreach ($raiz in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall') {
  foreach ($k in @(Get-ChildItem $raiz -ErrorAction SilentlyContinue)) {
    try {
      $nome = $k.GetValue('DisplayName')
      if (-not $nome -or $k.GetValue('SystemComponent') -eq 1) { continue }
      [pscustomobject]@{ Programa = "$nome"; Versao = "$($k.GetValue('DisplayVersion'))"; Fabricante = "$($k.GetValue('Publisher'))"; Instalado = "$($k.GetValue('InstallDate'))" }
    } catch { }
  }
}
@($progs | Sort-Object Programa -Unique) | Export-Csv (Join-Path $pasta '08_programas.csv') -NoTypeInformation -Encoding UTF8

# ================================================================ 10. resumo
# Obs.: @($null) tem 1 elemento; por isso as listas abaixo passam por Where-Object { $_ }
Log 'Gerando resumo'
$r = New-Object System.Collections.Generic.List[string]
$r.Add("DIAGNOSTICO - $env:COMPUTERNAME - $($inicio.ToString('yyyy-MM-dd HH:mm:ss')) ($((Get-TimeZone).Id))")
$r.Add("Patrimonio: $patrimonio   Modelo: $($cs.Manufacturer) $($cs.Model)   Serial: $($bios.SerialNumber)")
$r.Add("Sistema: $($os.Caption) $($saude.sistema.build) - ligado ha $($saude.sistema.horasLigado) h - eventos: $periodoTxt")
$r.Add('')
$r.Add('=== HARDWARE ===')
if ($saude.cpu) { $r.Add("CPU: $($saude.cpu.nome) - carga $($saude.cpu.cargaPct)%$(if ($saude.temperaturaCpu) { " - $($saude.temperaturaCpu) C" })") }
if ($saude.memoria) { $r.Add("Memoria: $($saude.memoria.totalGB) GB, uso $($saude.memoria.usoPct)% ($(@($saude.memoria.modulos).Count) modulo(s) de $($saude.memoria.slotsTotal) slots)") }
foreach ($g in @($saude.video | Where-Object { $_ })) { $r.Add("Video: $($g.nome) - driver $($g.driverVersao) ($($g.driverData))") }
foreach ($d in @($saude.discos | Where-Object { $_ })) { $r.Add("Disco: $($d.nome) - $($d.tipo) $($d.gb) GB - saude: $($d.saude) - temp: $($d.temperatura) C - desgaste: $($d.desgastePct)% - horas: $($d.horasLigado)") }
foreach ($v in @($saude.volumes | Where-Object { $_ })) { $r.Add("Unidade $($v.letra) $($v.livreGB) GB livres de $($v.totalGB) GB ($($v.livrePct)%)$(if ($v.verificacaoPendente) { ' - VERIFICACAO DE DISCO PENDENTE' })") }
$r.Add('')
$r.Add('=== PROBLEMAS ENCONTRADOS ===')
$p = 0
foreach ($d in @($saude.discos | Where-Object { $_ })) { if ($d.saude -and $d.saude -ne 'Healthy') { $r.Add("- Disco $($d.nome): saude $($d.saude)"); $p++ } }
if (@($saude.smart | Where-Object { $_.falhaPrevista })) { $r.Add('- SMART: falha de disco prevista'); $p++ }
foreach ($x in @($saude.dispositivosProblema | Where-Object { $_ })) { $r.Add("- Dispositivo: $($x.nome) - codigo $($x.codigo) $($x.descricao)"); $p++ }
foreach ($s in @($saude.servicos | Where-Object { $_ })) { if ($s.inicio -eq 'Auto' -and $s.estado -ne 'Running') { $r.Add("- Servico parado: $($s.descricao)"); $p++ } }
foreach ($t in @($saude.conectividade | Where-Object { $_ })) { if (-not $t.ok) { $r.Add("- Falhou: $($t.teste) ($($t.alvo))"); $p++ } }
if ($saude.ativacao -and -not $saude.ativacao.ativado) { $r.Add("- Windows: $($saude.ativacao.status)"); $p++ }
if ($saude.sistema.reinicioPendente) { $r.Add('- Reinicio pendente (atualizacoes)'); $p++ }
foreach ($k in 'telaAzul', 'erroHardware', 'erroDisco', 'driverVideo', 'desligamentoInesperado') { if ($ev[$k].total) { $r.Add("- $k : $($ev[$k].total) evento(s), ultimo $($ev[$k].ultimo)"); $p++ } }
foreach ($sa in @($saude.smartAtributos | Where-Object { $_ })) { foreach ($at in @($sa.atributos | Where-Object { $_ })) { if ($at.id -in 5, 187, 197, 198 -and $at.bruto -gt 0) { $r.Add("- SMART $($at.nome): $($at.bruto)"); $p++ } } }
foreach ($tm in @($saude.testeMemoriaWindows | Where-Object { $_.comErros })) { $r.Add("- Teste de memoria do Windows com erros em $($tm.hora)"); $p++ }
if ($saude.inicializacaoTempo -and $saude.inicializacaoTempo.mediaSeg -gt 120) { $r.Add("- Inicializacao lenta: media de $($saude.inicializacaoTempo.mediaSeg) s"); $p++ }
$sensLinhas = @()
foreach ($x in @($saude.sensores.itens | Where-Object { $_ })) {
  if ($x.tipo -eq 'tensao' -and $x.hwTipo -notmatch '^(Cpu|Gpu)') {
    $nom = Tensao-Nominal $x.nome
    if ($nom -and ([math]::Abs($x.min - $nom) / $nom -gt 0.05 -or [math]::Abs($x.max - $nom) / $nom -gt 0.05)) {
      $r.Add("- Tensao $($x.nome) fora de +/-5% ($($x.min) a $($x.max) V) - confirme com multimetro"); $p++
    }
  }
  if ($x.tipo -eq 'temperatura' -and $x.hwTipo -match '^(Cpu|Gpu)' -and $x.max -ge 95) { $r.Add("- Temperatura alta: $($x.hw) $($x.nome) chegou a $($x.max) C"); $p++ }
  if ($x.tipo -eq 'ventoinha' -and $x.inicial -gt 0 -and $x.min -eq 0 -and $x.hwTipo -notmatch '^Gpu') { $r.Add("- Ventoinha $($x.nome) ($($x.hw)) parou durante o monitoramento"); $p++ }
  if ($x.tipo -in 'temperatura', 'tensao', 'ventoinha', 'potencia') { $sensLinhas += "$($x.hw) - $($x.nome): $($x.min) a $($x.max) $($x.unidade) (inicial $($x.inicial))" }
}
if ($saude.profundo) {
  $T = $saude.profundo.testes
  if ($T.sistema -and ($T.sistema.dism -ne 'Healthy' -or $T.sistema.sfc -ne 'Sem violacoes')) { $r.Add("- Integridade do Windows: DISM $($T.sistema.dism) / SFC $($T.sistema.sfc)"); $p++ }
  foreach ($u in @($T.disco.unidades | Where-Object { $_ })) { if (-not $u.ok) { $r.Add("- Verificacao da unidade $($u.unidade): $($u.resultado)"); $p++ } }
  foreach ($d in @($T.superficie.discos | Where-Object { $_ })) { if ($d.areasComErro -or $d.erro) { $r.Add("- Superficie do disco $($d.disco): $($d.areasComErro) area(s) com erro de leitura $($d.erro)"); $p++ } }
  if ($T.memoria -and $T.memoria.erros) { $r.Add("- Teste de memoria: $($T.memoria.erros) erro(s)"); $p++ }
  if ($T.benchmark -and $T.benchmark.errosCalculo) { $r.Add("- Benchmark: $($T.benchmark.errosCalculo) erro(s) de calculo do processador"); $p++ }
  if ($T.estresse -and $T.estresse.abortado) { $r.Add("- Estresse do processador: $($T.estresse.abortado)"); $p++ }
  if ($T.estresse -and ($T.estresse.errosCalculo -or $T.estresse.errosWhea)) { $r.Add("- Estresse do processador: $($T.estresse.errosCalculo) erro(s) de calculo, $($T.estresse.errosWhea) erro(s) WHEA"); $p++ }
  foreach ($a in @($T.rede.alvos | Where-Object { $_ })) { if ($a.perdaPct -gt 1) { $r.Add("- Rede ($($a.nome)): $($a.perdaPct)% de perda"); $p++ } }
  if ($T.antivirus -and @($T.antivirus.ameacas).Count) { $r.Add("- Antivirus: $(@($T.antivirus.ameacas).Count) ameaca(s) encontrada(s)"); $p++ }
  if (-not $p) { $r.Add('Nenhum problema identificado automaticamente.'); $semProblemaDito = $true }
  $r.Add('')
  $r.Add("=== TESTES PROFUNDOS ($($saude.profundo.minutosTotal) min) ===")
  if ($T.sistema) { $r.Add("Integridade: DISM $($T.sistema.dism) - SFC $($T.sistema.sfc)") }
  foreach ($u in @($T.disco.unidades | Where-Object { $_ })) { $r.Add("chkdsk $($u.unidade): $($u.resultado)") }
  foreach ($d in @($T.superficie.discos | Where-Object { $_ })) { $r.Add("Superficie disco $($d.disco) $($d.modelo): $($d.lidoGB) de $($d.gb) GB lidos, media $($d.mediaMBs) MB/s, minimo $($d.minMBs) MB/s, blocos lentos $($d.blocosLentos), areas com erro $($d.areasComErro)") }
  if ($T.benchmark) { $r.Add("Benchmark: CPU $($T.benchmark.cpuMono) ciclos/s (1 thread), $($T.benchmark.cpuMulti) ($($T.benchmark.threads) threads) - memoria $($T.benchmark.memoriaMBs) MB/s - disco $($T.benchmark.disco.unidade) escrita $($T.benchmark.disco.escritaMBs) MB/s, leitura $($T.benchmark.disco.leituraMBs) MB/s, 4K $($T.benchmark.disco.leitura4kIops) IOPS") }
  if ($T.desempenho) { $r.Add("WinSAT: CPU $($T.desempenho.processador) - memoria $($T.desempenho.memoria) - disco $($T.desempenho.disco) - video $($T.desempenho.graficos)") }
  if ($T.memoria) { $r.Add("Memoria: $($T.memoria.mbTestados) MB, $($T.memoria.passadas) passada(s), $($T.memoria.erros) erro(s)") }
  if ($T.estresse) { $r.Add("Estresse CPU: $($T.estresse.minutos) min, desempenho medio $($T.estresse.desempenhoMedioPct)% (min $($T.estresse.desempenhoMinPct)%), temp max $($T.estresse.tempMax), erros de calculo $($T.estresse.errosCalculo)") }
  foreach ($a in @($T.rede.alvos | Where-Object { $_ })) { $r.Add("Rede $($a.nome) ($($a.alvo)): perda $($a.perdaPct)%, media $($a.mediaMs) ms, max $($a.maxMs) ms, jitter $($a.jitterMs) ms") }
  if ($T.antivirus) { $r.Add("Antivirus ($($T.antivirus.tipo)): $(@($T.antivirus.ameacas).Count) ameaca(s)") }
  if ($T.energia) { $r.Add("Energia (powercfg): $($T.energia.erros) erro(s), $($T.energia.avisos) aviso(s)") }
}
if (-not $p -and -not $semProblemaDito) { $r.Add('Nenhum problema identificado automaticamente.') }
if ($saude.sensores) {
  $r.Add('')
  $r.Add("=== SENSORES ($($saude.sensores.amostras) amostra(s) - $($saude.sensores.fonte)) ===")
  if ($saude.sensores.aviso) { $r.Add("AVISO: $($saude.sensores.aviso)") }
  $sensLinhas | ForEach-Object { $r.Add($_) }
  if (-not $sensorDll) { $r.Add('Tensoes da fonte e ventoinhas: coloque o LibreHardwareMonitor na pasta "sensores" (baixar-sensores.ps1).') }
}
$r.Add('')
$r.Add('Detalhes: 06_saude.json (abra no visualizador), 07_eventos_erros.csv, 08_programas.csv, 09_drivers.csv, 10_sensores.csv.')
$r | Set-Content (Join-Path $pasta '00_RESUMO.txt') -Encoding UTF8

# ================================================================ 11. hashes e zip
Log 'Calculando hashes e compactando'
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
Write-Host 'Diagnostico concluido.' -ForegroundColor Green
Write-Host "Pasta : $pasta"
Write-Host "Zip   : $zip"
Write-Host "Problemas encontrados: $p" -ForegroundColor $(if ($p) { 'Yellow' } else { 'Green' })

if ($Enviar) {
  Write-Host ''
  if (-not (Send-Coleta $zip)) {
    Write-Host 'O diagnostico foi salvo localmente, mas NAO foi enviado. Reenvie depois.' -ForegroundColor Yellow
    exit 2
  }
}
exit 0

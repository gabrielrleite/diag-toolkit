<#
  Assinador diag - assina laudos do Visualizador de Coletas com o certificado
  instalado no Windows (A1 importado ou A3 em token/cartao).

  E aberto pelo navegador atraves do link diagassina: (instalado pelo
  instalar-assinador.bat). Fluxo:
    1. baixa do servidor o PDF preparado (com campo de assinatura e selo)
    2. mostra a janela do Windows para escolher o certificado (A3 pede o PIN)
    3. preenche o selo visivel com titular/data, assina (CMS/PKCS#7, SHA-256)
    4. envia o PDF assinado ao servidor, que confere e guarda

  A chave privada nunca sai do Windows: so o PDF assinado e enviado.
#>
param(
  [string]$Url,
  [string]$PfxTeste,     # uso em testes: certificado de arquivo no lugar do repositorio do Windows
  [string]$SenhaTeste
)
$ErrorActionPreference = 'Stop'
try { $Host.UI.RawUI.WindowTitle = 'Assinador diag' } catch { }

function Pausa { if (-not $PfxTeste) { Write-Host ''; [void](Read-Host 'Pressione Enter para fechar') } }
function Falha([string]$m) { Write-Host ''; Write-Host "ERRO: $m" -ForegroundColor Red; Pausa; exit 1 }
function Erro-Web($e) {
  try {
    $r = $e.Exception.InnerException.Response; if (-not $r) { $r = $e.Exception.Response }
    $txt = (New-Object IO.StreamReader($r.GetResponseStream())).ReadToEnd()
    return ($txt | ConvertFrom-Json).erro
  } catch { return $e.Exception.Message }
}

foreach ($a in 'System.Security', 'System.Security.Cryptography.Pkcs') { try { Add-Type -AssemblyName $a } catch { } }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

Write-Host ''
Write-Host '  ASSINADOR DIAG - assinatura digital de laudos' -ForegroundColor Cyan
Write-Host '  ---------------------------------------------'

$u = ($Url -replace '^diagassina:', '').Trim().TrimEnd('/')
if ($u -notmatch '^https?://[^\s]+/api/assinatura/[0-9a-f]{48}$') { Falha "Link de assinatura invalido: $Url" }

# ------------------------------------------------------------- 1. documento
$wc = New-Object Net.WebClient
try { $pdf = $wc.DownloadData("$u/pdf") } catch { Falha (Erro-Web $_) }
$doc = ''
try { $doc = [uri]::UnescapeDataString([string]$wc.ResponseHeaders['X-Laudo']) } catch { }
Write-Host "  Documento: $doc"
Write-Host "  Tamanho  : $([math]::Round($pdf.Length / 1KB)) KB"

# ------------------------------------------------------------- 2. certificado
if ($PfxTeste) {
  $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2($PfxTeste, $SenhaTeste, [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable)
} else {
  $agora = Get-Date
  $col = New-Object Security.Cryptography.X509Certificates.X509Certificate2Collection
  foreach ($loc in 'CurrentUser', 'LocalMachine') {
    try {
      $st = New-Object Security.Cryptography.X509Certificates.X509Store('My', $loc)
      $st.Open('ReadOnly, OpenExistingOnly')
      foreach ($c in $st.Certificates) {
        if (-not $c.HasPrivateKey -or $c.NotBefore -gt $agora -or $c.NotAfter -lt $agora) { continue }
        $ku = $c.Extensions | Where-Object { $_ -is [Security.Cryptography.X509Certificates.X509KeyUsageExtension] }
        if ($ku -and -not ($ku.KeyUsages -band ([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::NonRepudiation))) { continue }
        if (-not ($col | Where-Object { $_.Thumbprint -eq $c.Thumbprint })) { [void]$col.Add($c) }
      }
      $st.Close()
    } catch { }
  }
  if ($col.Count -eq 0) { Falha 'Nenhum certificado valido com chave privada foi encontrado no Windows. Se usa token (A3), conecte-o e confira se o programa do token esta instalado.' }
  Write-Host ''
  Write-Host '  Escolha o certificado na janela do Windows...'
  $sel = [Security.Cryptography.X509Certificates.X509Certificate2UI]::SelectFromCollection($col, 'Assinador diag',
    "Escolha o certificado para assinar:`n$doc", [Security.Cryptography.X509Certificates.X509SelectionFlag]::SingleSelection)
  if ($sel.Count -eq 0) { Falha 'Nenhum certificado escolhido. Nada foi assinado.' }
  $cert = $sel[0]
}

$cn = $cert.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
$emissor = $cert.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $true)
$partes = $cn -split ':'
$nome = $partes[0].Trim()
$cpf = ''
if ($partes.Count -gt 1 -and $partes[1] -match '^\d{11}$') { $cpf = $partes[1] }
else {
  # ICP-Brasil: SAN otherName 2.16.76.1.3.1 = nascimento(8) + CPF(11)
  $raw = [Text.Encoding]::GetEncoding(28591).GetString($cert.RawData)
  $i = $raw.IndexOf((-join [char[]](0x06, 0x05, 0x60, 0x4C, 0x01, 0x03, 0x01)))
  if ($i -ge 0) { $m = [regex]::Match($raw.Substring($i, [math]::Min(80, $raw.Length - $i)), '\d{19}'); if ($m.Success) { $cpf = $m.Value.Substring(8, 11) } }
}
$cpfMasc = if ($cpf.Length -eq 11) { '***.' + $cpf.Substring(3, 3) + '.' + $cpf.Substring(6, 3) + '-**' } else { 'nao informado' }
Write-Host "  Titular  : $nome"
Write-Host "  CPF      : $cpfMasc"
Write-Host "  Emissor  : $emissor"
Write-Host "  Validade : $($cert.NotAfter.ToString('dd/MM/yyyy'))"

# ------------------------------------------------------------- 3. selo + assinatura
try { $enc = [Text.Encoding]::GetEncoding(1252) } catch { $enc = [Text.Encoding]::GetEncoding(28591) }
$s = [Text.Encoding]::GetEncoding(28591).GetString($pdf)
$agora = Get-Date
$tz = $agora.ToString('zzz')                      # -03:00
$dataTxt = $agora.ToString('dd/MM/yyyy HH:mm:ss') + ' ' + $tz
$mTxt = 'D:' + $agora.ToString('yyyyMMddHHmmss') + ($tz -replace ':', "'") + "'"

function Preenche([string]$marcador, [string]$valor, [switch]$Exato) {
  $i = $s.IndexOf($marcador)
  if ($i -lt 0) { Falha "PDF preparado sem o marcador $marcador. Gere o pedido de novo." }
  while ($i -ge 0) {
    $fim = $i + $marcador.Length
    while ($fim -lt $s.Length -and $s[$fim] -eq '#') { $fim++ }
    $tam = $fim - $i
    $v = ($valor -replace '[\(\)\\]', ' ')
    if ($Exato -and $v.Length -ne $tam) { Falha "Tamanho inesperado no campo $marcador." }
    if ($v.Length -gt $tam) { $v = $v.Substring(0, $tam) }
    $b = $enc.GetBytes($v.PadRight($tam))
    [Array]::Copy($b, 0, $pdf, $i, $tam)
    $i = $s.IndexOf($marcador, $fim)
  }
}
Preenche '##DIAGNOME' $nome
Preenche '##DIAGCPF' $cpfMasc
Preenche '##DIAGDATA' $dataTxt
Preenche '##DIAGEMISSOR' $emissor
Preenche '##DIAGM' $mTxt -Exato

$br = [regex]::Match($s, '/ByteRange\s*\[\s*0\s+/\*{10}\s+/\*{10}\s+/\*{10}\s*\]')
if (-not $br.Success) { Falha 'Campo de assinatura nao encontrado no PDF.' }
$ini = $s.IndexOf('<' + ('0' * 64))
$fimC = $s.IndexOf('>', $ini) + 1
$total = $pdf.Length
$faixa = "/ByteRange [0 $ini $fimC $($total - $fimC)]"
if ($faixa.Length -gt $br.Length) { Falha 'Espaco do ByteRange insuficiente.' }
$b = [Text.Encoding]::ASCII.GetBytes($faixa.PadRight($br.Length))
[Array]::Copy($b, 0, $pdf, $br.Index, $b.Length)

$dados = New-Object byte[] ($ini + $total - $fimC)
[Array]::Copy($pdf, 0, $dados, 0, $ini)
[Array]::Copy($pdf, $fimC, $dados, $ini, $total - $fimC)

Write-Host ''
Write-Host '  Assinando... (com token A3 o Windows pede o PIN)'
try {
  $ci = New-Object Security.Cryptography.Pkcs.ContentInfo -ArgumentList (,$dados)
  $cms = New-Object Security.Cryptography.Pkcs.SignedCms -ArgumentList $ci, $true
  $signer = New-Object Security.Cryptography.Pkcs.CmsSigner -ArgumentList $cert
  $signer.DigestAlgorithm = New-Object Security.Cryptography.Oid('2.16.840.1.101.3.4.2.1')
  $signer.IncludeOption = [Security.Cryptography.X509Certificates.X509IncludeOption]::WholeChain
  [void]$signer.SignedAttributes.Add((New-Object Security.Cryptography.Pkcs.Pkcs9SigningTime -ArgumentList $agora))
  try { $cms.ComputeSignature($signer, $false) }
  catch {
    # sem acesso a cadeia completa (ex.: offline): inclui so o certificado do titular
    $signer.IncludeOption = [Security.Cryptography.X509Certificates.X509IncludeOption]::EndCertOnly
    $cms = New-Object Security.Cryptography.Pkcs.SignedCms -ArgumentList $ci, $true
    $cms.ComputeSignature($signer, $false)
  }
  $assin = $cms.Encode()
} catch { Falha ("Nao foi possivel assinar: " + $_.Exception.Message + ' (PIN incorreto, token desconectado ou operacao cancelada?)') }

$hex = [BitConverter]::ToString($assin) -replace '-', ''
if ($hex.Length -gt ($fimC - $ini - 2)) { Falha 'Assinatura maior que o espaco reservado.' }
$b = [Text.Encoding]::ASCII.GetBytes($hex)
[Array]::Copy($b, 0, $pdf, $ini + 1, $b.Length)

# ------------------------------------------------------------- 4. envio
Write-Host '  Enviando ao servidor...'
try {
  $wc2 = New-Object Net.WebClient
  $wc2.Headers['Content-Type'] = 'application/pdf'
  $resp = [Text.Encoding]::UTF8.GetString($wc2.UploadData($u, 'POST', $pdf)) | ConvertFrom-Json
} catch { Falha (Erro-Web $_) }

Write-Host ''
Write-Host "  ASSINADO: laudo $($resp.numero) por $($resp.assinante)" -ForegroundColor Green
Write-Host "  SHA-256 do PDF: $($resp.sha256)"
Write-Host '  Pode voltar ao navegador: a tela atualiza sozinha.'
if (-not $PfxTeste) { Start-Sleep -Seconds 6 }
exit 0

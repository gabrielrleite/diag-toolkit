# Visualizador de Coletas (diag-hardware)

Três módulos:

- **Remoção de hardware**: análise das coletas do `diag-hardware.ps1` (janela de remoção, linha do tempo, integridade, aba Saúde) e relatório técnico com anexos.
- **Laudos de manutenção**: laudo técnico numerado (`0001/2026`), com coleta vinculada (dados de saúde e achados automáticos), testes, peças, conclusão (reparado, aguardando peça, garantia, sem defeito, antieconômico, baixa), anexos e impressão. Cada alteração salva uma revisão.
- **Equipamentos**: histórico por patrimônio (coletas e laudos).
- **Downloads** (`http://SERVIDOR/download/`, link no topo):
  - *Diagnóstico do computador*: `diag-diagnostico.zip` (`diagnostico.bat`/`.ps1`) para manutenção: saúde, erros, dispositivos com problema, serviços, impressoras, rede e conectividade, ativação, antivírus, programas. Envia com `X-Tipo: diagnostico`; no site abre direto na aba Saúde e vira laudo com um clique.
  - *Remoção de hardware*: `diag-remocao.zip` (`diag-hardware.bat`/`.ps1`).
  - Os dois trazem `diag-servidor.cfg` preenchido (endereço + UPLOAD_TOKEN) e exigem o READ_TOKEN. Os scripts ficam em `web/coleta/`: atualizar o servidor atualiza o download.
  - *Agente diag*: `agente-diag.zip`, só para assinar laudos com certificado do Windows (A1/A3). `instalar-agente.bat` (sem admin) registra o link `diagassina:`.
- **Assinatura dos laudos**: botão *Assinar…* no laudo.
  - *Certificado digital*: usa o certificado **instalado no Windows** (A1 importado ou A3 em token). O navegador gera o PDF oficial com campo de assinatura e selo visível e abre o **Assinador diag** (link `diagassina:`), que mostra a janela de certificados do Windows (A3 pede o PIN), preenche o selo com titular/CPF mascarado/data, assina (PKCS#7 detached, SHA-256) e envia. O servidor confere integridade, assinatura, validade do certificado e se o PDF é exatamente o preparado; guarda e trava o laudo. Instalação do assinador em cada PC: `http://SERVIDOR/download/` › Agente diag.
  - *Assinatura física*: imprime com linhas em branco; depois *Enviar via assinada* registra a digitalização (PDF/JPG/PNG, com SHA-256) como versão oficial e trava o laudo.
  - *Baixar PDF*: PDF oficial sem assinatura (rascunhos saem com marca d'água).
- **Modelos de laudo** (Laudos › Modelos): título do documento, seções exibidas e seus nomes, testes padrão, conclusões permitidas, textos pré-preenchidos com {patrimonio}/{computador}/{setor}/{local}/{solicitante}/{chamado}/{data}, campos extras (texto, texto longo, data, lista; obrigatórios ou não), texto de encaminhamento e assinaturas adicionais. Vêm 5 modelos padrão (completo, baixa patrimonial, garantia, registro de atendimento, requisição de peças), que podem ser editados, desativados ou restaurados; novos modelos podem ser criados ou duplicados. Cada laudo guarda uma cópia do modelo usado.

Servidor web que recebe as coletas do `diag-hardware.ps1` e ajuda a analisar e gerar o relatório técnico.

## Subir

```
powershell -ExecutionPolicy Bypass -File .\iniciar.ps1
```

Na primeira vez ele cria o `.env` com tokens aleatórios, grava o token de envio no
`..\diag-scripts\diag-servidor.cfg`, sobe o container e mostra o token de leitura.
Nas próximas vezes (ex.: depois de atualizar o código) mantém os tokens e só reconstrói.

Manual: copie `.env.example` para `.env`, troque os tokens e rode `docker compose up -d --build`.

Abra http://IP-DO-SERVIDOR:8080

Os dados ficam no volume `coletas` (`/data` no container):
- `coletas/<id>.zip` e `coletas/<id>.json` (metadados do recebimento)
- `audit.log`: envios, recusas e downloads, com IP e horário

Backup: `docker run --rm -v diag-viewer_coletas:/data -v %cd%:/b alpine tar czf /b/coletas.tgz -C /data .`

## Configurar o envio nos PCs

Na pasta do script (pendrive), crie `diag-servidor.cfg`:

```
SERVIDOR=http://IP-DO-SERVIDOR:8080
TOKEN=<o mesmo UPLOAD_TOKEN do .env>
```

No menu, a opção **[4] Enviar ao servidor** fica SIM automaticamente quando o arquivo existe.
A opção **[7]** reenvia a última coleta se o envio falhou.

O script manda o SHA256 junto; o servidor recalcula e **recusa** o arquivo se não bater.
O comprovante fica em `<coleta>.zip.envio.txt`.

## Tokens

- `UPLOAD_TOKEN`: obrigatório para receber coletas.
- `READ_TOKEN`: se definido, a interface pede o token para listar/baixar. Recomendado.

O tráfego é HTTP. Use apenas na rede interna ou coloque atrás de um proxy HTTPS.

## API

| Método | Rota | |
|---|---|---|
| POST | /api/coletas | corpo = .zip; cabeçalhos `X-Token`, `X-Sha256`, `X-Computador`, `X-Patrimonio`, `X-Usuario`, `X-Arquivo` |
| GET | /api/coletas | lista (X-Token = READ_TOKEN se definido) |
| GET | /api/coletas/:id/zip | download |
| GET | /api/info | estado |
| GET/POST | /api/coletas/:id/anexos | lista / adiciona anexo (JPG, PNG, WEBP, GIF, PDF; até `ANEXO_MAX_MB`, padrão 25) |
| GET/PUT/DELETE | /api/coletas/:id/anexos/:aid | baixa / altera descrição / remove (o arquivo fica como `.removido`) |

| GET/POST | /api/laudos | lista / cria laudo |
| GET/PUT | /api/laudos/:id | lê / atualiza (envie `revisao` para detectar conflito) |
| ... | /api/laudos/:id/anexos[/:aid] | anexos do laudo |

| GET/POST | /api/modelos | lista / cria modelo |
| GET/PUT/DELETE | /api/modelos/:id | lê / altera / exclui (padrão não exclui) |
| POST | /api/modelos/:id/restaurar | volta um modelo padrão ao original |
| POST | /api/laudos/:id/preparar | PDF com campo de assinatura → ticket (15 min) |
| GET/POST | /api/assinatura/:ticket[/pdf] | usado pelo Assinador diag (autenticado pelo ticket) |
| GET | /api/laudos/:id/assinado | PDF assinado digitalmente |
| GET | /api/coleta/pacote.zip[?tipo=diagnostico] | scripts (remoção ou diagnóstico) com cfg preenchido |
| GET/POST | /api/laudos/:id/digitalizado | via física assinada |

Anexos, laudos e modelos usam o mesmo `READ_TOKEN` da interface.

## Sem Docker

`UPLOAD_TOKEN=xxx node server.js` (Node 18+). Ou abra `web/index.html` direto no navegador só para analisar .zip locais.

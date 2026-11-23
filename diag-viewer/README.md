# Central diag (diag-viewer)

Interface web para manutenção e patrimônio de TI. Tema claro, escuro ou automático (segue o sistema): botão no canto superior direito, com transição animada; a escolha fica salva no navegador. Fonte Inter embutida (`web/vendor/fonts`).

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
- **Recebimentos** (folhas de recebimento assinadas, com OCR): importa fotos ou digitalizações (JPG/PNG/WEBP ou PDF, vários de uma vez; cada página do PDF vira uma folha, renderizada no navegador com [pdf.js](https://github.com/mozilla/pdf.js) embutido em `web/vendor/pdfjs`) da folha com colunas SELB, DATA, LOCAL, CPF e NOME (várias entregas por folha).
  - O navegador acha a tabela sozinho, corrige perspectiva e rotação (foto de lado ou de cabeça para baixo) e mostra a grade detectada; os 4 cantos podem ser arrastados e há *Girar 90°*. Se a tabela não for identificada (ou a folha for de outro formato), *Digitar manualmente* abre a folha vazia com a imagem inteira para consulta; Enter no último campo cria a próxima linha.
  - Na tela aparecem só **Local, SELB e Data**: o OCR ([Tesseract.js](https://github.com/naptha/tesseract.js), português, embutido em `web/vendor/tesseract`, sem internet) lê essas colunas nas células com escrita, e tudo pode ser corrigido à mão. A imagem é lida no navegador; vai ao servidor só ao salvar.
  - CPF e nome/assinatura **não são digitados**: ao abrir o item, cada linha mostra a foto da linha na folha (clique para ampliar) e há o botão *Foto original*. Linha preenchida só com nome/assinatura também é registrada.
  - Leitura mais robusta: datas com a barra perdida ("1111/2026") ou com um dígito impossível trocado ("25/68/26" → 25/08/26, com aviso para conferir); SELB separado por ". "; formato aprendido dos SELBs já cadastrados (ex.: 1 letra + 4 dígitos) corrige letra lida no lugar de número ("A2A17" → A2417). SELB bem formado nunca é trocado por outro parecido (são sequenciais). Com locais/SELBs registrados, cada célula é lida em três versões da imagem (cinza, só a tinta, traço engrossado) e fica a leitura que faz sentido. Teste de precisão: `test/ocr-bench.js` (folhas sintéticas com letra irregular; 192 células: 94% → 97% de acerto com lista, datas 95% → 100%).
  - Ajuda para letra cursiva: a leitura de Local e SELB é comparada com os valores já cadastrados e corrigida pelo mais parecido (com aviso e opção de voltar ao que o OCR leu); leitura muito incerta fica vazia com a dica "ilegível", em vez de texto errado. Autocompletar com os valores já usados, *Preencher datas vazias* com a data da folha e Enter para ir ao próximo campo.
  - **Vários SELBs na mesma entrega**: separe com vírgula (também aceita `;`, `+`, " e " ou espaço entre códigos completos): `A123, A124`. O campo é normalizado para maiúsculas e sem repetidos, mostra a quantidade ("3 SELBs"), e cada SELB conta separadamente no histórico, nos filtros, na aba SELBs e no CSV (coluna *Qtd SELB*). Corrigir ou apagar um SELB em lote mexe só nele, mantendo os outros da entrega.
  - **Local pelo histórico do SELB**: se o SELB já tem entregas registradas, o local da última entrega preenche o campo quando ele está vazio ou a leitura é duvidosa (aviso "preenchido pelo histórico", com opção de voltar ao lido). Se o OCR leu outro local com boa confiança, o histórico aparece só como sugestão (*usar*). Vale também ao digitar ou corrigir o SELB; o local continua editável.
  - Data inválida e leitura com confiança < 60% ficam em vermelho. Cada linha tem *conferida*.
  - Controle: filtros por **SELB** e por **Local** (com sugestões, sem diferenciar acentos/maiúsculas; clicar num SELB ou local da tabela filtra por ele) e resumo do filtro (locais por onde o SELB passou, última entrega), busca livre por data/folha (clicar na linha abre a folha), filtro de não conferidos e exportação CSV (o mesmo SELB pode aparecer em várias entregas). Guarda a foto/PDF original (o botão abre o PDF na página da folha) e a folha retificada (anexos com SHA-256), revisões e auditoria.
  - Aba **Locais**: cadastro de locais com endereço completo (logradouro, número, complemento, bairro, cidade/UF, CEP, referência). Os nomes cadastrados entram nas sugestões e na correção do OCR, e o endereço aparece ao passar o mouse no local da lista. Lista dos locais usados nas entregas (com ou sem cadastro), com *Cadastrar*, *Corrigir para…* (troca em todas as folhas) e *Apagar* (o campo fica vazio e a linha volta para conferência).
  - Aba **SELBs**: cada SELB é uma impressora/scanner com **cadastro**: tipo, marca, modelo, nº de série, **IP** (vira link para o painel da impressora), colorida ou preto, **tinta ou toner**, as cores usadas (preto, azul/ciano, magenta, amarelo) e uma **observação com os códigos** das tintas/toners e da caixa. A lista mostra o equipamento, o total de itens já entregues (bolinhas nas cores), entregas, locais e última entrega; SELBs com mais de um local ficam destacados (*usar em todas* no local certo). Ações: *Cadastro*, e no menu ⋯ *Corrigir SELB…* (itens e cadastro vão junto), *Trocar local…* e *Apagar das entregas*.
  - **Monitoramento das impressoras**: a cada 5 minutos (`MONITOR_MIN`) o servidor faz um ping pequeno (16 bytes) em cada SELB com IP. Se não responder, confirma com um 2º ping e pelas portas de impressora (9100, 631, 515), para impressora que bloqueia ping não virar alarme falso. Impressora fora do ar aparece na **tela inicial** (painel vermelho com SELB, modelo, local, IP e há quanto tempo) e com um contador no menu *Recebimentos*; na aba SELBs, bolinha verde/vermelha no IP e *Verificar impressoras*. Quedas e retornos vão para o `audit.log`.
  - **Itens entregues** em cada linha: na conferência, para cada SELB da linha, marcar as tintas/toners de cada cor e a **caixa de manutenção** — toda impressora usa, entra sozinha; scanner não (com quantidade); só aparecem os suprimentos do cadastro do SELB, e *kit completo* marca todos. A lista de entregas e o CSV mostram os itens.
  - **OCR no servidor** (serviço `diag-ocr`, opcional): TrOCR, modelo treinado em letra à mão, rodando em CPU com ONNX Runtime. Na importação dá para escolher *Servidor (TrOCR)* ou *Navegador (Tesseract)*; se o servidor não estiver pronto ou falhar, a leitura volta para o navegador sozinha. Configuração: `OCR_URL` (ex.: `http://ocr:8000`). Ver `diag-ocr/` e `docs/INSTALAR-PORTAINER.txt`.
  - Aba **Treinamento** (modo treinamento, liga/desliga): cada linha conferida guarda a leitura original e o texto final de Local/SELB/Data (com o recorte da célula). Leituras corrigidas da mesma forma na maioria das vezes (60%+) viram correções aprendidas, aplicadas sozinhas com aviso (SELB bem formado nunca é trocado). Mostra o acerto do OCR por campo, motor e semana; *Esquecer* regra; exportar os exemplos (.zip com imagens e `rotulos.tsv`).
  - As correções em lote guardam a revisão anterior de cada folha (`.bak`) e ficam no `audit.log`.
  - Letra de forma e números costumam ser lidos bem; letra cursiva quase sempre precisa de correção manual. Outro layout de folha ou outras colunas digitadas: ajuste `FOLHA_MODELO` (`ler: true/false`) em `web/recebimentos.js`.
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
| GET/POST | /api/recebimentos[?linhas=1] | lista / cria folha de recebimento |
| GET/PUT/DELETE | /api/recebimentos/:id | lê / atualiza (com `revisao`) / remove (fica `.removido`) |
| ... | /api/recebimentos/:id/anexos[/:aid] | foto original e folha retificada |
| GET | /api/monitor | situação das impressoras com IP (online, desde, latência, local) |
| POST | /api/monitor/verificar | faz a verificação agora |
| GET | /api/receb-selbs | cadastros dos SELBs |
| PUT/DELETE | /api/receb-selbs/:selb | grava / exclui o cadastro (equipamento, `ip`, `cor`, `suprimento`, `cores`, `obs`; `caixa` é calculado) |
| GET/POST | /api/receb-locais | lista / cadastra local |
| PUT/DELETE | /api/receb-locais/:id | altera / exclui (fica em `removidos`) |
| POST | /api/recebimentos/lote | `{campo: 'local'\|'selb', de, para, selb?}` troca ou apaga (`para: ''`) em todas as folhas |
| GET/POST | /api/ocr/saude, /api/ocr | estado / leitura em lote pelo diag-ocr (`{imagens: [base64]}`) |
| GET/DELETE | /api/treino | estatísticas, regras e memória / apaga os exemplos |
| PUT | /api/treino/config | `{ativo}` liga/desliga o modo treinamento |
| POST | /api/treino/exemplos, /api/treino/esquecer | grava exemplos conferidos / esquece uma regra |
| GET | /api/treino/exportar.zip | imagens + `rotulos.tsv` |

Anexos, laudos, modelos e recebimentos usam o mesmo `READ_TOKEN` da interface.

## Sem Docker

`UPLOAD_TOKEN=xxx node server.js` (Node 18+). Ou abra `web/index.html` direto no navegador só para analisar .zip locais.

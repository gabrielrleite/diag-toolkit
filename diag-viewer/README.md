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
  - **Monitoramento das impressoras**: a cada 5 minutos (`MONITOR_MIN`) o servidor faz um ping com o menor pacote possível (0 bytes de dados: pacote IP de 28 bytes) em cada SELB com IP. Se não responder, confirma com um 2º ping e pelas portas de impressora (9100, 631, 515), para impressora que bloqueia ping não virar alarme falso. Impressora fora do ar aparece na **tela inicial** (painel vermelho com SELB, modelo, local, IP e há quanto tempo) e com um contador no menu *Recebimentos*; na aba SELBs, bolinha verde/vermelha no IP e *Verificar impressoras*. Quedas e retornos vão para o `audit.log`.
  - Aba **Impressoras**: situação, barra das últimas 24 h (faixas de 30 min), disponibilidade em 24 h e 7 dias, quedas em 7 dias e o **histórico de quedas** (caiu em, voltou em, tempo fora). Clicar numa impressora abre o **histórico de ping**: linha do tempo de 24 h / 7 / 30 dias (faixas de 15 min), latência das últimas 24 h e as quedas do período. **Pausar** o monitoramento inteiro ou só uma impressora (1 h, 8 h, 24 h ou até retomar); pausado, a tela inicial avisa e não há alerta. Histórico em `recebimentos/monitor/` (`MONITOR_DIAS`, padrão 30 dias; quedas por ~1 ano).
  - **Tinta, toner e caixa de manutenção pela rede (SNMP)**: a cada 6 h (`SUPRIMENTOS_HORAS`) o servidor lê, de cada SELB com IP, os níveis informados pela impressora (Printer MIB, RFC 3805: nome, cor, capacidade e nível, mais modelo e nº de série). No cadastro do SELB: campo *Comunidade SNMP* (padrão `public`) e **Testar leitura**, que mostra na hora o que a impressora respondeu. Na aba Impressoras, os níveis por cor (barras nas cores reais) e *Ler suprimentos*; no detalhe, as barras, *Ler agora* e o histórico dos níveis. A caixa de manutenção aparece como **vida útil** (100% = nova); se a impressora não a informa, a linha mostra *não informada pela impressora*. Cada cartucho mostra o **código** (o que a impressora informa ou, na falta, o anotado na observação do SELB, marcado com *). Na tela inicial, aviso quando tinta/toner ou a vida útil da caixa está em 25% ou menos. Consulta de ~100 bytes por impressora; pula as fora do ar e as pausadas. Histórico em `recebimentos/monitor/suprimentos-AAAA-MM.jsonl` (`SUPRIMENTOS_DIAS`, padrão 365). Outras variáveis: `SNMP_COMUNIDADE` (padrão `public`) e `SNMP_PORTA` (161). Cliente SNMP próprio em `snmp.js` (v2c, com v1 como alternativa), sem dependências.
  - Aba **Suprimentos**: resumo de todas as impressoras, um cartão por impressora com as barras de cada cor, o código do cartucho e a caixa (vida útil); busca (SELB, local, modelo, código), filtros *Com alerta* / *Sem leitura*, ordem por menor nível, SELB ou local, e a lista **Para comprar / separar** (itens em 25% ou menos agrupados por código, com as impressoras e a quantidade).
  - **Cadastro pela rede**: no cadastro do SELB, *Testar leitura* mostra o que a impressora informa (marca, modelo, nº de série, tipo, cores) e *Preencher o cadastro* copia para o formulário. Na aba SELBs, *Completar pela rede* lista, para todas as impressoras com IP, o que difere do cadastro (marcar/desmarcar e aplicar). Impressora só preto entra como **toner**; multifuncional é reconhecida pelo nome do modelo (MFP, MFC/DCP, IM/MP, EcoTank...).
  - **Sublocais (salas)**: na aba Locais, marque os locais que ficam dentro de um mesmo lugar e use *Unificar selecionados* para escolher o principal; os outros viram salas dele (um nível). As entregas mantêm o nome da sala; o filtro de local pelo principal traz as salas, e impressoras, suprimentos e alertas mostram "Principal › Sala". Sala sem endereço usa o do principal. *Desvincular* desfaz; no formulário do local há o campo *Sala / sublocal de*.
  - **Categorias de locais** (personalizáveis): na aba Locais, *Categorias* cria, renomeia, colore e exclui (há sugestões: Escola, Unidade de saúde...). *Definir categoria* aplica aos locais marcados; o formulário do local também tem o campo. Sala sem categoria usa a do principal. Filtro por categoria em Locais, Entregas e Suprimentos.
  - Aba **Personalizar**: altera os textos da aba Recebimentos e dos submenus (título e subtítulo do módulo, nome no menu, nomes das abas, títulos e textos de ajuda), com prévia, `**negrito**` e quebra de linha; vazio = texto padrão; vale para todos (`recebimentos/textos.json`).
  - **SELB e IP sem repetição**: *Cadastrar SELB* não sobrescreve um SELB que já tem cadastro (aviso com link para o cadastro dele) e um IP já usado por outro SELB é recusado (no formulário e no servidor, 409). Repetições antigas aparecem com o selo *IP repetido* e no filtro *só IP repetido*; editar outros campos delas continua permitido. O campo IP já vem com `192.168.` (só o prefixo = sem IP).
  - **Local vinculado ao SELB** (mesmo sem entrega): campo *Local vinculado* no cadastro ou *Vincular local…* no menu ⋯ da aba SELBs (cria o cadastro se faltar; vazio desvincula). Prevalece sobre o local das folhas em impressoras, suprimentos e alertas, e preenche o local na conferência das folhas ("preenchido pelo local vinculado"). O local vinculado que ainda não existe é cadastrado na aba Locais automaticamente (também na subida do servidor, para vínculos antigos). As entregas já registradas não mudam; na aba Locais aparece "n SELBs vinculados".
  - **Minimizar**: as salas ficam recolhidas sob o local principal (seta ao lado do nome; *Expandir salas* / *Minimizar salas*; a busca abre o principal da sala encontrada). Os painéis de Locais, Alertas e Quedas (Impressoras) e os grupos da aba Personalizar também minimizam pela seta do título. O navegador lembra o que ficou aberto.
  - Filtros da aba Locais (*Mostrar*): nos cadastrados — sem endereço, sem categoria, com salas, salas, sem entregas, com/sem SELB vinculado; nos locais das entregas — sem cadastro, cadastrados, sem categoria, sem endereço, salas / não são salas (com contagem), busca por nome ou SELB e *Cadastrar os sem cadastro* de uma vez.
  - **Códigos por modelo** (aba Suprimentos): a maioria das impressoras não informa o código do cartucho por SNMP. A tabela tem um código por modelo e cor (e caixa), aprendido do que alguma impressora do modelo informa ou do que foi anotado na observação de um SELB, e editável (digitado prevalece; vazio volta ao aprendido). Vale para todas as impressoras do modelo: cartões, lista de compras, *Testar leitura* e alertas. Ordem: impressora > observação do SELB > tabela do modelo. Gravado em `recebimentos/codigos.json` (`GET/PUT /api/suprimentos/codigos`).
  - **Offline (impressoras)**: sem conexão com o servidor, as abas SELBs, Impressoras e Suprimentos continuam abrindo com a última cópia dos dados (guardada no navegador, IndexedDB). Alterações no cadastro do SELB (inclusive vincular local), nos códigos por modelo e nas pausas entram numa fila e são enviadas na ordem quando o servidor volta (tentativa a cada 20 s, ao voltar a rede ou em *Tentar agora*). As mesmas regras do servidor valem offline (SELB/IP repetido). O que o servidor recusar fica marcado com o motivo para descartar. Uma barra no canto mostra a situação e a fila. Ping e leitura SNMP só o servidor faz. Para **abrir a página** sem o servidor (não só manter aberta) o navegador precisa de HTTPS ou localhost (service worker `web/sw.js`); em `http://IP` funciona com a página já aberta — ou ative no Chrome `chrome://flags/#unsafely-treat-insecure-origin-as-secure` com o endereço do servidor.
  - **Instalar no celular (app)**: a Central é um PWA (`web/manifest.webmanifest`, ícones em `web/icons/`, service worker `web/sw.js`). No celular aparece o aviso *Instale a Central diag no celular* (dispensável) e no menu o botão *Instalar app*: no Chrome/Edge abre a instalação direto; no iPhone mostra o passo a passo do Safari (*Compartilhar → Adicionar à Tela de Início*). Instalada, abre em tela cheia com atalhos para Impressoras, Suprimentos e SELBs, e a parte das impressoras funciona offline. Instalar como app exige **HTTPS** (ou localhost); em `http://IP` o celular só cria um atalho — no Android dá para liberar o endereço em `chrome://flags` (*Insecure origins treated as secure*), no iPhone só com HTTPS.
  - **Alertas**: registrados ao cruzar 25% (e de novo em 5%) de tinta/toner ou da vida útil da caixa, e quando uma impressora cai ou volta. Ficam na aba Impressoras (*Alertas, 30 dias*) e em `recebimentos/monitor/alertas.json`. Com `ALERTA_WEBHOOK` (URL de webhook do Teams, Google Chat, Discord, Slack ou um tópico do ntfy.sh) cada alerta também é enviado para lá; botão *Enviar alerta de teste*. Exemplo de texto: `🟡 Toner amarelo baixo: 18% — R1 · Ricoh IM C3000 · Sala 3 · código 842284`.
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
| POST/DELETE | /api/monitor/pausa | `{alvo: 'todos' \| SELB, horas \| null}` pausa / `?alvo=` retoma |
| GET | /api/monitor/historico?selb=&dias= | pings e quedas de um SELB |
| GET | /api/monitor/quedas?dias= | todas as quedas do período |
| GET | /api/monitor/alertas?dias= | alertas do período (`webhook`: se o envio externo está ligado) |
| POST | /api/monitor/alerta-teste | envia uma mensagem de teste ao `ALERTA_WEBHOOK` |
| GET | /api/suprimentos | últimos níveis lidos por SELB |
| POST | /api/suprimentos/ler | `{selb?}` lê agora (um ou todos) |
| POST | /api/suprimentos/testar | `{ip, comunidade}` leitura avulsa, sem gravar |
| GET | /api/suprimentos/historico?selb=&dias= | histórico dos níveis |
| GET | /api/suprimentos/cadastro | dados do equipamento lidos pela rede (marca, modelo, série, tipo, cores, tinta/toner) que diferem do cadastro |
| GET/PUT | /api/receb-locais/categorias | categorias dos locais `[{id, nome, cor}]` (PUT grava a lista inteira) |
| POST | /api/receb-locais/categorizar | `{nomes: [...], categoria}` define a categoria de vários locais |
| GET/PUT | /api/receb-textos | textos personalizados da aba Recebimentos `{chave: texto}` (vazio = padrão) |
| POST | /api/receb-locais/unificar | `{principal, sublocais: [nomes]}` torna os locais salas/sublocais do principal |
| GET | /api/receb-selbs | cadastros dos SELBs |
| PUT/DELETE | /api/receb-selbs/:selb | grava / exclui o cadastro (equipamento, `ip`, `cor`, `suprimento`, `cores`, `obs`, `local`; `caixa` é calculado) |
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

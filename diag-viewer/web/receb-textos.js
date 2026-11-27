'use strict';
// ================================================================== textos personalizáveis da aba Recebimentos
// Cada texto tem um padrão; o personalizado fica no servidor (recebimentos/textos.json) e vale para todos.
// Marcação simples nos textos: **negrito** e quebra de linha.
const TEXTOS_RECEB = [
  ['Módulo', [
    ['modulo.titulo', 'Título do módulo (cabeçalho e menu lateral)', 'Recebimentos'],
    ['modulo.sub', 'Subtítulo do cabeçalho', 'Folhas de entrega assinadas, lidas por OCR, com locais e SELBs'],
  ]],
  ['Abas (submenus)', [
    ['aba.entregas', 'Aba Entregas', 'Entregas'],
    ['aba.locais', 'Aba Locais', 'Locais'],
    ['aba.selbs', 'Aba SELBs', 'SELBs'],
    ['aba.impressoras', 'Aba Impressoras', 'Impressoras'],
    ['aba.suprimentos', 'Aba Suprimentos', 'Suprimentos'],
    ['aba.treino', 'Aba Treinamento', 'Treinamento'],
    ['aba.textos', 'Aba Personalizar', 'Personalizar'],
  ]],
  ['Entregas', [
    ['entregas.folhas', 'Título: lista de folhas', 'Folhas de recebimento'],
    ['entregas.importar', 'Botão de importar', 'Importar folhas (OCR)'],
    ['entregas.lista', 'Título: lista de entregas', 'Recebimentos'],
  ]],
  ['Locais', [
    ['locais.titulo', 'Título: locais cadastrados', 'Locais cadastrados'],
    ['locais.ajuda', 'Texto de ajuda (locais cadastrados)', 'Salas, blocos e setores podem ser **sublocais** de um local principal: marque-os (aqui ou nos locais das entregas, abaixo) e use **Unificar selecionados**. As entregas continuam com o nome da sala; o principal agrupa tudo nos filtros, nas impressoras e nos alertas. Use **categorias** (Escola, Unidade de saúde...) para agrupar e filtrar.'],
    ['locais.usados', 'Título: locais usados nas entregas', 'Locais usados nas entregas'],
    ['locais.usadosAjuda', 'Texto de ajuda (locais usados)', 'Nomes como aparecem nas folhas. Leituras erradas do OCR podem ser corrigidas para o nome certo ou apagadas de todas as entregas (a linha volta para conferência).'],
  ]],
  ['SELBs', [
    ['selbs.titulo', 'Título', 'SELBs'],
    ['selbs.ajuda', 'Texto de ajuda', 'Cada SELB é uma impressora ou scanner. No cadastro ficam o equipamento, se é colorida ou preto, o IP, se usa **tinta ou toner**, as cores, a caixa de manutenção e os **códigos dos suprimentos** (observação).\nSELB raramente muda de lugar: mais de um local costuma ser leitura errada (use **usar em todas** no local certo).'],
  ]],
  ['Impressoras', [
    ['impressoras.titulo', 'Título: monitoramento', 'Monitoramento das impressoras'],
    ['impressoras.alertas', 'Título: alertas', 'Alertas (30 dias)'],
    ['impressoras.quedas', 'Título: histórico de quedas', 'Histórico de quedas (30 dias)'],
  ]],
  ['Suprimentos', [
    ['suprimentos.titulo', 'Título', 'Tinta, toner e caixa de manutenção'],
    ['suprimentos.compras', 'Título: lista de compras', 'Para comprar / separar'],
    ['suprimentos.rodape', 'Nota de rodapé', 'Caixa de manutenção em % de vida útil (100% = nova). n/i = a impressora não informa. * código que a impressora não informa: da observação do SELB ou da tabela de códigos do modelo.'],
  ]],
  ['Treinamento', [
    ['treino.titulo', 'Título', 'Modo treinamento'],
  ]],
];
const TXT_PADRAO = Object.fromEntries(TEXTOS_RECEB.flatMap(([, l]) => l.map(([k, , v]) => [k, v])));
const RT = { custom: {}, carregado: false };
const textoReceb = k => (RT.custom[k] || TXT_PADRAO[k] || '');
// HTML (com **negrito** e quebras de linha) e texto puro
const marcacaoHtml = v => esc(v).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
const TX = k => marcacaoHtml(textoReceb(k));
const Tp = k => textoReceb(k).replace(/\*\*(.+?)\*\*/g, '$1');

async function carregarTextosReceb(forcar = false) {
  if (RT.carregado && !forcar) return RT.custom;
  const r = await api('api/receb-textos').catch(() => null);
  if (r && r.ok) { RT.custom = await r.json().catch(() => ({})); RT.carregado = true; }
  aplicarTextosMenu();
  return RT.custom;
}
// nome do módulo no menu lateral (e no menu do celular)
function aplicarTextosMenu() {
  document.querySelectorAll('[data-mod-nome="receb"]').forEach(e => { e.textContent = Tp('modulo.titulo'); });
}

// ---------------------------------------------------------------- aba Personalizar
async function renderTextosReceb() {
  const el = $('#mod-receb');
  el.innerHTML = abasReceb('textos') + '<div class="panel">Carregando...</div>';
  if (!(await needServer(el))) return;
  await carregarTextosReceb(true);
  el.innerHTML = abasReceb('textos') + `
    <div class="panel">
      <div class="head-row"><h2>Textos da aba Recebimentos</h2><div class="filters" style="margin:0">
        <button class="btn ghost" id="txPadrao">Restaurar todos</button><button class="btn" id="txSalvar">Salvar textos</button></div></div>
      <p class="muted">Altere títulos, nomes das abas e textos de ajuda. Campo vazio = texto padrão. Use <b>**negrito**</b> para destacar e Enter para quebrar linha. Vale para todos os usuários.</p>
      ${TEXTOS_RECEB.map(([grupo, itens]) => `<fieldset class="tx-grupo" data-recolher="tx-${esc(nrm(grupo).replace(/ /g, '-'))}"><legend>${esc(grupo)}</legend>
        ${itens.map(([k, rot, pad]) => {
          const longo = pad.length > 70, v = RT.custom[k] || '';
          return `<div class="tx-campo ${v ? 'mudou' : ''}" data-k="${k}">
            <label for="tx-${k}">${esc(rot)}${v ? ' <span class="badge ok">personalizado</span>' : ''}</label>
            ${longo ? `<textarea id="tx-${k}" rows="3" maxlength="1000" placeholder="${esc(pad)}">${esc(v)}</textarea>` : `<input id="tx-${k}" value="${esc(v)}" maxlength="200" placeholder="${esc(pad)}">`}
            <div class="tx-pre"><small class="muted">Fica assim:</small> <span>${marcacaoHtml(v || pad)}</span>
              ${v ? '<button type="button" class="linklike" data-pad>usar o padrão</button>' : ''}</div></div>`;
        }).join('')}</fieldset>`).join('')}
      <div class="dlg-actions"><button class="btn" id="txSalvar2">Salvar textos</button></div>
    </div>`;
  ligarRecolhiveis(el);
  el.querySelectorAll('.tx-campo').forEach(c => {
    const inp = c.querySelector('input, textarea'), pre = c.querySelector('.tx-pre span');
    inp.addEventListener('input', () => { pre.innerHTML = marcacaoHtml(inp.value.trim() || TXT_PADRAO[c.dataset.k]); c.classList.toggle('mudou', !!inp.value.trim()); });
    const b = c.querySelector('[data-pad]');
    if (b) b.addEventListener('click', () => { inp.value = ''; inp.dispatchEvent(new Event('input')); b.remove(); });
  });
  const salvar = async corpo => {
    const r = await api('api/receb-textos', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }).catch(() => null);
    if (!r || !r.ok) return alert('Não foi possível salvar os textos.');
    RT.custom = await r.json(); aplicarTextosMenu();
    if (typeof showModule === 'function') showModule('receb');
    renderTextosReceb();
  };
  const coletar = () => Object.fromEntries([...el.querySelectorAll('.tx-campo')].map(c => [c.dataset.k, c.querySelector('input, textarea').value.trim()]).filter(([k, v]) => v && v !== TXT_PADRAO[k]));
  $('#txSalvar').addEventListener('click', () => salvar(coletar()));
  $('#txSalvar2').addEventListener('click', () => salvar(coletar()));
  $('#txPadrao').addEventListener('click', () => { if (confirm('Voltar todos os textos ao padrão?')) salvar({}); });
}

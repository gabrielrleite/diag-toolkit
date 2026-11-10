'use strict';
/*
  Módulos "Laudos de manutenção" e "Equipamentos" + navegação entre módulos.
  Depende de app.js (utilitários, api, srv, coletas) e saude.js.
*/

const CONCLUSAO_TXT = {
  '': '—',
  reparado: 'Reparado – equipamento em funcionamento',
  aguardando_peca: 'Reparo pendente – aguardando peça',
  garantia: 'Encaminhar à assistência técnica / garantia',
  sem_defeito: 'Sem defeito constatado',
  antieconomico: 'Reparo antieconômico – recomenda-se substituição',
  baixa: 'Inservível – recomenda-se baixa patrimonial',
};
const CONCLUSAO_CLS = { reparado: 'ok', sem_defeito: 'ok', aguardando_peca: 'warn', garantia: 'warn', antieconomico: 'bad', baixa: 'bad' };
const STATUS_TXT = { rascunho: 'Rascunho', emitido: 'Emitido', cancelado: 'Cancelado' };
const STATUS_CLS = { rascunho: 'warn', emitido: 'ok', cancelado: 'bad' };
const RESULTADO_TXT = { '': '—', ok: 'Aprovado', falha: 'Reprovado', na: 'Não aplicável' };
const ACAO_TXT = { '': '—', substituida: 'Substituída', a_substituir: 'A substituir', recuperada: 'Recuperada', removida: 'Removida' };
const TESTES_PADRAO = [
  'Inicialização (POST / BIOS)', 'Fonte de alimentação', 'Memória RAM', 'Armazenamento (SMART / leitura)',
  'Temperatura e ventilação', 'Vídeo / monitor', 'Rede', 'Periféricos (teclado, mouse, USB)', 'Sistema operacional',
];
const novoLaudo = () => ({
  id: '', numero: '', revisao: 0, status: 'rascunho', coletaId: '',
  patrimonio: '', computador: '', setor: '', local: '', solicitante: '', chamado: '', dataAbertura: toLocalInput(new Date()).slice(0, 10),
  problema: '', diagnostico: '', solucao: '', conclusao: '', justificativa: '', recomendacoes: '', observacoes: '',
  testes: TESTES_PADRAO.map(nome => ({ nome, resultado: '', obs: '' })), pecas: [], assinatura: {}, snapshot: null,
});
const LD = { list: [], cur: null, dirty: false, anexos: [], q: '', fStatus: '', fConc: '', timer: null };
const para = t => esc(t || '').replace(/\n/g, '<br>');
const dataBR = iso => { if (!iso) return '—'; const d = parseDate(iso.length === 10 ? iso + ' 00:00:00' : iso) || new Date(iso); return isNaN(d) ? esc(iso) : fmt(d).slice(0, 10); };

// ================================================================== navegação
const MODS = ['coletas', 'laudos', 'equip'];
function showModule(mod) {
  if (!MODS.includes(mod)) mod = 'coletas';
  document.querySelectorAll('[data-mod]').forEach(b => b.classList.toggle('on', b.dataset.mod === mod));
  $('#mod-coletas').hidden = mod !== 'coletas';
  $('#mod-laudos').hidden = mod !== 'laudos';
  $('#mod-equip').hidden = mod !== 'equip';
  $('#act-coletas').hidden = mod !== 'coletas';
  document.title = { coletas: 'Remoção de hardware', laudos: 'Laudos de manutenção', equip: 'Equipamentos' }[mod] + ' · Visualizador';
}

async function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [mod, arg] = h.split('/');
  if (MD.dirty && MD.cur && !(mod === 'modelo' && (arg === MD.cur.id || !MD.cur.id)) && !confirm('Há alterações não salvas no modelo. Sair mesmo assim?')) {
    history.replaceState(null, '', '#modelo/' + (MD.cur.id || 'novo')); return;
  }
  if (mod !== 'modelo') { MD.dirty = false; MD.cur = null; }
  if (['laudos', 'laudo', 'modelos', 'modelo'].includes(mod)) {
    if (LD.dirty && LD.cur && !(mod === 'laudo' && arg === LD.cur.id) && !confirm('Há alterações não salvas no laudo. Sair mesmo assim?')) {
      history.replaceState(null, '', '#laudo/' + (LD.cur.id || 'novo')); return;
    }
    showModule('laudos');
    if (mod === 'modelos') { LD.dirty = false; LD.cur = null; return renderModelos(); }
    if (mod === 'modelo') { LD.dirty = false; LD.cur = null; return editModelo(arg || 'novo'); }
    if (mod === 'laudo' && arg) return openLaudo(arg);
    LD.dirty = false; LD.cur = null;
    return renderLaudoList();
  }
  if (mod === 'equip') { showModule('equip'); return renderEquip(arg || ''); }
  showModule('coletas');
}
window.addEventListener('hashchange', route);
document.addEventListener('click', e => {
  const b = e.target.closest('[data-mod]');
  if (b) { e.preventDefault(); location.hash = b.dataset.mod === 'coletas' ? '' : b.dataset.mod; if (b.dataset.mod === 'coletas') showModule('coletas'); }
});
window.addEventListener('beforeunload', e => { if (LD.dirty || MD.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ================================================================== acesso ao servidor
async function needServer(el) {
  if (location.protocol === 'file:') {
    el.innerHTML = '<div class="panel"><h2>Requer o servidor</h2><p>Este módulo guarda os dados no servidor. Abra a interface pelo endereço do servidor (ex.: http://IP-DO-SERVIDOR).</p></div>';
    return false;
  }
  const r = await api('api/laudos').catch(() => null);
  if (!r) { el.innerHTML = '<div class="panel"><p class="err">Servidor indisponível.</p></div>'; return false; }
  if (r.status === 401) {
    el.innerHTML = `<div class="panel"><h2>Token de leitura</h2><p>Este servidor exige o token de leitura.</p>
      <div class="filters"><input id="mtok" type="password" placeholder="token de leitura" style="min-width:280px"><button class="btn small" id="mtokOk">Entrar</button></div></div>`;
    const go = () => { srv.token = $('#mtok').value.trim(); try { sessionStorage.setItem('diagReadToken', srv.token); } catch {} route(); };
    $('#mtokOk').addEventListener('click', go);
    $('#mtok').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    return false;
  }
  LD.list = r.ok ? await r.json() : [];
  return true;
}
async function loadColetasList() {
  const r = await api('api/coletas').catch(() => null);
  if (r && r.ok) srv.list = await r.json();
  return srv.list || [];
}

// ================================================================== lista de laudos
async function renderLaudoList() {
  const el = $('#mod-laudos');
  el.innerHTML = '<div class="panel">Carregando...</div>';
  if (!(await needServer(el))) return;
  el.innerHTML = `
    <div class="panel">
      <div class="head-row"><h2>Laudos de manutenção</h2><div class="filters" style="margin:0"><a href="#modelos" class="btn ghost">Modelos</a><button class="btn" id="ldNovo">Novo laudo</button></div></div>
      <div class="filters">
        <label>Buscar <input type="search" id="ldQ" value="${esc(LD.q)}" placeholder="nº, patrimônio, setor, problema..."></label>
        <label>Situação <select id="ldSt"><option value="">Todas</option>${Object.entries(STATUS_TXT).map(([k, t]) => `<option value="${k}" ${LD.fStatus === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Conclusão <select id="ldCo"><option value="">Todas</option>${Object.entries(CONCLUSAO_TXT).filter(([k]) => k).map(([k, t]) => `<option value="${k}" ${LD.fConc === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      </div>
      <div id="ldTable"></div>
    </div>`;
  const draw = () => {
    const q = LD.q.trim().toLowerCase();
    const rows = LD.list.filter(l => (!LD.fStatus || l.status === LD.fStatus) && (!LD.fConc || l.conclusao === LD.fConc) &&
      (!q || [l.numero, l.patrimonio, l.computador, l.setor, l.problema, l.chamado, l.modeloNome].join(' ').toLowerCase().includes(q)));
    $('#ldTable').innerHTML = !LD.list.length ? '<p class="muted">Nenhum laudo ainda. Clique em "Novo laudo".</p>' :
      `<div class="tablewrap"><table class="clickable"><thead><tr><th class="nosort">Nº</th><th class="nosort">Modelo</th><th class="nosort">Aberto em</th><th class="nosort">Equipamento</th><th class="nosort">Setor</th><th class="nosort">Problema</th><th class="nosort">Conclusão</th><th class="nosort">Situação</th></tr></thead><tbody>
      ${rows.map(l => `<tr data-open-laudo="${esc(l.id)}">
        <td><b>${esc(l.numero)}</b>${l.revisao > 1 ? `<br><small>rev. ${l.revisao}</small>` : ''}</td>
        <td><small>${esc(l.modeloNome || '—')}</small></td>
        <td class="t">${fmt(new Date(l.criadoEm)).slice(0, 10)}</td>
        <td>${esc(l.patrimonio || '—')}<br><small>${esc(l.computador || '')}</small></td>
        <td>${esc(l.setor || '—')}</td>
        <td>${esc(l.problema || '')}${l.anexos ? ` <small>· ${l.anexos} anexo(s)</small>` : ''}</td>
        <td>${l.conclusao ? `<span class="badge ${CONCLUSAO_CLS[l.conclusao] || ''}">${esc(CONCLUSAO_TXT[l.conclusao].split(' –')[0])}</span>` : '—'}</td>
        <td><span class="badge ${STATUS_CLS[l.status]}">${STATUS_TXT[l.status]}</span>${l.assinado ? `<br><span class="badge ok" style="margin-top:3px">✓ assinado ${l.assinado === 'digital' ? 'digitalmente' : '(via física)'}</span>` : ''}</td></tr>`).join('')}
      </tbody></table></div>`;
    $('#ldTable').querySelectorAll('[data-open-laudo]').forEach(tr => tr.addEventListener('click', () => { location.hash = 'laudo/' + tr.dataset.openLaudo; }));
  };
  $('#ldNovo').addEventListener('click', () => { location.hash = 'laudo/novo'; });
  $('#ldQ').addEventListener('input', e => { LD.q = e.target.value; draw(); });
  $('#ldSt').addEventListener('change', e => { LD.fStatus = e.target.value; draw(); });
  $('#ldCo').addEventListener('change', e => { LD.fConc = e.target.value; draw(); });
  draw();
}

// ================================================================== abrir / novo
let pendingNovo = null; // dados para pré-preencher um laudo novo (vindo de coleta/equipamento)

async function openLaudo(id) {
  const el = $('#mod-laudos');
  if (LD.cur && (LD.cur.id === id || (id === 'novo' && !LD.cur.id))) return; // já aberto
  el.innerHTML = '<div class="panel">Carregando...</div>';
  if (!(await needServer(el))) return;
  await Promise.all([loadColetasList(), loadModelos()]);
  LD.anexos = [];
  if (id === 'novo') {
    LD.cur = novoLaudo();
    const pre = pendingNovo; pendingNovo = null;
    if (pre) {
      Object.assign(LD.cur, pre.campos || {});
      if (pre.coletaId) await vincularColeta(pre.coletaId, true);
    }
    LD.dirty = false;
    return renderModelPicker();
  } else {
    const r = await api('api/laudos/' + encodeURIComponent(id));
    if (!r.ok) { el.innerHTML = `<div class="panel"><p class="err">Laudo ${esc(id)} não encontrado.</p><a class="btn small ghost" href="#laudos">Voltar</a></div>`; return; }
    LD.cur = await r.json();
    await loadLaudoAnexos();
  }
  LD.dirty = false;
  renderEditor();
}

async function vincularColeta(cid, silencioso) {
  const L = LD.cur;
  if (!cid) { L.coletaId = ''; L.snapshot = null; return; }
  const meta = (srv.list || []).find(m => m.id === cid);
  try {
    const r = await api(`api/coletas/${encodeURIComponent(cid)}/zip`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    const files = await readZip(buf);
    let infoTxt = '';
    for (const [k, b] of files) if (/(^|\/)01_maquina\.txt$/i.test(k)) infoTxt = decodeText(b);
    const info = parseInfoText(infoTxt);
    const saude = readSaudeFrom(files);
    L.coletaId = cid;
    L.snapshot = snapshotColeta({ id: cid, info, saude, zipHash: await sha256Hex(new Uint8Array(buf)), recebidoEm: meta ? meta.recebidoEm : '' });
    if (!L.patrimonio || /^NAO /.test(L.patrimonio)) L.patrimonio = /^NAO /.test(L.snapshot.patrimonio) ? '' : L.snapshot.patrimonio;
    if (!L.computador) L.computador = L.snapshot.computador;
    markDirty();
  } catch (e) {
    if (!silencioso) alert('Não foi possível carregar a coleta: ' + e.message);
  }
}

// ================================================================== modelos (uso no laudo)
const SEC_KEYS = ['identificacao', 'solicitacao', 'diagnostico', 'testes', 'coleta', 'achados', 'analise', 'servicos', 'pecas', 'conclusao', 'recomendacoes', 'observacoes', 'anexos'];
const SEC_TITULOS = {
  identificacao: 'Identificação do equipamento', solicitacao: 'Solicitação', diagnostico: 'Diagnóstico', testes: 'Testes realizados',
  coleta: 'Dados coletados automaticamente', achados: 'Achados automáticos', analise: 'Análise técnica', servicos: 'Serviços executados',
  pecas: 'Peças', conclusao: 'Conclusão', recomendacoes: 'Recomendações', observacoes: 'Observações', anexos: 'Anexos',
};
const SEC_CAMPO_TXT = { identificacao: 'Identificação', solicitacao: 'Solicitação', diagnostico: 'Diagnóstico', servicos: 'Serviços', conclusao: 'Conclusão' };
const TIPO_CAMPO_TXT = { texto: 'Texto curto', textarea: 'Texto longo', data: 'Data', selecao: 'Lista de opções' };
const MODELO_FALLBACK = {
  id: '', nome: 'Laudo técnico completo', titulo: 'Laudo Técnico', subtitulo: 'Manutenção de equipamento de informática', rotuloNumero: 'Laudo nº',
  secoes: Object.fromEntries(SEC_KEYS.map(k => [k, { on: true, titulo: SEC_TITULOS[k] }])), testes: TESTES_PADRAO,
  conclusoes: Object.keys(CONCLUSAO_TXT).filter(Boolean), conclusaoPadrao: '', textos: {}, camposExtras: [], encaminhamento: '', assinaturasExtras: [],
};
LD.modelos = [];
async function loadModelos() {
  const r = await api('api/modelos').catch(() => null);
  if (r && r.ok) LD.modelos = await r.json();
  return LD.modelos;
}
function modeloDe(L) {
  const m = (L && L.modeloSnap) || LD.modelos.find(x => x.id === (L && L.modeloId)) || MODELO_FALLBACK;
  return { ...MODELO_FALLBACK, ...m, secoes: { ...MODELO_FALLBACK.secoes, ...(m.secoes || {}) } };
}
const secOn = (M, k) => !!(M.secoes[k] && M.secoes[k].on);
const secTit = (M, k) => (M.secoes[k] && M.secoes[k].titulo) || SEC_TITULOS[k];
const copiaModelo = M => JSON.parse(JSON.stringify({ id: M.id, nome: M.nome, descricao: M.descricao, titulo: M.titulo, subtitulo: M.subtitulo, rotuloNumero: M.rotuloNumero, secoes: M.secoes, testes: M.testes, conclusoes: M.conclusoes, conclusaoPadrao: M.conclusaoPadrao, textos: M.textos, camposExtras: M.camposExtras, encaminhamento: M.encaminhamento, assinaturasExtras: M.assinaturasExtras }));

// Substitui {patrimonio}, {computador}, {setor}, {local}, {data} no texto impresso
function subst(t, L) {
  const hoje = fmt(new Date()).slice(0, 10);
  return String(t || '').replace(/\{(patrimonio|computador|setor|local|solicitante|chamado|data)\}/g, (_, k) =>
    k === 'data' ? hoje : (L[k] || `{${k}}`));
}

function aplicarModelo(L, M, novo) {
  L.modeloId = M.id;
  L.modeloSnap = copiaModelo(M);
  const temResultado = (L.testes || []).some(t => t.resultado || t.obs);
  if (novo || !temResultado) L.testes = (M.testes || []).map(nome => ({ nome, resultado: '', obs: '' }));
  else for (const nome of M.testes || []) if (!L.testes.some(t => t.nome === nome)) L.testes.push({ nome, resultado: '', obs: '' });
  if (!L.conclusao || !M.conclusoes.includes(L.conclusao)) L.conclusao = M.conclusaoPadrao || '';
  for (const [k, t] of Object.entries(M.textos || {})) if (t && !String(L[k] || '').trim()) L[k] = t;
  L.campos = L.campos || {};
  for (const c of M.camposExtras || []) if (!(c.id in L.campos)) L.campos[c.id] = '';
}

function renderModelPicker() {
  const el = $('#mod-laudos');
  const ativos = LD.modelos.filter(m => m.ativo !== false);
  el.innerHTML = `<div class="panel">
    <div class="head-row"><div><a href="#laudos" class="btn small ghost">← Laudos</a> <b class="ld-title">Novo laudo: escolha o modelo</b></div>
      <a href="#modelos" class="btn small ghost">Gerenciar modelos</a></div>
    ${LD.cur.snapshot ? `<p class="muted">Coleta vinculada: ${esc(LD.cur.snapshot.computador)} · ${esc(LD.cur.snapshot.horaColeta)}</p>` : ''}
    <div class="model-grid">${(ativos.length ? ativos : [MODELO_FALLBACK]).map(m => `<button class="model-card" data-pick="${esc(m.id)}">
      <b>${esc(m.nome)}</b><span>${esc(m.descricao || '')}</span>
      <small>${esc(m.titulo)} · ${m.conclusoes.map(c => esc((CONCLUSAO_TXT[c] || c).split(' –')[0])).join(', ')}</small></button>`).join('')}</div>
  </div>`;
  el.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
    const M = LD.modelos.find(m => m.id === b.dataset.pick) || MODELO_FALLBACK;
    aplicarModelo(LD.cur, M, true);
    LD.dirty = true;
    renderEditor();
  }));
}

// ================================================================== editor
function coletaOptions(sel) {
  const list = srv.list || [];
  return `<option value="">— sem coleta vinculada —</option>` + list.map(m =>
    `<option value="${esc(m.id)}" ${m.id === sel ? 'selected' : ''}>${esc(m.patrimonio && !/^NAO /.test(m.patrimonio) ? m.patrimonio + ' · ' : '')}${esc(m.computador)} · ${fmt(new Date(m.recebidoEm)).slice(0, 16)}</option>`).join('');
}
const fld = (k, label, attrs = '') => `<label>${label}<input data-f="${k}" value="${esc(LD.cur[k] || '')}" ${attrs}></label>`;
const area = (k, label, rows = 3, ph = '') => `<label class="full">${label}<textarea data-f="${k}" rows="${rows}" placeholder="${esc(ph)}">${esc(LD.cur[k] || '')}</textarea></label>`;

function extrasForm(M, secao) {
  const L = LD.cur;
  return (M.camposExtras || []).filter(c => c.secao === secao).map(c => {
    const val = (L.campos || {})[c.id] || '';
    const lab = esc(c.rotulo) + (c.obrigatorio ? ' *' : '');
    if (c.tipo === 'textarea') return `<label class="full">${lab}<textarea data-c="${esc(c.id)}" rows="3">${esc(val)}</textarea></label>`;
    if (c.tipo === 'selecao') return `<label>${lab}<select data-c="${esc(c.id)}"><option value="">— selecione —</option>${(c.opcoes || []).map(o => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    return `<label>${lab}<input data-c="${esc(c.id)}" value="${esc(val)}" ${c.tipo === 'data' ? 'type="date"' : ''}></label>`;
  }).join('');
}

function renderEditor() {
  const L = LD.cur, el = $('#mod-laudos'), M = modeloDe(L);
  const rasc = L.status === 'rascunho';
  const assinado = !!(L.assinaturaDigital || L.assinaturaFisica);
  const diagOn = ['testes', 'coleta', 'achados', 'analise'].some(k => secOn(M, k)) || M.camposExtras.some(c => c.secao === 'diagnostico');
  const servOn = secOn(M, 'servicos') || secOn(M, 'pecas') || M.camposExtras.some(c => c.secao === 'servicos');
  el.innerHTML = `
  <div class="panel noprint ld-bar">
    <div><a href="#laudos" class="btn small ghost">← Laudos</a>
      <b class="ld-title">${L.id ? `${esc(M.rotuloNumero)} ${esc(L.numero)}` : 'Novo laudo'}</b>
      ${L.revisao ? `<small>revisão ${L.revisao}${L.atualizadoEm ? ' · salvo em ' + fmt(new Date(L.atualizadoEm)) : ''}</small>` : ''}
      <span id="ldDirty" class="badge warn" ${LD.dirty ? '' : 'hidden'}>não salvo</span></div>
    <div class="filters" style="margin:0">
      <label>Modelo <select id="ldModelo" ${rasc ? '' : 'disabled title="Só é possível trocar o modelo em rascunho"'}>
        ${(LD.modelos.length ? LD.modelos : [MODELO_FALLBACK]).filter(m => m.ativo !== false || m.id === L.modeloId).map(m => `<option value="${esc(m.id)}" ${m.id === L.modeloId ? 'selected' : ''}>${esc(m.nome)}</option>`).join('')}
        ${L.modeloId && !LD.modelos.some(m => m.id === L.modeloId) ? `<option selected>${esc(M.nome)} (removido)</option>` : ''}</select></label>
      <label>Situação <select data-f="status">${Object.entries(STATUS_TXT).map(([k, t]) => `<option value="${k}" ${L.status === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      ${assinado ? '' : '<button class="btn" id="ldSave">Salvar</button>'}
      <button class="btn ghost" id="ldPdf">Baixar PDF</button>
      ${assinado ? '' : `<button class="btn" id="ldSign" ${L.id ? '' : 'disabled title="Salve o laudo primeiro"'}>Assinar…</button>`}
      ${!assinado && L.id && L.status === 'emitido' ? '<button class="btn ghost" id="ldVia" title="Registrar a digitalização da via assinada à mão">Enviar via assinada</button>' : ''}
    </div>
    <p class="err" id="ldErr" hidden style="flex-basis:100%;margin:0"></p>
  </div>
  ${faixaAssinatura(L)}

  <div class="panel noprint">
    <h2>${esc(secTit(M, 'identificacao'))}</h2>
    <div class="rep-grid">
      <label class="full">Coleta do diag-hardware vinculada <select id="ldColeta">${coletaOptions(L.coletaId)}</select></label>
      ${fld('patrimonio', 'Patrimônio')}${fld('computador', 'Nome do computador')}${fld('setor', 'Setor')}${fld('local', 'Local')}
      ${extrasForm(M, 'identificacao')}
    </div>
    ${L.snapshot ? `<p class="muted" style="margin:8px 0 0">Coleta de ${esc(L.snapshot.horaColeta)} · ${esc(L.snapshot.fabricanteModelo)} · ${esc(L.snapshot.cpu || '')}${L.snapshot.memoriaGB ? ' · ' + L.snapshot.memoriaGB + ' GB RAM' : ''}${L.snapshot.temSaude ? '' : ' · <b>coleta sem dados de saúde (script antigo)</b>'}</p>` : '<p class="muted" style="margin:8px 0 0">Sem coleta vinculada, o laudo não terá dados técnicos automáticos.</p>'}
  </div>

  ${secOn(M, 'solicitacao') ? `<div class="panel noprint">
    <h2>${esc(secTit(M, 'solicitacao'))}</h2>
    <div class="rep-grid">
      ${fld('solicitante', 'Solicitante')}${fld('chamado', 'Nº do chamado / OS')}${fld('dataAbertura', 'Data de abertura', 'type="date"')}
      ${extrasForm(M, 'solicitacao')}
      ${area('problema', 'Problema relatado', 3, 'Descrição do problema conforme o usuário/solicitante')}
    </div>
  </div>` : ''}

  ${diagOn ? `<div class="panel noprint">
    <h2>${esc(secOn(M, 'diagnostico') ? secTit(M, 'diagnostico') : 'Diagnóstico')}</h2>
    ${(secOn(M, 'achados') || secOn(M, 'coleta')) && L.snapshot ? `<h3>${esc(secTit(M, 'achados'))}</h3>${achadosHtml(L.snapshot.achados || [], L.snapshot.temSaude ? undefined : 'Coleta sem dados de saúde.')}` : ''}
    ${secOn(M, 'testes') ? `<h3>${esc(secTit(M, 'testes'))}</h3><div id="ldTestes"></div>` : ''}
    <div class="rep-grid">${extrasForm(M, 'diagnostico')}
    ${secOn(M, 'analise') ? area('diagnostico', secTit(M, 'analise'), 5, 'O que foi verificado, como e o que foi constatado') : ''}</div>
  </div>` : ''}

  ${servOn ? `<div class="panel noprint">
    <h2>${esc(secOn(M, 'servicos') ? secTit(M, 'servicos') : secTit(M, 'pecas'))}</h2>
    <div class="rep-grid">${secOn(M, 'servicos') ? area('solucao', 'Serviços / procedimentos realizados', 4, 'Ex.: substituição da fonte, limpeza interna, reinstalação do sistema...') : ''}
    ${extrasForm(M, 'servicos')}</div>
    ${secOn(M, 'pecas') ? `${secOn(M, 'servicos') ? `<h3>${esc(secTit(M, 'pecas'))}</h3>` : ''}<div id="ldPecas"></div>` : ''}
  </div>` : ''}

  ${secOn(M, 'conclusao') || secOn(M, 'recomendacoes') || secOn(M, 'observacoes') ? `<div class="panel noprint">
    <h2>${esc(secOn(M, 'conclusao') ? secTit(M, 'conclusao') : 'Encerramento')}</h2>
    <div class="rep-grid">
      ${secOn(M, 'conclusao') ? `<label class="full">Conclusão <select data-f="conclusao"><option value="">— selecione —</option>${M.conclusoes.map(k => `<option value="${k}" ${L.conclusao === k ? 'selected' : ''}>${esc(CONCLUSAO_TXT[k] || k)}</option>`).join('')}</select></label>
      ${area('justificativa', 'Justificativa técnica', 3)}` : ''}
      ${extrasForm(M, 'conclusao')}
      ${secOn(M, 'recomendacoes') ? area('recomendacoes', secTit(M, 'recomendacoes'), 2) : ''}
      ${secOn(M, 'observacoes') ? area('observacoes', secTit(M, 'observacoes'), 2) : ''}
    </div>
    ${M.encaminhamento ? `<p class="muted" style="margin:10px 0 0">Texto de encaminhamento do modelo: “${esc(M.encaminhamento)}”</p>` : ''}
  </div>` : ''}

  ${secOn(M, 'anexos') ? '<div class="panel noprint" id="ldAnexos"></div>' : ''}
  <p class="muted noprint" style="margin:-4px 0 12px">Nos textos, {patrimonio}, {computador}, {setor}, {local}, {solicitante}, {chamado} e {data} são substituídos na impressão.</p>
  <div id="ldPaper"></div>`;

  el.querySelectorAll('[data-f]').forEach(i => i.addEventListener('input', () => { L[i.dataset.f] = i.value; markDirty(); }));
  el.querySelectorAll('[data-c]').forEach(i => i.addEventListener('input', () => { L.campos = L.campos || {}; L.campos[i.dataset.c] = i.value; markDirty(); }));
  $('#ldColeta').addEventListener('change', async e => { await vincularColeta(e.target.value); renderEditor(); });
  $('#ldModelo').addEventListener('change', e => {
    const N = LD.modelos.find(m => m.id === e.target.value);
    if (!N) return;
    if (!confirm(`Aplicar o modelo "${N.nome}"? Os campos já preenchidos são mantidos.`)) { e.target.value = L.modeloId; return; }
    aplicarModelo(L, N, false); markDirty(); renderEditor();
  });
  if ($('#ldSave')) $('#ldSave').addEventListener('click', () => saveLaudo());
  $('#ldPdf').addEventListener('click', baixarPdfLaudo);
  if ($('#ldSign')) $('#ldSign').addEventListener('click', abrirAssinatura);
  if ($('#ldVia')) $('#ldVia').addEventListener('click', enviarDigitalizada);
  if (secOn(M, 'testes')) renderTestes();
  if (secOn(M, 'pecas')) renderPecas();
  if (secOn(M, 'anexos')) renderLaudoAnexos();
  renderLaudoPaper();
  if (assinado) { // laudo assinado: somente leitura
    el.querySelectorAll('.panel:not(.ld-bar):not(.sig-ok) :is(input, select, textarea, button), #ldModelo, .ld-bar [data-f="status"]').forEach(x => { x.disabled = true; });
    el.querySelectorAll('.panel:not(.ld-bar) label.btn').forEach(x => x.classList.add('is-disabled'));
  }
}

function markDirty() {
  LD.dirty = true;
  const d = $('#ldDirty'); if (d) d.hidden = false;
  clearTimeout(LD.timer);
  LD.timer = setTimeout(renderLaudoPaper, 350);
}

function renderTestes() {
  const L = LD.cur, box = $('#ldTestes');
  if (!box) return;
  box.innerHTML = `<div class="tablewrap"><table><thead><tr><th class="nosort">Teste</th><th class="nosort">Resultado</th><th class="nosort">Observação</th><th class="nosort"></th></tr></thead><tbody>
    ${L.testes.map((t, i) => `<tr>
      <td><input data-t="${i}:nome" value="${esc(t.nome)}" class="w100"></td>
      <td><select data-t="${i}:resultado">${Object.entries(RESULTADO_TXT).map(([k, x]) => `<option value="${k}" ${t.resultado === k ? 'selected' : ''}>${k ? x : 'não realizado'}</option>`).join('')}</select></td>
      <td><input data-t="${i}:obs" value="${esc(t.obs)}" class="w100"></td>
      <td><button class="btn small ghost" data-tdel="${i}" title="Remover">×</button></td></tr>`).join('')}
    </tbody></table></div><button class="btn small ghost" id="ldTAdd" style="margin-top:6px">+ Teste</button>`;
  box.querySelectorAll('[data-t]').forEach(i => i.addEventListener('input', () => { const [n, k] = i.dataset.t.split(':'); L.testes[n][k] = i.value; markDirty(); }));
  box.querySelectorAll('[data-tdel]').forEach(b => b.addEventListener('click', () => { L.testes.splice(+b.dataset.tdel, 1); markDirty(); renderTestes(); }));
  $('#ldTAdd').addEventListener('click', () => { L.testes.push({ nome: '', resultado: '', obs: '' }); markDirty(); renderTestes(); });
}

function renderPecas() {
  const L = LD.cur, box = $('#ldPecas');
  if (!box) return;
  box.innerHTML = `${L.pecas.length ? `<div class="tablewrap"><table><thead><tr><th class="nosort">Item</th><th class="nosort">Qtd</th><th class="nosort">Situação</th><th class="nosort">Observação</th><th class="nosort"></th></tr></thead><tbody>
    ${L.pecas.map((p, i) => `<tr>
      <td><input data-p="${i}:item" value="${esc(p.item)}" class="w100" placeholder="ex.: Fonte ATX 500 W"></td>
      <td><input data-p="${i}:qtd" type="number" min="0" max="999" value="${esc(p.qtd)}" style="width:70px"></td>
      <td><select data-p="${i}:acao">${Object.entries(ACAO_TXT).map(([k, x]) => `<option value="${k}" ${p.acao === k ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
      <td><input data-p="${i}:obs" value="${esc(p.obs)}" class="w100"></td>
      <td><button class="btn small ghost" data-pdel="${i}" title="Remover">×</button></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">Nenhuma peça informada.</p>'}<button class="btn small ghost" id="ldPAdd" style="margin-top:6px">+ Peça</button>`;
  box.querySelectorAll('[data-p]').forEach(i => i.addEventListener('input', () => { const [n, k] = i.dataset.p.split(':'); L.pecas[n][k] = k === 'qtd' ? (parseInt(i.value, 10) || 0) : i.value; markDirty(); }));
  box.querySelectorAll('[data-pdel]').forEach(b => b.addEventListener('click', () => { L.pecas.splice(+b.dataset.pdel, 1); markDirty(); renderPecas(); }));
  $('#ldPAdd').addEventListener('click', () => { L.pecas.push({ item: '', qtd: 1, acao: '', obs: '' }); markDirty(); renderPecas(); });
}

function ldErr(msg) { const e = $('#ldErr'); if (e) { e.textContent = msg || ''; e.hidden = !msg; } }

async function saveLaudo({ silent = false } = {}) {
  const L = LD.cur, M = modeloDe(L);
  if (L.status === 'emitido') {
    const falta = [];
    if (secOn(M, 'solicitacao') && !String(L.problema || '').trim()) falta.push('problema relatado');
    if (secOn(M, 'analise') && !String(L.diagnostico || '').trim()) falta.push(secTit(M, 'analise').toLowerCase());
    if (secOn(M, 'servicos') && !secOn(M, 'analise') && !String(L.solucao || '').trim()) falta.push('serviços executados');
    if (secOn(M, 'conclusao') && !L.conclusao) falta.push('conclusão');
    for (const c of M.camposExtras || []) if (c.obrigatorio && !String((L.campos || {})[c.id] || '').trim()) falta.push(c.rotulo.toLowerCase());
    if (falta.length) { ldErr('Para emitir, preencha: ' + falta.join(', ') + '.'); return false; }
  }
  ldErr('');
  const body = JSON.stringify({ ...L, revisao: L.revisao || undefined });
  const r = await api(L.id ? 'api/laudos/' + encodeURIComponent(L.id) : 'api/laudos', { method: L.id ? 'PUT' : 'POST', body, headers: { 'Content-Type': 'application/json' } }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok) { ldErr(j.erro || 'Falha ao salvar no servidor.'); return false; }
  const novo = !L.id;
  LD.cur = j; LD.dirty = false;
  if (novo) history.replaceState(null, '', '#laudo/' + j.id);
  if (!silent) renderEditor(); else { const d = $('#ldDirty'); if (d) d.hidden = true; }
  return true;
}

function printLaudo() {
  askPrint(() => {
    const M = modeloDe(LD.cur);
    LD.cur.assinatura = { responsavel: rep.responsavel, cargo: rep.cargo, matricula: rep.matricula, cidade: rep.cidade, data: rep.data };
    setPageFooter(`${M.titulo} – ${M.rotuloNumero} ${LD.cur.numero || '(não salvo)'}`);
    renderLaudoPaper();
    if (LD.cur.id) saveLaudo({ silent: true });
  });
}

// ================================================================== anexos do laudo
const ldAnxBase = () => `api/laudos/${encodeURIComponent(LD.cur.id)}/anexos`;
const ldAnxUrl = aid => `${ldAnxBase()}/${aid}${srv.token ? '?token=' + encodeURIComponent(srv.token) : ''}`;
async function loadLaudoAnexos() {
  LD.anexos = [];
  if (!LD.cur || !LD.cur.id) return;
  const r = await api(ldAnxBase()).catch(() => null);
  if (r && r.ok) LD.anexos = (await r.json()).map(a => ({ ...a, url: ldAnxUrl(a.aid) }));
}

function renderLaudoAnexos() {
  const box = $('#ldAnexos');
  if (!box) return;
  box.innerHTML = `<div class="head-row"><h2 style="margin:0">Anexos (${LD.anexos.length})</h2>
      <label class="btn small">Adicionar fotos / PDF<input id="ldAnxIn" type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" multiple hidden></label></div>
    ${LD.cur.id ? '' : '<p class="muted">O laudo será salvo automaticamente ao adicionar o primeiro anexo.</p>'}
    <p class="err" id="ldAnxMsg" hidden></p>
    <div class="anx-list">${LD.anexos.map((a, n) => `<div class="anx-item">
      <div class="anx-thumb">${a.tipo.startsWith('image/') ? `<img src="${esc(a.url)}" alt="">` : '<span>PDF</span>'}</div>
      <div class="anx-info"><div><b>Anexo ${n + 1}</b> · ${esc(a.nome)} · ${tamanhoTxt(a.tamanho)} · <span class="muted">${anexoDataTxt(a)}</span></div>
        <div class="mono anx-hash">SHA-256 ${esc(a.sha256)}</div>
        <input data-ldanx="${esc(a.aid)}" value="${esc(a.legenda || '')}" maxlength="300" placeholder="Descrição do anexo"></div>
      <button class="btn small ghost" data-ldanxdel="${esc(a.aid)}">Remover</button></div>`).join('')}</div>`;
  const msg = t => { const m = $('#ldAnxMsg'); m.textContent = t; m.hidden = !t; };
  $('#ldAnxIn').addEventListener('change', async e => {
    const files = [...e.target.files]; e.target.value = '';
    if (!LD.cur.id && !(await saveLaudo({ silent: true }))) { msg('Salve o laudo antes de anexar.'); return; }
    const erros = [];
    for (const f of files) {
      const tipo = (f.type || '').toLowerCase();
      if (!ANX_OK.test(tipo)) { erros.push(`${f.name}: tipo não suportado.`); continue; }
      const u8 = new Uint8Array(await f.arrayBuffer());
      const sha = await sha256Hex(u8);
      const r = await api(ldAnxBase(), { method: 'POST', body: u8, headers: {
        'Content-Type': tipo, 'X-Nome': encodeURIComponent(f.name), 'X-Sha256': sha,
        'X-Modificado': new Date(f.lastModified).toISOString(), 'X-Capturada': tipo === 'image/jpeg' ? exifDate(u8) || '' : '' } }).catch(() => null);
      const j = r ? await r.json().catch(() => ({})) : {};
      if (!r || !r.ok) { erros.push(`${f.name}: ${j.erro || 'falha no envio'}`); continue; }
      LD.anexos.push({ ...j, url: ldAnxUrl(j.aid) });
    }
    renderEditor();
    if (erros.length) { const m = $('#ldAnxMsg'); m.textContent = erros.join(' '); m.hidden = false; }
  });
  box.querySelectorAll('[data-ldanx]').forEach(i => i.addEventListener('change', async () => {
    const a = LD.anexos.find(x => x.aid === i.dataset.ldanx); if (!a) return;
    const r = await api(`${ldAnxBase()}/${a.aid}`, { method: 'PUT', body: JSON.stringify({ legenda: i.value }), headers: { 'Content-Type': 'application/json' } }).catch(() => null);
    if (r && r.ok) { a.legenda = i.value; renderLaudoPaper(); } else msg('Não foi possível salvar a descrição.');
  }));
  box.querySelectorAll('[data-ldanxdel]').forEach(b => b.addEventListener('click', async () => {
    const a = LD.anexos.find(x => x.aid === b.dataset.ldanxdel);
    if (!a || !confirm(`Remover o anexo "${a.nome}"?`)) return;
    const r = await api(`${ldAnxBase()}/${a.aid}`, { method: 'DELETE' }).catch(() => null);
    if (!r || !r.ok) { msg('Não foi possível remover.'); return; }
    LD.anexos = LD.anexos.filter(x => x !== a); renderLaudoAnexos(); renderLaudoPaper();
  }));
}

// ================================================================== documento do laudo
function extrasPaper(M, L, secao) {
  const cs = (M.camposExtras || []).filter(c => c.secao === secao);
  if (!cs.length) return '';
  const val = c => { const v = (L.campos || {})[c.id] || ''; return c.tipo === 'data' ? (v ? dataBR(v) : '—') : (v ? para(subst(v, L)) : '—'); };
  return `<table class="r-kv">${cs.map(c => `<tr><th>${esc(c.rotulo)}</th><td colspan="3">${val(c)}</td></tr>`).join('')}</table>`;
}

function blocosLaudo(M, L) {
  const S = L.snapshot, B = [];
  const on = k => secOn(M, k);
  if (on('identificacao')) B.push({ k: 'identificacao' });
  if (on('solicitacao')) B.push({ k: 'solicitacao' });
  const diag = ['testes', 'coleta', 'achados', 'analise'].filter(k => on(k) &&
    (k === 'testes' ? (L.testes || []).some(t => t.nome && t.resultado) : k === 'coleta' ? !!S : k === 'achados' ? !!(S && S.temSaude) : true));
  const diagExtras = M.camposExtras.some(c => c.secao === 'diagnostico');
  if (on('diagnostico') && (diag.length || diagExtras)) B.push({ k: 'diagnostico', filhos: diag, extras: diagExtras });
  else diag.forEach(k => B.push({ k }));
  const pecas = on('pecas') && (L.pecas || []).some(p => p.item);
  if (on('servicos')) B.push({ k: 'servicos', filhos: pecas ? ['pecas'] : [] });
  else if (pecas) B.push({ k: 'pecas' });
  if (on('conclusao')) B.push({ k: 'conclusao', filhos: on('recomendacoes') && L.recomendacoes ? ['recomendacoes'] : [] });
  else if (on('recomendacoes') && L.recomendacoes) B.push({ k: 'recomendacoes' });
  if (on('observacoes') && L.observacoes) B.push({ k: 'observacoes' });
  if (on('anexos') && LD.anexos.length) B.push({ k: 'anexos' });
  return B;
}

function conteudoBloco(k, M, L) {
  const S = L.snapshot;
  switch (k) {
    case 'identificacao': return `<table class="r-kv">
        <tr><th>Patrimônio</th><td>${esc(L.patrimonio || '—')}</td><th>Nome do computador</th><td>${esc(L.computador || '—')}</td></tr>
        <tr><th>Fabricante / modelo</th><td>${esc(S ? S.fabricanteModelo : '') || '—'}</td><th>Nº de série (BIOS)</th><td>${esc(S ? S.serial : '') || '—'}</td></tr>
        <tr><th>Processador</th><td>${esc(S ? S.cpu : '') || '—'}</td><th>Memória</th><td>${S && S.memoriaGB ? `${S.memoriaGB} GB${S.modulos && S.modulos.length ? ` (${S.modulos.length} módulo${S.modulos.length > 1 ? 's' : ''})` : ''}` : '—'}</td></tr>
        <tr><th>Sistema operacional</th><td colspan="3">${esc(S ? S.sistema : '') || '—'}</td></tr>
        <tr><th>Setor</th><td>${esc(L.setor || '—')}</td><th>Local</th><td>${esc(L.local || '—')}</td></tr>
      </table>${extrasPaper(M, L, 'identificacao')}`;
    case 'solicitacao': return `<table class="r-kv">
        <tr><th>Solicitante</th><td>${esc(L.solicitante || '—')}</td><th>Data de abertura</th><td>${dataBR(L.dataAbertura)}</td></tr>
        ${L.chamado ? `<tr><th>Chamado / OS</th><td colspan="3">${esc(L.chamado)}</td></tr>` : ''}
      </table>${extrasPaper(M, L, 'solicitacao')}
      <p><b>Problema relatado:</b><br>${para(subst(L.problema, L)) || '—'}</p>`;
    case 'testes': {
      const testes = (L.testes || []).filter(t => t.nome && t.resultado);
      return `<table class="r-table"><thead><tr><th>Teste</th><th>Resultado</th><th>Observação</th></tr></thead><tbody>
        ${testes.map(t => `<tr><td>${esc(t.nome)}</td><td>${t.resultado === 'falha' ? `<b class="r-bad">${RESULTADO_TXT[t.resultado]}</b>` : RESULTADO_TXT[t.resultado]}</td><td>${esc(t.obs)}</td></tr>`).join('')}
      </tbody></table>`;
    }
    case 'coleta': {
      const ev = S.eventos || null;
      return `<p class="r-small">${S.tipoColeta === 'diagnostico' ? 'Diagnóstico' : 'Coleta diag-hardware'} de ${esc(S.horaColeta || '—')}${S.coletadoPor ? ', executada por ' + esc(S.coletadoPor) : ''}${S.pacoteSha256 ? ` · SHA-256 do pacote <span class="r-mono">${esc(S.pacoteSha256)}</span>` : ''}.</p>
      ${S.discos && S.discos.length ? `<table class="r-table"><thead><tr><th>Disco</th><th>Tipo</th><th>Capacidade</th><th>Saúde</th><th>Temp.</th><th>Desgaste</th><th>Horas ligado</th></tr></thead><tbody>
        ${S.discos.map(d => `<tr><td>${esc(d.nome)}</td><td>${esc(d.tipo || '—')}</td><td>${d.gb != null ? d.gb + ' GB' : '—'}</td><td>${d.saude ? (/^healthy$/i.test(d.saude) ? 'Saudável' : `<b class="r-bad">${esc(d.saude)}</b>`) : '—'}</td><td>${d.temperatura != null ? d.temperatura + ' °C' : '—'}</td><td>${d.desgastePct != null ? d.desgastePct + '%' : '—'}</td><td>${d.horasLigado != null ? d.horasLigado : '—'}</td></tr>`).join('')}
      </tbody></table>` : ''}
      ${S.volumes && S.volumes.length ? `<p class="r-small">Unidades: ${S.volumes.map(x => `${esc(x.letra)} ${x.livreGB} GB livres de ${x.totalGB} GB (${x.livrePct}%)`).join(' · ')}</p>` : ''}
      ${ev ? `<table class="r-kv">${EVENTOS_SAUDE.filter(([k]) => ev[k] != null).map(([k, l]) => `<tr><th>${esc(l)}</th><td>${ev[k]}</td></tr>`).join('')}</table>
        <p class="r-small">Eventos registrados pelo Windows no período coberto pela coleta.</p>` : ''}
      ${(S.testesAuto || []).length ? `<h4>Testes automáticos${S.profundoEm ? ' – ' + esc(S.profundoEm) : ''}</h4><table class="r-table"><thead><tr><th>Teste</th><th>Resultado</th><th>Detalhes</th></tr></thead><tbody>
        ${S.testesAuto.map(t => `<tr><td>${esc(t.nome)}</td><td>${t.resultado === 'falha' ? '<b class="r-bad">Falha</b>' : t.resultado === 'alerta' ? '<b>Atenção</b>' : 'OK'}</td><td>${esc(t.obs)}</td></tr>`).join('')}
      </tbody></table>` : ''}`;
    }
    case 'achados': return (S.achados || []).length
      ? `<ul class="r-list">${S.achados.map(a => `<li><b>${NIVEL[a.nivel].label}:</b> ${esc(a.texto)}</li>`).join('')}</ul>`
      : '<p class="r-small">Nenhum problema identificado automaticamente nos dados coletados.</p>';
    case 'analise': return `<p>${para(subst(L.diagnostico, L)) || '—'}</p>`;
    case 'servicos': return `<p>${para(subst(L.solucao, L)) || '—'}</p>`;
    case 'pecas': return `<table class="r-table"><thead><tr><th>Peça / item</th><th>Qtd</th><th>Situação</th><th>Observação</th></tr></thead><tbody>
        ${L.pecas.filter(p => p.item).map(p => `<tr><td>${esc(p.item)}</td><td>${esc(p.qtd)}</td><td>${ACAO_TXT[p.acao] || '—'}</td><td>${esc(p.obs)}</td></tr>`).join('')}</tbody></table>`;
    case 'conclusao': return `<div class="r-window r-conc ${CONCLUSAO_CLS[L.conclusao] || ''}">
        <div class="r-window-l">${esc(secTit(M, 'conclusao'))}</div>
        <div class="r-window-v">${esc(CONCLUSAO_TXT[L.conclusao] || '—')}</div>
        ${L.justificativa ? `<div class="r-window-s">${para(subst(L.justificativa, L))}</div>` : ''}
      </div>${extrasPaper(M, L, 'conclusao')}`;
    case 'recomendacoes': return `<p>${para(subst(L.recomendacoes, L))}</p>`;
    case 'observacoes': return `<p class="r-obs">${para(subst(L.observacoes, L))}</p>`;
    case 'anexos': return `<table class="r-table r-hash"><thead><tr><th>Nº</th><th>Descrição</th><th>Arquivo</th><th>Data</th><th>SHA-256</th></tr></thead><tbody>
      ${LD.anexos.map((a, n) => `<tr><td>${n + 1}</td><td>${esc(a.legenda || '—')}</td><td>${esc(a.nome)}<br><span class="r-small">${tamanhoTxt(a.tamanho)}</span></td><td class="r-small">${anexoDataTxt(a)}</td><td class="r-mono">${esc(a.sha256)}</td></tr>`).join('')}
      </tbody></table>`;
  }
  return '';
}

function renderLaudoPaper() {
  const box = $('#ldPaper');
  if (!box || !LD.cur) return;
  const L = LD.cur, M = modeloDe(L), A = L.assinatura || {};
  const marca = L.status === 'rascunho' ? 'RASCUNHO' : L.status === 'cancelado' ? 'CANCELADO' : '';
  const blocos = blocosLaudo(M, L);
  const fechamento = blocos.length ? blocos[blocos.length - 1] : null;
  const corpo = blocos.map((b, i) => {
    const n = i + 1;
    let h = `<h2>${n}. ${esc(secTit(M, b.k))}</h2>`;
    if (b.k === 'diagnostico') {
      h += b.filhos.map((f, j) => `<h3>${n}.${j + 1} ${esc(secTit(M, f))}</h3>${conteudoBloco(f, M, L)}`).join('');
      if (b.extras) h += extrasPaper(M, L, 'diagnostico');
    } else {
      h += conteudoBloco(b.k, M, L);
      if (b.k === 'servicos') h += extrasPaper(M, L, 'servicos');
      for (const f of b.filhos || []) h += `<h3>${esc(secTit(M, f))}</h3>${conteudoBloco(f, M, L)}`;
    }
    const sec = `<section class="${['conclusao', 'observacoes', 'anexos', 'recomendacoes'].includes(b.k) ? 'r-break-avoid' : ''}">${h}</section>`;
    return b === fechamento ? `<div class="r-break-avoid">${sec}` : sec; // o último bloco fica junto da assinatura
  }).join('');
  const assin = [
    { nome: A.responsavel || 'Responsável técnico', cargo: A.cargo || 'Cargo', extra: A.matricula ? 'Matrícula ' + esc(A.matricula) : 'Matrícula' },
    ...(M.assinaturasExtras || []).map(t => ({ nome: '', cargo: t, extra: '' })),
  ];

  box.innerHTML = `<article class="paper ${marca ? 'marca' : ''}" data-marca="${marca}">
    <header class="r-head">
      <div>
        <div class="r-org">${esc(rep.orgao || 'Tecnologia da Informação')}</div>
        <h1>${esc(M.titulo)}</h1>
        ${M.subtitulo ? `<div class="r-sub">${esc(M.subtitulo)}</div>` : ''}
      </div>
      <table class="r-meta">
        <tr><th>${esc(M.rotuloNumero.replace(/\s*nº$/i, '') || 'Nº')} nº</th><td><b>${esc(L.numero || '(não salvo)')}</b>${L.revisao > 1 ? ` · rev. ${L.revisao}` : ''}</td></tr>
        <tr><th>Patrimônio</th><td><b>${esc(L.patrimonio || '—')}</b></td></tr>
        <tr><th>Chamado</th><td>${esc(L.chamado || '—')}</td></tr>
      </table>
    </header>
    ${corpo}
    ${fechamento ? '' : '<div class="r-break-avoid">'}
    ${M.encaminhamento ? `<p class="r-encaminha">${para(subst(M.encaminhamento, L))}</p>` : ''}
    <div class="r-date-line">${esc(A.cidade || '__________________')}, ${A.data ? esc(dataExtenso(A.data)) : '____ / ____ / ________'}</div>
    <div class="r-signs">${assin.map(s => `<div class="r-sign-block">
      <div class="r-sign-name">${esc(s.nome) || '&nbsp;'}</div><div class="r-sign-role">${esc(s.cargo)}</div><div class="r-small">${s.extra || '&nbsp;'}</div></div>`).join('')}</div>
    </div>
    <div class="r-foot r-small">${esc(M.rotuloNumero)} ${esc(L.numero || '(não salvo)')}${L.revisao ? ', revisão ' + L.revisao : ''} · modelo "${esc(M.nome)}" · gerado em ${fmt(new Date())} pelo Visualizador de Coletas (diag-hardware)</div>
    ${secOn(M, 'anexos') && LD.anexos.length ? `<section class="r-anexos"><h2>Reprodução dos anexos</h2>${LD.anexos.map((a, n) => `<figure class="r-anexo">
      <figcaption><b>Anexo ${n + 1}</b>${a.legenda ? ' – ' + esc(a.legenda) : ''}</figcaption>
      ${a.tipo.startsWith('image/') ? `<img src="${esc(a.url)}" alt="Anexo ${n + 1}">` : `<div class="r-pdf">Documento PDF entregue em separado: <b>${esc(a.nome)}</b></div>`}
      <div class="r-small">${esc(a.nome)} · ${tamanhoTxt(a.tamanho)} · ${anexoDataTxt(a)}<br>SHA-256 <span class="r-mono">${esc(a.sha256)}</span></div>
    </figure>`).join('')}</section>` : ''}
  </article>`;
}

// ================================================================== gerenciar modelos
const MD = { cur: null, dirty: false, timer: null };

async function renderModelos() {
  const el = $('#mod-laudos');
  el.innerHTML = '<div class="panel">Carregando...</div>';
  if (!(await needServer(el))) return;
  await loadModelos();
  el.innerHTML = `<div class="panel">
    <div class="head-row"><div><a href="#laudos" class="btn small ghost">← Laudos</a> <b class="ld-title">Modelos de laudo</b></div>
      <a href="#modelo/novo" class="btn">Novo modelo</a></div>
    <p class="muted">O modelo define o título do documento, as seções e seus nomes, os testes, as conclusões permitidas, textos pré-preenchidos, campos extras e assinaturas. Cada laudo guarda uma cópia do modelo usado: alterar um modelo não muda laudos já criados.</p>
    <div class="tablewrap"><table class="clickable"><thead><tr><th class="nosort">Modelo</th><th class="nosort">Documento</th><th class="nosort">Conclusões</th><th class="nosort">Campos extras</th><th class="nosort">Situação</th><th class="nosort"></th></tr></thead><tbody>
    ${LD.modelos.map(m => `<tr data-edit-modelo="${esc(m.id)}">
      <td><b>${esc(m.nome)}</b>${m.padrao ? ' <span class="badge">padrão</span>' : ''}<br><small>${esc(m.descricao || '')}</small></td>
      <td>${esc(m.titulo)}<br><small>${esc(m.rotuloNumero)}</small></td>
      <td><small>${m.conclusoes.map(c => esc((CONCLUSAO_TXT[c] || c).split(' –')[0])).join(', ')}</small></td>
      <td>${m.camposExtras.length || '—'}</td>
      <td><span class="badge ${m.ativo !== false ? 'ok' : ''}">${m.ativo !== false ? 'Ativo' : 'Inativo'}</span></td>
      <td><a class="btn small ghost" href="#modelo/dup:${esc(m.id)}" data-stop>Duplicar</a></td></tr>`).join('')}
    </tbody></table></div></div>`;
  el.querySelectorAll('[data-stop]').forEach(a => a.addEventListener('click', e => e.stopPropagation()));
  el.querySelectorAll('[data-edit-modelo]').forEach(tr => tr.addEventListener('click', () => { location.hash = 'modelo/' + tr.dataset.editModelo; }));
}

async function editModelo(id) {
  const el = $('#mod-laudos');
  el.innerHTML = '<div class="panel">Carregando...</div>';
  if (!(await needServer(el))) return;
  await loadModelos();
  const clone = o => JSON.parse(JSON.stringify(o));
  if (id === 'novo') MD.cur = { ...clone(MODELO_FALLBACK), id: '', nome: 'Novo modelo', descricao: '', padrao: false, ativo: true, ordem: 100 };
  else if (id.startsWith('dup:')) {
    const src = LD.modelos.find(m => m.id === id.slice(4));
    if (!src) { el.innerHTML = '<div class="panel"><p class="err">Modelo não encontrado.</p></div>'; return; }
    MD.cur = { ...clone(src), id: '', padrao: false, nome: src.nome + ' (cópia)', ordem: 100 };
  } else {
    const src = LD.modelos.find(m => m.id === id);
    if (!src) { el.innerHTML = '<div class="panel"><p class="err">Modelo não encontrado.</p><a class="btn small ghost" href="#modelos">Voltar</a></div>'; return; }
    MD.cur = clone(src);
  }
  MD.cur.secoes = { ...clone(MODELO_FALLBACK.secoes), ...(MD.cur.secoes || {}) };
  MD.cur.textos = MD.cur.textos || {};
  MD.dirty = id === 'novo' || id.startsWith('dup:');
  renderModeloEditor();
}

function mdDirty() {
  MD.dirty = true;
  const d = $('#mdDirty'); if (d) d.hidden = false;
  clearTimeout(MD.timer);
  MD.timer = setTimeout(previewModelo, 350);
}

function renderModeloEditor() {
  const M = MD.cur, el = $('#mod-laudos');
  const TX = [['problema', 'Problema relatado'], ['diagnostico', 'Análise técnica'], ['solucao', 'Serviços executados'], ['justificativa', 'Justificativa da conclusão'], ['recomendacoes', 'Recomendações'], ['observacoes', 'Observações']];
  el.innerHTML = `
  <div class="panel noprint ld-bar">
    <div><a href="#modelos" class="btn small ghost">← Modelos</a> <b class="ld-title">${esc(M.nome)}</b>
      ${M.padrao ? '<span class="badge">padrão</span>' : ''} <span id="mdDirty" class="badge warn" ${MD.dirty ? '' : 'hidden'}>não salvo</span></div>
    <div class="filters" style="margin:0">
      ${M.id ? `<a class="btn small ghost" href="#modelo/dup:${esc(M.id)}">Duplicar</a>` : ''}
      ${M.padrao ? '<button class="btn small ghost" id="mdRestore">Restaurar padrão</button>' : ''}
      ${M.id && !M.padrao ? '<button class="btn small ghost" id="mdDel">Excluir</button>' : ''}
      <button class="btn" id="mdSave">Salvar modelo</button>
    </div>
    <p class="err" id="mdErr" hidden style="flex-basis:100%;margin:0"></p>
  </div>

  <div class="panel noprint"><h2>Geral</h2>
    <div class="rep-grid">
      <label>Nome do modelo<input data-m="nome" value="${esc(M.nome)}" maxlength="80"></label>
      <label>Título do documento<input data-m="titulo" value="${esc(M.titulo)}" maxlength="80"></label>
      <label>Subtítulo<input data-m="subtitulo" value="${esc(M.subtitulo || '')}" maxlength="120"></label>
      <label>Rótulo do número<input data-m="rotuloNumero" value="${esc(M.rotuloNumero)}" maxlength="30" placeholder="ex.: Laudo nº, Atendimento nº"></label>
      <label class="full">Descrição (aparece na escolha do modelo)<input data-m="descricao" value="${esc(M.descricao || '')}" maxlength="200"></label>
      <label>Ordem na lista<input data-m="ordem" type="number" min="0" max="9999" value="${esc(M.ordem ?? 100)}"></label>
      <label class="chk"><input type="checkbox" data-mb="ativo" ${M.ativo !== false ? 'checked' : ''}> Ativo (disponível para novos laudos)</label>
    </div>
  </div>

  <div class="panel noprint"><h2>Seções</h2>
    <p class="muted">Desmarque o que não deve aparecer e ajuste o nome de cada seção no documento. "Diagnóstico" agrupa testes, dados da coleta, achados e análise; se ele estiver desmarcado, os itens marcados viram seções próprias.</p>
    <div class="tablewrap"><table><thead><tr><th class="nosort">Exibir</th><th class="nosort">Seção</th><th class="nosort">Título no documento</th></tr></thead><tbody>
    ${SEC_KEYS.map(k => `<tr><td><input type="checkbox" data-son="${k}" ${M.secoes[k].on ? 'checked' : ''}></td><td>${['testes', 'coleta', 'achados', 'analise'].includes(k) ? '&nbsp;&nbsp;↳ ' : ''}${esc(SEC_TITULOS[k])}</td>
      <td><input data-stit="${k}" value="${esc(M.secoes[k].titulo)}" class="w100" maxlength="80"></td></tr>`).join('')}
    </tbody></table></div>
  </div>

  <div class="panel noprint"><h2>Conclusão e testes</h2>
    <div class="rep-grid">
      <div class="full"><div class="lbl">Conclusões permitidas</div>
        <div class="chk-list">${Object.entries(CONCLUSAO_TXT).filter(([k]) => k).map(([k, t]) => `<label class="chk"><input type="checkbox" data-conc="${k}" ${M.conclusoes.includes(k) ? 'checked' : ''}> ${esc(t)}</label>`).join('')}</div></div>
      <label>Conclusão já selecionada<select data-m="conclusaoPadrao"><option value="">— nenhuma —</option>${M.conclusoes.map(k => `<option value="${k}" ${M.conclusaoPadrao === k ? 'selected' : ''}>${esc((CONCLUSAO_TXT[k] || k).split(' –')[0])}</option>`).join('')}</select></label>
      <label class="full">Testes padrão (um por linha)<textarea id="mdTestes" rows="6">${esc((M.testes || []).join('\n'))}</textarea></label>
    </div>
  </div>

  <div class="panel noprint"><h2>Textos pré-preenchidos</h2>
    <p class="muted">Entram no laudo novo quando o campo está vazio. Use {patrimonio}, {computador}, {setor}, {local}, {solicitante}, {chamado} e {data}; eles são substituídos na impressão.</p>
    <div class="rep-grid">${TX.map(([k, l]) => `<label class="full">${l}<textarea data-tx="${k}" rows="2">${esc(M.textos[k] || '')}</textarea></label>`).join('')}</div>
  </div>

  <div class="panel noprint"><h2>Campos extras</h2>
    <p class="muted">Campos próprios deste modelo, como nota fiscal, fornecedor ou estado de conservação. Aparecem na seção escolhida, no formulário e no documento.</p>
    <div id="mdCampos"></div>
  </div>

  <div class="panel noprint"><h2>Encerramento</h2>
    <div class="rep-grid">
      <label class="full">Texto de encaminhamento (antes da assinatura)<textarea data-m="encaminhamento" rows="2" maxlength="2000" placeholder="ex.: Encaminha-se ao Setor de Patrimônio para as providências cabíveis.">${esc(M.encaminhamento || '')}</textarea></label>
      <label class="full">Assinaturas adicionais (uma por linha, até 4)<textarea id="mdAssin" rows="3" placeholder="ex.: Responsável pelo setor de origem">${esc((M.assinaturasExtras || []).join('\n'))}</textarea></label>
    </div>
  </div>

  <h2 class="noprint" style="margin:18px 0 8px">Pré-visualização (dados de exemplo)</h2>
  <div id="ldPaper"></div>`;

  el.querySelectorAll('[data-m]').forEach(i => i.addEventListener('input', () => { M[i.dataset.m] = i.dataset.m === 'ordem' ? parseInt(i.value, 10) || 0 : i.value; mdDirty(); }));
  el.querySelectorAll('[data-mb]').forEach(i => i.addEventListener('change', () => { M[i.dataset.mb] = i.checked; mdDirty(); }));
  el.querySelectorAll('[data-son]').forEach(i => i.addEventListener('change', () => { M.secoes[i.dataset.son].on = i.checked; mdDirty(); }));
  el.querySelectorAll('[data-stit]').forEach(i => i.addEventListener('input', () => { M.secoes[i.dataset.stit].titulo = i.value; mdDirty(); }));
  el.querySelectorAll('[data-tx]').forEach(i => i.addEventListener('input', () => { M.textos[i.dataset.tx] = i.value; mdDirty(); }));
  el.querySelectorAll('[data-conc]').forEach(i => i.addEventListener('change', () => {
    const k = i.dataset.conc;
    M.conclusoes = Object.keys(CONCLUSAO_TXT).filter(c => c && (c === k ? i.checked : M.conclusoes.includes(c)));
    if (!M.conclusoes.includes(M.conclusaoPadrao)) M.conclusaoPadrao = '';
    mdDirty(); renderModeloEditor();
  }));
  $('#mdTestes').addEventListener('input', e => { M.testes = e.target.value.split('\n').map(s => s.trim()).filter(Boolean); mdDirty(); });
  $('#mdAssin').addEventListener('input', e => { M.assinaturasExtras = e.target.value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 4); mdDirty(); });
  $('#mdSave').addEventListener('click', saveModelo);
  if ($('#mdDel')) $('#mdDel').addEventListener('click', async () => {
    if (!confirm(`Excluir o modelo "${M.nome}"? Laudos já criados com ele não são afetados.`)) return;
    const r = await api('api/modelos/' + encodeURIComponent(M.id), { method: 'DELETE' }).catch(() => null);
    if (r && r.ok) { MD.dirty = false; location.hash = 'modelos'; } else mdErr('Não foi possível excluir.');
  });
  if ($('#mdRestore')) $('#mdRestore').addEventListener('click', async () => {
    if (!confirm('Restaurar este modelo para a configuração original? As alterações feitas nele serão perdidas.')) return;
    const r = await api(`api/modelos/${encodeURIComponent(M.id)}/restaurar`, { method: 'POST' }).catch(() => null);
    if (r && r.ok) { MD.cur = await r.json(); MD.dirty = false; await loadModelos(); renderModeloEditor(); } else mdErr('Não foi possível restaurar.');
  });
  renderCamposExtras();
  previewModelo();
}

function renderCamposExtras() {
  const M = MD.cur, box = $('#mdCampos');
  box.innerHTML = `${M.camposExtras.length ? `<div class="tablewrap"><table><thead><tr><th class="nosort">Rótulo</th><th class="nosort">Tipo</th><th class="nosort">Opções (separadas por ;)</th><th class="nosort">Seção</th><th class="nosort">Obrigatório</th><th class="nosort"></th></tr></thead><tbody>
    ${M.camposExtras.map((c, i) => `<tr>
      <td><input data-ce="${i}:rotulo" value="${esc(c.rotulo)}" class="w100" maxlength="80"></td>
      <td><select data-ce="${i}:tipo">${Object.entries(TIPO_CAMPO_TXT).map(([k, t]) => `<option value="${k}" ${c.tipo === k ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
      <td><input data-ce="${i}:opcoes" value="${esc((c.opcoes || []).join('; '))}" class="w100" ${c.tipo === 'selecao' ? '' : 'disabled placeholder="só para lista"'}></td>
      <td><select data-ce="${i}:secao">${Object.entries(SEC_CAMPO_TXT).map(([k, t]) => `<option value="${k}" ${c.secao === k ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
      <td style="text-align:center"><input type="checkbox" data-ceob="${i}" ${c.obrigatorio ? 'checked' : ''}></td>
      <td><button class="btn small ghost" data-cedel="${i}">×</button></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">Nenhum campo extra.</p>'}
    <button class="btn small ghost" id="mdCAdd" style="margin-top:6px">+ Campo</button>
    <p class="muted" style="margin:6px 0 0">Campos obrigatórios precisam estar preenchidos para emitir o laudo.</p>`;
  box.querySelectorAll('[data-ce]').forEach(i => i.addEventListener(i.tagName === 'SELECT' ? 'change' : 'input', () => {
    const [n, k] = i.dataset.ce.split(':');
    M.camposExtras[n][k] = k === 'opcoes' ? i.value.split(';').map(s => s.trim()).filter(Boolean) : i.value;
    if (!M.camposExtras[n].id) M.camposExtras[n].id = slugCampo(M.camposExtras[n].rotulo, n);
    mdDirty();
    if (k === 'tipo') renderCamposExtras();
  }));
  box.querySelectorAll('[data-ceob]').forEach(i => i.addEventListener('change', () => { M.camposExtras[i.dataset.ceob].obrigatorio = i.checked; mdDirty(); }));
  box.querySelectorAll('[data-cedel]').forEach(b => b.addEventListener('click', () => { M.camposExtras.splice(+b.dataset.cedel, 1); mdDirty(); renderCamposExtras(); }));
  $('#mdCAdd').addEventListener('click', () => {
    if (M.camposExtras.length >= 20) return;
    M.camposExtras.push({ id: '', rotulo: 'Novo campo', tipo: 'texto', opcoes: [], secao: 'identificacao', obrigatorio: false });
    M.camposExtras[M.camposExtras.length - 1].id = slugCampo('campo', M.camposExtras.length + Date.now() % 1000);
    mdDirty(); renderCamposExtras();
  });
}
function slugCampo(t, n) {
  return (String(t || 'campo').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'campo') + '_' + n;
}

function mdErr(msg) { const e = $('#mdErr'); if (e) { e.textContent = msg || ''; e.hidden = !msg; } }

async function saveModelo() {
  const M = MD.cur;
  if (!String(M.nome || '').trim()) return mdErr('Informe o nome do modelo.');
  if (!M.conclusoes.length && M.secoes.conclusao.on) return mdErr('Marque pelo menos uma conclusão permitida.');
  mdErr('');
  const r = await api(M.id ? 'api/modelos/' + encodeURIComponent(M.id) : 'api/modelos', { method: M.id ? 'PUT' : 'POST', body: JSON.stringify(M), headers: { 'Content-Type': 'application/json' } }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok) return mdErr(j.erro || 'Falha ao salvar o modelo.');
  MD.cur = j; MD.dirty = false;
  await loadModelos();
  history.replaceState(null, '', '#modelo/' + j.id);
  renderModeloEditor();
}

function previewModelo() {
  const M = MD.cur;
  if (!M || !$('#ldPaper')) return;
  const hoje = toLocalInput(new Date()).slice(0, 10);
  const exemplo = {
    numero: '0000/' + new Date().getFullYear(), revisao: 1, status: 'emitido', patrimonio: '000000', computador: 'PC000000',
    setor: 'Setor de exemplo', local: 'Sala 1', solicitante: 'Solicitante de exemplo', chamado: 'CH-0000', dataAbertura: hoje,
    problema: M.textos.problema || 'Descrição do problema relatado pelo usuário.',
    diagnostico: M.textos.diagnostico || 'Descrição técnica do que foi verificado e constatado.',
    solucao: M.textos.solucao || 'Descrição dos serviços executados.',
    conclusao: M.conclusaoPadrao || M.conclusoes[0] || '', justificativa: M.textos.justificativa || 'Justificativa técnica da conclusão.',
    recomendacoes: M.textos.recomendacoes || 'Recomendações ao setor.', observacoes: M.textos.observacoes || '',
    testes: (M.testes || []).slice(0, 4).map((nome, i) => ({ nome, resultado: i === 2 ? 'falha' : 'ok', obs: '' })),
    pecas: [{ item: 'Peça de exemplo', qtd: 1, acao: 'a_substituir', obs: '' }],
    campos: Object.fromEntries((M.camposExtras || []).map(c => [c.id, c.tipo === 'selecao' ? (c.opcoes[0] || '') : c.tipo === 'data' ? hoje : 'Exemplo'])),
    assinatura: { responsavel: rep.responsavel, cargo: rep.cargo, matricula: rep.matricula, cidade: rep.cidade, data: hoje },
    snapshot: null, modeloSnap: copiaModelo(M),
  };
  const salvo = LD.cur, anx = LD.anexos;
  LD.cur = exemplo; LD.anexos = [];
  try { renderLaudoPaper(); } finally { LD.cur = salvo; LD.anexos = anx; }
}

// ================================================================== equipamentos
function chaveEquip(patr, comp) {
  const p = String(patr || '').trim();
  return p && !/^NAO /i.test(p) ? 'P:' + p : 'C:' + String(comp || '?').trim().toUpperCase();
}
async function renderEquip(sel) {
  const el = $('#mod-equip');
  el.innerHTML = '<div class="panel">Carregando...</div>';
  if (!(await needServer(el))) return;
  await loadColetasList();
  const map = new Map();
  const get = (k, patr, comp) => { if (!map.has(k)) map.set(k, { k, patrimonio: k.startsWith('P:') ? k.slice(2) : '', computadores: new Set(), coletas: [], laudos: [] }); const o = map.get(k); if (comp) o.computadores.add(comp); return o; };
  for (const c of srv.list || []) get(chaveEquip(c.patrimonio, c.computador), c.patrimonio, c.computador).coletas.push(c);
  for (const l of LD.list) get(chaveEquip(l.patrimonio, l.computador), l.patrimonio, l.computador).laudos.push(l);
  const equips = [...map.values()].map(o => {
    const datas = [...o.coletas.map(c => c.recebidoEm), ...o.laudos.map(l => l.atualizadoEm || l.criadoEm)].sort();
    return { ...o, ultima: datas[datas.length - 1] || '' };
  }).sort((a, b) => b.ultima.localeCompare(a.ultima));

  if (sel) {
    const o = map.get(sel);
    if (!o) { el.innerHTML = `<div class="panel"><p>Equipamento não encontrado.</p><a class="btn small ghost" href="#equip">Voltar</a></div>`; return; }
    const linhas = [
      ...o.coletas.map(c => ({ t: c.recebidoEm, tipo: 'Coleta', desc: `${esc(c.computador)} · enviada por ${esc(c.usuario || '—')}${c.anexos ? ` · ${c.anexos} anexo(s)` : ''}`, acao: `<button class="btn small" data-eqcol="${esc(c.id)}">Abrir coleta</button>` })),
      ...o.laudos.map(l => ({ t: l.criadoEm, tipo: `Laudo ${esc(l.numero)}`, desc: `${esc(l.problema || '')} ${l.conclusao ? `<span class="badge ${CONCLUSAO_CLS[l.conclusao] || ''}">${esc(CONCLUSAO_TXT[l.conclusao].split(' –')[0])}</span>` : ''} <span class="badge ${STATUS_CLS[l.status]}">${STATUS_TXT[l.status]}</span>`, acao: `<a class="btn small" href="#laudo/${esc(l.id)}">Abrir laudo</a>` })),
    ].sort((a, b) => String(b.t).localeCompare(String(a.t)));
    el.innerHTML = `<div class="panel">
      <div class="head-row"><div><a href="#equip" class="btn small ghost">← Equipamentos</a>
        <h2 style="display:inline-block;margin:0 0 0 10px">${o.patrimonio ? 'Patrimônio ' + esc(o.patrimonio) : esc([...o.computadores][0] || '')}</h2></div>
        <button class="btn" id="eqNovo">Novo laudo para este equipamento</button></div>
      <p class="muted">Nomes de computador: ${[...o.computadores].map(esc).join(', ') || '—'}</p>
      ${simpleTable(['Data', 'Registro', 'Descrição', ''], linhas.map(x => [fmt(new Date(x.t)), x.tipo, x.desc, x.acao]), true)}
    </div>`;
    $('#eqNovo').addEventListener('click', () => {
      const ult = o.coletas.slice().sort((a, b) => b.recebidoEm.localeCompare(a.recebidoEm))[0];
      pendingNovo = { coletaId: ult ? ult.id : '', campos: { patrimonio: o.patrimonio, computador: [...o.computadores][0] || '' } };
      LD.cur = null; location.hash = 'laudo/novo';
    });
    el.querySelectorAll('[data-eqcol]').forEach(b => b.addEventListener('click', () => { location.hash = ''; showModule('coletas'); openFromServer(b.dataset.eqcol, b); }));
    return;
  }
  el.innerHTML = `<div class="panel"><div class="head-row"><h2>Equipamentos</h2>
      <input type="search" id="eqQ" placeholder="patrimônio ou nome do computador"></div>
      <p class="muted">Equipamentos com coleta ou laudo registrado no servidor.</p><div id="eqTable"></div></div>`;
  const draw = q => {
    q = (q || '').trim().toLowerCase();
    const rows = equips.filter(o => !q || (o.patrimonio + ' ' + [...o.computadores].join(' ')).toLowerCase().includes(q));
    $('#eqTable').innerHTML = !equips.length ? '<p class="muted">Nenhum registro ainda.</p>' : `<div class="tablewrap"><table class="clickable"><thead><tr><th class="nosort">Patrimônio</th><th class="nosort">Computador</th><th class="nosort">Coletas</th><th class="nosort">Laudos</th><th class="nosort">Último laudo</th><th class="nosort">Última atividade</th></tr></thead><tbody>
      ${rows.map(o => { const ul = o.laudos.slice().sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)))[0];
        return `<tr data-eq="${esc(o.k)}"><td><b>${esc(o.patrimonio || '—')}</b></td><td>${[...o.computadores].map(esc).join('<br>')}</td><td>${o.coletas.length}</td><td>${o.laudos.length}</td>
        <td>${ul ? `${esc(ul.numero)} ${ul.conclusao ? `<span class="badge ${CONCLUSAO_CLS[ul.conclusao] || ''}">${esc(CONCLUSAO_TXT[ul.conclusao].split(' –')[0])}</span>` : ''}` : '—'}</td>
        <td class="t">${o.ultima ? fmt(new Date(o.ultima)).slice(0, 10) : '—'}</td></tr>`; }).join('')}
      </tbody></table></div>`;
    $('#eqTable').querySelectorAll('[data-eq]').forEach(tr => tr.addEventListener('click', () => { location.hash = 'equip/' + encodeURIComponent(tr.dataset.eq); }));
  };
  $('#eqQ').addEventListener('input', e => draw(e.target.value));
  draw('');
}

// laudo a partir da coleta aberta no módulo de remoção
function novoLaudoDaColeta() {
  if (!state.origin || state.origin.tipo !== 'servidor') return;
  const m = state.origin.meta;
  pendingNovo = { coletaId: m.id, campos: {} };
  LD.cur = null;
  location.hash = 'laudo/novo';
}

route();

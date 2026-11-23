'use strict';
/*
  Recebimentos › abas "Locais" e "SELBs".
  - Locais: cadastro com endereço completo; lista dos locais usados nas entregas, com
    cadastrar / corrigir para outro / apagar das entregas.
  - SELBs: cada SELB com seus locais (SELB raramente muda de lugar: mais de um local é destacado),
    corrigir ou apagar o SELB, e "usar este local em todas".
  As correções nas entregas usam POST /api/recebimentos/lote (todas as folhas, com revisão e auditoria).
  Depende de app.js (esc, api, fmt), laudos.js (needServer) e recebimentos.js (RB, RecebOCR).
*/

const CAD = { locais: [], qLocal: '', qSelb: '', soMulti: false };
const nrm = t => RecebOCR.normalizar(t);
const kSelb = t => RecebOCR.normalizar(t).replace(/ /g, '');

function abasReceb(on) {
  const a = (k, rot, href) => `<a href="${href}" class="${on === k ? 'on' : ''}">${rot}</a>`;
  return `<nav class="rb-abas">${a('entregas', 'Entregas', '#receb')}${a('locais', 'Locais', '#receb/locais')}${a('selbs', 'SELBs', '#receb/selbs')}</nav>`;
}

async function carregarLocais() {
  const r = await api('api/receb-locais').catch(() => null);
  CAD.locais = r && r.ok ? await r.json() : [];
  return CAD.locais;
}
const enderecoTxt = L => [
  [L.logradouro, L.numero].filter(Boolean).join(', '), L.complemento, L.bairro,
  [L.cidade, L.uf].filter(Boolean).join('/'), L.cep && 'CEP ' + L.cep,
].filter(Boolean).join(' · ');
const localCadastrado = nome => CAD.locais.find(L => nrm(L.nome) === nrm(nome));

// todas as entregas (linhas) de todas as folhas
async function carregarEntregas() {
  const r = await api('api/recebimentos?linhas=1').catch(() => null);
  RB.folhas = r && r.ok ? await r.json() : [];
  RB.vocab = null; // recalcula sugestões depois de correções
  return RB.folhas.flatMap(f => f.linhas.map(l => ({ ...l, folha: f })));
}

// janela simples: pergunta um valor (com sugestões); resolve null se cancelar
function pedirValor({ titulo, texto, valor = '', sugestoes = [], rotulo = 'Valor', permitirVazio = false }) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = `<form method="dialog"><h2>${esc(titulo)}</h2>${texto ? `<p>${texto}</p>` : ''}
      <label>${esc(rotulo)}<input id="pvIn" value="${esc(valor)}" list="pvDl" autocomplete="off"></label>
      <datalist id="pvDl">${sugestoes.map(v => `<option value="${esc(v)}">`).join('')}</datalist>
      <div class="dlg-actions"><button class="btn ghost" value="x">Cancelar</button><button class="btn" value="ok" id="pvOk">Aplicar</button></div></form>`;
    document.body.appendChild(d);
    d.addEventListener('close', () => {
      const v = d.querySelector('#pvIn').value.trim();
      d.remove();
      resolve(d.returnValue === 'ok' && (v || permitirVazio) ? v : null);
    });
    d.showModal();
    d.querySelector('#pvIn').select();
  });
}

async function corrigirLote(campo, de, para, selb = '') {
  const r = await api('api/recebimentos/lote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campo, de, para, selb }) }).catch(() => null);
  if (!r || !r.ok) { const e = r ? (await r.json().catch(() => ({}))).erro : ''; alert('Não foi possível aplicar: ' + (e || 'servidor indisponível.')); return null; }
  return r.json();
}

// ================================================================== aba Locais
async function renderLocais(editarId) {
  const el = $('#mod-receb');
  el.innerHTML = abasReceb('locais') + '<div class="panel">Carregando...</div>';
  if (!(await needServer(el))) return;
  const [regs] = await Promise.all([carregarEntregas(), carregarLocais()]);
  // locais usados nas entregas, agrupados sem diferenciar acento/maiúscula
  const usados = new Map();
  for (const l of regs) {
    if (!l.local) continue;
    const k = nrm(l.local), u = usados.get(k) || { nome: l.local, n: 0, selbs: new Set(), ult: '' };
    u.n++; if (l.selb) u.selbs.add(l.selb);
    if ((l.dataIso || '') > u.ult) u.ult = l.dataIso || '';
    usados.set(k, u);
  }
  const nomesSug = [...new Set([...CAD.locais.map(L => L.nome), ...[...usados.values()].map(u => u.nome)])].sort();
  const editando = editarId === 'novo' ? {} : CAD.locais.find(L => L.id === editarId);
  el.innerHTML = abasReceb('locais') + `
    ${editando ? formLocal(editando) : ''}
    <div class="panel">
      <div class="head-row"><h2>Locais cadastrados</h2><button class="btn" id="lcNovo">Novo local</button></div>
      ${!CAD.locais.length ? '<p class="muted">Nenhum local cadastrado. Cadastre com "Novo local" ou a partir dos locais usados nas entregas, abaixo.</p>' : `
      <div class="filters"><label>Buscar <input type="search" id="lcQ" value="${esc(CAD.qLocal)}" placeholder="nome, endereço, bairro..." style="min-width:260px"></label></div>
      <div class="tablewrap"><table><thead><tr><th class="nosort">Local</th><th class="nosort">Endereço</th><th class="nosort">Entregas</th><th class="nosort"></th></tr></thead><tbody id="lcLista"></tbody></table></div>`}
    </div>
    <div class="panel">
      <div class="head-row"><h2>Locais usados nas entregas</h2></div>
      <p class="muted">Nomes como aparecem nas folhas. Leituras erradas do OCR podem ser corrigidas para o nome certo ou apagadas de todas as entregas (a linha volta para conferência).</p>
      ${!usados.size ? '<p class="muted">Nenhuma entrega com local.</p>' : `
      <div class="tablewrap"><table><thead><tr><th class="nosort">Local</th><th class="nosort">Entregas</th><th class="nosort">SELBs</th><th class="nosort">Última</th><th class="nosort"></th></tr></thead><tbody>
      ${[...usados.values()].sort((a, b) => b.n - a.n).map(u => {
        const cad = localCadastrado(u.nome);
        return `<tr><td><b>${esc(u.nome)}</b> ${cad ? '<span class="badge ok">cadastrado</span>' : '<span class="badge warn">sem cadastro</span>'}</td>
          <td>${u.n}</td><td><small>${[...u.selbs].slice(0, 8).map(esc).join(', ')}${u.selbs.size > 8 ? '…' : ''}</small></td>
          <td class="t">${u.ult ? esc(u.ult.split('-').reverse().join('/')) : '—'}</td>
          <td class="acoes">${cad ? '' : `<button class="btn ghost small" data-cad="${esc(u.nome)}">Cadastrar</button>`}
            <button class="btn ghost small" data-corr="${esc(u.nome)}">Corrigir para…</button>
            <button class="btn ghost small perigo" data-apagar="${esc(u.nome)}">Apagar</button></td></tr>`;
      }).join('')}</tbody></table></div>`}
    </div>`;
  const desenharCad = () => {
    const box = $('#lcLista'); if (!box) return;
    const q = nrm(CAD.qLocal);
    const conta = L => [...usados.values()].filter(u => nrm(u.nome) === nrm(L.nome)).reduce((a, u) => a + u.n, 0);
    box.innerHTML = CAD.locais.filter(L => !q || nrm([L.nome, enderecoTxt(L), L.referencia].join(' ')).includes(q))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
      .map(L => `<tr><td><b>${esc(L.nome)}</b>${L.referencia ? `<br><small>${esc(L.referencia)}</small>` : ''}</td>
        <td>${esc(enderecoTxt(L)) || '<span class="muted">sem endereço</span>'}${L.obs ? `<br><small>${esc(L.obs)}</small>` : ''}</td>
        <td>${conta(L) ? `<button class="linklike" data-ver="${esc(L.nome)}">${conta(L)}</button>` : '0'}</td>
        <td class="acoes"><a class="btn ghost small" href="#receb/locais~${esc(L.id)}">Editar</a>
          <button class="btn ghost small perigo" data-excluir="${esc(L.id)}">Excluir</button></td></tr>`).join('');
    box.querySelectorAll('[data-ver]').forEach(b => b.addEventListener('click', () => { RB.fLocal = b.dataset.ver; RB.fSelb = ''; RB.q = ''; location.hash = 'receb'; }));
    box.querySelectorAll('[data-excluir]').forEach(b => b.addEventListener('click', async () => {
      const L = CAD.locais.find(x => x.id === b.dataset.excluir);
      if (!confirm(`Excluir o cadastro de "${L.nome}"? As entregas não são alteradas.`)) return;
      const r = await api('api/receb-locais/' + L.id, { method: 'DELETE' }).catch(() => null);
      if (!r || !r.ok) return alert('Não foi possível excluir.');
      renderLocais();
    }));
  };
  $('#lcNovo').addEventListener('click', () => { location.hash = 'receb/locais~novo'; });
  if ($('#lcQ')) $('#lcQ').addEventListener('input', e => { CAD.qLocal = e.target.value; desenharCad(); });
  el.querySelectorAll('[data-cad]').forEach(b => b.addEventListener('click', () => { CAD.novoNome = b.dataset.cad; location.hash = 'receb/locais~novo'; }));
  el.querySelectorAll('[data-corr]').forEach(b => b.addEventListener('click', async () => {
    const de = b.dataset.corr;
    const para = await pedirValor({ titulo: 'Corrigir local', rotulo: 'Trocar por', texto: `Troca “${esc(de)}” em todas as entregas.`, sugestoes: nomesSug.filter(v => nrm(v) !== nrm(de)) });
    if (para === null || nrm(para) === nrm(de) && para === de) return;
    const r = await corrigirLote('local', de, para);
    if (r) { alert(`${r.linhas} entrega(s) corrigida(s) em ${r.folhas} folha(s).`); renderLocais(); }
  }));
  el.querySelectorAll('[data-apagar]').forEach(b => b.addEventListener('click', async () => {
    const de = b.dataset.apagar;
    if (!confirm(`Apagar o local “${de}” de todas as entregas? O campo fica vazio e a linha volta para conferência.`)) return;
    const r = await corrigirLote('local', de, '');
    if (r) { alert(`Local apagado de ${r.linhas} entrega(s).`); renderLocais(); }
  }));
  if (editando) ligarFormLocal(editando);
  desenharCad();
}

function formLocal(L) {
  const v = k => esc(L[k] || (k === 'nome' && !L.id ? CAD.novoNome || '' : ''));
  const ufs = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');
  return `<div class="panel" id="lcForm">
    <div class="head-row"><h2>${L.id ? 'Editar local' : 'Novo local'}</h2></div>
    <div class="rep-grid">
      <label class="full">Nome do local (como aparece nas folhas) <input id="lfNome" value="${v('nome')}" maxlength="160" required></label>
      <label>CEP <input id="lfCep" value="${v('cep')}" maxlength="9" inputmode="numeric" placeholder="00000-000"></label>
      <label class="full">Logradouro <input id="lfLogradouro" value="${v('logradouro')}" maxlength="200" placeholder="Rua, avenida..."></label>
      <label>Número <input id="lfNumero" value="${v('numero')}" maxlength="20"></label>
      <label>Complemento <input id="lfComplemento" value="${v('complemento')}" maxlength="120" placeholder="sala, andar, bloco..."></label>
      <label>Bairro <input id="lfBairro" value="${v('bairro')}" maxlength="120"></label>
      <label>Cidade <input id="lfCidade" value="${v('cidade')}" maxlength="120"></label>
      <label>UF <select id="lfUf"><option value=""></option>${ufs.map(u => `<option ${L.uf === u ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
      <label class="full">Ponto de referência <input id="lfReferencia" value="${v('referencia')}" maxlength="300"></label>
      <label class="full">Observações <textarea id="lfObs" rows="2" maxlength="1000">${v('obs')}</textarea></label>
    </div>
    <div class="dlg-actions"><a class="btn ghost" href="#receb/locais">Cancelar</a><button class="btn" id="lfSalvar">Salvar local</button></div>
  </div>`;
}
function ligarFormLocal(L) {
  CAD.novoNome = '';
  $('#lcForm').scrollIntoView({ block: 'start' });
  $('#lfNome').focus();
  $('#lfCep').addEventListener('input', e => { const d = e.target.value.replace(/\D/g, '').slice(0, 8); e.target.value = d.length > 5 ? d.slice(0, 5) + '-' + d.slice(5) : d; });
  $('#lfSalvar').addEventListener('click', async e => {
    const corpo = {};
    for (const k of ['nome', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf', 'referencia', 'obs']) corpo[k] = $('#lf' + k[0].toUpperCase() + k.slice(1)).value.trim();
    if (!corpo.nome) { alert('Informe o nome do local.'); return $('#lfNome').focus(); }
    e.target.disabled = true;
    const r = await api('api/receb-locais' + (L.id ? '/' + L.id : ''), { method: L.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }).catch(() => null);
    e.target.disabled = false;
    if (!r || !r.ok) { const er = r ? (await r.json().catch(() => ({}))).erro : ''; return alert('Não foi possível salvar: ' + (er || 'servidor indisponível.')); }
    // renomeou um local cadastrado: oferece atualizar as entregas com o nome antigo
    if (L.id && L.nome && nrm(L.nome) !== nrm(corpo.nome) && confirm(`Trocar também “${L.nome}” por “${corpo.nome}” nas entregas já registradas?`)) await corrigirLote('local', L.nome, corpo.nome);
    location.hash = 'receb/locais';
  });
}

// ================================================================== aba SELBs
async function renderSelbs() {
  const el = $('#mod-receb');
  el.innerHTML = abasReceb('selbs') + '<div class="panel">Carregando...</div>';
  if (!(await needServer(el))) return;
  const [regs] = await Promise.all([carregarEntregas(), carregarLocais()]);
  const mapa = new Map();
  for (const l of regs) {
    if (!l.selb) continue;
    const k = kSelb(l.selb), s = mapa.get(k) || { selb: l.selb, n: 0, locais: new Map(), ult: null };
    s.n++;
    if (l.local) { const lk = nrm(l.local), o = s.locais.get(lk) || { nome: l.local, n: 0 }; o.n++; s.locais.set(lk, o); }
    if (!s.ult || (l.dataIso || '') > (s.ult.dataIso || '')) s.ult = l;
    mapa.set(k, s);
  }
  const selbs = [...mapa.values()].sort((a, b) => a.selb.localeCompare(b.selb, 'pt-BR', { numeric: true }));
  const multi = selbs.filter(s => s.locais.size > 1).length;
  const nomesSug = [...new Set([...CAD.locais.map(L => L.nome), ...regs.map(l => l.local).filter(Boolean)])].sort();
  el.innerHTML = abasReceb('selbs') + `
    <div class="panel">
      <div class="head-row"><h2>SELBs</h2></div>
      <div class="stats">
        <div class="stat"><div class="v">${selbs.length}</div><div class="l">SELBs</div></div>
        <div class="stat ${multi ? 'bad' : ''}"><div class="v">${multi}</div><div class="l">com mais de um local</div></div>
      </div>
      <p class="muted">SELB raramente muda de lugar: mais de um local costuma ser leitura errada. Use <b>usar em todas</b> no local certo, ou corrija/apague um SELB lido errado (ex.: “B7T7” no lugar de “B77”).</p>
      <div class="filters"><label>SELB <input type="search" id="sbQ" value="${esc(CAD.qSelb)}" placeholder="buscar SELB ou local" style="min-width:220px"></label>
        <label class="chk"><input type="checkbox" id="sbMulti" ${CAD.soMulti ? 'checked' : ''}> só com mais de um local</label><span class="muted" id="sbN"></span></div>
      <div id="sbLista"></div>
    </div>`;
  const desenhar = () => {
    const q = nrm(CAD.qSelb), qk = kSelb(CAD.qSelb);
    const lista = selbs.filter(s => (!CAD.soMulti || s.locais.size > 1) && (!q || kSelb(s.selb).includes(qk) || [...s.locais.values()].some(o => nrm(o.nome).includes(q))));
    $('#sbN').textContent = `${lista.length} de ${selbs.length}`;
    $('#sbLista').innerHTML = !lista.length ? '<p class="muted">Nenhum SELB.</p>' : `<div class="tablewrap"><table><thead><tr><th class="nosort">SELB</th><th class="nosort">Entregas</th><th class="nosort">Locais</th><th class="nosort">Última entrega</th><th class="nosort"></th></tr></thead><tbody>
      ${lista.slice(0, 1000).map(s => {
        const locs = [...s.locais.values()].sort((a, b) => b.n - a.n);
        return `<tr class="${s.locais.size > 1 ? 'rb-multi' : ''}"><td><b>${esc(s.selb)}</b>${s.locais.size > 1 ? ' <span class="badge warn">mais de um local</span>' : ''}</td>
          <td><button class="linklike" data-ver="${esc(s.selb)}">${s.n}</button></td>
          <td>${locs.map(o => `<div class="rb-loc">${esc(o.nome)} <small>(${o.n})</small>${localCadastrado(o.nome) ? '' : ' <span class="badge warn" title="Local sem cadastro">?</span>'}
            ${s.locais.size > 1 ? `<button class="linklike" data-todas="${esc(s.selb)}" data-loc="${esc(o.nome)}">usar em todas</button>` : ''}</div>`).join('') || '—'}</td>
          <td class="t">${esc(s.ult.data || '—')}<br><small>${esc(s.ult.local || '')}</small></td>
          <td class="acoes"><button class="btn ghost small" data-corrsel="${esc(s.selb)}">Corrigir SELB…</button>
            <button class="btn ghost small" data-corrloc="${esc(s.selb)}">Trocar local…</button>
            <button class="btn ghost small perigo" data-apagasel="${esc(s.selb)}">Apagar</button></td></tr>`;
      }).join('')}</tbody></table></div>`;
    const box = $('#sbLista');
    box.querySelectorAll('[data-ver]').forEach(b => b.addEventListener('click', () => { RB.fSelb = b.dataset.ver; RB.fLocal = ''; RB.q = ''; location.hash = 'receb'; }));
    box.querySelectorAll('[data-todas]').forEach(b => b.addEventListener('click', async () => {
      const s = mapa.get(kSelb(b.dataset.todas)), certo = b.dataset.loc;
      const outros = [...s.locais.values()].filter(o => nrm(o.nome) !== nrm(certo));
      if (!confirm(`Usar “${certo}” em todas as entregas do SELB ${s.selb}?\nTroca: ${outros.map(o => `${o.nome} (${o.n})`).join(', ')}`)) return;
      let n = 0;
      for (const o of outros) { const r = await corrigirLote('local', o.nome, certo, s.selb); if (!r) return; n += r.linhas; }
      alert(`${n} entrega(s) do SELB ${s.selb} atualizada(s).`); renderSelbs();
    }));
    box.querySelectorAll('[data-corrloc]').forEach(b => b.addEventListener('click', async () => {
      const s = mapa.get(kSelb(b.dataset.corrloc));
      const para = await pedirValor({ titulo: `Local do SELB ${s.selb}`, rotulo: 'Local certo', texto: 'Coloca este local em todas as entregas deste SELB.', valor: s.ult.local || '', sugestoes: nomesSug });
      if (para === null) return;
      let n = 0;
      for (const o of s.locais.values()) if (nrm(o.nome) !== nrm(para) || o.nome !== para) { const r = await corrigirLote('local', o.nome, para, s.selb); if (!r) return; n += r.linhas; }
      alert(`${n} entrega(s) do SELB ${s.selb} atualizada(s).`); renderSelbs();
    }));
    box.querySelectorAll('[data-corrsel]').forEach(b => b.addEventListener('click', async () => {
      const de = b.dataset.corrsel;
      const para = await pedirValor({ titulo: 'Corrigir SELB', rotulo: 'SELB certo', texto: `Troca o SELB “${esc(de)}” em todas as entregas.`, valor: de, sugestoes: selbs.map(s => s.selb).filter(v => kSelb(v) !== kSelb(de)) });
      if (para === null || para.toUpperCase() === de) return;
      const r = await corrigirLote('selb', de, para);
      if (r) { alert(`${r.linhas} entrega(s) corrigida(s).`); renderSelbs(); }
    }));
    box.querySelectorAll('[data-apagasel]').forEach(b => b.addEventListener('click', async () => {
      const de = b.dataset.apagasel;
      if (!confirm(`Apagar o SELB “${de}” de todas as entregas? O campo fica vazio e a linha volta para conferência.`)) return;
      const r = await corrigirLote('selb', de, '');
      if (r) { alert(`SELB apagado de ${r.linhas} entrega(s).`); renderSelbs(); }
    }));
  };
  $('#sbQ').addEventListener('input', e => { CAD.qSelb = e.target.value; desenhar(); });
  $('#sbMulti').addEventListener('change', e => { CAD.soMulti = e.target.checked; desenhar(); });
  desenhar();
}

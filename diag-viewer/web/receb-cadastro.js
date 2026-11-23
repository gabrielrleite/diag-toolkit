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

const CAD = { locais: [], qLocal: '', qSelb: '', soMulti: false, soSemCad: false };
const nrm = t => RecebOCR.normalizar(t);
const kSelb = t => RecebOCR.normalizar(t).replace(/ /g, '');

function abasReceb(on) {
  const a = (k, rot, href) => `<a href="${href}" class="${on === k ? 'on' : ''}">${rot}</a>`;
  return `<nav class="rb-abas">${a('entregas', 'Entregas', '#receb')}${a('locais', 'Locais', '#receb/locais')}${a('selbs', 'SELBs', '#receb/selbs')}${a('impressoras', 'Impressoras', '#receb/impressoras')}${a('treino', 'Treinamento', '#receb/treino')}</nav>`;
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
    u.n++; for (const x of RecebOCR.separarSelbs(l.selb)) u.selbs.add(x);
    if ((l.dataIso || '') > u.ult) u.ult = l.dataIso || '';
    usados.set(k, u);
  }
  const nomesSug = [...new Set([...CAD.locais.map(L => L.nome), ...[...usados.values()].map(u => u.nome)])].sort();
  const editando = editarId === 'novo' ? {} : CAD.locais.find(L => L.id === editarId);
  el.innerHTML = abasReceb('locais') + `
    ${editando ? formLocal(editando) : ''}
    <div class="panel">
      <div class="head-row"><h2>Locais cadastrados</h2><button class="btn" id="lcNovo">Novo local</button></div>
      ${!CAD.locais.length ? vazioHtml('local', 'Nenhum local cadastrado', 'Cadastre com "Novo local" ou a partir dos locais usados nas entregas, abaixo.') : `
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
async function renderSelbs(editar = '') {
  const el = $('#mod-receb');
  el.innerHTML = abasReceb('selbs') + '<div class="panel">Carregando...</div>';
  if (!(await needServer(el))) return;
  const [regs, , cads] = await Promise.all([carregarEntregas(), carregarLocais(), carregarSelbsCad(), atualizarMonitor()]);
  const mapa = new Map();
  const novoS = sel => ({ selb: sel.toUpperCase(), n: 0, locais: new Map(), ult: null, itens: new Map() });
  // uma entrega com vários SELBs conta para cada um deles
  for (const l of regs) for (const sel of RecebOCR.separarSelbs(l.selb)) {
    const k = kSelb(sel), s = mapa.get(k) || novoS(sel);
    s.n++;
    if (l.local) { const lk = nrm(l.local), o = s.locais.get(lk) || { nome: l.local, n: 0 }; o.n++; s.locais.set(lk, o); }
    if (!s.ult || (l.dataIso || '') > (s.ult.dataIso || '')) s.ult = l;
    for (const it of l.itens || []) if (kSelb(it.selb) === k) { const key = it.item + '|' + it.tipo; s.itens.set(key, (s.itens.get(key) || 0) + it.qtd); }
    mapa.set(k, s);
  }
  for (const c of cads) if (!mapa.has(kSelb(c.selb))) mapa.set(kSelb(c.selb), novoS(c.selb)); // cadastrado, ainda sem entrega
  const selbs = [...mapa.values()].sort((a, b) => a.selb.localeCompare(b.selb, 'pt-BR', { numeric: true }));
  const multi = selbs.filter(s => s.locais.size > 1).length, semCad = selbs.filter(s => !cadSelb(s.selb)).length;
  const totItens = selbs.reduce((a, s) => a + [...s.itens.values()].reduce((b, q) => b + q, 0), 0);
  const nomesSug = [...new Set([...CAD.locais.map(L => L.nome), ...regs.map(l => l.local).filter(Boolean)])].sort();
  const editando = editar ? (cadSelb(editar) || { selb: editar === 'novo' ? '' : editar.toUpperCase(), novo: true }) : null;
  el.innerHTML = abasReceb('selbs') + `
    ${editando ? formSelb(editando, mapa.get(kSelb(editando.selb || ''))) : ''}
    <div class="panel">
      <div class="head-row"><h2>SELBs</h2><div class="filters" style="margin:0">
        <button class="btn ghost" id="sbPing" title="Pinga agora as impressoras com IP">${IC('raio')}Verificar impressoras</button>
        <a class="btn" href="#receb/selbs~novo">${IC('mais')}Cadastrar SELB</a></div></div>
      <div class="stats">
        ${statHtml(selbs.length, 'SELBs', 'tag', '')}
        ${statHtml(selbs.length - semCad, 'com cadastro', 'monitor', 'ok')}
        ${statHtml(totItens, 'tintas, toners e caixas entregues', 'caixa', 'violeta')}
        ${statHtml(multi, 'com mais de um local', 'local', multi ? 'bad' : '')}
      </div>
      <p class="muted">Cada SELB é uma impressora ou scanner. No cadastro ficam o equipamento, se é colorida ou preto, o IP, se usa <b>tinta ou toner</b>, as cores, a caixa de manutenção e os <b>códigos dos suprimentos</b> (observação).
        SELB raramente muda de lugar: mais de um local costuma ser leitura errada (use <b>usar em todas</b> no local certo).</p>
      <div class="filters"><label>Buscar <input type="search" id="sbQ" value="${esc(CAD.qSelb)}" placeholder="SELB, local, marca, modelo, IP, código" style="min-width:260px"></label>
        <label class="chk"><input type="checkbox" id="sbMulti" ${CAD.soMulti ? 'checked' : ''}> só com mais de um local</label>
        <label class="chk"><input type="checkbox" id="sbSemCad" ${CAD.soSemCad ? 'checked' : ''}> só sem cadastro</label><span class="muted" id="sbN"></span></div>
      <div id="sbLista"></div>
    </div>`;
  const desenhar = () => {
    const q = nrm(CAD.qSelb), qk = kSelb(CAD.qSelb);
    const lista = selbs.filter(s => {
      const c = cadSelb(s.selb);
      if (CAD.soMulti && s.locais.size <= 1) return false;
      if (CAD.soSemCad && c) return false;
      return !q || kSelb(s.selb).includes(qk) || [...s.locais.values()].some(o => nrm(o.nome).includes(q)) || (c && nrm([c.marca, c.modelo, c.serie, c.ip, c.obs].join(' ')).includes(q));
    });
    $('#sbN').textContent = `${lista.length} de ${selbs.length}`;
    $('#sbLista').innerHTML = !lista.length ? vazioHtml('tag', 'Nenhum SELB', 'Os SELBs aparecem aqui conforme as folhas são importadas, ou cadastre um em "Cadastrar SELB".') : `<div class="tablewrap"><table><thead><tr><th class="nosort">SELB / equipamento</th><th class="nosort">Entregas</th><th class="nosort">Itens entregues</th><th class="nosort">Locais</th><th class="nosort">Última entrega</th><th class="nosort"></th></tr></thead><tbody>
      ${lista.slice(0, 1000).map(s => {
        const locs = [...s.locais.values()].sort((a, b) => b.n - a.n), c = cadSelb(s.selb);
        const itens = [...s.itens.entries()].map(([key, qtd]) => { const [item, tipo] = key.split('|'); return { selb: s.selb, item, tipo, qtd }; })
          .sort((a, b) => Object.keys(ITENS).indexOf(a.item) - Object.keys(ITENS).indexOf(b.item));
        return `<tr class="${s.locais.size > 1 ? 'rb-multi' : ''}">
          <td><b>${esc(s.selb)}</b>${s.locais.size > 1 ? ' <span class="badge warn">mais de um local</span>' : ''}
            <br>${c ? `<small>${esc(resumoEquip(c, false))}</small>${c.ip ? ` <a class="ip-link" href="http://${esc(c.ip)}" target="_blank" rel="noopener" title="Abrir o painel da impressora">${situacaoHtml(c.ip)}${esc(c.ip)}</a>` : ''}${c.obs ? `<br><small class="it-obs" title="${esc(c.obs)}">${IC('tag')} ${esc(c.obs.slice(0, 70))}${c.obs.length > 70 ? '…' : ''}</small>` : ''}` : '<span class="badge">sem cadastro</span>'}</td>
          <td>${s.n ? `<button class="linklike" data-ver="${esc(s.selb)}">${s.n}</button>` : '0'}</td>
          <td>${itens.length ? itensHtml(itens, false) : '<span class="muted">—</span>'}</td>
          <td>${locs.map(o => `<div class="rb-loc">${esc(o.nome)} <small>(${o.n})</small>${localCadastrado(o.nome) ? '' : ' <span class="badge warn" title="Local sem cadastro">?</span>'}
            ${s.locais.size > 1 ? `<button class="linklike" data-todas="${esc(s.selb)}" data-loc="${esc(o.nome)}">usar em todas</button>` : ''}</div>`).join('') || '—'}</td>
          <td class="t">${s.ult ? `${esc(s.ult.data || '—')}<br><small>${esc(s.ult.local || '')}</small>` : '—'}</td>
          <td class="acoes"><a class="btn small" href="#receb/selbs~${encodeURIComponent(s.selb)}">${c ? 'Cadastro' : 'Cadastrar'}</a>
            ${s.n ? `<details class="menu-acoes"><summary class="btn ghost small" title="Mais ações">⋯</summary><div>
              <button class="btn ghost small" data-corrsel="${esc(s.selb)}">Corrigir SELB…</button>
              <button class="btn ghost small" data-corrloc="${esc(s.selb)}">Trocar local…</button>
              <button class="btn ghost small perigo" data-apagasel="${esc(s.selb)}">Apagar das entregas</button></div></details>` : ''}</td></tr>`;
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
      const para = await pedirValor({ titulo: `Local do SELB ${s.selb}`, rotulo: 'Local certo', texto: 'Coloca este local em todas as entregas deste SELB.', valor: s.ult ? s.ult.local || '' : '', sugestoes: nomesSug });
      if (para === null) return;
      let n = 0;
      for (const o of s.locais.values()) if (nrm(o.nome) !== nrm(para) || o.nome !== para) { const r = await corrigirLote('local', o.nome, para, s.selb); if (!r) return; n += r.linhas; }
      alert(`${n} entrega(s) do SELB ${s.selb} atualizada(s).`); renderSelbs();
    }));
    box.querySelectorAll('[data-corrsel]').forEach(b => b.addEventListener('click', async () => {
      const de = b.dataset.corrsel;
      const para = await pedirValor({ titulo: 'Corrigir SELB', rotulo: 'SELB certo', texto: `Troca o SELB “${esc(de)}” em todas as entregas (os itens e o cadastro vão junto).`, valor: de, sugestoes: selbs.map(s => s.selb).filter(v => kSelb(v) !== kSelb(de)) });
      if (para === null || para.toUpperCase() === de) return;
      const r = await corrigirLote('selb', de, para);
      if (r) { alert(`${r.linhas} entrega(s) corrigida(s).`); renderSelbs(); }
    }));
    box.querySelectorAll('[data-apagasel]').forEach(b => b.addEventListener('click', async () => {
      const de = b.dataset.apagasel;
      if (!confirm(`Apagar o SELB “${de}” de todas as entregas? O campo fica vazio, os itens desse SELB saem e a linha volta para conferência. (O cadastro do SELB não é apagado.)`)) return;
      const r = await corrigirLote('selb', de, '');
      if (r) { alert(`SELB apagado de ${r.linhas} entrega(s).`); renderSelbs(); }
    }));
  };
  $('#sbPing').addEventListener('click', async e => {
    e.target.disabled = true; e.target.textContent = 'Verificando…';
    await atualizarMonitor(true); renderSelbs();
  });
  $('#sbQ').addEventListener('input', e => { CAD.qSelb = e.target.value; desenhar(); });
  $('#sbMulti').addEventListener('change', e => { CAD.soMulti = e.target.checked; desenhar(); });
  $('#sbSemCad').addEventListener('change', e => { CAD.soSemCad = e.target.checked; desenhar(); });
  if (editando) ligarFormSelb(editando);
  desenhar();
}

// formulário do cadastro de um SELB (impressora/scanner)
function formSelb(c, uso) {
  const cores = c.cores || ['preto', 'azul', 'magenta', 'amarelo'], cor = c.cor || 'colorida', sup = c.suprimento || 'tinta';
  const radio = (nome, valor, rot, atual) => `<label class="seg-op"><input type="radio" name="${nome}" value="${valor}" ${atual === valor ? 'checked' : ''}><span>${rot}</span></label>`;
  return `<div class="panel" id="sbForm">
    <div class="head-row"><h2>${c.novo ? 'Cadastrar SELB' : 'Cadastro do SELB ' + esc(c.selb)}</h2>
      ${uso && uso.n ? `<span class="muted">${uso.n} entrega(s) registrada(s)</span>` : ''}</div>
    <div class="rep-grid">
      <label>SELB <input id="sfSelb" value="${esc(c.selb)}" maxlength="40" ${c.novo ? '' : 'readonly'} placeholder="ex.: A1234"></label>
      <label>Tipo <select id="sfTipo">${Object.entries(TIPO_EQUIP_TXT).map(([k, t]) => `<option value="${k}" ${c.tipo === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Marca <input id="sfMarca" value="${esc(c.marca || '')}" maxlength="80" placeholder="ex.: Epson"></label>
      <label>Modelo <input id="sfModelo" value="${esc(c.modelo || '')}" maxlength="120" placeholder="ex.: L6270"></label>
      <label>Nº de série <input id="sfSerie" value="${esc(c.serie || '')}" maxlength="80"></label>
      <label>IP da impressora <input id="sfIp" value="${esc(c.ip || '')}" maxlength="15" inputmode="decimal" placeholder="ex.: 192.168.0.50" autocomplete="off"></label>
    </div>
    <div class="sf-grupos">
      <div><span class="lbl">Impressão</span><div class="seg2">${radio('sfCor', 'colorida', 'Colorida', cor)}${radio('sfCor', 'pb', 'Preto', cor)}</div></div>
      <div><span class="lbl">Suprimento</span><div class="seg2">${radio('sfSup', 'tinta', 'Tinta', sup)}${radio('sfSup', 'toner', 'Toner', sup)}${radio('sfSup', 'nenhum', 'Nenhum (scanner)', sup)}</div></div>
      <div><span class="lbl">Cores usadas</span><div class="it-chips" id="sfCores">
        ${['preto', 'azul', 'magenta', 'amarelo'].map(k => `<label class="it-chip ${cores.includes(k) ? 'on' : ''}"><input type="checkbox" value="${k}" ${cores.includes(k) ? 'checked' : ''}><span class="it-bola it-${k}"></span>${ITENS[k]}</label>`).join('')}</div></div>
      <div><span class="lbl">Manutenção</span><p class="sf-nota"><span class="it-bola it-caixa">${IC('caixa')}</span>Toda impressora usa caixa de manutenção: ela entra sozinha nos itens (scanner não).</p></div>
    </div>
    <label class="full">Observação — códigos das tintas/toners e da caixa
      <textarea id="sfObs" rows="3" maxlength="2000" placeholder="ex.: Tinta T544120 (preto), T544220 (azul), T544320 (magenta), T544420 (amarelo) · Caixa C9345">${esc(c.obs || '')}</textarea></label>
    <div class="dlg-actions">${c.novo ? '' : '<button class="btn ghost perigo" id="sfExcluir">Excluir cadastro</button>'}<a class="btn ghost" href="#receb/selbs">Cancelar</a><button class="btn" id="sfSalvar">Salvar cadastro</button></div>
  </div>`;
}
function ligarFormSelb(c) {
  const f = $('#sbForm');
  f.scrollIntoView({ block: 'start' });
  const atualizar = () => {
    const pb = f.querySelector('input[name="sfCor"]:checked').value === 'pb', nenhum = f.querySelector('input[name="sfSup"]:checked').value === 'nenhum';
    f.querySelectorAll('#sfCores input').forEach(cb => {
      if (pb) cb.checked = cb.value === 'preto';
      if (nenhum) cb.checked = false;
      cb.disabled = nenhum || (pb && cb.value !== 'preto');
      cb.closest('.it-chip').classList.toggle('on', cb.checked);
      cb.closest('.it-chip').classList.toggle('off', cb.disabled);
    });
  };
  f.querySelectorAll('input[name="sfCor"], input[name="sfSup"]').forEach(r => r.addEventListener('change', () => {
    // voltou para colorida: marca as 4 cores
    if (r.name === 'sfCor' && r.value === 'colorida') f.querySelectorAll('#sfCores input').forEach(cb => { cb.checked = true; });
    atualizar();
  }));
  f.querySelectorAll('.it-chip input[type="checkbox"]').forEach(cb => cb.addEventListener('change', () => cb.closest('.it-chip').classList.toggle('on', cb.checked)));
  atualizar();
  $('#sfSalvar').addEventListener('click', async e => {
    const selb = $('#sfSelb').value.trim().toUpperCase();
    if (!selb || RecebOCR.separarSelbs(selb).length !== 1) { alert('Informe um SELB (um só).'); return $('#sfSelb').focus(); }
    const ip = $('#sfIp').value.trim();
    if (ip && !ipValido(ip)) { alert('IP inválido. Use o formato 192.168.0.50.'); return $('#sfIp').focus(); }
    const corpo = {
      tipo: $('#sfTipo').value, marca: $('#sfMarca').value, modelo: $('#sfModelo').value, serie: $('#sfSerie').value,
      cor: f.querySelector('input[name="sfCor"]:checked').value, suprimento: f.querySelector('input[name="sfSup"]:checked').value,
      cores: [...f.querySelectorAll('#sfCores input:checked')].map(cb => cb.value), ip: $('#sfIp').value.trim(), obs: $('#sfObs').value,
    };
    e.target.disabled = true;
    const r = await api('api/receb-selbs/' + encodeURIComponent(selb), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }).catch(() => null);
    e.target.disabled = false;
    if (!r || !r.ok) { const er = r ? (await r.json().catch(() => ({}))).erro : ''; return alert('Não foi possível salvar: ' + (er || 'servidor indisponível.')); }
    RB.vocab = null;
    location.hash = 'receb/selbs';
  });
  if ($('#sfExcluir')) $('#sfExcluir').addEventListener('click', async () => {
    if (!confirm(`Excluir o cadastro do SELB ${c.selb}? As entregas não são alteradas.`)) return;
    const r = await api('api/receb-selbs/' + encodeURIComponent(c.selb), { method: 'DELETE' }).catch(() => null);
    if (!r || !r.ok) return alert('Não foi possível excluir.');
    RB.vocab = null; location.hash = 'receb/selbs';
  });
}

// ================================================================== aba Treinamento
const CAMPO_TXT = { local: 'Local', selb: 'SELB', data: 'Data' };
const pct = (a, n) => n ? Math.round(a / n * 100) + '%' : '—';
async function renderTreino() {
  const el = $('#mod-receb');
  el.innerHTML = abasReceb('treino') + '<div class="panel">Carregando...</div>';
  if (!(await needServer(el))) return;
  const [T, st] = await Promise.all([api('api/treino').then(r => r.ok ? r.json() : null).catch(() => null), estadoOcrServidor()]);
  if (!T) { el.innerHTML = abasReceb('treino') + '<div class="panel"><p class="err">Não foi possível carregar o treinamento.</p></div>'; return; }
  const tot = Object.values(T.porCampo).reduce((a, v) => [a[0] + v.certos, a[1] + v.n], [0, 0]);
  const barra = (c, n) => `<div class="vol-bar" style="min-width:120px"><div style="width:${n ? Math.round(c / n * 100) : 0}%"></div></div>`;
  const tabela = (obj, rot) => `<table><thead><tr><th class="nosort">${rot}</th><th class="nosort">Exemplos</th><th class="nosort">Lidos certo pelo OCR</th><th class="nosort"></th></tr></thead><tbody>
    ${Object.entries(obj).map(([k, v]) => `<tr><td>${esc(rot === 'Campo' ? CAMPO_TXT[k] || k : rot === 'Leitura' ? MOTOR_TXT[k] || k : k)}</td><td>${v.n}</td><td>${pct(v.certos, v.n)}</td><td style="width:40%">${barra(v.certos, v.n)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Sem exemplos ainda.</td></tr>'}</tbody></table>`;
  const zipUrl = `api/treino/exportar.zip${srv.token ? '?token=' + encodeURIComponent(srv.token) : ''}`;
  el.innerHTML = abasReceb('treino') + `
    <div class="panel">
      <div class="head-row"><h2>Modo treinamento</h2>
        <label class="rb-switch"><input type="checkbox" id="trAtivo" ${T.ativo ? 'checked' : ''}><span></span><b>${T.ativo ? 'Ligado' : 'Desligado'}</b></label></div>
      <p class="muted">Com o modo ligado, cada linha <b>conferida</b> ensina o sistema: o que o OCR leu em Local, SELB e Data é comparado com o texto final.
        Leituras que já foram corrigidas da mesma forma passam a ser corrigidas sozinhas na próxima folha (com aviso, e dá para voltar ao lido).
        SELB bem formado nunca é trocado. Ficam guardados só os recortes dessas três células — CPF, nome e assinatura nunca entram.</p>
      <div class="stats">
        ${statHtml(T.total, 'exemplos conferidos', 'lista', '')}
        ${statHtml(pct(tot[0], tot[1]), 'lidos certo pelo OCR', 'check', 'ok')}
        ${statHtml(T.regras.length, 'correções aprendidas', 'cerebro', 'violeta')}
        ${statHtml(T.comImagem, 'com recorte da imagem', 'imagem', '')}
      </div>
    </div>
    <div class="panel">
      <div class="head-row"><h2>OCR do servidor</h2><span class="badge ${st.estado === 'pronto' ? 'ok' : st.estado === 'erro' ? 'bad' : 'warn'}">${esc(ESTADO_OCR_TXT[st.estado] || st.estado)}</span></div>
      ${st.estado === 'desativado' ? `<p class="muted">O serviço <b>diag-ocr</b> (TrOCR, letra à mão) não está instalado neste servidor; a leitura usa o Tesseract do navegador. Veja <i>docs/INSTALAR-PORTAINER.txt</i>.</p>`
        : `<p class="muted">Modelo <b>${esc(st.modelo || '—')}</b>${st.precisao ? ` (${esc(st.precisao)})` : ''}${st.detalhe ? ` · ${esc(st.detalhe)}` : ''}</p>`}
    </div>
    <div class="grid2">
      <div class="panel"><h2>Acerto por campo</h2>${tabela(T.porCampo, 'Campo')}</div>
      <div class="panel"><h2>Acerto por leitura</h2>${tabela(T.porMotor, 'Leitura')}</div>
    </div>
    <div class="panel"><h2>Acerto por semana</h2>${tabela(Object.fromEntries(T.porSemana.map(s => [s.semana, s])), 'Semana')}</div>
    <div class="panel">
      <div class="head-row"><h2>Correções aprendidas</h2></div>
      <p class="muted">Leitura do OCR que, na maioria das vezes (60%+), foi corrigida para o mesmo texto. Se uma regra estiver errada, use <b>Esquecer</b>.</p>
      ${!T.regras.length ? '<p class="muted">Nenhuma ainda: aparecem depois que a mesma leitura for corrigida em linhas conferidas.</p>' : `
      <div class="tablewrap"><table><thead><tr><th class="nosort">Campo</th><th class="nosort">OCR leu</th><th class="nosort">Corrigido para</th><th class="nosort">Vezes</th><th class="nosort"></th></tr></thead><tbody>
      ${T.regras.map((r, i) => `<tr><td>${esc(CAMPO_TXT[r.campo])}</td><td class="t">${esc(r.lido)}</td><td><b>${esc(r.final)}</b></td><td>${r.n} de ${r.total}</td>
        <td class="acoes"><button class="btn ghost small perigo" data-esq="${i}">Esquecer</button></td></tr>`).join('')}</tbody></table></div>`}
    </div>
    <div class="panel">
      <div class="head-row"><h2>Dados de treinamento</h2><div class="filters" style="margin:0">
        <a class="btn ghost" href="${zipUrl}" download>Exportar exemplos (.zip)</a>
        <button class="btn ghost perigo" id="trApagar">Apagar exemplos</button></div></div>
      <p class="muted">O .zip traz os recortes e um <i>rotulos.tsv</i> (imagem, campo, texto certo, o que o OCR leu), pronto para treinar um modelo no futuro.</p>
    </div>`;
  $('#trAtivo').addEventListener('change', async e => {
    const r = await api('api/treino/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ativo: e.target.checked }) }).catch(() => null);
    if (!r || !r.ok) { alert('Não foi possível alterar.'); e.target.checked = !e.target.checked; return; }
    RB.vocab = null; renderTreino();
  });
  el.querySelectorAll('[data-esq]').forEach(b => b.addEventListener('click', async () => {
    const r0 = T.regras[+b.dataset.esq];
    if (!confirm(`Esquecer a correção “${r0.lido}” → “${r0.final}”?`)) return;
    const r = await api('api/treino/esquecer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campo: r0.campo, lido: r0.lido }) }).catch(() => null);
    if (!r || !r.ok) return alert('Não foi possível esquecer.');
    RB.vocab = null; renderTreino();
  }));
  $('#trApagar').addEventListener('click', async () => {
    if (!confirm('Apagar todos os exemplos de treinamento? As correções aprendidas deixam de valer. (O servidor guarda uma cópia para auditoria.)')) return;
    const r = await api('api/treino', { method: 'DELETE' }).catch(() => null);
    if (!r || !r.ok) return alert('Não foi possível apagar.');
    RB.vocab = null; renderTreino();
  });
}

// fecha o menu "⋯" ao clicar fora dele
document.addEventListener('click', e => {
  document.querySelectorAll('.menu-acoes[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; });
});

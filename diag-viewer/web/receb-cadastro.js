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

const CAD = { locais: [], categorias: [], fCat: '', qLocal: '', qSelb: '', soMulti: false, soSemCad: false };
const nrm = t => RecebOCR.normalizar(t);
const kSelb = t => RecebOCR.normalizar(t).replace(/ /g, '');

function abasReceb(on) {
  const a = (k, rot, href) => `<a href="${href}" class="${on === k ? 'on' : ''}">${rot}</a>`;
  return `<nav class="rb-abas">${[['entregas', '#receb'], ['locais', '#receb/locais'], ['selbs', '#receb/selbs'], ['impressoras', '#receb/impressoras'], ['suprimentos', '#receb/suprimentos'], ['treino', '#receb/treino'], ['textos', '#receb/textos']]
    .map(([k, href]) => a(k, esc(Tp('aba.' + k)), href)).join('')}</nav>`;
}

async function carregarLocais() {
  const [r, rc] = await Promise.all([api('api/receb-locais').catch(() => null), api('api/receb-locais/categorias').catch(() => null)]);
  CAD.locais = r && r.ok ? await r.json() : [];
  CAD.categorias = rc && rc.ok ? await rc.json() : [];
  return CAD.locais;
}
// ---------------------------------------------------------------- categorias dos locais (personalizáveis)
const CAT_CORES = ['azul', 'verde', 'ambar', 'vermelho', 'violeta', 'rosa', 'ciano', 'cinza'];
const CAT_SUGESTOES = ['Escola', 'Unidade de saúde', 'Secretaria', 'Administrativo', 'Almoxarifado'];
const catPorId = id => id && CAD.categorias.find(c => c.id === id) || null;
// categoria de um local pelo nome; sala sem categoria usa a do principal
function categoriaDoLocal(nome) {
  const L = nome && localCadastrado(nome);
  if (!L) return null;
  return catPorId(L.categoria) || (L.pai ? catPorId((CAD.locais.find(x => x.id === L.pai) || {}).categoria) : null);
}
const catBadge = (c, herdada = false) => c ? `<span class="cat-tag cat-${esc(c.cor)}" title="Categoria${herdada ? ' (do local principal)' : ''}">${esc(c.nome)}</span>` : '';
// filtro por categoria ('' = todas, '-' = sem categoria)
const casaCategoria = (nome, f) => !f || (f === '-' ? !categoriaDoLocal(nome) : (categoriaDoLocal(nome) || {}).id === f);
const selectCategoria = (id, atual) => `<select id="${id}"><option value="">todas</option>${CAD.categorias.map(c => `<option value="${esc(c.id)}" ${atual === c.id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}<option value="-" ${atual === '-' ? 'selected' : ''}>sem categoria</option></select>`;

// janela: criar, renomear, colorir e excluir categorias
function gerenciarCategorias() {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'dlg dlg-largo';
    let lista = CAD.categorias.map(c => ({ ...c }));
    const linha = (c, i) => `<div class="cat-linha" data-i="${i}">
      <span class="cat-tag cat-${esc(c.cor)}">${esc(c.nome || 'nova')}</span>
      <input class="cat-nome" value="${esc(c.nome)}" maxlength="60" placeholder="nome da categoria" aria-label="Nome">
      <div class="cat-cores" role="radiogroup" aria-label="Cor">${CAT_CORES.map(cor => `<button type="button" class="cat-cor cat-${cor} ${c.cor === cor ? 'on' : ''}" data-cor="${cor}" title="${cor}" aria-label="${cor}"></button>`).join('')}</div>
      <button type="button" class="btn ghost small perigo" data-rem title="Excluir categoria">Excluir</button></div>`;
    const desenhar = () => {
      d.innerHTML = `<h2>Categorias de locais</h2>
        <p class="muted">Agrupe os locais (Escola, Unidade de saúde...). Excluir uma categoria só tira a categoria dos locais.</p>
        <div class="cat-lista">${lista.map(linha).join('') || '<p class="muted">Nenhuma categoria ainda.</p>'}</div>
        <div class="filters" style="margin:0"><button type="button" class="btn ghost small" id="catNova">${IC('mais')}Nova categoria</button>
          ${!lista.length ? `<button type="button" class="btn ghost small" id="catSug">Usar sugestões (${CAT_SUGESTOES.join(', ')})</button>` : ''}</div>
        <div class="dlg-actions"><button type="button" class="btn ghost" id="catCancelar">Cancelar</button><button type="button" class="btn" id="catSalvar">Salvar categorias</button></div>`;
      d.querySelectorAll('.cat-linha').forEach(el => {
        const c = lista[+el.dataset.i];
        el.querySelector('.cat-nome').addEventListener('input', e => { c.nome = e.target.value; el.querySelector('.cat-tag').textContent = c.nome || 'nova'; });
        el.querySelectorAll('.cat-cor').forEach(b => b.addEventListener('click', () => { c.cor = b.dataset.cor; desenhar(); }));
        el.querySelector('[data-rem]').addEventListener('click', () => { lista.splice(+el.dataset.i, 1); desenhar(); });
      });
      d.querySelector('#catNova').onclick = () => { lista.push({ nome: '', cor: CAT_CORES[lista.length % CAT_CORES.length] }); desenhar(); d.querySelector('.cat-linha:last-child .cat-nome').focus(); };
      if (d.querySelector('#catSug')) d.querySelector('#catSug').onclick = () => { lista = CAT_SUGESTOES.map((nome, i) => ({ nome, cor: CAT_CORES[i] })); desenhar(); };
      d.querySelector('#catCancelar').onclick = () => d.close();
      d.querySelector('#catSalvar').onclick = async e => {
        e.target.disabled = true;
        const r = await api('api/receb-locais/categorias', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lista.filter(c => c.nome.trim())) }).catch(() => null);
        if (!r || !r.ok) { e.target.disabled = false; const er = r ? (await r.json().catch(() => ({}))).erro : ''; return alert('Não foi possível salvar: ' + (er || 'servidor indisponível.')); }
        CAD.categorias = await r.json(); d.salvou = true; d.close();
      };
    };
    document.body.appendChild(d); desenhar(); d.showModal();
    d.addEventListener('close', () => { d.remove(); resolve(!!d.salvou); });
  });
}
// janela: escolher a categoria para os locais marcados
function escolherCategoria(n) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = `<form method="dialog"><h2>Definir categoria</h2><p>${n} local(is) selecionado(s).</p>
      <div class="lc-esc">${CAD.categorias.map((c, i) => `<label class="chk"><input type="radio" name="catEsc" value="${esc(c.id)}" ${!i ? 'checked' : ''}> ${catBadge(c)}</label>`).join('')}
        <label class="chk"><input type="radio" name="catEsc" value="" ${!CAD.categorias.length ? 'checked' : ''}> <span class="muted">sem categoria</span></label></div>
      <div class="dlg-actions"><button class="btn ghost" value="x">Cancelar</button><button class="btn" value="ok">Aplicar</button></div></form>`;
    document.body.appendChild(d);
    d.addEventListener('close', () => { const v = d.querySelector('input[name="catEsc"]:checked').value; d.remove(); resolve(d.returnValue === 'ok' ? v : null); });
    d.showModal();
  });
}
const enderecoTxt = L => [
  [L.logradouro, L.numero].filter(Boolean).join(', '), L.complemento, L.bairro,
  [L.cidade, L.uf].filter(Boolean).join('/'), L.cep && 'CEP ' + L.cep,
].filter(Boolean).join(' · ');
const localCadastrado = nome => CAD.locais.find(L => nrm(L.nome) === nrm(nome));
// sublocal (sala, bloco...): o local principal dele, pelo cadastro
const principalDoLocal = nome => { const L = nome && localCadastrado(nome); return L && L.pai ? CAD.locais.find(x => x.id === L.pai) || null : null; };
const localComPrincipal = nome => { const p = principalDoLocal(nome); return p ? `${p.nome} › ${nome}` : nome || ''; };

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
  const [regs] = await Promise.all([carregarEntregas(), carregarLocais(), carregarSelbsCad()]);
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
  const sel = CAD.selLocais || (CAD.selLocais = new Set()); // nomes marcados para unificar
  const cb = nome => `<input type="checkbox" class="lc-sel" data-nome="${esc(nome)}" ${sel.has(nrm(nome)) ? 'checked' : ''} aria-label="Selecionar ${esc(nome)}">`;
  el.innerHTML = abasReceb('locais') + `
    ${editando ? formLocal(editando) : ''}
    <div class="panel" data-recolher="locais-cad">
      <div class="head-row"><h2>${TX('locais.titulo')}</h2><div class="filters" style="margin:0">
        <button class="btn ghost" id="lcCats" title="Criar, renomear e excluir categorias">${IC('tag')}Categorias</button>
        <button class="btn ghost" id="lcCategorizar" disabled title="Definir a categoria dos locais marcados">${IC('tag')}Definir categoria</button>
        <button class="btn ghost" id="lcUnificar" disabled title="Marque os locais (salas, blocos...) que ficam dentro de um mesmo local principal">${IC('local')}Unificar selecionados</button>
        <button class="btn" id="lcNovo">Novo local</button></div></div>
      <p class="muted">${TX('locais.ajuda')}</p>
      ${!CAD.locais.length ? vazioHtml('local', 'Nenhum local cadastrado', 'Cadastre com "Novo local" ou a partir dos locais usados nas entregas, abaixo.') : `
      <div class="filters"><label>Buscar <input type="search" id="lcQ" value="${esc(CAD.qLocal)}" placeholder="nome, endereço, bairro..." style="min-width:260px"></label>
        <label>Mostrar <select id="lcMostra">${FILTROS_CAD.map(([v, t]) => `<option value="${v}" ${(CAD.fMostra || '') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label><span class="muted" id="lcN"></span>
        ${CAD.locais.some(L => L.pai) ? `<span class="lc-arvore"><button type="button" class="btn ghost small" id="lcExpandir">Expandir salas</button><button type="button" class="btn ghost small" id="lcRecolher">Minimizar salas</button></span>` : ''}
        ${CAD.categorias.length ? `<div class="cat-filtro" role="group" aria-label="Filtrar por categoria">${[['', 'Todas'], ...CAD.categorias.map(c => [c.id, c.nome, c.cor]), ['-', 'Sem categoria']].map(([id, nome, cor]) => `<button type="button" class="cat-chip ${cor ? 'cat-' + cor : ''} ${CAD.fCat === id ? 'on' : ''}" data-fcat="${esc(id)}">${esc(nome)} <small>${id ? CAD.locais.filter(L => !L.pai || !CAD.locais.some(x => x.id === L.pai)).filter(L => casaCategoria(L.nome, id)).length : ''}</small></button>`).join('')}</div>` : ''}</div>
      <div class="tablewrap"><table><thead><tr><th class="nosort" style="width:28px"></th><th class="nosort">Local</th><th class="nosort">Endereço</th><th class="nosort">Entregas</th><th class="nosort"></th></tr></thead><tbody id="lcLista"></tbody></table></div>`}
    </div>
    <div class="panel" data-recolher="locais-usados">
      <div class="head-row"><h2>${TX('locais.usados')}</h2></div>
      <p class="muted">${TX('locais.usadosAjuda')}</p>
      ${!usados.size ? '<p class="muted">Nenhuma entrega com local.</p>' : `
      <div class="filters"><label>Buscar <input type="search" id="luQ" value="${esc(CAD.qUsado || '')}" placeholder="nome do local, SELB..." style="min-width:220px"></label>
        <label>Mostrar <select id="luMostra">${FILTROS_USADOS.map(([v, t, f]) => `<option value="${v}" ${(CAD.fUsado || '') === v ? 'selected' : ''}>${t}${v ? ` (${[...usados.values()].filter(f).length})` : ''}</option>`).join('')}</select></label>
        <span class="muted" id="luN"></span>
        <button class="btn ghost small" id="luCadTodos" hidden>${IC('mais')}Cadastrar os sem cadastro</button></div>
      <div class="tablewrap"><table><thead><tr><th class="nosort" style="width:28px"></th><th class="nosort">Local</th><th class="nosort">Entregas</th><th class="nosort">SELBs</th><th class="nosort">Última</th><th class="nosort"></th></tr></thead><tbody id="lcUsados"></tbody></table></div>`}
    </div>`;
  const contaNome = nome => [...usados.values()].filter(u => nrm(u.nome) === nrm(nome)).reduce((a, u) => a + u.n, 0);
  const vincDe = L => [...RB.selbsCad.values()].filter(c => c.local && nrm(c.local) === nrm(L.nome)).map(c => c.selb);
  const subsDe = L => CAD.locais.filter(x => x.pai === L.id).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true }));
  const raiz = L => !L.pai || !CAD.locais.some(x => x.id === L.pai);
  const abertos = CAD.abertos || (CAD.abertos = lerSetLocal('lcAbertos')); // principais com as salas à mostra
  const linhaLocal = (L, P, comSeta = false, aberto = false) => {
    const n = contaNome(L.nome), subs = P ? [] : subsDe(L), nSubs = subs.reduce((a, x) => a + contaNome(x.nome), 0);
    const end = enderecoTxt(L);
    return `<tr class="${P ? 'lc-sub' : subs.length ? 'lc-pai' : ''}"><td>${cb(L.nome)}</td>
      <td>${P ? '<span class="lc-ramo">└</span>' : ''}${comSeta && subs.length ? `<button type="button" class="rc-tog lc-tog" data-tog="${esc(L.id)}" aria-expanded="${aberto}" title="${aberto ? 'Minimizar' : 'Expandir'} as salas" aria-label="${aberto ? 'Minimizar' : 'Expandir'} as salas de ${esc(L.nome)}"></button>` : ''}<b>${esc(L.nome)}</b> ${catBadge(categoriaDoLocal(L.nome), !catPorId(L.categoria))}${subs.length ? ` <span class="badge">${subs.length} ${subs.length === 1 ? 'sala' : 'salas'}</span>` : ''}${L.referencia ? `<br><small>${esc(L.referencia)}</small>` : ''}</td>
      <td>${end ? esc(end) : P && enderecoTxt(P) ? `<span class="muted">${esc(enderecoTxt(P))} (do principal)</span>` : '<span class="muted">sem endereço</span>'}${L.obs ? `<br><small>${esc(L.obs)}</small>` : ''}</td>
      <td>${n ? `<button class="linklike" data-ver="${esc(L.nome)}">${n}</button>` : '0'}${vincDe(L).length ? ` <small class="muted" title="SELBs vinculados: ${esc(vincDe(L).join(', '))}">· ${vincDe(L).length} SELB${vincDe(L).length > 1 ? 's' : ''} vinculado${vincDe(L).length > 1 ? 's' : ''}</small>` : ''}${nSubs ? ` <small class="muted" title="entregas nas salas/sublocais">+${nSubs} nas salas</small>` : ''}</td>
      <td class="acoes">${P ? `<button class="btn ghost small" data-solta="${esc(L.id)}" title="Deixa de ser sala de ${esc(P.nome)}">Desvincular</button>` : ''}
        <a class="btn ghost small" href="#receb/locais~${esc(L.id)}">Editar</a>
        <button class="btn ghost small perigo" data-excluir="${esc(L.id)}">Excluir</button></td></tr>`;
  };
  const atualizarSel = () => {
    $('#lcUnificar').disabled = sel.size < 2;
    $('#lcCategorizar').disabled = !sel.size;
    $('#lcCategorizar').innerHTML = `${IC('tag')}Definir categoria${sel.size ? ` (${sel.size})` : ''}`;
    $('#lcUnificar').innerHTML = `${IC('local')}Unificar selecionados${sel.size ? ` (${sel.size})` : ''}`;
    el.querySelectorAll('.lc-sel').forEach(c => { c.checked = sel.has(nrm(c.dataset.nome)); });
  };
  const ligarSel = raizEl => raizEl.querySelectorAll('.lc-sel').forEach(c => c.addEventListener('change', () => {
    if (c.checked) sel.add(nrm(c.dataset.nome)); else sel.delete(nrm(c.dataset.nome));
    CAD.selNomes = { ...(CAD.selNomes || {}), [nrm(c.dataset.nome)]: c.dataset.nome };
    atualizarSel();
  }));
  const desenharCad = () => {
    const box = $('#lcLista'); if (!box) return;
    const q = nrm(CAD.qLocal);
    const casa = L => nrm([L.nome, enderecoTxt(L), L.referencia].join(' ')).includes(q);
    const fm = CAD.fMostra || '';
    const paiDe = L => CAD.locais.find(x => x.id === L.pai) || null;
    const testa = {
      semend: L => !enderecoTxt(L) && !(paiDe(L) && enderecoTxt(paiDe(L))), semcat: L => !categoriaDoLocal(L.nome), comsalas: L => subsDe(L).length > 0,
      sala: L => !raiz(L), sement: L => !contaNome(L.nome), vinc: L => vincDe(L).length > 0, semvinc: L => !vincDe(L).length,
    }[fm];
    let html, n;
    if (testa) {
      // filtro ativo: lista plana (salas mostram o principal)
      const lista = CAD.locais.filter(L => testa(L) && (!q || casa(L)) && casaCategoria(L.nome, CAD.fCat)).sort((a, b) => localComPrincipal(a.nome).localeCompare(localComPrincipal(b.nome), 'pt-BR'));
      n = lista.length;
      html = lista.map(L => linhaLocal(L, raiz(L) ? null : paiDe(L))).join('');
    } else {
      // principal aparece se ele ou alguma sala casar com a busca; as salas logo abaixo dele
      const raizes = CAD.locais.filter(raiz).filter(L => (!q || casa(L) || subsDe(L).some(casa)) && casaCategoria(L.nome, CAD.fCat))
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
      n = raizes.length;
      html = raizes.map(L => {
        // busca que casa com uma sala abre o principal dela
        const aberto = abertos.has(L.id) || (q && !casa(L) && subsDe(L).some(casa));
        return linhaLocal(L, null, true, aberto) + (aberto ? subsDe(L).filter(x => !q || casa(L) || casa(x)).map(x => linhaLocal(x, L)).join('') : '');
      }).join('');
    }
    box.innerHTML = html || `<tr><td colspan="5" class="muted">Nenhum local com esse filtro.</td></tr>`;
    $('#lcN').textContent = `${n} local(is)`;
    box.querySelectorAll('[data-ver]').forEach(b => b.addEventListener('click', () => { RB.fLocal = b.dataset.ver; RB.fSelb = ''; RB.q = ''; location.hash = 'receb'; }));
    box.querySelectorAll('[data-tog]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.tog; abertos.has(id) ? abertos.delete(id) : abertos.add(id); gravarSetLocal('lcAbertos', abertos); desenharCad();
    }));
    box.querySelectorAll('[data-excluir]').forEach(b => b.addEventListener('click', async () => {
      const L = CAD.locais.find(x => x.id === b.dataset.excluir);
      const subs = subsDe(L).length;
      if (!confirm(`Excluir o cadastro de "${L.nome}"? As entregas não são alteradas.${subs ? ` As ${subs} sala(s) dele viram locais principais.` : ''}`)) return;
      const r = await api('api/receb-locais/' + L.id, { method: 'DELETE' }).catch(() => null);
      if (!r || !r.ok) return alert('Não foi possível excluir.');
      renderLocais();
    }));
    box.querySelectorAll('[data-solta]').forEach(b => b.addEventListener('click', async () => {
      const L = CAD.locais.find(x => x.id === b.dataset.solta);
      const r = await api('api/receb-locais/' + L.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...L, pai: '' }) }).catch(() => null);
      if (!r || !r.ok) return alert('Não foi possível desvincular.');
      renderLocais();
    }));
    ligarSel(box); atualizarSel();
  };
  $('#lcNovo').addEventListener('click', () => { location.hash = 'receb/locais~novo'; });
  $('#lcCats').addEventListener('click', async () => { if (await gerenciarCategorias()) renderLocais(editarId); });
  el.querySelectorAll('[data-fcat]').forEach(b => b.addEventListener('click', () => {
    CAD.fCat = b.dataset.fcat; el.querySelectorAll('[data-fcat]').forEach(x => x.classList.toggle('on', x === b)); desenharCad();
  }));
  $('#lcCategorizar').addEventListener('click', async () => {
    if (!CAD.categorias.length) { if (!(await gerenciarCategorias()) || !CAD.categorias.length) return; }
    const cat = await escolherCategoria(sel.size);
    if (cat === null) return;
    const nomes = [...sel].map(k => (CAD.selNomes || {})[k] || (CAD.locais.find(L => nrm(L.nome) === k) || {}).nome || k);
    const r = await api('api/receb-locais/categorizar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nomes, categoria: cat }) }).catch(() => null);
    if (!r || !r.ok) { const er = r ? (await r.json().catch(() => ({}))).erro : ''; return alert('Não foi possível aplicar: ' + (er || 'servidor indisponível.')); }
    sel.clear(); renderLocais(editarId);
  });
  $('#lcUnificar').addEventListener('click', async () => {
    const nomes = [...sel].map(k => (CAD.selNomes || {})[k] || (CAD.locais.find(L => nrm(L.nome) === k) || {}).nome || k);
    const r = await escolherPrincipal(nomes, nomesSug);
    if (!r) return;
    const resp = await api('api/receb-locais/unificar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) }).catch(() => null);
    if (!resp || !resp.ok) { const er = resp ? (await resp.json().catch(() => ({}))).erro : ''; return alert('Não foi possível unificar: ' + (er || 'servidor indisponível.')); }
    const j = await resp.json();
    sel.clear();
    alert(`${j.n} local(is) agora são salas/sublocais de “${j.principal.nome}”.`);
    renderLocais();
  });
  if ($('#lcQ')) $('#lcQ').addEventListener('input', e => { CAD.qLocal = e.target.value; desenharCad(); });
  if ($('#lcMostra')) $('#lcMostra').addEventListener('change', e => { CAD.fMostra = e.target.value; desenharCad(); });
  if ($('#lcExpandir')) {
    $('#lcExpandir').addEventListener('click', () => { CAD.locais.filter(L => CAD.locais.some(x => x.pai === L.id)).forEach(L => abertos.add(L.id)); gravarSetLocal('lcAbertos', abertos); desenharCad(); });
    $('#lcRecolher').addEventListener('click', () => { abertos.clear(); gravarSetLocal('lcAbertos', abertos); desenharCad(); });
  }
  ligarRecolhiveis(el);
  // locais usados nas entregas: busca + filtro "Mostrar"
  const desenharUsados = () => {
    const box = $('#lcUsados'); if (!box) return;
    const q = nrm(CAD.qUsado || ''), f = (FILTROS_USADOS.find(x => x[0] === (CAD.fUsado || '')) || FILTROS_USADOS[0])[2];
    const lista = [...usados.values()].filter(u => f(u) && (!q || nrm([u.nome, localComPrincipal(u.nome), ...u.selbs].join(' ')).includes(q))).sort((a, b) => b.n - a.n);
    $('#luN').textContent = `${lista.length} de ${usados.size}`;
    const semCad = lista.filter(u => !localCadastrado(u.nome));
    $('#luCadTodos').hidden = !semCad.length;
    $('#luCadTodos').innerHTML = `${IC('mais')}Cadastrar os sem cadastro (${semCad.length})`;
    box.innerHTML = lista.map(u => {
      const cad = localCadastrado(u.nome), pr = principalDoLocal(u.nome);
      return `<tr><td>${cb(u.nome)}</td><td><b>${esc(u.nome)}</b> ${catBadge(categoriaDoLocal(u.nome))} ${cad ? '<span class="badge ok">cadastrado</span>' : '<span class="badge warn">sem cadastro</span>'}${pr ? `<br><small class="muted">${IC('local')} sala/sublocal de <b>${esc(pr.nome)}</b></small>` : ''}</td>
        <td>${u.n}</td><td><small>${[...u.selbs].slice(0, 8).map(esc).join(', ')}${u.selbs.size > 8 ? '…' : ''}</small></td>
        <td class="t">${u.ult ? esc(u.ult.split('-').reverse().join('/')) : '—'}</td>
        <td class="acoes">${cad ? '' : `<button class="btn ghost small" data-cad="${esc(u.nome)}">Cadastrar</button>`}
          <button class="btn ghost small" data-corr="${esc(u.nome)}">Corrigir para…</button>
          <button class="btn ghost small perigo" data-apagar="${esc(u.nome)}">Apagar</button></td></tr>`;
    }).join('') || `<tr><td colspan="6" class="muted">Nenhum local com esse filtro.</td></tr>`;
    ligarSel(box); atualizarSel();
    ligarUsados(box);
  };
  if ($('#luQ')) {
    $('#luQ').addEventListener('input', e => { CAD.qUsado = e.target.value; desenharUsados(); });
    $('#luMostra').addEventListener('change', e => { CAD.fUsado = e.target.value; desenharUsados(); });
    $('#luCadTodos').addEventListener('click', async e => {
      const q = nrm(CAD.qUsado || ''), f = (FILTROS_USADOS.find(x => x[0] === (CAD.fUsado || '')) || FILTROS_USADOS[0])[2];
      const nomes = [...usados.values()].filter(u => f(u) && !localCadastrado(u.nome) && (!q || nrm([u.nome, ...u.selbs].join(' ')).includes(q))).map(u => u.nome);
      if (!nomes.length || !confirm(`Cadastrar ${nomes.length} local(is) só com o nome (o endereço pode ser completado depois)?\n\n${nomes.slice(0, 15).join('\n')}${nomes.length > 15 ? '\n…' : ''}`)) return;
      e.currentTarget.disabled = true;
      let ok = 0;
      for (const nome of nomes) {
        const r = await api('api/receb-locais', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome }) }).catch(() => null);
        if (r && (r.ok || r.status === 409)) ok++;
      }
      alert(`${ok} local(is) cadastrado(s).`); renderLocais();
    });
  }
  const ligarUsados = raizEl => {
  raizEl.querySelectorAll('[data-cad]').forEach(b => b.addEventListener('click', () => { CAD.novoNome = b.dataset.cad; location.hash = 'receb/locais~novo'; }));
  raizEl.querySelectorAll('[data-corr]').forEach(b => b.addEventListener('click', async () => {
    const de = b.dataset.corr;
    const para = await pedirValor({ titulo: 'Corrigir local', rotulo: 'Trocar por', texto: `Troca “${esc(de)}” em todas as entregas.`, sugestoes: nomesSug.filter(v => nrm(v) !== nrm(de)) });
    if (para === null || nrm(para) === nrm(de) && para === de) return;
    const r = await corrigirLote('local', de, para);
    if (r) { alert(`${r.linhas} entrega(s) corrigida(s) em ${r.folhas} folha(s).`); renderLocais(); }
  }));
  raizEl.querySelectorAll('[data-apagar]').forEach(b => b.addEventListener('click', async () => {
    const de = b.dataset.apagar;
    if (!confirm(`Apagar o local “${de}” de todas as entregas? O campo fica vazio e a linha volta para conferência.`)) return;
    const r = await corrigirLote('local', de, '');
    if (r) { alert(`Local apagado de ${r.linhas} entrega(s).`); renderLocais(); }
  }));
  };
  if (editando) ligarFormLocal(editando);
  desenharCad();
  desenharUsados();
  atualizarSel();
}

// ---------------------------------------------------------------- recolher/expandir (lembra no navegador)
function lerSetLocal(chave) { try { return new Set(JSON.parse(localStorage.getItem(chave) || '[]')); } catch { return new Set(); } }
function gravarSetLocal(chave, set) { try { localStorage.setItem(chave, JSON.stringify([...set])); } catch { /* sem storage */ } }
// painéis com data-recolher="chave": botão de seta no título recolhe o conteúdo (fica só o título)
function ligarRecolhiveis(raiz) {
  const recolhidos = lerSetLocal('painelRecolhido');
  raiz.querySelectorAll('[data-recolher]').forEach(p => {
    const k = p.dataset.recolher, cab = p.querySelector(':scope > .head-row, :scope > legend');
    if (!cab || cab.querySelector('.rc-tog')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'rc-tog';
    const aplicar = () => { const fechado = recolhidos.has(k); p.classList.toggle('recolhido', fechado); b.setAttribute('aria-expanded', String(!fechado)); b.title = fechado ? 'Expandir' : 'Minimizar'; b.setAttribute('aria-label', b.title); };
    b.addEventListener('click', e => { e.preventDefault(); recolhidos.has(k) ? recolhidos.delete(k) : recolhidos.add(k); gravarSetLocal('painelRecolhido', recolhidos); aplicar(); });
    cab.prepend(b); aplicar();
  });
}

// filtros "Mostrar" da aba Locais: [valor, rótulo, teste]
const FILTROS_USADOS = [
  ['', 'todos', () => true],
  ['semcad', 'sem cadastro', u => !localCadastrado(u.nome)],
  ['cad', 'cadastrados', u => !!localCadastrado(u.nome)],
  ['semcat', 'sem categoria', u => !categoriaDoLocal(u.nome)],
  ['semend', 'sem endereço', u => { const L = localCadastrado(u.nome), P = principalDoLocal(u.nome); return !(L && enderecoTxt(L)) && !(P && enderecoTxt(P)); }],
  ['sala', 'salas (sublocais)', u => !!principalDoLocal(u.nome)],
  ['naosala', 'não são salas', u => !principalDoLocal(u.nome)],
];
const FILTROS_CAD = [
  ['', 'todos'], ['semend', 'sem endereço'], ['semcat', 'sem categoria'], ['comsalas', 'com salas'], ['sala', 'salas (sublocais)'],
  ['sement', 'sem entregas'], ['vinc', 'com SELB vinculado'], ['semvinc', 'sem SELB vinculado'],
];

// janela "Unificar": escolhe qual dos marcados é o principal (ou outro nome); os demais viram salas dele
function escolherPrincipal(nomes, sugestoes) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    // sugestão: o nome mais curto costuma ser o principal ("ESCOLA X" de "ESCOLA X SALA 3")
    const pre = [...nomes].sort((a, b) => a.length - b.length)[0];
    d.innerHTML = `<form method="dialog"><h2>Unificar locais</h2>
      <p>Qual é o <b>local principal</b>? Os outros viram salas/sublocais dele.</p>
      <div class="lc-esc">${nomes.map(n => `<label class="chk"><input type="radio" name="lcP" value="${esc(n)}" ${n === pre ? 'checked' : ''}> ${esc(n)}</label>`).join('')}
        <label class="chk"><input type="radio" name="lcP" value=""> outro local: <input id="lcPOutro" list="lcPDl" placeholder="nome do local principal" autocomplete="off"></label></div>
      <datalist id="lcPDl">${sugestoes.filter(v => !nomes.some(n => nrm(n) === nrm(v))).map(v => `<option value="${esc(v)}">`).join('')}</datalist>
      <div class="dlg-actions"><button class="btn ghost" value="x">Cancelar</button><button class="btn" value="ok">Unificar</button></div></form>`;
    document.body.appendChild(d);
    d.querySelector('#lcPOutro').addEventListener('focus', () => { d.querySelector('input[name="lcP"][value=""]').checked = true; });
    d.addEventListener('close', () => {
      const v = d.querySelector('input[name="lcP"]:checked').value || d.querySelector('#lcPOutro').value.trim();
      d.remove();
      resolve(d.returnValue === 'ok' && v ? { principal: v, sublocais: nomes.filter(n => nrm(n) !== nrm(v)) } : null);
    });
    d.showModal();
  });
}

function formLocal(L) {
  const v = k => esc(L[k] || (k === 'nome' && !L.id ? CAD.novoNome || '' : ''));
  const ufs = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');
  return `<div class="panel" id="lcForm">
    <div class="head-row"><h2>${L.id ? 'Editar local' : 'Novo local'}</h2></div>
    <div class="rep-grid">
      <label class="full">Nome do local (como aparece nas folhas) <input id="lfNome" value="${v('nome')}" maxlength="160" required></label>
      <label>Categoria <select id="lfCategoria"><option value="">— sem categoria${L.pai ? ' (usa a do principal)' : ''} —</option>
        ${CAD.categorias.map(c => `<option value="${esc(c.id)}" ${L.categoria === c.id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select></label>
      <label>Sala / sublocal de <select id="lfPai"><option value="">— nenhum: é um local principal —</option>
        ${CAD.locais.filter(x => !x.pai && x.id !== L.id).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')).map(x => `<option value="${esc(x.id)}" ${L.pai === x.id ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></label>
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
    for (const k of ['nome', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf', 'referencia', 'obs', 'pai', 'categoria']) corpo[k] = $('#lf' + k[0].toUpperCase() + k.slice(1)).value.trim();
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
      <div class="head-row"><h2>${TX('selbs.titulo')}</h2><div class="filters" style="margin:0">
        <button class="btn ghost" id="sbRede" title="Marca, modelo, nº de série, tipo, cores e tinta/toner lidos das impressoras com IP">${IC('impressora')}Completar pela rede</button>
        <button class="btn ghost" id="sbPing" title="Pinga agora as impressoras com IP">${IC('raio')}Verificar impressoras</button>
        <a class="btn" href="#receb/selbs~novo">${IC('mais')}Cadastrar SELB</a></div></div>
      <div class="stats">
        ${statHtml(selbs.length, 'SELBs', 'tag', '')}
        ${statHtml(selbs.length - semCad, 'com cadastro', 'monitor', 'ok')}
        ${statHtml(totItens, 'tintas, toners e caixas entregues', 'caixa', 'violeta')}
        ${statHtml(multi, 'com mais de um local', 'local', multi ? 'bad' : '')}
      </div>
      <p class="muted">${TX('selbs.ajuda')}</p>
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
      return !q || kSelb(s.selb).includes(qk) || [...s.locais.values()].some(o => nrm(o.nome).includes(q)) || (c && nrm([c.marca, c.modelo, c.serie, c.ip, c.obs, c.local].join(' ')).includes(q));
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
          <td>${c && c.local ? `<div class="rb-loc rb-vinc" title="Local vinculado no cadastro do SELB (vale mesmo sem entrega)">${IC('local')}<b>${esc(localComPrincipal(c.local))}</b> <span class="badge ok">vinculado</span>${localCadastrado(c.local) ? '' : ' <span class="badge warn" title="Local sem cadastro">?</span>'}</div>` : ''}
            ${locs.map(o => `<div class="rb-loc">${esc(o.nome)} <small>(${o.n})</small>${localCadastrado(o.nome) ? '' : ' <span class="badge warn" title="Local sem cadastro">?</span>'}
            ${s.locais.size > 1 ? `<button class="linklike" data-todas="${esc(s.selb)}" data-loc="${esc(o.nome)}">usar em todas</button>` : ''}</div>`).join('') || (c && c.local ? '' : '—')}</td>
          <td class="t">${s.ult ? `${esc(s.ult.data || '—')}<br><small>${esc(s.ult.local || '')}</small>` : '—'}</td>
          <td class="acoes"><a class="btn small" href="#receb/selbs~${encodeURIComponent(s.selb)}">${c ? 'Cadastro' : 'Cadastrar'}</a>
            <details class="menu-acoes"><summary class="btn ghost small" title="Mais ações">⋯</summary><div>
              <button class="btn ghost small" data-vinc="${esc(s.selb)}">${c && c.local ? 'Trocar local vinculado…' : 'Vincular local…'}</button>
              ${s.n ? `<button class="btn ghost small" data-corrsel="${esc(s.selb)}">Corrigir SELB…</button>
              <button class="btn ghost small" data-corrloc="${esc(s.selb)}">Trocar local das entregas…</button>
              <button class="btn ghost small perigo" data-apagasel="${esc(s.selb)}">Apagar das entregas</button>` : ''}</div></details></td></tr>`;
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
    // vincula um local ao SELB pelo cadastro (cria o cadastro se ainda não existir); vazio = desvincula
    box.querySelectorAll('[data-vinc]').forEach(b => b.addEventListener('click', async () => {
      const s = mapa.get(kSelb(b.dataset.vinc)), c = cadSelb(s.selb);
      const para = await pedirValor({ titulo: `Local do SELB ${s.selb}`, rotulo: 'Local vinculado', permitirVazio: true,
        texto: 'Fica no cadastro do SELB e vale mesmo sem entrega: aparece nas impressoras, suprimentos e alertas e preenche o local na conferência das folhas. As entregas já registradas não mudam. Vazio = desvincular.',
        valor: c && c.local || (s.ult ? s.ult.local || '' : ''), sugestoes: nomesSug });
      if (para === null) return;
      const novo = { ...(c || { selb: s.selb, tipo: 'impressora', cor: 'colorida', suprimento: 'tinta', cores: ['preto', 'azul', 'magenta', 'amarelo'] }), local: para };
      const r = await api('api/receb-selbs/' + encodeURIComponent(s.selb), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(novo) }).catch(() => null);
      if (!r || !r.ok) return alert('Não foi possível vincular.');
      renderSelbs();
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
  $('#sbRede').addEventListener('click', () => completarPelaRede());
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

// resumo do que foi lido da impressora: "Epson WF-M5299 · série X · Impressora · Preto · Toner"
function equipLidoHtml(eq) {
  const p = [];
  if (eq.marca || eq.modelo) p.push(`<b>${esc([eq.marca, eq.modelo].filter(Boolean).join(' '))}</b>`);
  if (eq.serie) p.push(`série <span class="mono">${esc(eq.serie)}</span>`);
  if (eq.tipo) p.push(esc(TIPO_EQUIP_TXT[eq.tipo] || eq.tipo));
  if (eq.cor) p.push(eq.cor === 'pb' ? 'Preto' : 'Colorida');
  if (eq.cores) p.push(`<span class="eq-cores">${eq.cores.map(c => `<span class="it-bola it-${c}" title="${esc(ITENS[c])}"></span>`).join('')}</span>`);
  if (eq.suprimento) p.push(eq.suprimento === 'toner' ? 'Toner' : 'Tinta');
  return p.join(' · ') || '<span class="muted">sem dados do equipamento</span>';
}
// completa os cadastros com o que as impressoras informam (última leitura SNMP); mostra antes de gravar
const CAMPO_EQ_TXT = { marca: 'Marca', modelo: 'Modelo', serie: 'Nº de série', tipo: 'Tipo', cor: 'Impressão', cores: 'Cores', suprimento: 'Suprimento' };
const valorCampoTxt = (k, v) => k === 'tipo' ? TIPO_EQUIP_TXT[v] || v : k === 'cor' ? (v === 'pb' ? 'Preto' : v ? 'Colorida' : '') : k === 'suprimento' ? ({ tinta: 'Tinta', toner: 'Toner', nenhum: 'Nenhum' }[v] || '')
  : k === 'cores' ? (v || []).map(c => ITENS[c]).join(', ') : v || '';
async function completarPelaRede(lerAntes = false) {
  const d = document.createElement('dialog');
  d.className = 'dlg dlg-largo';
  d.innerHTML = `<h2>Completar cadastros pela rede</h2><p class="muted">${IC('relogio')} ${lerAntes ? 'Lendo todas as impressoras (pode levar alguns minutos)…' : 'Buscando…'}</p>`;
  document.body.appendChild(d); d.showModal();
  d.addEventListener('close', () => d.remove());
  if (lerAntes) await api('api/suprimentos/ler', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null);
  const r = await api('api/suprimentos/cadastro').catch(() => null);
  const sug = r && r.ok ? (await r.json()).sugestoes : null;
  await carregarSelbsCad();
  if (!sug) { d.innerHTML = `<h2>Completar cadastros pela rede</h2><p class="err">Não foi possível buscar.</p><div class="dlg-actions"><button class="btn" id="cpFechar">Fechar</button></div>`; d.querySelector('#cpFechar').onclick = () => d.close(); return; }
  d.innerHTML = `<h2>Completar cadastros pela rede</h2>
    <p class="muted">Dados informados pelas próprias impressoras (última leitura SNMP) que estão diferentes ou faltando no cadastro. Impressora só preto entra como <b>toner</b>. Confira e desmarque o que não quiser.</p>
    ${!sug.length ? vazioHtml('check', 'Nada a completar', 'Os cadastros já batem com o que as impressoras informam (ou ainda não há leitura).') : `
    <div class="filters" style="margin:0 0 8px"><label class="chk"><input type="checkbox" id="cpTodos" checked> marcar todos</label><span class="muted">${sug.length} SELB(s)</span></div>
    <div class="tablewrap cp-lista"><table><thead><tr><th class="nosort" style="width:28px"></th><th class="nosort">SELB</th><th class="nosort">O que muda</th><th class="nosort">Lido</th></tr></thead><tbody>
    ${sug.map((x, i) => { const c = cadSelb(x.selb) || {}; return `<tr><td><input type="checkbox" class="cp-sel" data-i="${i}" checked aria-label="Aplicar em ${esc(x.selb)}"></td>
      <td><b>${esc(x.selb)}</b><br><small class="muted">${esc(x.modeloLido || '')}</small></td>
      <td><ul class="cp-dif">${Object.entries(x.dif).map(([k, v]) => `<li><span class="muted">${CAMPO_EQ_TXT[k]}:</span> ${valorCampoTxt(k, c[k]) ? `<s>${esc(valorCampoTxt(k, c[k]))}</s> → ` : ''}<b>${esc(valorCampoTxt(k, v))}</b></li>`).join('')}</ul></td>
      <td class="t"><small>${esc(haQuanto(x.lidoEm))}</small></td></tr>`; }).join('')}</tbody></table></div>`}
    <div class="dlg-actions"><button class="btn ghost" id="cpLer" title="Lê todas as impressoras agora antes de comparar">${IC('raio')}Ler todas agora</button>
      <button class="btn ghost" id="cpFechar">Fechar</button>${sug.length ? '<button class="btn" id="cpAplicar">Aplicar selecionados</button>' : ''}</div>`;
  d.querySelector('#cpFechar').onclick = () => d.close();
  d.querySelector('#cpLer').onclick = () => { d.close(); completarPelaRede(true); };
  if (!sug.length) return;
  const cbs = [...d.querySelectorAll('.cp-sel')];
  d.querySelector('#cpTodos').onchange = e => cbs.forEach(c => { c.checked = e.target.checked; });
  d.querySelector('#cpAplicar').onclick = async e => {
    const escolhidos = cbs.filter(c => c.checked).map(c => sug[+c.dataset.i]);
    if (!escolhidos.length) return;
    e.target.disabled = true;
    let ok = 0;
    for (const x of escolhidos) {
      e.target.textContent = `Gravando ${ok + 1} de ${escolhidos.length}…`;
      const atual = cadSelb(x.selb) || {}, novo = { ...atual, ...x.dif };
      if (novo.cor === 'pb') novo.cores = ['preto'];
      const rr = await api('api/receb-selbs/' + encodeURIComponent(x.selb), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(novo) }).catch(() => null);
      if (rr && rr.ok) ok++;
    }
    d.close();
    alert(`${ok} cadastro(s) atualizado(s)${ok < escolhidos.length ? `; ${escolhidos.length - ok} falharam` : ''}.`);
    renderSelbs();
  };
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
      <label class="sf-local">Local vinculado <input id="sfLocal" value="${esc(c.local || '')}" maxlength="160" list="sfDlLocal" placeholder="${uso && uso.ult && uso.ult.local ? 'pelas entregas: ' + esc(uso.ult.local) : 'ex.: Escola X › Sala 3'}" autocomplete="off"></label>
      <datalist id="sfDlLocal">${[...new Set([...CAD.locais.map(L => L.nome), ...(uso ? [...uso.locais.values()].map(o => o.nome) : [])])].sort().map(v => `<option value="${esc(v)}">`).join('')}</datalist>
      <label>IP da impressora <input id="sfIp" value="${esc(c.ip || '')}" maxlength="15" inputmode="decimal" placeholder="ex.: 192.168.0.50" autocomplete="off"></label>
      <label>Comunidade SNMP <input id="sfCom" value="${esc(c.comunidade || '')}" maxlength="64" placeholder="public" autocomplete="off"></label>
      <div class="sf-testar"><span class="lbl">Níveis e dados da impressora</span><button type="button" class="btn ghost" id="sfTestar">${IC('raio')}Testar leitura</button></div>
    </div>
    <div class="sf-grupos">
      <div><span class="lbl">Impressão</span><div class="seg2">${radio('sfCor', 'colorida', 'Colorida', cor)}${radio('sfCor', 'pb', 'Preto', cor)}</div></div>
      <div><span class="lbl">Suprimento</span><div class="seg2">${radio('sfSup', 'tinta', 'Tinta', sup)}${radio('sfSup', 'toner', 'Toner', sup)}${radio('sfSup', 'nenhum', 'Nenhum (scanner)', sup)}</div></div>
      <div><span class="lbl">Cores usadas</span><div class="it-chips" id="sfCores">
        ${['preto', 'azul', 'magenta', 'amarelo'].map(k => `<label class="it-chip ${cores.includes(k) ? 'on' : ''}"><input type="checkbox" value="${k}" ${cores.includes(k) ? 'checked' : ''}><span class="it-bola it-${k}"></span>${ITENS[k]}</label>`).join('')}</div></div>
      <div><span class="lbl">Manutenção</span><p class="sf-nota"><span class="it-bola it-caixa">${IC('caixa')}</span>Toda impressora usa caixa de manutenção: ela entra sozinha nos itens (scanner não).</p></div>
    </div>
    <div id="sfSnmp" class="sf-snmp" hidden></div>
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
  // lê agora, pela rede, os níveis da impressora (SNMP) sem gravar nada
  $('#sfTestar').addEventListener('click', async e => {
    const ip = $('#sfIp').value.trim(), box = $('#sfSnmp');
    if (!ipValido(ip)) { alert('Informe um IP válido para testar.'); return $('#sfIp').focus(); }
    e.currentTarget.disabled = true; box.hidden = false; box.innerHTML = `<p class="muted">${IC('relogio')} Lendo ${esc(ip)} por SNMP…</p>`;
    const r = await api('api/suprimentos/testar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, comunidade: $('#sfCom').value.trim() }) })
      .then(x => x.json()).catch(() => ({ ok: false, erro: 'servidor indisponível' }));
    $('#sfTestar').disabled = false;
    box.innerHTML = r.ok
      ? `<div class="sf-snmp-cab"><span class="badge ok">leitura ok</span> <b>${esc(r.modelo || 'modelo não informado')}</b>${r.serie ? ` <small class="mono">série ${esc(r.serie)}</small>` : ''} <small class="muted">SNMP ${esc(r.versao)} · ${r.ms} ms</small></div>${suprimentosHtml(r.itens, { tipo: $('#sfTipo').value, obs: $('#sfObs').value, cor: (f.querySelector('input[name="sfCor"]:checked') || {}).value, suprimento: (f.querySelector('input[name="sfSup"]:checked') || {}).value })}`
      : `<p class="err">${IC('alerta')} Não foi possível ler: ${esc(r.erro || 'erro')}</p>${r.sysDescr ? `<p class="muted">O equipamento respondeu: ${esc(r.sysDescr)}</p>` : ''}`;
    // dados do equipamento lidos: oferece preencher o cadastro
    if (r.ok && r.equipamento) {
      const eq = r.equipamento, div = document.createElement('div');
      div.className = 'sf-equip';
      div.innerHTML = `<div><span class="lbl">Lido da impressora</span><p>${equipLidoHtml(eq)}</p></div>
        <button type="button" class="btn" id="sfPreencher">${IC('check')}Preencher o cadastro</button>`;
      box.prepend(div);
      $('#sfPreencher').addEventListener('click', ev => {
        if (eq.marca) $('#sfMarca').value = eq.marca;
        if (eq.modelo) $('#sfModelo').value = eq.modelo;
        if (eq.serie) $('#sfSerie').value = eq.serie;
        if (eq.tipo) $('#sfTipo').value = eq.tipo;
        if (eq.cor) f.querySelector(`input[name="sfCor"][value="${eq.cor}"]`).checked = true;
        if (eq.suprimento) f.querySelector(`input[name="sfSup"][value="${eq.suprimento}"]`).checked = true;
        if (eq.cores) f.querySelectorAll('#sfCores input').forEach(cb => { cb.checked = eq.cores.includes(cb.value); });
        atualizar();
        ['#sfMarca', '#sfModelo', '#sfSerie', '#sfTipo'].forEach(q => { $(q).classList.remove('sf-preenchido'); void $(q).offsetWidth; $(q).classList.add('sf-preenchido'); });
        ev.currentTarget.outerHTML = `<span class="badge ok">${IC('check')} preenchido — confira e salve</span>`;
      });
    }
  });
  $('#sfSalvar').addEventListener('click', async e => {
    const selb = $('#sfSelb').value.trim().toUpperCase();
    if (!selb || RecebOCR.separarSelbs(selb).length !== 1) { alert('Informe um SELB (um só).'); return $('#sfSelb').focus(); }
    const ip = $('#sfIp').value.trim();
    if (ip && !ipValido(ip)) { alert('IP inválido. Use o formato 192.168.0.50.'); return $('#sfIp').focus(); }
    const corpo = {
      tipo: $('#sfTipo').value, marca: $('#sfMarca').value, modelo: $('#sfModelo').value, serie: $('#sfSerie').value,
      cor: f.querySelector('input[name="sfCor"]:checked').value, suprimento: f.querySelector('input[name="sfSup"]:checked').value,
      cores: [...f.querySelectorAll('#sfCores input:checked')].map(cb => cb.value), ip: $('#sfIp').value.trim(), comunidade: $('#sfCom').value.trim(), obs: $('#sfObs').value, local: $('#sfLocal').value.trim(),
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
      <div class="head-row"><h2>${TX('treino.titulo')}</h2>
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

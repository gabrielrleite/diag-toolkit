'use strict';
// ================================================================== Recebimentos › entrega manual (assinada no celular)
// Formulário pensado para o celular: local, SELB(s), itens entregues, quem recebeu, campos personalizados,
// fotos opcionais e assinatura desenhada na tela. Sem conexão, a entrega entra na fila do offline.js
// (com assinatura e fotos) e é enviada quando o servidor responder.
const EM = { cfg: null };
const CAMPOS_ENTREGA_PADRAO = {
  recebedor: { ativo: true, obrigatorio: true, rotulo: 'Nome de quem recebeu' },
  documento: { ativo: false, obrigatorio: false, rotulo: 'CPF / matrícula' },
  assinatura: { obrigatoria: true }, fotos: { ativo: true, max: 4 },
  termo: 'Declaro que recebi os itens acima em perfeito estado.', campos: [],
};
const TIPO_CAMPO_ENTREGA_TXT = { texto: 'Texto curto', texto_longo: 'Texto longo', numero: 'Número', data: 'Data', lista: 'Lista de opções', sim_nao: 'Sim / não' };
async function carregarCamposEntrega() {
  const r = await api('api/receb-entrega-campos').catch(() => null);
  EM.cfg = r && r.ok ? await r.json() : EM.cfg || CAMPOS_ENTREGA_PADRAO;
  return EM.cfg;
}
const hojeIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const idCliente = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));

// ---------------------------------------------------------------- assinatura na tela (dedo, caneta ou mouse)
function padAssinatura(canvas) {
  const ctx = canvas.getContext('2d');
  let desenhando = false, vazio = true, ult = null;
  const ajustar = () => {
    // resolução real da tela (traço nítido); mantém o desenho ao girar o celular
    const antes = vazio ? null : canvas.toDataURL();
    const r = canvas.getBoundingClientRect(), k = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * k); canvas.height = Math.round(r.height * k);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111827';
    if (antes) { const im = new Image(); im.onload = () => ctx.drawImage(im, 0, 0, r.width, r.height); im.src = antes; }
  };
  const ponto = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', e => { desenhando = true; ult = ponto(e); canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.arc(ult.x, ult.y, 1.1, 0, Math.PI * 2); ctx.fillStyle = '#111827'; ctx.fill(); vazio = false; canvas.dispatchEvent(new Event('mudou')); });
  canvas.addEventListener('pointermove', e => {
    if (!desenhando) return;
    for (const ev of (e.getCoalescedEvents ? e.getCoalescedEvents() : [e])) {
      const p = ponto(ev);
      ctx.beginPath(); ctx.moveTo(ult.x, ult.y); ctx.lineTo(p.x, p.y); ctx.stroke(); ult = p;
    }
  });
  const fim = () => { desenhando = false; };
  canvas.addEventListener('pointerup', fim); canvas.addEventListener('pointercancel', fim);
  new ResizeObserver(() => ajustar()).observe(canvas);
  ajustar();
  return {
    vazio: () => vazio,
    limpar: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); vazio = true; canvas.dispatchEvent(new Event('mudou')); },
    // PNG recortado no traço, com fundo branco (fica legível no comprovante e no tema escuro)
    png: () => {
      if (vazio) return '';
      const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(canvas, 0, 0);
      const max = 900, k = Math.min(1, max / c.width), o = document.createElement('canvas');
      o.width = Math.round(c.width * k); o.height = Math.round(c.height * k);
      o.getContext('2d').drawImage(c, 0, 0, o.width, o.height);
      return o.toDataURL('image/png');
    },
    desenhar: url => new Promise(ok => { const im = new Image(); im.onload = () => { const r = canvas.getBoundingClientRect(); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(im, 0, 0, r.width, r.height); vazio = false; ok(); }; im.src = url; }),
  };
}
// foto do celular: reduz para no máximo 1600 px (JPEG), o envio fica leve mesmo no 4G
function reduzirFoto(arquivo, max = 1600) {
  return new Promise((ok, erro) => {
    const u = URL.createObjectURL(arquivo), im = new Image();
    im.onload = () => {
      const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight)), c = document.createElement('canvas');
      c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(u); ok(c.toDataURL('image/jpeg', 0.8));
    };
    im.onerror = () => { URL.revokeObjectURL(u); erro(new Error('imagem inválida')); };
    im.src = u;
  });
}

// ---------------------------------------------------------------- formulário
async function renderEntregaManual() {
  const el = $('#mod-receb');
  el.innerHTML = abasReceb('entregas') + '<div class="panel">Carregando...</div>';
  if (!(await needServer(el, { offline: true }))) return;
  const [r] = await Promise.all([api('api/recebimentos?linhas=1').catch(() => null), carregarLocais(), carregarSelbsCad(), carregarCamposEntrega()]);
  const folhas = r && r.ok ? await r.json() : [];
  const cfg = EM.cfg;
  const locais = [...new Set([...CAD.locais.map(L => L.nome), ...folhas.flatMap(f => f.linhas.map(l => l.local)).filter(Boolean)])].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const selbs = [...new Set([...[...RB.selbsCad.values()].map(c => c.selb), ...folhas.flatMap(f => f.linhas.flatMap(l => selbsDe(l.selb)))])].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
  const E = { id: idCliente(), itens: [], fotos: [] };
  const campoHtml = c => {
    const id = 'emc-' + c.id, req = c.obrigatorio ? ' <span class="em-obr">*</span>' : '';
    if (c.tipo === 'sim_nao') return `<div class="em-campo"><span class="lbl">${esc(c.rotulo)}${req}</span><div class="seg2" data-campo="${esc(c.id)}">${['sim', 'nao'].map(v => `<label class="seg-op"><input type="radio" name="${id}" value="${v}"><span>${v === 'sim' ? 'Sim' : 'Não'}</span></label>`).join('')}</div></div>`;
    if (c.tipo === 'lista') return `<label class="em-campo"><span>${esc(c.rotulo)}${req}</span><select id="${id}" data-campo="${esc(c.id)}"><option value=""></option>${c.opcoes.map(o => `<option>${esc(o)}</option>`).join('')}</select></label>`;
    if (c.tipo === 'texto_longo') return `<label class="em-campo full"><span>${esc(c.rotulo)}${req}</span><textarea id="${id}" data-campo="${esc(c.id)}" rows="3" maxlength="2000"></textarea></label>`;
    return `<label class="em-campo"><span>${esc(c.rotulo)}${req}</span><input id="${id}" data-campo="${esc(c.id)}" type="${c.tipo === 'numero' ? 'number' : c.tipo === 'data' ? 'date' : 'text'}" ${c.tipo === 'numero' ? 'inputmode="decimal"' : ''} maxlength="300"></label>`;
  };
  el.innerHTML = abasReceb('entregas') + `
    <div class="panel em-form" id="emForm">
      <div class="head-row"><div><a href="#receb" class="btn small ghost">← ${esc(Tp('aba.entregas'))}</a> <b class="ld-title">${TX('manual.titulo')}</b></div><a class="linklike" href="#receb/textos" title="Escolher os campos deste formulário">Personalizar campos</a></div>
      <p class="muted">${TX('manual.ajuda')}</p>
      <div class="em-grade">
        <label class="em-campo"><span>Local <span class="em-obr">*</span></span><input id="emLocal" list="emDlLocal" autocomplete="off" maxlength="160" placeholder="onde foi entregue"></label>
        <label class="em-campo"><span>SELB <span class="em-obr">*</span></span><input id="emSelb" list="emDlSelb" autocomplete="off" maxlength="300" placeholder="vários: A123, A124" autocapitalize="characters"></label>
        <label class="em-campo">Data <input id="emData" type="date" value="${hojeIso()}"></label>
        <datalist id="emDlLocal">${locais.map(v => `<option value="${esc(v)}">`).join('')}</datalist>
        <datalist id="emDlSelb">${selbs.map(v => `<option value="${esc(v)}">`).join('')}</datalist>
      </div>
      <div id="emSelbInfo" class="em-selb-info"></div>
      <div class="em-bloco"><span class="lbl">Itens entregues</span><div id="emItens"><p class="muted">Informe o SELB para escolher os itens.</p></div></div>
      <div class="em-grade">
        ${cfg.recebedor.ativo ? `<label class="em-campo"><span>${esc(cfg.recebedor.rotulo)}${cfg.recebedor.obrigatorio ? ' <span class="em-obr">*</span>' : ''}</span><input id="emRecebedor" maxlength="160" autocomplete="off" autocapitalize="words"></label>` : ''}
        ${cfg.documento.ativo ? `<label class="em-campo"><span>${esc(cfg.documento.rotulo)}${cfg.documento.obrigatorio ? ' <span class="em-obr">*</span>' : ''}</span><input id="emDocumento" maxlength="40" autocomplete="off" inputmode="numeric"></label>` : ''}
        ${cfg.campos.filter(c => c.ativo).map(campoHtml).join('')}
        <label class="em-campo full">Observação <textarea id="emObs" rows="2" maxlength="2000" placeholder="opcional"></textarea></label>
      </div>
      ${cfg.fotos.ativo ? `<div class="em-bloco"><span class="lbl">Fotos da entrega <small class="muted">(opcional, até ${cfg.fotos.max})</small></span>
        <div class="em-fotos" id="emFotos"></div>
        <div class="filters" style="margin:6px 0 0"><label class="btn ghost small em-foto-btn">${IC('imagem')}Tirar foto<input type="file" accept="image/*" capture="environment" id="emCam" hidden></label>
          <label class="btn ghost small em-foto-btn">${IC('upload')}Escolher fotos<input type="file" accept="image/*" multiple id="emGal" hidden></label></div></div>` : ''}
      <div class="em-bloco">
        <span class="lbl">Assinatura de quem recebeu${cfg.assinatura.obrigatoria ? ' <span class="em-obr">*</span>' : ' <small class="muted">(opcional)</small>'}</span>
        ${cfg.termo ? `<p class="em-termo">${esc(cfg.termo)}</p>` : ''}
        <div class="em-pad-caixa"><canvas id="emPad" class="em-pad" aria-label="Área para assinar com o dedo"></canvas><span class="em-pad-linha">assine aqui</span></div>
        <div class="filters" style="margin:6px 0 0"><button type="button" class="btn ghost small" id="emLimpar">Limpar</button><button type="button" class="btn ghost small" id="emTela">Assinar em tela cheia</button></div>
      </div>
      <div class="dlg-actions"><a class="btn ghost" href="#receb">Cancelar</a><button class="btn" id="emSalvar">${IC('check')}Registrar entrega</button></div>
    </div>`;
  const pad = padAssinatura($('#emPad'));
  $('#emPad').addEventListener('mudou', () => $('#emForm .em-pad-caixa').classList.toggle('assinado', !pad.vazio()));
  $('#emLimpar').onclick = () => pad.limpar();
  $('#emTela').onclick = () => assinarTelaCheia(pad, cfg.termo);
  // SELB: itens conforme o cadastro (cores + caixa) e local vinculado
  const desenharItens = () => {
    const lista = selbsDe($('#emSelb').value.toUpperCase());
    E.itens = E.itens.filter(it => lista.some(x => kSelb(x) === kSelb(it.selb)));
    $('#emSelbInfo').innerHTML = lista.map(s => { const c = cadSelb(s); return `<span class="em-selb">${IC('tag')}<b>${esc(s)}</b> ${c ? `<small>${esc(resumoEquip(c, false))}</small>` : '<small class="muted">sem cadastro</small>'}</span>`; }).join('');
    $('#emItens').innerHTML = !lista.length ? '<p class="muted">Informe o SELB para escolher os itens.</p>' : lista.map(s => {
      const c = cadSelb(s), tipo = c && c.suprimento === 'toner' ? 'toner' : 'tinta';
      return `<div class="em-itens-selb">${lista.length > 1 ? `<small class="muted">${esc(s)}</small>` : ''}<div class="em-chips">${suprimentosDe(s).map(item => {
        const it = E.itens.find(x => kSelb(x.selb) === kSelb(s) && x.item === item), q = it ? it.qtd : 0;
        return `<div class="em-chip ${q ? 'on' : ''}" data-selb="${esc(s)}" data-item="${item}">
          <button type="button" class="em-chip-nome" aria-pressed="${!!q}"><span class="it-bola it-${item}">${item === 'caixa' ? IC('caixa') : ''}</span>${esc(item === 'caixa' ? ITENS.caixa : nomeSuprimento(item, tipo))}</button>
          <span class="em-qtd"><button type="button" data-q="-1" aria-label="menos">−</button><b>${q}</b><button type="button" data-q="1" aria-label="mais">+</button></span></div>`;
      }).join('')}</div></div>`;
    }).join('');
    $('#emItens').querySelectorAll('.em-chip').forEach(ch => {
      const mudar = d => {
        const s = ch.dataset.selb, item = ch.dataset.item, c = cadSelb(s);
        let it = E.itens.find(x => kSelb(x.selb) === kSelb(s) && x.item === item);
        if (!it) { it = { selb: s.toUpperCase(), item, qtd: 0, tipo: item === 'caixa' ? '' : c && c.suprimento === 'toner' ? 'toner' : 'tinta' }; E.itens.push(it); }
        it.qtd = Math.max(0, Math.min(99, it.qtd + d));
        E.itens = E.itens.filter(x => x.qtd > 0);
        desenharItens();
      };
      ch.querySelector('.em-chip-nome').onclick = () => mudar(E.itens.some(x => kSelb(x.selb) === kSelb(ch.dataset.selb) && x.item === ch.dataset.item) ? -99 : 1);
      ch.querySelectorAll('[data-q]').forEach(b => { b.onclick = () => mudar(+b.dataset.q); });
    });
  };
  $('#emSelb').addEventListener('input', () => {
    desenharItens();
    // local vinculado no cadastro do SELB preenche o local (se ainda vazio)
    const um = selbsDe($('#emSelb').value.toUpperCase());
    const vinc = um.length === 1 && (cadSelb(um[0]) || {}).local;
    if (vinc && !$('#emLocal').value.trim()) { $('#emLocal').value = vinc; $('#emLocal').classList.add('sf-preenchido'); }
  });
  // fotos
  const desenharFotos = () => {
    const box = $('#emFotos'); if (!box) return;
    box.innerHTML = E.fotos.map((f, i) => `<figure class="em-foto"><img src="${f.dataUrl}" alt="Foto ${i + 1}"><button type="button" class="em-foto-x" data-i="${i}" aria-label="Remover foto">×</button></figure>`).join('') || '<p class="muted">Nenhuma foto.</p>';
    box.querySelectorAll('.em-foto-x').forEach(b => { b.onclick = () => { E.fotos.splice(+b.dataset.i, 1); desenharFotos(); }; });
    document.querySelectorAll('.em-foto-btn').forEach(l => l.classList.toggle('desab', E.fotos.length >= cfg.fotos.max));
  };
  const addFotos = async files => {
    for (const f of [...files]) {
      if (E.fotos.length >= cfg.fotos.max) { alert(`No máximo ${cfg.fotos.max} fotos.`); break; }
      try { E.fotos.push({ dataUrl: await reduzirFoto(f), legenda: '' }); } catch { alert(`Não foi possível abrir ${f.name}.`); }
    }
    desenharFotos();
  };
  if ($('#emCam')) { $('#emCam').onchange = e => { addFotos(e.target.files); e.target.value = ''; }; $('#emGal').onchange = e => { addFotos(e.target.files); e.target.value = ''; }; desenharFotos(); }
  // registrar
  $('#emSalvar').addEventListener('click', async e => {
    const val = q => ($(q) ? $(q).value.trim() : '');
    const campos = {};
    for (const c of cfg.campos.filter(x => x.ativo)) {
      if (c.tipo === 'sim_nao') { const r = document.querySelector(`input[name="emc-${c.id}"]:checked`); campos[c.id] = r ? r.value : ''; }
      else campos[c.id] = val('#emc-' + c.id);
    }
    const corpo = {
      idCliente: E.id, feitaEm: new Date().toISOString(), local: val('#emLocal'), selb: normSelbs(val('#emSelb')), dataIso: val('#emData') || hojeIso(),
      itens: E.itens, recebedor: val('#emRecebedor'), documento: val('#emDocumento'), obs: val('#emObs'), campos,
      assinatura: pad.png(), fotos: E.fotos,
    };
    // obrigatórios (o servidor confere de novo)
    const faltam = [];
    if (!corpo.local) faltam.push('Local');
    if (!corpo.selb) faltam.push('SELB');
    if (cfg.recebedor.ativo && cfg.recebedor.obrigatorio && !corpo.recebedor) faltam.push(cfg.recebedor.rotulo);
    if (cfg.documento.ativo && cfg.documento.obrigatorio && !corpo.documento) faltam.push(cfg.documento.rotulo);
    for (const c of cfg.campos.filter(x => x.ativo && x.obrigatorio)) if (!campos[c.id]) faltam.push(c.rotulo);
    if (cfg.assinatura.obrigatoria && pad.vazio()) faltam.push('Assinatura');
    if (faltam.length) return alert('Preencha: ' + faltam.join(', ') + '.');
    if (!corpo.itens.length && !confirm('Nenhum item marcado. Registrar a entrega mesmo assim?')) return;
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Registrando…';
    const r = await api('api/recebimentos/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) { b.disabled = false; b.innerHTML = `${IC('check')}Registrar entrega`; return alert('Não foi possível registrar: ' + (j.erro || 'servidor indisponível.')); }
    RB.vocab = null;
    if (j.offline) { alert('Sem conexão: a entrega (com a assinatura e as fotos) ficou guardada neste aparelho e será enviada quando o servidor responder.'); location.hash = 'receb'; return; }
    location.hash = 'receb/' + j.id;
  });
}

// assinatura em tela cheia (mais espaço no celular; deitado fica melhor)
function assinarTelaCheia(padPeq, termo) {
  const d = document.createElement('dialog');
  d.className = 'em-tela';
  d.innerHTML = `<div class="em-tela-cab"><b>Assinatura</b>${termo ? `<small>${esc(termo)}</small>` : ''}</div>
    <div class="em-pad-caixa grande"><canvas class="em-pad"></canvas><span class="em-pad-linha">assine aqui</span></div>
    <div class="em-tela-acoes"><button type="button" class="btn ghost" data-a="limpar">Limpar</button><button type="button" class="btn ghost" data-a="cancelar">Cancelar</button><button type="button" class="btn" data-a="ok">Usar assinatura</button></div>`;
  document.body.appendChild(d); d.showModal();
  const pad = padAssinatura(d.querySelector('canvas'));
  d.querySelector('[data-a="limpar"]').onclick = () => pad.limpar();
  d.querySelector('[data-a="cancelar"]').onclick = () => d.close();
  d.querySelector('[data-a="ok"]').onclick = async () => { if (pad.vazio()) return alert('Assine na área branca.'); await padPeq.desenhar(pad.png()); $('#emPad').dispatchEvent(new Event('mudou')); d.close(); };
  d.addEventListener('close', () => d.remove());
}

// ---------------------------------------------------------------- comprovante de uma entrega manual
async function verEntregaManual(F) {
  const el = $('#mod-receb');
  const l = F.linhas[0] || {}, M = F.manual || {};
  const anx = F.pendente ? [] : await api(`api/recebimentos/${F.id}/anexos`).then(x => x.ok ? x.json() : []).catch(() => []);
  const url = aid => `api/recebimentos/${F.id}/anexos/${aid}${srv.token ? '?token=' + encodeURIComponent(srv.token) : ''}`;
  const img = async aid => api(url(aid)).then(x => x.ok ? x.blob() : null).then(b => b ? URL.createObjectURL(b) : '').catch(() => '');
  const ass = M.assinatura ? await img(M.assinatura) : '';
  const fotos = await Promise.all((M.fotos || []).map(async aid => ({ aid, src: await img(aid), legenda: (anx.find(a => a.aid === aid) || {}).legenda || '' })));
  const quando = M.feitaEm ? fmt(new Date(M.feitaEm)).slice(0, 16) : '—';
  const pr = principalDoLocal(l.local);
  el.innerHTML = abasReceb('entregas') + `
    <div class="panel em-comprovante">
      <div class="head-row"><div><a href="#receb" class="btn small ghost noprint">← ${esc(Tp('aba.entregas'))}</a> <b class="ld-title">${TX('manual.titulo')}</b> ${F.pendente ? '<span class="badge">aguardando envio</span>' : `<small class="mono muted">${esc(F.id)}</small>`}</div>
        <div class="filters noprint" style="margin:0"><button class="btn ghost small" id="emImprimir">Imprimir</button>${F.pendente ? '' : '<button class="btn ghost small perigo" id="emExcluir">Excluir</button>'}</div></div>
      <dl class="em-dados">
        <dt>Local</dt><dd>${esc(l.local || '—')}${pr ? ` <small class="muted">(${esc(pr.nome)})</small>` : ''}</dd>
        <dt>SELB</dt><dd>${esc(l.selb || '—')}</dd>
        <dt>Data</dt><dd>${esc(l.data || '—')} <small class="muted">registrada em ${esc(quando)}</small></dd>
        <dt>Itens</dt><dd>${(l.itens || []).length ? `<ul class="em-itens-lista">${l.itens.map(it => `<li><span class="it-bola it-${it.item}">${it.item === 'caixa' ? IC('caixa') : ''}</span>${esc(it.item === 'caixa' ? ITENS.caixa : nomeSuprimento(it.item, it.tipo))} <b>× ${it.qtd}</b>${selbsDe(l.selb).length > 1 ? ` <small class="muted">${esc(it.selb)}</small>` : ''}</li>`).join('')}</ul>` : '<span class="muted">nenhum item marcado</span>'}</dd>
        ${M.recebedor ? `<dt>Recebido por</dt><dd>${esc(M.recebedor)}</dd>` : ''}
        ${M.documento ? `<dt>Documento</dt><dd>${esc(M.documento)}</dd>` : ''}
        ${Object.values(M.campos || {}).map(c => `<dt>${esc(c.rotulo)}</dt><dd>${esc(c.valor)}</dd>`).join('')}
        ${F.obs ? `<dt>Observação</dt><dd>${esc(F.obs)}</dd>` : ''}
      </dl>
      ${M.termo ? `<p class="em-termo">${esc(M.termo)}</p>` : ''}
      <div class="em-ass">${ass ? `<img src="${ass}" alt="Assinatura de ${esc(M.recebedor || 'quem recebeu')}">` : `<span class="muted">${F.pendente ? 'assinatura guardada neste aparelho' : 'sem assinatura'}</span>`}<small>${esc(M.recebedor || 'assinatura')}</small></div>
      ${fotos.length ? `<h3 class="sr-h3">Fotos</h3><div class="em-fotos">${fotos.map(f => `<figure class="em-foto"><a href="${f.src}" target="_blank" rel="noopener"><img src="${f.src}" alt="${esc(f.legenda)}"></a></figure>`).join('')}</div>` : ''}
    </div>`;
  $('#emImprimir').onclick = () => window.print();
  if ($('#emExcluir')) $('#emExcluir').onclick = async () => {
    if (!confirm('Excluir esta entrega manual? (fica no histórico de auditoria)')) return;
    const r = await api('api/recebimentos/' + F.id, { method: 'DELETE' }).catch(() => null);
    if (!r || !r.ok) return alert('Não foi possível excluir.');
    location.hash = 'receb';
  };
}

// ---------------------------------------------------------------- configuração dos campos (aba Personalizar)
async function painelCamposEntrega(box) {
  const cfg = JSON.parse(JSON.stringify(await carregarCamposEntrega()));
  const desenhar = () => {
    box.innerHTML = `<div class="head-row"><h2>Campos da entrega manual</h2><button class="btn" id="ecSalvar">Salvar campos</button></div>
      <p class="muted">Escolha o que aparece no formulário da entrega manual. Local, SELB, data e itens sempre aparecem.</p>
      <div class="ec-lista">
        ${[['recebedor', cfg.recebedor], ['documento', cfg.documento]].map(([k, c]) => `<div class="ec-linha" data-fixo="${k}">
          <label class="chk"><input type="checkbox" data-a="ativo" ${c.ativo ? 'checked' : ''}> mostrar</label>
          <input data-a="rotulo" value="${esc(c.rotulo)}" maxlength="60" aria-label="Nome do campo">
          <span class="muted ec-tipo">Texto curto</span>
          <label class="chk"><input type="checkbox" data-a="obrigatorio" ${c.obrigatorio ? 'checked' : ''}> obrigatório</label><span></span></div>`).join('')}
        ${cfg.campos.map((c, i) => `<div class="ec-linha" data-i="${i}">
          <label class="chk"><input type="checkbox" data-a="ativo" ${c.ativo ? 'checked' : ''}> mostrar</label>
          <input data-a="rotulo" value="${esc(c.rotulo)}" maxlength="60" placeholder="nome do campo" aria-label="Nome do campo">
          <select data-a="tipo">${Object.entries(TIPO_CAMPO_ENTREGA_TXT).map(([v, t]) => `<option value="${v}" ${c.tipo === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <label class="chk"><input type="checkbox" data-a="obrigatorio" ${c.obrigatorio ? 'checked' : ''}> obrigatório</label>
          <span class="ec-acoes"><button type="button" class="btn ghost small" data-mover="-1" title="Subir" aria-label="Subir">↑</button><button type="button" class="btn ghost small" data-mover="1" title="Descer" aria-label="Descer">↓</button><button type="button" class="btn ghost small perigo" data-rem title="Excluir campo">Excluir</button></span>
          ${c.tipo === 'lista' ? `<input class="ec-opcoes" data-a="opcoes" value="${esc(c.opcoes.join(', '))}" placeholder="opções separadas por vírgula (ex.: Manhã, Tarde)">` : ''}</div>`).join('')}
      </div>
      <button type="button" class="btn ghost small" id="ecNovo">${IC('mais')}Novo campo</button>
      <div class="ec-extra">
        <label class="chk"><input type="checkbox" id="ecAss" ${cfg.assinatura.obrigatoria ? 'checked' : ''}> assinatura obrigatória</label>
        <label class="chk"><input type="checkbox" id="ecFotos" ${cfg.fotos.ativo ? 'checked' : ''}> permitir fotos</label>
        <label>no máximo <input type="number" id="ecFotosMax" min="1" max="10" value="${cfg.fotos.max}" style="width:70px"> fotos</label>
      </div>
      <label class="full">Texto acima da assinatura <textarea id="ecTermo" rows="2" maxlength="500">${esc(cfg.termo || '')}</textarea></label>`;
    box.querySelectorAll('.ec-linha').forEach(ln => {
      const alvo = ln.dataset.fixo ? cfg[ln.dataset.fixo] : cfg.campos[+ln.dataset.i];
      ln.querySelectorAll('[data-a]').forEach(inp => inp.addEventListener(inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input', () => {
        const a = inp.dataset.a;
        alvo[a] = inp.type === 'checkbox' ? inp.checked : a === 'opcoes' ? inp.value.split(',').map(x => x.trim()).filter(Boolean) : inp.value;
        if (a === 'tipo') desenhar();
      }));
      const rem = ln.querySelector('[data-rem]');
      if (rem) rem.onclick = () => { cfg.campos.splice(+ln.dataset.i, 1); desenhar(); };
      ln.querySelectorAll('[data-mover]').forEach(b => { b.onclick = () => { const i = +ln.dataset.i, j = i + +b.dataset.mover; if (j < 0 || j >= cfg.campos.length) return; [cfg.campos[i], cfg.campos[j]] = [cfg.campos[j], cfg.campos[i]]; desenhar(); }; });
    });
    box.querySelector('#ecNovo').onclick = () => { cfg.campos.push({ rotulo: '', tipo: 'texto', obrigatorio: false, ativo: true, opcoes: [] }); desenhar(); box.querySelector('.ec-linha:last-child [data-a="rotulo"]').focus(); };
    box.querySelector('#ecSalvar').onclick = async e => {
      cfg.assinatura.obrigatoria = box.querySelector('#ecAss').checked;
      cfg.fotos = { ativo: box.querySelector('#ecFotos').checked, max: +box.querySelector('#ecFotosMax').value || 4 };
      cfg.termo = box.querySelector('#ecTermo').value;
      if (cfg.campos.some(c => c.tipo === 'lista' && !c.opcoes.length)) return alert('Informe as opções dos campos do tipo lista.');
      e.target.disabled = true;
      const r = await api('api/receb-entrega-campos', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) }).catch(() => null);
      e.target.disabled = false;
      if (!r || !r.ok) return alert('Não foi possível salvar os campos.');
      EM.cfg = await r.json(); Object.assign(cfg, JSON.parse(JSON.stringify(EM.cfg))); desenhar();
      e.target.textContent = 'Salvo';
    };
  };
  desenhar();
}

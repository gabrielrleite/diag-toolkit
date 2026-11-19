'use strict';
/*
  Módulo "Recebimentos": importa fotos/digitalizações de folhas de recebimento assinadas
  (várias entregas por folha: SELB, DATA, LOCAL, CPF, NOME) e lê com OCR no navegador.
  A imagem não sai da máquina até o técnico conferir e salvar.
  Depende de app.js (esc, api, srv, sha256Hex, fmt), laudos.js (showModule, needServer) e receb-ocr.js.
*/

// Modelo da folha: colunas na ordem impressa. "peso" = largura relativa (ajuda a saber se a foto está de cabeça para baixo).
// "ler": coluna digitada (OCR + ajuste manual). As demais (CPF, nome/assinatura) ficam só na imagem da folha.
const FOLHA_MODELO = {
  colunas: [
    { k: 'selb', rotulo: 'SELB', peso: 198, ler: true, wl: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/. ' },
    { k: 'data', rotulo: 'Data', peso: 254, ler: true, wl: '0123456789/.-' },
    { k: 'local', rotulo: 'Local', peso: 786, ler: true, wl: '' },
    { k: 'cpf', rotulo: 'CPF', peso: 340, ler: false },
    { k: 'nome', rotulo: 'Nome', peso: 616, ler: false },
  ],
  cabecalho: true, // primeira linha da grade é o cabeçalho
};
const RB = { folhas: [], q: '', cur: null, dirty: false, imp: null, worker: null, carregandoOcr: null };
const COLS = FOLHA_MODELO.colunas;
// o que aparece na tela e é digitado, na ordem de exibição
const CAMPOS = ['local', 'selb', 'data'].map(k => COLS.find(c => c.k === k)).filter(c => c && c.ler);
const NA_IMAGEM = COLS.filter(c => !c.ler).map(c => c.rotulo).join(' e ');
const dataOk = v => !v || RecebOCR.limparData(v).ok;

// ================================================================== lista / controle
async function renderReceb(arg) {
  const el = $('#mod-receb');
  if (RB.dirty && RB.cur && (arg || '').split('~')[0] !== RB.cur.id && !confirm('Há alterações não salvas na folha. Sair mesmo assim?')) {
    history.replaceState(null, '', '#receb/' + (RB.cur.id || 'importar')); return;
  }
  RB.dirty = false; RB.cur = null;
  if (arg === 'importar') return renderImportar();
  if (arg) { const [fid, n] = arg.split('~'); return abrirFolha(fid, +n || 0); }
  RB.imp = null;
  el.innerHTML = '<div class="panel">Carregando...</div>';
  if (!(await needServer(el))) return;
  const r = await api('api/recebimentos?linhas=1').catch(() => null);
  RB.folhas = r && r.ok ? await r.json() : [];
  const regs = RB.folhas.flatMap(f => f.linhas.map(l => ({ ...l, folha: f })));
  const porSelb = new Map();
  for (const l of regs) if (l.selb) porSelb.set(l.selb.toUpperCase(), (porSelb.get(l.selb.toUpperCase()) || 0) + 1);
  const pend = regs.filter(l => !l.revisado).length;
  el.innerHTML = `
    <div class="panel">
      <div class="head-row"><h2>Folhas de recebimento</h2><a class="btn" href="#receb/importar">Importar folhas (OCR)</a></div>
      <div class="stats">
        <div class="stat"><div class="v">${RB.folhas.length}</div><div class="l">folhas</div></div>
        <div class="stat"><div class="v">${regs.length}</div><div class="l">recebimentos registrados</div></div>
        <div class="stat ${pend ? 'bad' : ''}"><div class="v">${pend}</div><div class="l">linhas não conferidas</div></div>
      </div>
      ${!RB.folhas.length ? '<p class="muted">Nenhuma folha ainda. Clique em "Importar folhas", escolha as fotos ou digitalizações e confira o que o OCR leu.</p>' : `
      <div class="tablewrap" style="max-height:34vh"><table class="clickable"><thead><tr><th class="nosort">Folha</th><th class="nosort">Data</th><th class="nosort">Linhas</th><th class="nosort">Conferência</th><th class="nosort">Importada em</th></tr></thead><tbody>
      ${RB.folhas.map(f => `<tr data-folha="${esc(f.id)}"><td><b>${esc(f.titulo || f.id)}</b><br><small class="mono">${esc(f.id)}</small></td>
        <td class="t">${f.dataFolha ? esc(f.dataFolha.split('-').reverse().join('/')) : '—'}</td><td>${f.total}</td>
        <td>${f.pendentes ? `<span class="badge warn">${f.pendentes} a conferir</span>` : '<span class="badge ok">conferida</span>'}</td>
        <td class="t">${fmt(new Date(f.criadoEm)).slice(0, 16)}</td></tr>`).join('')}
      </tbody></table></div>`}
    </div>
    ${regs.length ? `<div class="panel">
      <div class="head-row"><h2>Recebimentos</h2><button class="btn ghost small" id="rbCsv">Exportar CSV</button></div>
      <div class="filters"><label>Buscar <input type="search" id="rbQ" value="${esc(RB.q)}" placeholder="SELB, local, data..." style="min-width:260px"></label>
        <label class="chk"><input type="checkbox" id="rbPend"> só não conferidos</label><span class="muted" id="rbN"></span></div>
      <div id="rbRegs"></div></div>` : ''}`;
  el.querySelectorAll('[data-folha]').forEach(tr => tr.addEventListener('click', () => { location.hash = 'receb/' + tr.dataset.folha; }));
  if (!regs.length) return;
  let filtrados = regs;
  const draw = () => {
    const q = RB.q.trim().toLowerCase(), so = $('#rbPend').checked;
    filtrados = regs.filter(l => (!so || !l.revisado) && (!q || [l.selb, l.data, l.local, l.folha.titulo].join(' ').toLowerCase().includes(q)));
    $('#rbN').textContent = `${filtrados.length} de ${regs.length}`;
    $('#rbRegs').innerHTML = `<div class="tablewrap"><table class="clickable"><thead><tr><th class="nosort">Local</th><th class="nosort">SELB</th><th class="nosort">Data</th><th class="nosort">Folha</th></tr></thead><tbody>
      ${filtrados.slice(0, 1000).map(l => `<tr data-folha="${esc(l.folha.id)}~${l.n}">
        <td>${esc(l.local || '—')}</td>
        <td>${esc(l.selb || '—')}${l.selb && porSelb.get(l.selb.toUpperCase()) > 1 ? ' <span class="badge warn" title="Mesmo SELB em mais de uma linha">repetido</span>' : ''}</td>
        <td class="t">${esc(l.data || '—')}</td>
        <td><small>${esc(l.folha.titulo || l.folha.id)} · linha ${l.n}</small>${l.revisado ? '' : ' <span class="badge warn">conferir</span>'}</td></tr>`).join('')}
      </tbody></table></div>${filtrados.length > 1000 ? '<p class="muted">Mostrando os primeiros 1000. Refine a busca.</p>' : ''}`;
    $('#rbRegs').querySelectorAll('[data-folha]').forEach(tr => tr.addEventListener('click', () => { location.hash = 'receb/' + tr.dataset.folha; }));
  };
  $('#rbQ').addEventListener('input', e => { RB.q = e.target.value; draw(); });
  $('#rbPend').addEventListener('change', draw);
  $('#rbCsv').addEventListener('click', () => {
    const cel = v => /[";\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const linhas = [['Local', 'SELB', 'Data', 'Folha', 'Linha', 'Conferido'].join(';'),
      ...filtrados.map(l => [l.local, l.selb, l.data, l.folha.titulo || l.folha.id, l.n, l.revisado ? 'sim' : 'não'].map(cel).join(';'))];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = `recebimentos-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  draw();
}

// ================================================================== OCR (Tesseract, carregado sob demanda)
function carregarScript(src) {
  return new Promise((ok, erro) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => erro(new Error('Falha ao carregar ' + src)); document.head.appendChild(s); });
}
async function ocrWorker(progresso) {
  if (RB.worker) return RB.worker;
  if (!RB.carregandoOcr) {
    RB.carregandoOcr = (async () => {
      if (typeof Tesseract === 'undefined') await carregarScript('vendor/tesseract/tesseract.min.js');
      const base = new URL('vendor/tesseract/', location.href).href;
      const w = await Tesseract.createWorker('por', 1 /* só LSTM */, {
        workerPath: base + 'worker.min.js', corePath: base + 'core', langPath: base + 'lang',
        workerBlobURL: false, gzip: true,
        logger: m => { if (RB.onOcrLog) RB.onOcrLog(m); },
      });
      RB.worker = w;
      return w;
    })().catch(e => { RB.carregandoOcr = null; throw e; });
  }
  RB.onOcrLog = progresso;
  return RB.carregandoOcr;
}

// ================================================================== importação
// valores já usados (locais e SELB) para autocompletar e corrigir a leitura
async function carregarVocab() {
  if (!RB.folhas.length || !RB.folhas[0].linhas) {
    const r = await api('api/recebimentos?linhas=1').catch(() => null);
    if (r && r.ok) RB.folhas = await r.json();
  }
  const conta = k => { const m = new Map(); for (const f of RB.folhas) for (const l of f.linhas || []) if (l[k]) m.set(l[k], (m.get(l[k]) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]); };
  RB.vocab = { local: conta('local'), selb: conta('selb') };
}

async function renderImportar() {
  const el = $('#mod-receb');
  if (!(await needServer(el))) return;
  carregarVocab().catch(() => {});
  RB.imp = { fila: [], i: 0 };
  el.innerHTML = `<div class="panel">
    <div class="head-row"><div><a href="#receb" class="btn small ghost">← Recebimentos</a> <b class="ld-title">Importar folhas</b></div></div>
    <div class="drop" id="rbDrop" style="padding:28px">
      <h1 style="font-size:18px">Escolha as fotos ou digitalizações das folhas</h1>
      <p>JPG, PNG, WEBP ou PDF (pode arrastar para cá). Pode escolher vários; cada página do PDF vira uma folha. Cada folha é conferida antes de salvar.</p>
      <label class="btn">Escolher arquivos<input type="file" id="rbFiles" accept="image/jpeg,image/png,image/webp,application/pdf,.pdf" multiple hidden></label>
      <p class="muted" style="margin-top:12px">Dicas: folha inteira na foto, sem cortar a tabela; luz uniforme; caneta escura.
      O OCR acerta bem letra de forma e números; letra cursiva quase sempre precisa de correção manual.
      A leitura acontece neste navegador.</p>
    </div></div>`;
  // cada item da fila é uma folha: uma imagem ou uma página de PDF
  const pegar = async files => {
    const fila = [];
    for (const f of files) {
      if (ehPdf(f)) {
        $('#rbDrop h1').textContent = `Abrindo ${f.name}…`;
        try {
          const doc = await abrirPdf(f);
          for (let p = 1; p <= doc.numPages; p++) fila.push({ file: f, pagina: p, paginas: doc.numPages });
        } catch (e) { alert(`Não foi possível abrir o PDF ${f.name}: ${e.message || e}`); }
      } else if (/^image\/(jpeg|png|webp)$/.test(f.type)) fila.push({ file: f, pagina: 0, paginas: 0 });
    }
    if (!fila.length) { $('#rbDrop h1').textContent = 'Escolha as fotos ou digitalizações das folhas'; return alert('Escolha imagens JPG, PNG, WEBP ou PDF.'); }
    RB.imp.fila = fila; RB.imp.i = 0; prepararFolha();
  };
  $('#rbFiles').addEventListener('change', e => pegar(e.target.files));
  RB.pegar = pegar;
  ocrWorker().catch(() => {}); // já começa a carregar o OCR
}

// ---------------------------------------------------------------- PDF (pdf.js, carregado sob demanda)
const ehPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const nomeItem = it => it.file.name + (it.paginas > 1 ? ` · pág. ${it.pagina} de ${it.paginas}` : '');
const pdfDocs = new WeakMap();
async function abrirPdf(file) {
  if (pdfDocs.has(file)) return pdfDocs.get(file);
  if (typeof pdfjsLib === 'undefined') {
    await carregarScript('vendor/pdfjs/pdf.min.js');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
  }
  const p = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  pdfDocs.set(file, p);
  return p;
}
// renderiza a página com ~3000 px no lado maior (digitalizações costumam vir a 150–300 dpi)
async function renderizarPagina(file, n) {
  const doc = await abrirPdf(file), pg = await doc.getPage(n);
  const v1 = pg.getViewport({ scale: 1 });
  const vp = pg.getViewport({ scale: Math.min(6, 3000 / Math.max(v1.width, v1.height)) });
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: ctx, viewport: vp }).promise;
  return c;
}

async function carregarImagem(it) {
  if (it.pagina) return renderizarPagina(it.file, it.pagina);
  const url = URL.createObjectURL(it.file);
  try {
    const im = new Image(); im.src = url; await im.decode();
    const k = Math.min(1, 3600 / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}

// escolhe a rotação: linhas da tabela na horizontal e cabeçalho em cima (pelas larguras das colunas)
function escolherGiro(img, cantos) {
  const pesos = COLS.map(c => c.peso);
  let melhor = null;
  for (const giro of [0, 1, 2, 3]) {
    const R = RecebOCR.retificar(img, cantos, giro, 900, 1);
    if (!R) continue;
    const G = RecebOCR.analisarGrade(R);
    const s = (G.rows.length > G.cols.length ? 100 : 0) + (G.cols.length - 1 === COLS.length ? 10 : 0) + RecebOCR.scoreLarguras(G.cols, pesos);
    if (!melhor || s > melhor.s) melhor = { giro, s };
  }
  return melhor ? melhor.giro : 0;
}

async function prepararFolha() {
  const imp = RB.imp, el = $('#mod-receb'), it = imp.fila[imp.i], file = it.file;
  el.innerHTML = `<div class="panel">Abrindo ${esc(nomeItem(it))}...</div>`;
  let canvas;
  try { canvas = await carregarImagem(it); } catch { el.innerHTML = `<div class="panel"><p class="err">Não foi possível abrir ${esc(nomeItem(it))}.</p>${imp.i + 1 < imp.fila.length ? '<button class="btn" id="rbPular2">Próxima folha</button> ' : ''}<a class="btn ghost" href="#receb">Voltar</a></div>`; if ($('#rbPular2')) $('#rbPular2').addEventListener('click', proximaFolha); return; }
  await new Promise(r => setTimeout(r, 20));
  const img = RecebOCR.cinza(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  const auto = RecebOCR.detectarCantos(img);
  const m = 0.06;
  const cantos = auto || [[img.w * m, img.h * m], [img.w * (1 - m), img.h * m], [img.w * (1 - m), img.h * (1 - m)], [img.w * m, img.h * (1 - m)]];
  imp.atual = { file, pagina: it.pagina, paginas: it.paginas, nome: nomeItem(it), canvas, img, cantos, auto: !!auto, giro: auto ? escolherGiro(img, cantos) : 0 };
  renderAjuste();
}

function renderAjuste() {
  const imp = RB.imp, A = imp.atual, el = $('#mod-receb');
  el.innerHTML = `<div class="panel">
    <div class="ld-bar"><div><a href="#receb" class="btn small ghost">← Recebimentos</a>
      <b class="ld-title">Folha ${imp.i + 1} de ${imp.fila.length}</b><small>${esc(A.nome)}</small></div>
      <div class="filters" style="margin:0">
        ${imp.fila.length > 1 ? '<button class="btn ghost small" id="rbPular">Pular esta folha</button>' : ''}
        <button class="btn ghost" id="rbGirar" title="Gira a orientação da tabela em 90°">Girar 90°</button>
        <button class="btn ghost" id="rbRedet">Detectar de novo</button>
        <button class="btn" id="rbLer">Ler folha (OCR)</button></div></div>
    ${A.auto ? '' : '<p class="note">Não encontrei a tabela automaticamente. Arraste os 4 cantos até os cantos da tabela.</p>'}
    <p class="muted">Confira se os 4 cantos estão nos cantos externos da tabela (arraste para ajustar). À direita, a folha corrigida:
      <span style="color:var(--ok)">verde</span> = célula vazia, <span style="color:var(--bad)">vermelho</span> = célula com escrita (vai para o OCR).
      O cabeçalho (${COLS.map(c => esc(c.rotulo)).join(', ')}) deve ficar em cima; se não estiver, use <b>Girar 90°</b>.</p>
    <div class="rb-ajuste">
      <div class="rb-foto" id="rbFoto"><canvas id="rbCv"></canvas></div>
      <div class="rb-prev"><canvas id="rbPrev"></canvas><p id="rbInfo" class="muted"></p></div>
    </div></div>`;
  const cv = $('#rbCv'), box = $('#rbFoto');
  const escala = Math.min(1, Math.min(box.clientWidth || 600, 900) / A.canvas.width, 760 / A.canvas.height);
  cv.width = Math.round(A.canvas.width * escala); cv.height = Math.round(A.canvas.height * escala);
  const ctx = cv.getContext('2d');
  const desenhar = () => {
    ctx.drawImage(A.canvas, 0, 0, cv.width, cv.height);
    const p = RecebOCR.cantosGirados(A.cantos, A.giro).map(([x, y]) => [x * escala, y * escala]);
    ctx.lineWidth = 2; ctx.strokeStyle = '#2357d6'; ctx.fillStyle = 'rgba(35,87,214,.10)';
    ctx.beginPath(); p.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fill(); ctx.stroke();
    // lado do cabeçalho em destaque
    ctx.strokeStyle = '#d97706'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(...p[0]); ctx.lineTo(...p[1]); ctx.stroke();
    p.forEach(([x, y], i) => {
      ctx.fillStyle = i === 0 ? '#d97706' : '#2357d6';
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), x, y);
    });
  };
  const previa = () => {
    const R = RecebOCR.retificar(A.img, A.cantos, A.giro);
    if (!R) { $('#rbInfo').textContent = 'Cantos inválidos.'; return; }
    const G = RecebOCR.analisarGrade(R);
    A.R = R; A.G = G;
    const pv = $('#rbPrev'); pv.width = R.w; pv.height = R.h;
    const px = pv.getContext('2d'), id = px.createImageData(R.w, R.h);
    for (let i = 0; i < R.g.length; i++) { const v = R.g[i]; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
    px.putImageData(id, 0, 0);
    let cheias = 0;
    const lw = Math.max(2, Math.round(R.w / 700));
    for (let r = 0; r + 1 < G.rows.length; r++) for (let c = 0; c + 1 < G.cols.length; c++) {
      const q = RecebOCR.celula(G, r, c), t = RecebOCR.tinta(G, R, q), cheia = RecebOCR.temConteudo(t);
      if (cheia && !(FOLHA_MODELO.cabecalho && r === 0)) cheias++;
      px.lineWidth = lw; px.strokeStyle = FOLHA_MODELO.cabecalho && r === 0 ? 'rgba(217,119,6,.9)' : cheia ? 'rgba(192,38,45,.9)' : 'rgba(24,121,78,.55)';
      px.strokeRect(q.x, q.y, q.w, q.h);
    }
    const nLin = G.rows.length - 1 - (FOLHA_MODELO.cabecalho ? 1 : 0), nCol = G.cols.length - 1;
    $('#rbInfo').innerHTML = `${nLin} linhas × ${nCol} colunas · ${cheias} células com escrita` +
      (nCol !== COLS.length ? ` <span class="badge bad">esperado ${COLS.length} colunas — ajuste os cantos ou gire</span>` : '');
    $('#rbLer').disabled = nCol < 1 || nLin < 1;
  };
  // arrastar cantos
  let arr = -1;
  const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width / escala, (e.clientY - r.top) * cv.height / r.height / escala]; };
  cv.addEventListener('pointerdown', e => {
    const [x, y] = pos(e);
    let best = -1, bd = 30 / escala;
    A.cantos.forEach(([cx, cy], i) => { const d = Math.hypot(cx - x, cy - y); if (d < bd) { bd = d; best = i; } });
    if (best >= 0) { arr = best; cv.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  cv.addEventListener('pointermove', e => {
    if (arr < 0) return;
    const [x, y] = pos(e);
    A.cantos[arr] = [Math.max(0, Math.min(A.img.w - 1, x)), Math.max(0, Math.min(A.img.h - 1, y))];
    desenhar();
  });
  cv.addEventListener('pointerup', () => { if (arr >= 0) { arr = -1; previa(); } });
  $('#rbGirar').addEventListener('click', () => { A.giro = (A.giro + 1) % 4; desenhar(); previa(); });
  $('#rbRedet').addEventListener('click', () => {
    const c = RecebOCR.detectarCantos(A.img);
    if (!c) return alert('Não encontrei a tabela. Ajuste os cantos manualmente.');
    A.cantos = c; A.auto = true; A.giro = escolherGiro(A.img, c); desenhar(); previa();
  });
  if ($('#rbPular')) $('#rbPular').addEventListener('click', proximaFolha);
  $('#rbLer').addEventListener('click', () => lerFolha());
  desenhar(); previa();
}

function proximaFolha() {
  const imp = RB.imp;
  if (!imp) return;
  imp.i++;
  if (imp.i < imp.fila.length) prepararFolha();
  else { RB.imp = null; location.hash = 'receb'; }
}

// recorte de uma área da imagem retificada, com contraste esticado, num canvas (para o OCR ou para exibir)
function recorte(R, q, alturaAlvo, contraste = true) {
  const k = alturaAlvo ? Math.max(1, Math.min(4, alturaAlvo / q.h)) : 1, pad = alturaAlvo ? 12 : 0;
  const c = document.createElement('canvas');
  c.width = Math.round(q.w * k) + pad * 2; c.height = Math.round(q.h * k) + pad * 2;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  const src = document.createElement('canvas'); src.width = q.w; src.height = q.h;
  const sx = src.getContext('2d'), id = sx.createImageData(q.w, q.h);
  let lo = 255, hist = new Uint32Array(256);
  for (let y = 0; y < q.h; y++) for (let xx = 0; xx < q.w; xx++) { const v = R.g[(q.y + y) * R.w + q.x + xx]; hist[v]++; if (v < lo) lo = v; }
  let acc = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= q.w * q.h * 0.6) { hi = v; break; } }
  const amp = Math.max(1, hi - lo);
  for (let y = 0; y < q.h; y++) for (let xx = 0; xx < q.w; xx++) {
    let v = R.g[(q.y + y) * R.w + q.x + xx];
    if (contraste) v = Math.max(0, Math.min(255, (v - lo) * 255 / amp));
    const o = (y * q.w + xx) * 4; id.data[o] = id.data[o + 1] = id.data[o + 2] = v; id.data[o + 3] = 255;
  }
  sx.putImageData(id, 0, 0);
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, pad, pad, c.width - pad * 2, c.height - pad * 2);
  return c;
}

async function lerFolha() {
  const A = RB.imp.atual, R = A.R, G = A.G, el = $('#mod-receb');
  const nCol = Math.min(COLS.length, G.cols.length - 1), r0 = FOLHA_MODELO.cabecalho ? 1 : 0;
  // células a ler, agrupadas por coluna (troca os parâmetros do OCR uma vez por coluna)
  // linha com escrita em qualquer coluna (inclusive só nome/assinatura) entra na conferência
  const tarefas = [], comEscrita = new Set();
  for (let c = 0; c < nCol; c++) for (let r = r0; r + 1 < G.rows.length; r++) {
    const q = RecebOCR.celula(G, r, c), t = RecebOCR.tinta(G, R, q);
    if (!RecebOCR.temConteudo(t)) continue;
    comEscrita.add(r);
    if (COLS[c].ler) tarefas.push({ r, c, q, t });
  }
  RB.imp.atual.comEscrita = comEscrita;
  el.innerHTML = `<div class="panel"><h2>Lendo a folha…</h2>
    <p id="rbSt" class="muted">Carregando o OCR (na primeira vez pode levar alguns segundos)…</p>
    <div class="vol-bar" style="max-width:520px"><div id="rbBar" style="width:0%"></div></div>
    <p><button class="btn ghost small" id="rbCancel">Cancelar</button></p></div>`;
  let cancelado = false;
  $('#rbCancel').addEventListener('click', () => { cancelado = true; renderAjuste(); });
  let w;
  try {
    w = await ocrWorker(m => { if (m.status && $('#rbSt') && !tarefas.feitas) $('#rbSt').textContent = `Carregando o OCR: ${m.status} ${m.progress ? Math.round(m.progress * 100) + '%' : ''}`; });
  } catch (e) {
    el.innerHTML = `<div class="panel"><p class="err">Não foi possível iniciar o OCR: ${esc(e.message)}</p><p>Você ainda pode digitar os dados manualmente.</p><button class="btn" id="rbMan">Preencher manualmente</button></div>`;
    $('#rbMan').addEventListener('click', () => montarRevisao({}));
    if (!tarefas.length) return;
    return;
  }
  const lidos = {};
  let colAtual = -1;
  tarefas.feitas = 0;
  for (const tk of tarefas) {
    if (cancelado) return;
    if (tk.c !== colAtual) {
      colAtual = tk.c;
      await w.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: COLS[tk.c].wl, preserve_interword_spaces: '1' });
    }
    // recorta só a área escrita (com folga) para tirar sobras das linhas da grade
    const cx = tk.t.caixa, f = 6;
    const q = { x: Math.max(tk.q.x, cx.x - f), y: Math.max(tk.q.y, cx.y - f) };
    q.w = Math.min(tk.q.x + tk.q.w, cx.x + cx.w + f) - q.x; q.h = Math.min(tk.q.y + tk.q.h, cx.y + cx.h + f) - q.y;
    let texto = '', conf = 0;
    try {
      const { data } = await w.recognize(recorte(R, q, 64));
      texto = (data.text || '').trim(); conf = Math.round(data.confidence || 0);
    } catch { /* célula fica vazia para digitar */ }
    (lidos[tk.r] = lidos[tk.r] || {})[COLS[tk.c].k] = { texto, conf };
    tarefas.feitas++;
    if ($('#rbBar')) { $('#rbBar').style.width = Math.round(tarefas.feitas / tarefas.length * 100) + '%'; $('#rbSt').textContent = `Lendo célula ${tarefas.feitas} de ${tarefas.length}…`; }
  }
  if (!cancelado) montarRevisao(lidos);
}

function montarRevisao(lidos) {
  const A = RB.imp.atual, R = A.R, G = A.G, r0 = FOLHA_MODELO.cabecalho ? 1 : 0;
  const anoPadrao = new Date().getFullYear();
  const linhas = [];
  for (let r = r0; r + 1 < G.rows.length; r++) {
    const L = lidos[r] || {};
    if (!lidos[r] && !(A.comEscrita && A.comEscrita.has(r))) continue;
    const l = { n: r - r0 + 1, revisado: false, escrita: true, conf: {}, dataIso: '' };
    l.dica = {};
    for (const c of CAMPOS) {
      const v = L[c.k];
      l[c.k] = '';
      if (!v) continue;
      l.conf[c.k] = v.conf;
      if (c.k === 'data') {
        const d = RecebOCR.limparData(v.texto, anoPadrao);
        // leitura ruim e inválida: melhor vazio (com a leitura como dica) do que lixo no campo
        if (!d.ok && v.conf < 50) { l.dica.data = { tipo: 'incerto', texto: v.texto.trim() }; continue; }
        l.data = d.valor; l.dataIso = d.iso;
        continue;
      }
      const t = RecebOCR.limparTexto(v.texto).toUpperCase();
      // compara com o que já foi cadastrado (cursiva costuma sair "parecida")
      const sug = t && RecebOCR.sugerir(t, (RB.vocab && RB.vocab[c.k]) || [], c.k === 'selb' ? 0.8 : 0.7);
      if (sug && RecebOCR.normalizar(sug.valor) !== RecebOCR.normalizar(t)) { l[c.k] = sug.valor; l.dica[c.k] = { tipo: 'lista', texto: t, sim: sug.sim }; }
      else if (sug) l[c.k] = sug.valor;
      else if (v.conf < 40) l.dica[c.k] = { tipo: 'incerto', texto: t };
      else l[c.k] = t;
    }
    linhas.push(l);
  }
  // recorte de cada linha (para conferir lado a lado)
  const imgs = {};
  for (let r = r0; r + 1 < G.rows.length; r++) {
    const y0 = Math.max(0, G.rows[r] - 4), y1 = Math.min(R.h, G.rows[r + 1] + 4);
    imgs[r - r0 + 1] = recorte(R, { x: 0, y: y0, w: R.w, h: y1 - y0 }, 0, false).toDataURL('image/jpeg', 0.75);
  }
  const datas = linhas.map(l => l.dataIso).filter(Boolean).sort();
  const folha = {
    titulo: A.file.name.replace(/\.[^.]+$/, '') + (A.paginas > 1 ? ` – pág. ${A.pagina}` : ''), obs: '', dataFolha: datas.length ? datas[datas.length - 1] : '',
    linhas, grade: { w: R.w, h: R.h, linhas: G.rows.slice(r0), colunas: G.cols },
  };
  RB.cur = folha; RB.dirty = true;
  renderFolhaEditor(folha, imgs, { nova: true, nLinhas: G.rows.length - 1 - r0, fotoOriginal: URL.createObjectURL(A.file) + (A.pagina ? '#page=' + A.pagina : '') });
}

// ================================================================== editor (nova folha ou existente)
function renderFolhaEditor(F, imgs, opt = {}) {
  const el = $('#mod-receb');
  const imp = RB.imp;
  el.innerHTML = `
    <div class="panel ld-bar">
      <div>${opt.nova ? '<a href="#receb" class="btn small ghost">← Recebimentos</a>' : '<a href="#receb" class="btn small ghost">← Recebimentos</a>'}
        <b class="ld-title">${opt.nova ? `Conferir folha${imp && imp.fila.length > 1 ? ` ${imp.i + 1} de ${imp.fila.length}` : ''}` : esc(F.titulo || F.id)}</b>
        ${opt.nova ? '<span class="badge warn">ainda não salva</span>' : `<small class="mono">${esc(F.id)} · rev. ${F.revisao}</small>`}</div>
      <div class="filters" style="margin:0">
        ${opt.nova ? '<button class="btn ghost" id="rbVoltarAj">Ajustar cantos</button>' : `<button class="btn ghost small" id="rbExcluir">Excluir folha</button>`}${opt.fotoOriginal ? `<a class="btn ghost small" href="${opt.fotoOriginal}" target="_blank" rel="noopener">${/#page=/.test(opt.fotoOriginal) ? 'PDF original' : 'Foto original'}</a>` : ''}
        <button class="btn ghost" id="rbTodas">Marcar todas como conferidas</button>
        <button class="btn" id="rbSalvar">${opt.nova ? 'Salvar folha' : 'Salvar'}</button></div>
    </div>
    <div class="panel">
      <div class="rep-grid">
        <label>Identificação da folha <input id="rbTit" value="${esc(F.titulo)}" maxlength="160" placeholder="ex.: Entrega notebooks lote 3"></label>
        <label>Data da folha <input type="date" id="rbData" value="${esc(F.dataFolha)}"></label>
        <label class="full">Observações <textarea id="rbObs" rows="2" maxlength="2000">${esc(F.obs)}</textarea></label>
      </div>
      ${opt.nova ? `<p class="note info">${F.linhas.length} linha(s) com escrita de ${opt.nLinhas}. O OCR leu ${CAMPOS.map(c => c.rotulo).join(', ')}: confira com a foto da linha e corrija o que for preciso.
        ${esc(NA_IMAGEM)} não são digitados: ficam na foto da folha. Campos em <span class="bad-txt">vermelho</span> têm baixa confiança ou formato inválido.</p>` : ''}
    </div>
    <div class="panel"><div class="head-row"><h2>Linhas</h2><div class="filters" style="margin:0">
        <button class="btn ghost small" id="rbDatas" title="Usa a data da folha nas linhas sem data">Preencher datas vazias</button>
        <button class="btn ghost small" id="rbAdd">Adicionar linha</button></div></div>
      <div id="rbLinhas" class="rb-linhas"></div>
      <datalist id="rbDlLocal"></datalist><datalist id="rbDlSelb"></datalist></div>`;
  const opcoes = k => [...new Set([...F.linhas.map(l => l[k]).filter(Boolean), ...((RB.vocab && RB.vocab[k]) || [])])].slice(0, 500).map(v => `<option value="${esc(v)}">`).join('');
  const listas = () => { $('#rbDlLocal').innerHTML = opcoes('local'); $('#rbDlSelb').innerHTML = opcoes('selb'); };
  if (!RB.vocab) carregarVocab().then(listas).catch(() => {});
  const marcarSujo = () => { RB.dirty = true; };
  const desenhar = () => {
    const box = $('#rbLinhas');
    if (!F.linhas.length) { box.innerHTML = '<p class="muted">Nenhuma linha preenchida. Use "Adicionar linha" para digitar.</p>'; return; }
    F.linhas.sort((a, b) => a.n - b.n);
    box.innerHTML = F.linhas.map((l, i) => {
      const campo = c => {
        const v = l[c.k] || '', conf = l.conf && l.conf[c.k], dica = l.dica && l.dica[c.k];
        const ruim = (c.k === 'data' && v && !dataOk(v)) || (conf != null && conf < 60 && !l.revisado) || (dica && !l.revisado);
        const lista = c.k === 'local' ? 'rbDlLocal' : c.k === 'selb' ? 'rbDlSelb' : '';
        const txtDica = !dica ? '' : dica.tipo === 'lista'
          ? `OCR leu “${esc(dica.texto)}” → corrigido pela lista <button type="button" class="linklike" data-usar="${i}" data-k="${c.k}">usar “${esc(dica.texto)}”</button>`
          : `ilegível para o OCR${dica.texto ? ` (leu “${esc(dica.texto)}”)` : ''}: digite olhando a foto`;
        return `<label class="rb-c rb-${c.k}">${esc(c.rotulo)}${conf != null ? ` <small title="confiança do OCR">${conf}%</small>` : ''}
          <input data-i="${i}" data-k="${c.k}" value="${esc(v)}" class="${ruim ? 'rb-ruim' : ''}" maxlength="${c.k === 'local' ? 160 : 40}" ${lista ? `list="${lista}"` : ''} ${c.k === 'data' ? 'placeholder="dd/mm/aaaa"' : ''} autocomplete="off">
          ${txtDica ? `<small class="rb-dica">${txtDica}</small>` : ''}</label>`;
      };
      const src = imgs && imgs[l.n];
      return `<div class="rb-linha ${l.revisado ? 'ok' : ''} ${opt.linha === l.n ? 'rb-alvo' : ''}" data-n="${l.n}">
        <div class="rb-lh"><b>Linha ${l.n}</b>
          <label class="chk"><input type="checkbox" data-rev="${i}" ${l.revisado ? 'checked' : ''}> conferida</label>
          <button class="btn ghost small" data-del="${i}">Remover</button></div>
        <div class="rb-campos">${CAMPOS.map(campo).join('')}</div>
        ${src ? `<figure class="rb-fig"><img class="rb-strip" src="${src}" alt="Foto da linha ${l.n}" title="Clique para ampliar">
          <figcaption>Foto da linha na folha${NA_IMAGEM ? ` (${esc(NA_IMAGEM)})` : ''} · clique para ampliar</figcaption></figure>` : ''}</div>`;
    }).join('');
    box.querySelectorAll('input[data-k]').forEach(inp => inp.addEventListener('input', () => {
      const l = F.linhas[+inp.dataset.i], k = inp.dataset.k;
      l[k] = inp.value; marcarSujo();
      if (l.conf) delete l.conf[k]; // corrigido à mão
      if (l.dica) delete l.dica[k];
      inp.classList.remove('rb-ruim');
      if (k === 'data') { const d = RecebOCR.limparData(inp.value); l.dataIso = d.iso; inp.classList.toggle('rb-ruim', !!inp.value && !d.ok); }
    }));
    // Enter vai para o próximo campo (digitação rápida)
    const todos = [...box.querySelectorAll('input[data-k]')];
    todos.forEach((inp, j) => inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); (todos[j + 1] || inp).focus(); } }));
    box.querySelectorAll('[data-usar]').forEach(b => b.addEventListener('click', e => {
      e.preventDefault();
      const l = F.linhas[+b.dataset.usar], k = b.dataset.k;
      l[k] = l.dica[k].texto; delete l.dica[k]; marcarSujo(); desenhar();
    }));
    box.querySelectorAll('input[data-k="data"]').forEach(inp => inp.addEventListener('blur', () => {
      const d = RecebOCR.limparData(inp.value); if (d.ok) { inp.value = d.valor; F.linhas[+inp.dataset.i].data = d.valor; }
    }));
    box.querySelectorAll('.rb-strip').forEach(im => im.addEventListener('click', () => im.closest('.rb-fig').classList.toggle('zoom')));
    const alvo = opt.linha && box.querySelector(`.rb-linha[data-n="${opt.linha}"]`);
    if (alvo) { alvo.scrollIntoView({ block: 'center' }); opt.linha = 0; }
    box.querySelectorAll('[data-rev]').forEach(cb => cb.addEventListener('change', () => {
      F.linhas[+cb.dataset.rev].revisado = cb.checked; cb.closest('.rb-linha').classList.toggle('ok', cb.checked); marcarSujo();
    }));
    box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      if (!confirm('Remover esta linha?')) return;
      F.linhas.splice(+b.dataset.del, 1); marcarSujo(); desenhar();
    }));
  };
  $('#rbTit').addEventListener('input', e => { F.titulo = e.target.value; marcarSujo(); });
  $('#rbData').addEventListener('input', e => { F.dataFolha = e.target.value; marcarSujo(); });
  $('#rbObs').addEventListener('input', e => { F.obs = e.target.value; marcarSujo(); });
  $('#rbAdd').addEventListener('click', () => {
    const usados = new Set(F.linhas.map(l => l.n));
    let n = 1; while (usados.has(n)) n++;
    const novo = window.prompt('Número da linha na folha:', String(n));
    if (novo === null) return;
    F.linhas.push({ n: Math.max(1, parseInt(novo, 10) || n), revisado: false, conf: {}, selb: '', data: '', dataIso: '', local: '', escrita: true });
    marcarSujo(); desenhar();
  });
  $('#rbDatas').addEventListener('click', () => {
    if (!F.dataFolha) return alert('Preencha a "Data da folha" primeiro.');
    const d = RecebOCR.limparData(F.dataFolha.split('-').reverse().join('/'));
    let n = 0;
    F.linhas.forEach(l => { if (!l.data) { l.data = d.valor; l.dataIso = d.iso; if (l.dica) delete l.dica.data; n++; } });
    if (!n) return alert('Nenhuma linha sem data.');
    marcarSujo(); desenhar();
  });
  $('#rbTodas').addEventListener('click', () => { F.linhas.forEach(l => { l.revisado = true; }); marcarSujo(); desenhar(); });
  if ($('#rbVoltarAj')) $('#rbVoltarAj').addEventListener('click', () => { if (confirm('Voltar ao ajuste descarta as correções desta folha. Continuar?')) { RB.dirty = false; RB.cur = null; renderAjuste(); } });
  if ($('#rbExcluir')) $('#rbExcluir').addEventListener('click', async () => {
    if (!confirm('Excluir esta folha e seus registros? (o servidor guarda uma cópia para auditoria)')) return;
    const r = await api('api/recebimentos/' + F.id, { method: 'DELETE' }).catch(() => null);
    if (!r || !r.ok) return alert('Não foi possível excluir.');
    RB.dirty = false; RB.cur = null; location.hash = 'receb';
  });
  $('#rbSalvar').addEventListener('click', async e => {
    const btn = e.target; btn.disabled = true;
    try { opt.nova ? await salvarNova(F) : await salvarExistente(F); } finally { if (document.body.contains(btn)) btn.disabled = false; }
  });
  desenhar(); listas();
}

async function enviarAnexo(id, blob, nome, legenda) {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  const r = await api(`api/recebimentos/${id}/anexos`, { method: 'POST', body: u8, headers: {
    'Content-Type': blob.type, 'X-Nome': encodeURIComponent(nome), 'X-Legenda': encodeURIComponent(legenda), 'X-Sha256': await sha256Hex(u8) } }).catch(() => null);
  return !!(r && r.ok);
}

async function salvarNova(F) {
  const A = RB.imp.atual;
  const r = await api('api/recebimentos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(F) }).catch(() => null);
  if (!r || !r.ok) { const e = r ? (await r.json().catch(() => ({}))).erro : ''; return alert('Não foi possível salvar: ' + (e || 'servidor indisponível.')); }
  const salvo = await r.json();
  // imagem retificada (usada para mostrar os recortes das linhas) + foto original
  const ret = recorte(A.R, { x: 0, y: 0, w: A.R.w, h: A.R.h }, 0, false);
  const blobRet = await new Promise(ok => ret.toBlob(ok, 'image/jpeg', 0.82));
  const okRet = await enviarAnexo(salvo.id, blobRet, 'folha-retificada.jpg', 'Folha retificada');
  // PDF: guarda o arquivo inteiro e a página da folha na legenda
  const legOrig = A.pagina ? `Arquivo original (pág. ${A.pagina}${A.paginas > 1 ? ` de ${A.paginas}` : ''})` : 'Foto original';
  const arq = A.pagina && !A.file.type ? new Blob([A.file], { type: 'application/pdf' }) : A.file;
  const okOrig = A.file.size <= 25 * 1048576 ? await enviarAnexo(salvo.id, arq, A.file.name, legOrig) : false;
  if (!okRet || !okOrig) alert('A folha foi salva, mas ' + (!okRet ? 'a imagem retificada' : 'a foto original') + ' não foi enviada (tamanho ou conexão).');
  RB.dirty = false; RB.cur = null;
  if (RB.imp && RB.imp.i + 1 < RB.imp.fila.length) proximaFolha();
  else { RB.imp = null; location.hash = 'receb/' + salvo.id; }
}

async function salvarExistente(F) {
  const r = await api('api/recebimentos/' + F.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(F) }).catch(() => null);
  if (!r || !r.ok) { const e = r ? (await r.json().catch(() => ({}))).erro : ''; return alert('Não foi possível salvar: ' + (e || 'servidor indisponível.')); }
  const novo = await r.json();
  Object.assign(F, { revisao: novo.revisao, atualizadoEm: novo.atualizadoEm });
  RB.dirty = false;
  const t = document.querySelector('#mod-receb .ld-bar small.mono'); if (t) t.textContent = `${F.id} · rev. ${F.revisao} · salvo`;
}

async function abrirFolha(id, linha = 0) {
  const el = $('#mod-receb');
  el.innerHTML = '<div class="panel">Carregando...</div>';
  if (!(await needServer(el))) return;
  const r = await api('api/recebimentos/' + encodeURIComponent(id)).catch(() => null);
  if (!r || !r.ok) { el.innerHTML = '<div class="panel"><p>Folha não encontrada.</p><a class="btn small ghost" href="#receb">Voltar</a></div>'; return; }
  const F = await r.json();
  RB.cur = F; RB.dirty = false;
  const anx = await api(`api/recebimentos/${F.id}/anexos`).then(x => x.ok ? x.json() : []).catch(() => []);
  const url = a => `api/recebimentos/${F.id}/anexos/${a.aid}${srv.token ? '?token=' + encodeURIComponent(srv.token) : ''}`;
  const ret = anx.find(a => a.legenda === 'Folha retificada'), orig = anx.find(a => /^(Foto|Arquivo) original/.test(a.legenda));
  const pag = orig && (orig.legenda.match(/pág\. (\d+)/) || [])[1];
  const imgs = {};
  if (ret && F.grade && F.grade.linhas.length > 1) {
    try {
      const b = await api(url(ret)).then(x => x.blob());
      const u = URL.createObjectURL(b), im = new Image(); im.src = u; await im.decode();
      const k = im.naturalHeight / (F.grade.h || im.naturalHeight), L = F.grade.linhas;
      for (let n = 1; n < L.length; n++) {
        const y0 = Math.max(0, (L[n - 1] - 4) * k), y1 = Math.min(im.naturalHeight, (L[n] + 4) * k);
        const c = document.createElement('canvas'); c.width = Math.min(1400, im.naturalWidth); c.height = Math.max(1, Math.round((y1 - y0) * c.width / im.naturalWidth));
        c.getContext('2d').drawImage(im, 0, y0, im.naturalWidth, y1 - y0, 0, 0, c.width, c.height);
        imgs[n] = c.toDataURL('image/jpeg', 0.75);
      }
      URL.revokeObjectURL(u);
    } catch { /* sem recortes */ }
  }
  renderFolhaEditor(F, imgs, { fotoOriginal: orig ? url(orig) + (pag ? '#page=' + pag : '') : '', linha });
}

// arrastar imagens para a tela de importação (chamado pelo tratador de "soltar" do app.js)
function recebSoltar(files) {
  if ($('#mod-receb').hidden || !$('#rbDrop') || !RB.pegar) return false;
  RB.pegar(files); return true;
}

window.addEventListener('beforeunload', e => { if (RB.dirty) { e.preventDefault(); e.returnValue = ''; } });

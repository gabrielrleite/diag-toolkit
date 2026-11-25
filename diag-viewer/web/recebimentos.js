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
    { k: 'selb', rotulo: 'SELB', peso: 198, ler: true, wl: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/., ;+' },
    { k: 'data', rotulo: 'Data', peso: 254, ler: true, wl: '0123456789/.-' },
    { k: 'local', rotulo: 'Local', peso: 786, ler: true, wl: '' },
    { k: 'cpf', rotulo: 'CPF', peso: 340, ler: false },
    { k: 'nome', rotulo: 'Nome', peso: 616, ler: false },
  ],
  cabecalho: true, // primeira linha da grade é o cabeçalho
};
const RB = { folhas: [], q: '', fSelb: '', fLocal: '', cur: null, dirty: false, imp: null, worker: null, carregandoOcr: null, selbsCad: new Map() };

// ---------------------------------------------------------------- itens entregues (suprimentos de impressoras)
// cada SELB é uma impressora/scanner; numa entrega vão tintas/toners por cor e caixa de manutenção
const ITENS = { preto: 'Preto', azul: 'Azul (ciano)', magenta: 'Magenta', amarelo: 'Amarelo', caixa: 'Caixa de manutenção' };
const ITENS_CURTO = { preto: 'P', azul: 'A', magenta: 'M', amarelo: 'Am', caixa: 'Caixa' };
const SUPRIMENTO_TXT = { tinta: 'tinta', toner: 'toner', nenhum: 'sem suprimento' };
const TIPO_EQUIP_TXT = { impressora: 'Impressora', multifuncional: 'Multifuncional', scanner: 'Scanner', outro: 'Outro' };
const cadSelb = selb => RB.selbsCad.get(RecebOCR.chaveSelb(selb)) || null;
// toda impressora usa caixa de manutenção; scanner (sem suprimento) não
const usaCaixa = c => !c || (c.tipo !== 'scanner' && c.suprimento !== 'nenhum');
const ipValido = ip => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip) && ip.split('.').every(n => +n <= 255);
// suprimentos que o SELB usa (pelo cadastro; sem cadastro, todas as opções)
function suprimentosDe(selb) {
  const c = cadSelb(selb);
  if (!c) return ['preto', 'azul', 'magenta', 'amarelo', 'caixa'];
  return [...c.cores, ...(usaCaixa(c) ? ['caixa'] : [])];
}
const nomeSuprimento = (item, tipo) => item === 'caixa' ? ITENS.caixa : `${tipo === 'toner' ? 'Toner' : 'Tinta'} ${ITENS[item].toLowerCase()}`;
const resumoEquip = (c, comIp = true) => !c ? '' : [TIPO_EQUIP_TXT[c.tipo], [c.marca, c.modelo].filter(Boolean).join(' '), c.suprimento === 'nenhum' ? '' : c.cor === 'pb' ? 'preto' : 'colorida', SUPRIMENTO_TXT[c.suprimento], comIp && c.ip ? 'IP ' + c.ip : ''].filter(Boolean).join(' · ');
// bolinhas coloridas com quantidade (lista, aba SELBs)
function itensHtml(itens, porSelb = true) {
  if (!itens || !itens.length) return '<span class="muted">—</span>';
  const bola = it => `<span class="it-bola it-${it.item}" title="${esc(nomeSuprimento(it.item, it.tipo))}${it.qtd > 1 ? ' × ' + it.qtd : ''}">${it.item === 'caixa' ? IC('caixa') : ''}${it.qtd > 1 ? `<i>${it.qtd}</i>` : ''}</span>`;
  if (!porSelb) return `<span class="it-bolas">${itens.map(bola).join('')}</span>`;
  const g = new Map();
  for (const it of itens) (g.get(it.selb) || g.set(it.selb, []).get(it.selb)).push(it);
  return [...g.entries()].map(([sel, l]) => `<span class="it-grupo">${g.size > 1 ? `<small>${esc(sel)}</small>` : ''}<span class="it-bolas">${l.map(bola).join('')}</span></span>`).join('');
}
const itensTexto = itens => (itens || []).map(it => `${it.selb}: ${nomeSuprimento(it.item, it.tipo)}${it.qtd > 1 ? ' x' + it.qtd : ''}`).join('; ');
async function carregarSelbsCad() {
  const r = await api('api/receb-selbs').catch(() => null);
  const lista = r && r.ok ? await r.json() : [];
  RB.selbsCad = new Map(lista.map(c => [RecebOCR.chaveSelb(c.selb), c]));
  return lista;
}
const COLS = FOLHA_MODELO.colunas;
// o que aparece na tela e é digitado, na ordem de exibição
// SELB: uma entrega pode ter vários ("A123, A124")
const selbsDe = v => RecebOCR.separarSelbs(v);
const normSelbs = v => RecebOCR.juntarSelbs(selbsDe(String(v || '').toUpperCase()));
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
  if (arg && arg.split('~')[0] === 'selbs') return renderSelbs(arg.split('~').slice(1).join('~'));
  if (arg === 'treino') return renderTreino();
  if (arg === 'suprimentos') return renderSuprimentosResumo();
  if (arg && arg.split('~')[0] === 'impressoras') return renderImpressoras(arg.split('~').slice(1).join('~'));
  if (arg && arg.split('~')[0] === 'locais') return renderLocais(arg.split('~')[1] || '');
  if (arg) { const [fid, n] = arg.split('~'); return abrirFolha(fid, +n || 0); }
  RB.imp = null;
  el.innerHTML = abasReceb('entregas') + '<div class="panel">Carregando...</div>';
  if (!(await needServer(el))) return;
  const [r] = await Promise.all([api('api/recebimentos?linhas=1').catch(() => null), carregarLocais(), carregarSelbsCad()]);
  RB.folhas = r && r.ok ? await r.json() : [];
  const regs = RB.folhas.flatMap(f => f.linhas.map(l => ({ ...l, folha: f })));
  const pend = regs.filter(l => !l.revisado).length;
  el.innerHTML = abasReceb('entregas') + `
    <div class="panel">
      <div class="head-row"><h2>Folhas de recebimento</h2><a class="btn" href="#receb/importar">Importar folhas (OCR)</a></div>
      <div class="stats">
        ${statHtml(RB.folhas.length, 'folhas', 'arquivo', '')}
        ${statHtml(regs.length, 'recebimentos registrados', 'lista', 'violeta')}
        ${statHtml(regs.reduce((a, l) => a + selbsDe(l.selb).length, 0), 'SELBs entregues', 'tag', 'ok')}
        ${statHtml(regs.reduce((a, l) => a + (l.itens || []).reduce((b, it) => b + it.qtd, 0), 0), 'tintas, toners e caixas', 'caixa', 'violeta')}
        ${statHtml(pend, 'linhas não conferidas', 'alerta', pend ? 'bad' : '')}
      </div>
      ${!RB.folhas.length ? vazioHtml('caixa', 'Nenhuma folha ainda', 'Clique em "Importar folhas", escolha as fotos, digitalizações ou PDFs e confira o que o OCR leu.') : `
      <div class="tablewrap" style="max-height:34vh"><table class="clickable"><thead><tr><th class="nosort">Folha</th><th class="nosort">Data</th><th class="nosort">Linhas</th><th class="nosort">Conferência</th><th class="nosort">Importada em</th></tr></thead><tbody>
      ${RB.folhas.map(f => `<tr data-folha="${esc(f.id)}"><td><b>${esc(f.titulo || f.id)}</b><br><small class="mono">${esc(f.id)}</small></td>
        <td class="t">${f.dataFolha ? esc(f.dataFolha.split('-').reverse().join('/')) : '—'}</td><td>${f.total}</td>
        <td>${f.pendentes ? `<span class="badge warn">${f.pendentes} a conferir</span>` : '<span class="badge ok">conferida</span>'}</td>
        <td class="t">${fmt(new Date(f.criadoEm)).slice(0, 16)}</td></tr>`).join('')}
      </tbody></table></div>`}
    </div>
    ${regs.length ? `<div class="panel">
      <div class="head-row"><h2>Recebimentos</h2><button class="btn ghost small" id="rbCsv">Exportar CSV</button></div>
      <div class="filters">
        <label>SELB <input type="search" id="rbFSelb" value="${esc(RB.fSelb)}" list="rbDlFSelb" placeholder="todos" style="width:130px" autocomplete="off"></label>
        <label>Local <input type="search" id="rbFLocal" value="${esc(RB.fLocal)}" list="rbDlFLocal" placeholder="todos" style="min-width:220px" autocomplete="off"></label>
        <label>Buscar <input type="search" id="rbQ" value="${esc(RB.q)}" placeholder="data, folha..." style="min-width:180px"></label>
        <label class="chk"><input type="checkbox" id="rbPend"> só não conferidos</label>
        <button class="btn ghost small" id="rbLimpar">Limpar filtros</button><span class="muted" id="rbN"></span></div>
      <datalist id="rbDlFSelb">${[...new Set(regs.flatMap(l => selbsDe(l.selb)))].sort().map(v => `<option value="${esc(v)}">`).join('')}</datalist>
      <datalist id="rbDlFLocal">${[...new Set([...regs.map(l => l.local), ...regs.map(l => (principalDoLocal(l.local) || {}).nome)].filter(Boolean))].sort().map(v => `<option value="${esc(v)}">`).join('')}</datalist>
      <p class="muted" id="rbResumo" style="margin:0 0 8px"></p>
      <div id="rbRegs"></div></div>` : ''}`;
  el.querySelectorAll('[data-folha]').forEach(tr => tr.addEventListener('click', () => { location.hash = 'receb/' + tr.dataset.folha; }));
  if (!regs.length) return;
  let filtrados = regs;
  // filtros sem diferenciar acento/maiúscula; SELB ignora espaços e pontuação
  const N = RecebOCR.normalizar, chave = v => N(v).replace(/ /g, '');
  for (const l of regs) { l._busca = N([l.selb, l.data, l.local, l.folha.titulo].join(' ')); l._local = N(localComPrincipal(l.local)); }
  regs.sort((a, b) => String(b.dataIso || b.folha.criadoEm).localeCompare(String(a.dataIso || a.folha.criadoEm)) || a.n - b.n);
  const draw = () => {
    const q = N(RB.q), fs = chave(RB.fSelb), fl = N(RB.fLocal), so = $('#rbPend').checked;
    filtrados = regs.filter(l => (!so || !l.revisado) && (!fs || selbsDe(l.selb).some(x => chave(x).includes(fs))) && (!fl || l._local.includes(fl)) && (!q || l._busca.includes(q)));
    $('#rbN').textContent = `${filtrados.length} de ${regs.length}`;
    // resumo do filtro: por SELB mostra os locais por onde passou; por local, quantos SELB diferentes
    let resumo = '';
    if ((fs || fl) && filtrados.length) {
      const conta = k => { const m = new Map(); for (const l of filtrados) for (const v of k === 'selb' ? selbsDe(l.selb) : l[k] ? [l[k]] : []) m.set(v, (m.get(v) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
      const ult = filtrados[0];
      resumo = fs ? `${filtrados.length} entrega(s) · locais: ${conta('local').map(([v, n]) => `${esc(v)} (${n})`).join(', ') || '—'} · última: ${esc(ult.data || '—')} em ${esc(ult.local || '—')}`
        : `${filtrados.length} entrega(s) · ${conta('selb').length} SELB diferente(s)`;
    }
    $('#rbResumo').innerHTML = resumo;
    $('#rbRegs').innerHTML = `<div class="tablewrap"><table class="clickable"><thead><tr><th class="nosort">Local</th><th class="nosort">SELB</th><th class="nosort">Itens entregues</th><th class="nosort">Data</th><th class="nosort">Folha</th></tr></thead><tbody>
      ${filtrados.slice(0, 1000).map(l => `<tr data-folha="${esc(l.folha.id)}~${l.n}">
        <td>${l.local ? `<button class="linklike" data-filtro="local" data-v="${esc(l.local)}" title="${esc((localCadastrado(l.local) ? enderecoTxt(localCadastrado(l.local)) + ' — ' : '') + 'clique para filtrar por este local')}">${esc(l.local)}</button>${principalDoLocal(l.local) ? `<br><button class="linklike sub-principal" data-filtro="local" data-v="${esc(principalDoLocal(l.local).nome)}" title="Local principal: filtrar por ele e todas as salas">${IC('local')}${esc(principalDoLocal(l.local).nome)}</button>` : ''}` : '—'}</td>
        <td>${selbsDe(l.selb).map(x => `<button class="linklike" data-filtro="selb" data-v="${esc(x)}" title="Filtrar por este SELB">${esc(x)}</button>`).join(', ') || '—'}</td>
        <td>${itensHtml(l.itens)}</td>
        <td class="t">${esc(l.data || '—')}</td>
        <td><small>${esc(l.folha.titulo || l.folha.id)} · linha ${l.n}</small>${l.revisado ? '' : ' <span class="badge warn">conferir</span>'}</td></tr>`).join('')}
      </tbody></table></div>${filtrados.length > 1000 ? '<p class="muted">Mostrando os primeiros 1000. Refine a busca.</p>' : ''}`;
    $('#rbRegs').querySelectorAll('[data-folha]').forEach(tr => tr.addEventListener('click', () => { location.hash = 'receb/' + tr.dataset.folha; }));
    // clicar no SELB ou no local filtra por ele (em vez de abrir a folha)
    $('#rbRegs').querySelectorAll('[data-filtro]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      if (b.dataset.filtro === 'selb') { RB.fSelb = b.dataset.v; $('#rbFSelb').value = RB.fSelb; } else { RB.fLocal = b.dataset.v; $('#rbFLocal').value = RB.fLocal; }
      draw();
    }));
  };
  $('#rbQ').addEventListener('input', e => { RB.q = e.target.value; draw(); });
  $('#rbFSelb').addEventListener('input', e => { RB.fSelb = e.target.value; draw(); });
  $('#rbFLocal').addEventListener('input', e => { RB.fLocal = e.target.value; draw(); });
  $('#rbLimpar').addEventListener('click', () => { RB.q = RB.fSelb = RB.fLocal = ''; $('#rbQ').value = $('#rbFSelb').value = $('#rbFLocal').value = ''; $('#rbPend').checked = false; draw(); });
  $('#rbPend').addEventListener('change', draw);
  $('#rbCsv').addEventListener('click', () => {
    const cel = v => /[";\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const linhas = [['Local', 'SELB', 'Qtd SELB', 'Itens entregues', 'Qtd itens', 'Data', 'Folha', 'Linha', 'Conferido'].join(';'),
      ...filtrados.map(l => [l.local, l.selb, selbsDe(l.selb).length, itensTexto(l.itens), (l.itens || []).reduce((a, it) => a + it.qtd, 0), l.data, l.folha.titulo || l.folha.id, l.n, l.revisado ? 'sim' : 'não'].map(cel).join(';'))];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = `recebimentos${RB.fSelb ? '-selb-' + chave(RB.fSelb) : ''}-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
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
  const conta = k => { const m = new Map(); for (const f of RB.folhas) for (const l of f.linhas || []) for (const v of k === 'selb' ? selbsDe(l.selb) : l[k] ? [l[k]] : []) m.set(v, (m.get(v) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]); };
  // locais cadastrados vêm primeiro (nome oficial), depois os já usados nas folhas
  const cad = await carregarLocais().catch(() => []);
  RB.vocab = { local: [...new Set([...cad.map(L => L.nome), ...conta('local')])], selb: conta('selb') };
  // SELBs cadastrados também valem para o formato e o autocompletar
  await carregarSelbsCad().catch(() => {});
  RB.vocab.selb = [...new Set([...RB.vocab.selb, ...[...RB.selbsCad.values()].map(c => c.selb)])];
  RB.formatoSelb = RecebOCR.formatoSelb(RB.vocab.selb); // ex.: 1 letra + 4 dígitos
  // modo treinamento: regras aprendidas com as correções ("leitura X foi corrigida para Y")
  const tr = await api('api/treino').then(r => r.ok ? r.json() : null).catch(() => null);
  RB.treino = tr; RB.memoria = tr && tr.ativo ? tr.memoria : null;
}

// ---------------------------------------------------------------- local pelo histórico do SELB
const chaveSelb = v => RecebOCR.normalizar(v).replace(/ /g, '');
// última entrega registrada desse SELB (outras folhas + outras linhas desta folha) e quantas vezes o local se repete
function historicoSelb(selb, F, linhaAtual) {
  const meus = selbsDe(selb);
  if (!meus.length) return null;
  const casa = campo => meus.some(x => RecebOCR.temSelb(campo, x));
  const regs = [];
  for (const f of RB.folhas || []) {
    if (F.id && f.id === F.id) continue; // a folha aberta entra pelas linhas atuais (podem ter mudado)
    for (const l of f.linhas || []) if (l.local && casa(l.selb)) regs.push({ local: l.local, quando: l.dataIso || (f.criadoEm || '').slice(0, 10) });
  }
  for (const l of F.linhas || []) if (l !== linhaAtual && l.local && casa(l.selb) && !(l.dica && l.dica.local && l.dica.local.tipo === 'historico'))
    regs.push({ local: l.local, quando: l.dataIso || F.dataFolha || '9999' });
  if (!regs.length) return null;
  regs.sort((a, b) => String(b.quando).localeCompare(String(a.quando)));
  const ult = regs[0];
  return { local: ult.local, quando: ult.quando, vezes: regs.filter(r => RecebOCR.normalizar(r.local) === RecebOCR.normalizar(ult.local)).length };
}
// preenche o local pelo histórico quando ele está vazio ou a leitura é duvidosa; senão só sugere
function aplicarHistorico(l, F) {
  if (!l.selb) return;
  const h = historicoSelb(l.selb, F, l);
  l.dica = l.dica || {};
  const d = l.dica.local;
  if (d && (d.tipo === 'historico' || d.tipo === 'histSug')) { delete l.dica.local; if (d.tipo === 'historico') l.local = d.texto || ''; }
  if (!h || RecebOCR.normalizar(h.local) === RecebOCR.normalizar(l.local)) return;
  const conf = l.conf && l.conf.local;
  const duvidoso = !l.local || (d && (d.tipo === 'incerto' || d.tipo === 'lista')) || (conf != null && conf < 60);
  if (duvidoso) {
    const lido = d && d.tipo !== 'historico' && d.tipo !== 'histSug' ? d.texto : (d && d.tipo === 'historico' ? d.texto : l.local);
    l.dica.local = { tipo: 'historico', selb: l.selb, quando: h.quando, vezes: h.vezes, texto: lido || '' };
    l.local = h.local;
  } else l.dica.local = { tipo: 'histSug', selb: l.selb, quando: h.quando, vezes: h.vezes, valor: h.local };
}
const dataCurta = iso => /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.split('-').reverse().join('/') : '';

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
        <button class="btn ghost" id="rbManual" title="Sem tabela/OCR: digita as linhas olhando a imagem">Digitar manualmente</button>
        <label class="rb-motor" title="Onde o texto é lido">Leitura <select id="rbMotor">
          <option value="servidor">${MOTOR_TXT.servidor}</option><option value="navegador">${MOTOR_TXT.navegador}</option></select></label>
        <button class="btn" id="rbLer">Ler folha (OCR)</button></div></div>
    <p class="muted rb-motor-st" id="rbMotorSt"></p>
    ${A.auto ? '' : '<p class="note">Não encontrei a tabela automaticamente. Arraste os 4 cantos até os cantos da tabela ou use <b>Digitar manualmente</b> para lançar as linhas olhando a imagem.</p>'}
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
  // motor de leitura: servidor (TrOCR) quando estiver pronto; senão o navegador
  const selM = $('#rbMotor');
  A.motorEscolhido = A.motorEscolhido || motorPreferido();
  selM.value = A.motorEscolhido;
  selM.addEventListener('change', () => { A.motorEscolhido = selM.value; try { localStorage.setItem('diagOcrMotor', selM.value); } catch { /* só agora */ } mostrarEstadoMotor(); });
  const mostrarEstadoMotor = async () => {
    const st = await estadoOcrServidor();
    if (!$('#rbMotorSt')) return;
    const pronto = st.estado === 'pronto';
    selM.querySelector('option[value="servidor"]').textContent = MOTOR_TXT.servidor + (pronto ? '' : ` — ${ESTADO_OCR_TXT[st.estado] || st.estado}`);
    if (st.estado === 'desativado') { selM.querySelector('option[value="servidor"]').disabled = true; if (selM.value === 'servidor') { selM.value = 'navegador'; A.motorEscolhido = 'navegador'; } }
    $('#rbMotorSt').textContent = A.motorEscolhido === 'servidor' && !pronto
      ? `OCR do servidor ${ESTADO_OCR_TXT[st.estado] || st.estado}${st.detalhe ? ' (' + st.detalhe + ')' : ''}. Enquanto isso, a leitura usa o navegador.` : '';
    if (A.motorEscolhido === 'servidor' && !pronto && st.estado !== 'desativado') A.motorAguardando = setTimeout(mostrarEstadoMotor, 5000);
  };
  clearTimeout(A.motorAguardando);
  mostrarEstadoMotor();
  $('#rbManual').addEventListener('click', montarManual);
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

// ---------------------------------------------------------------- leitura de uma célula
// Versões da imagem da célula para o OCR:
//   cinza  : tons de cinza com contraste esticado (preserva traço fraco)
//   limpa  : só a tinta, preta sobre branco (tira sombra, granulado e sobras da grade)
//   grossa : "limpa" com o traço engrossado 1 px (caneta fina / letra corrida)
function imagemCelula(R, G, q, tipo, alturaAlvo) {
  if (tipo === 'cinza') return recorte(R, q, alturaAlvo);
  const m = RecebOCR.mascaraTinta(G, R, q);
  let t = m;
  if (tipo === 'grossa') {
    t = new Uint8Array(m.length);
    for (let y = 0; y < q.h; y++) for (let x = 0; x < q.w; x++) {
      if (!m[y * q.w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < q.h && xx >= 0 && xx < q.w) t[yy * q.w + xx] = 1;
      }
    }
  }
  const k = Math.max(1, Math.min(4, alturaAlvo / q.h)), pad = 14;
  const src = document.createElement('canvas'); src.width = q.w; src.height = q.h;
  const sx = src.getContext('2d'), id = sx.createImageData(q.w, q.h);
  for (let i = 0; i < t.length; i++) { const v = t[i] ? 0 : 255; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
  sx.putImageData(id, 0, 0);
  const c = document.createElement('canvas');
  c.width = Math.round(q.w * k) + pad * 2; c.height = Math.round(q.h * k) + pad * 2;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, pad, pad, c.width - pad * 2, c.height - pad * 2);
  return c;
}

// pontua uma leitura: confiança do OCR + bônus quando o texto "faz sentido" para a coluna
function pontuarLeitura(k, texto, conf) {
  const t = (texto || '').trim();
  if (!t) return -1;
  let p = conf;
  if (k === 'data') p += RecebOCR.limparData(t).ok ? 40 : -20;
  if (k === 'selb') {
    const itens = selbsDe(t.toUpperCase()).map(x => RecebOCR.ajustarAoFormato(x, RB.formatoSelb));
    if (itens.length && itens.every(x => /\d/.test(x) && x.replace(/[^A-Z0-9]/g, '').length >= 2)) p += 15;
    const voc = (RB.vocab && RB.vocab.selb) || [];
    if (itens.some(x => voc.some(v => RecebOCR.chaveSelb(v) === RecebOCR.chaveSelb(x)))) p += 25;
  }
  if (k === 'local') {
    const voc = (RB.vocab && RB.vocab.local) || [];
    const sg = voc.length && RecebOCR.sugerir(RecebOCR.limparTexto(t), voc, 0.7);
    if (sg) p += 25 * sg.sim;
    if (/[A-Za-zÀ-ú]{3}/.test(t)) p += 5;
  }
  return p;
}

// lê uma célula: modo "base" = uma imagem; "multi" = várias versões e fica com a melhor leitura
// (para cedo quando a primeira já é boa). Retorna { texto, conf, versao }.
async function lerCelula(w, R, G, tk, k, modo = 'multi') {
  const cx = tk.t.caixa, f = 6;
  const q = { x: Math.max(tk.q.x, cx.x - f), y: Math.max(tk.q.y, cx.y - f) };
  q.w = Math.min(tk.q.x + tk.q.w, cx.x + cx.w + f) - q.x; q.h = Math.min(tk.q.y + tk.q.h, cx.y + cx.h + f) - q.y;
  const versoes = modo === 'base' ? [['cinza', 64]] : [['cinza', 64], ['limpa', 56], ['grossa', 56]];
  let melhor = { texto: '', conf: 0, versao: '', p: -Infinity };
  for (const [tipo, alvo] of versoes) {
    let texto = '', conf = 0;
    try {
      const { data } = await w.recognize(imagemCelula(R, G, q, tipo, alvo));
      texto = (data.text || '').trim(); conf = Math.round(data.confidence || 0);
    } catch { continue; }
    const p = pontuarLeitura(k, texto, conf);
    if (p > melhor.p) melhor = { texto, conf, versao: tipo, p };
    // primeira leitura já confiável e coerente: não precisa das outras versões
    if (modo !== 'base' && conf >= 88 && p >= conf) break;
  }
  return { texto: melhor.texto, conf: melhor.conf, versao: melhor.versao };
}

// SELB que já tem cara de código completo (pelo formato aprendido; sem ele, letras + 2+ dígitos)
const selbBemFormado = x => RB.formatoSelb
  ? new RegExp(`^[A-Z]{${RB.formatoSelb.letras}}\\d{${RB.formatoSelb.digitos}}$`).test(RecebOCR.chaveSelb(x))
  : /^[A-Z]{0,4}\d{2,}$/.test(RecebOCR.chaveSelb(x));

// ---------------------------------------------------------------- motor de leitura
// "servidor": TrOCR (manuscrito) no serviço diag-ocr do container; "navegador": Tesseract.
// Preferência guardada no navegador; sem servidor pronto, usa o navegador.
const MOTOR_TXT = { servidor: 'Servidor (TrOCR, manuscrito)', navegador: 'Navegador (Tesseract)' };
function motorPreferido() { try { return localStorage.getItem('diagOcrMotor') || 'servidor'; } catch { return 'servidor'; } }
async function estadoOcrServidor() {
  const r = await api('api/ocr/saude').catch(() => null);
  return r && r.ok ? r.json() : { estado: 'indisponivel' };
}
const ESTADO_OCR_TXT = {
  pronto: 'pronto', baixando: 'baixando o modelo (só na 1ª vez)', carregando: 'carregando o modelo', iniciando: 'iniciando',
  erro: 'com erro', indisponivel: 'indisponível', desativado: 'não instalado neste servidor',
};

// recorte pequeno da célula (para o OCR do servidor e para o treinamento)
function recorteCelula(R, tk, altura) {
  const cx = tk.t.caixa, f = 6;
  const q = { x: Math.max(tk.q.x, cx.x - f), y: Math.max(tk.q.y, cx.y - f) };
  q.w = Math.min(tk.q.x + tk.q.w, cx.x + cx.w + f) - q.x; q.h = Math.min(tk.q.y + tk.q.h, cx.y + cx.h + f) - q.y;
  return recorte(R, q, altura);
}

async function lerNoServidor(R, tarefas, progresso, cancelado) {
  const lidos = {}, LOTE = 16;
  for (let i = 0; i < tarefas.length; i += LOTE) {
    if (cancelado()) return null;
    const lote = tarefas.slice(i, i + LOTE);
    const r = await api('api/ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagens: lote.map(tk => recorteCelula(R, tk, 64).toDataURL('image/png')) }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(j.textos)) throw new Error(j.erro || `HTTP ${r.status}`);
    lote.forEach((tk, k) => { (lidos[tk.r] = lidos[tk.r] || {})[COLS[tk.c].k] = { texto: j.textos[k].texto || '', conf: j.textos[k].conf || 0 }; });
    progresso(Math.min(tarefas.length, i + LOTE));
  }
  return lidos;
}

async function lerNoNavegador(R, G, tarefas, progresso, cancelado) {
  const w = await ocrWorker(m => progresso(0, m));
  // com locais/SELBs já registrados, testa várias versões da imagem e escolhe a leitura que bate com eles
  // (no teste de precisão em test/ocr-bench.js isso reduziu os erros; sem lista não fez diferença)
  const modo = RB.vocab && RB.vocab.local.length + RB.vocab.selb.length >= 5 ? 'multi' : 'base';
  const lidos = {};
  let colAtual = -1, feitas = 0;
  for (const tk of tarefas) {
    if (cancelado()) return null;
    if (tk.c !== colAtual) {
      colAtual = tk.c;
      await w.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: COLS[tk.c].wl, preserve_interword_spaces: '1' });
    }
    const { texto, conf } = await lerCelula(w, R, G, tk, COLS[tk.c].k, modo);
    (lidos[tk.r] = lidos[tk.r] || {})[COLS[tk.c].k] = { texto, conf };
    progresso(++feitas);
  }
  return lidos;
}

async function lerFolha() {
  const A = RB.imp.atual, R = A.R, G = A.G, el = $('#mod-receb');
  const nCol = Math.min(COLS.length, G.cols.length - 1), r0 = FOLHA_MODELO.cabecalho ? 1 : 0;
  // células a ler; linha com escrita em qualquer coluna (inclusive só nome/assinatura) entra na conferência
  const tarefas = [], comEscrita = new Set();
  for (let c = 0; c < nCol; c++) for (let r = r0; r + 1 < G.rows.length; r++) {
    const q = RecebOCR.celula(G, r, c), t = RecebOCR.tinta(G, R, q);
    if (!RecebOCR.temConteudo(t)) continue;
    comEscrita.add(r);
    if (COLS[c].ler) tarefas.push({ r, c, q, t });
  }
  A.comEscrita = comEscrita;
  // recortes guardados para o modo treinamento (só Local/SELB/Data)
  A.recortes = {};
  for (const tk of tarefas) (A.recortes[tk.r] = A.recortes[tk.r] || {})[COLS[tk.c].k] = recorteCelula(R, tk, 40).toDataURL('image/png');
  el.innerHTML = `<div class="panel"><h2>Lendo a folha…</h2>
    <p id="rbSt" class="muted">Preparando…</p>
    <div class="vol-bar" style="max-width:520px"><div id="rbBar" style="width:0%"></div></div>
    <p><button class="btn ghost small" id="rbCancel">Cancelar</button></p></div>`;
  let cancelou = false;
  const cancelado = () => cancelou;
  $('#rbCancel').addEventListener('click', () => { cancelou = true; renderAjuste(); });
  const progresso = (n, m) => {
    if (!$('#rbBar')) return;
    if (m && m.status && !n) { $('#rbSt').textContent = `Carregando o OCR: ${m.status} ${m.progress ? Math.round(m.progress * 100) + '%' : ''}`; return; }
    $('#rbBar').style.width = Math.round(n / Math.max(1, tarefas.length) * 100) + '%';
    $('#rbSt').textContent = `${MOTOR_TXT[A.motor]}: célula ${n} de ${tarefas.length}…`;
  };
  if (!RB.vocab) await carregarVocab().catch(() => {});
  let lidos = null;
  A.motor = A.motorEscolhido || 'navegador';
  if (A.motor === 'servidor' && (await estadoOcrServidor()).estado !== 'pronto') { A.motor = 'navegador'; A.avisoMotor = 'O OCR do servidor ainda não está pronto; a folha foi lida no navegador.'; }
  if (A.motor === 'servidor') {
    try { lidos = await lerNoServidor(R, tarefas, progresso, cancelado); }
    catch (e) {
      if (cancelou) return;
      A.avisoMotor = `O OCR do servidor falhou (${e.message}); a folha foi lida no navegador.`;
      A.motor = 'navegador';
    }
  }
  if (!lidos && !cancelou) {
    try { lidos = await lerNoNavegador(R, G, tarefas, progresso, cancelado); }
    catch (e) {
      el.innerHTML = `<div class="panel"><p class="err">Não foi possível iniciar o OCR: ${esc(e.message)}</p><p>Você ainda pode digitar os dados manualmente.</p><button class="btn" id="rbMan">Preencher manualmente</button></div>`;
      $('#rbMan').addEventListener('click', () => montarRevisao({}));
      return;
    }
  }
  if (!cancelou && lidos) montarRevisao(lidos);
}

function montarRevisao(lidos) {
  const A = RB.imp.atual, R = A.R, G = A.G, r0 = FOLHA_MODELO.cabecalho ? 1 : 0;
  const anoPadrao = new Date().getFullYear();
  const linhas = [];
  for (let r = r0; r + 1 < G.rows.length; r++) {
    const L = lidos[r] || {};
    if (!lidos[r] && !(A.comEscrita && A.comEscrita.has(r))) continue;
    const l = { n: r - r0 + 1, revisado: false, escrita: true, conf: {}, dataIso: '', lido: {}, motor: A.motor || '' };
    l.dica = {};
    for (const c of CAMPOS) {
      const v = L[c.k];
      l[c.k] = '';
      if (!v) continue;
      l.conf[c.k] = v.conf;
      l.lido[c.k] = v.texto; // leitura original: vai para o modo treinamento quando a linha for conferida
      // modo treinamento: esta mesma leitura já foi corrigida antes (SELB bem formado nunca é trocado)
      const regra = RB.memoria && RB.memoria[c.k] && RB.memoria[c.k][c.k === 'selb' ? RecebOCR.chaveSelb(v.texto) : RecebOCR.normalizar(v.texto)];
      if (regra && !(c.k === 'selb' && selbBemFormado(v.texto))) {
        if (c.k === 'data') { const d = RecebOCR.limparData(regra.final, anoPadrao); l.data = d.valor; l.dataIso = d.iso; }
        else l[c.k] = c.k === 'selb' ? normSelbs(regra.final) : regra.final;
        l.dica[c.k] = { tipo: 'memoria', texto: v.texto.trim(), n: regra.n };
        continue;
      }
      if (c.k === 'data') {
        const d = RecebOCR.limparData(v.texto, anoPadrao);
        // leitura ruim e inválida: melhor vazio (com a leitura como dica) do que lixo no campo
        if (!d.ok && v.conf < 50) { l.dica.data = { tipo: 'incerto', texto: v.texto.trim() }; continue; }
        l.data = d.valor; l.dataIso = d.iso;
        if (d.corrigida) l.dica.data = { tipo: 'corrigida', texto: v.texto.trim() }; // dígito parecido trocado: conferir
        continue;
      }
      const t = RecebOCR.limparTexto(v.texto).toUpperCase();
      if (c.k === 'selb') {
        // vários SELBs: corrige cada um pela lista dos já registrados
        // formato aprendido dos SELBs já registrados corrige letra/dígito trocados ("A2A17" -> "A2417")
        const itens = selbsDe(t).map(x => RecebOCR.ajustarAoFormato(x, RB.formatoSelb)), voc = (RB.vocab && RB.vocab.selb) || [];
        // SELB costuma ser sequencial (A1234, A1235...): um código bem formado NUNCA é trocado pelo "mais parecido";
        // a lista só ajuda quando a leitura está estragada (sobrou letra/sinal fora do formato)
        const bemFormado = selbBemFormado;
        const corrigir = x => { if (bemFormado(x)) return x; const sg = RecebOCR.sugerir(x, voc, 0.8); return sg ? sg.valor : x; };
        const corr = itens.map(corrigir);
        const conhecidos = itens.filter(x => bemFormado(x) || RecebOCR.sugerir(x, voc, 0.8)).length;
        if (!itens.length || (v.conf < 40 && !conhecidos)) { if (t) l.dica.selb = { tipo: 'incerto', texto: t }; continue; }
        l.selb = RecebOCR.juntarSelbs(corr);
        const lidoSelb = RecebOCR.juntarSelbs(selbsDe(t));
        if (RecebOCR.chaveSelb(l.selb) !== RecebOCR.chaveSelb(lidoSelb)) l.dica.selb = { tipo: 'lista', texto: lidoSelb };
        continue;
      }
      // compara com o que já foi cadastrado (cursiva costuma sair "parecida")
      const sug = t && RecebOCR.sugerir(t, (RB.vocab && RB.vocab[c.k]) || [], c.k === 'selb' ? 0.8 : 0.7);
      if (sug && RecebOCR.normalizar(sug.valor) !== RecebOCR.normalizar(t)) { l[c.k] = sug.valor; l.dica[c.k] = { tipo: 'lista', texto: t, sim: sug.sim }; }
      else if (sug) l[c.k] = sug.valor;
      else if (v.conf < 40) l.dica[c.k] = { tipo: 'incerto', texto: t };
      else l[c.k] = t;
    }
    l.confLida = { ...l.conf };
    linhas.push(l);
  }
  // local pelo histórico do SELB (outras folhas e linhas anteriores desta)
  const tmp = { linhas };
  for (const l of linhas) aplicarHistorico(l, tmp);
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

// sem tabela detectada (ou sem OCR): folha vazia para digitar, com a imagem inteira para consulta
function imagemReduzida(canvas, max = 1800) {
  const k = Math.min(1, max / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas'); c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c;
}
function montarManual() {
  const A = RB.imp.atual;
  A.manual = true;
  const folha = {
    titulo: A.file.name.replace(/\.[^.]+$/, '') + (A.paginas > 1 ? ` – pág. ${A.pagina}` : ''), obs: '', dataFolha: '',
    linhas: [novaLinha(1)], grade: null,
  };
  RB.cur = folha; RB.dirty = true;
  renderFolhaEditor(folha, {}, { nova: true, manual: true, imagem: imagemReduzida(A.canvas).toDataURL('image/jpeg', 0.85),
    fotoOriginal: URL.createObjectURL(A.file) + (A.pagina ? '#page=' + A.pagina : '') });
}
const novaLinha = n => ({ n, revisado: false, conf: {}, selb: '', data: '', dataIso: '', local: '', escrita: false });

// seção "Itens entregues" de uma linha: para cada SELB, as cores/caixa que ele usa
function itensEditor(l, i) {
  const sels = selbsDe(l.selb).map(x => x.toUpperCase());
  if (!sels.length) return `<div class="it-ed it-vazio">${IC('caixa')} Informe o SELB para marcar as tintas/toners e caixas entregues.</div>`;
  return `<div class="it-ed">${sels.map(sel => {
    const c = cadSelb(sel), tipo = c && c.suprimento === 'toner' ? 'toner' : 'tinta';
    const chips = c && !suprimentosDe(sel).length ? '<span class="muted">sem suprimentos (scanner)</span>' : suprimentosDe(sel).map(item => {
      const it = (l.itens || []).find(x => x.selb === sel && x.item === item);
      return `<label class="it-chip ${it ? 'on' : ''}" title="${esc(nomeSuprimento(item, tipo))}"><input type="checkbox" data-it data-i="${i}" data-selb="${esc(sel)}" data-item="${item}" ${it ? 'checked' : ''}>
        <span class="it-bola it-${item}">${item === 'caixa' ? IC('caixa') : ''}</span>${item === 'caixa' ? 'Caixa' : ITENS[item].replace(' (ciano)', '')}
        <input type="number" class="it-qtd" min="1" max="99" value="${it ? it.qtd : 1}" aria-label="quantidade"></label>`;
    }).join('');
    return `<div class="it-selb"><div class="it-cab"><b>${esc(sel)}</b> <small>${c ? esc(resumoEquip(c)) : 'sem cadastro'}</small>
        ${c ? '' : `<a class="linklike" href="#receb/selbs~${encodeURIComponent(sel)}" target="_blank" rel="noopener">cadastrar</a>`}
        <button type="button" class="linklike" data-kit="${esc(sel)}" data-i="${i}">kit completo</button>
        ${c && c.obs ? `<small class="it-obs" title="${esc(c.obs)}">${IC('tag')} ${esc(c.obs.slice(0, 80))}${c.obs.length > 80 ? '…' : ''}</small>` : ''}</div>
      <div class="it-chips">${chips}</div></div>`;
  }).join('')}</div>`;
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
        ${opt.nova ? `<button class="btn ghost" id="rbVoltarAj">${opt.manual ? 'Voltar ao ajuste' : 'Ajustar cantos'}</button>` : `<button class="btn ghost small" id="rbExcluir">Excluir folha</button>`}${opt.fotoOriginal ? `<a class="btn ghost small" href="${opt.fotoOriginal}" target="_blank" rel="noopener">${/#page=/.test(opt.fotoOriginal) ? 'PDF original' : 'Foto original'}</a>` : ''}
        <button class="btn ghost" id="rbTodas">Marcar todas como conferidas</button>
        <button class="btn" id="rbSalvar">${opt.nova ? 'Salvar folha' : 'Salvar'}</button></div>
    </div>
    <div class="panel">
      <div class="rep-grid">
        <label>Identificação da folha <input id="rbTit" value="${esc(F.titulo)}" maxlength="160" placeholder="ex.: Entrega notebooks lote 3"></label>
        <label>Data da folha <input type="date" id="rbData" value="${esc(F.dataFolha)}"></label>
        <label class="full">Observações <textarea id="rbObs" rows="2" maxlength="2000">${esc(F.obs)}</textarea></label>
      </div>
      ${opt.manual ? `<p class="note info">Lançamento manual: digite ${CAMPOS.map(c => c.rotulo).join(', ')} de cada entrega olhando a imagem abaixo. Linhas sem nada preenchido são descartadas ao salvar.</p>` : ''}
      ${opt.nova && !opt.manual && RB.imp && RB.imp.atual && RB.imp.atual.avisoMotor ? `<p class="note">${esc(RB.imp.atual.avisoMotor)}</p>` : ''}
      ${opt.nova && !opt.manual ? `<p class="note info">Lido por: <b>${esc(MOTOR_TXT[RB.imp.atual.motor] || '')}</b>${RB.treino && RB.treino.ativo ? ' · modo treinamento ligado: as linhas conferidas ensinam o sistema' : ''}.<br>${F.linhas.length} linha(s) com escrita de ${opt.nLinhas}. O OCR leu ${CAMPOS.map(c => c.rotulo).join(', ')}: confira com a foto da linha e corrija o que for preciso.
        ${esc(NA_IMAGEM)} não são digitados: ficam na foto da folha. Campos em <span class="bad-txt">vermelho</span> têm baixa confiança ou formato inválido.</p>` : ''}
    </div>
    ${opt.imagem ? `<div class="panel"><div class="head-row"><h2>Folha</h2><small class="muted">clique na imagem para ampliar</small></div>
      <figure class="rb-fig rb-folha"><img class="rb-strip" src="${opt.imagem}" alt="Imagem da folha"></figure></div>` : ''}
    <div class="panel"><div class="head-row"><h2>Linhas</h2><div class="filters" style="margin:0">
        <button class="btn ghost small" id="rbDatas" title="Usa a data da folha nas linhas sem data">Preencher datas vazias</button>
        <button class="btn ghost small" id="rbAdd">Adicionar linha</button></div></div>
      <div id="rbLinhas" class="rb-linhas"></div>
      <datalist id="rbDlLocal"></datalist><datalist id="rbDlSelb"></datalist></div>`;
  const opcoes = k => [...new Set([...F.linhas.map(l => l[k]).filter(Boolean), ...((RB.vocab && RB.vocab[k]) || [])])].slice(0, 500).map(v => `<option value="${esc(v)}">`).join('');
  const listas = () => { $('#rbDlLocal').innerHTML = opcoes('local'); $('#rbDlSelb').innerHTML = opcoes('selb'); };
  if (!RB.vocab) carregarVocab().then(() => { listas(); desenhar(); }).catch(() => {}); // cadastro dos SELBs: redesenha os itens
  const marcarSujo = () => { RB.dirty = true; };
  const desenhar = () => {
    const box = $('#rbLinhas');
    if (!F.linhas.length) { box.innerHTML = '<p class="muted">Nenhuma linha preenchida. Use "Adicionar linha" para digitar.</p>'; return; }
    F.linhas.sort((a, b) => a.n - b.n);
    box.innerHTML = F.linhas.map((l, i) => {
      const campo = c => {
        const v = l[c.k] || '', conf = l.conf && l.conf[c.k], dica = l.dica && l.dica[c.k];
        const ruim = (c.k === 'data' && v && !dataOk(v)) || (conf != null && conf < 60 && !l.revisado) || (dica && dica.tipo !== 'historico' && dica.tipo !== 'histSug' && !l.revisado);
        const lista = c.k === 'local' ? 'rbDlLocal' : c.k === 'selb' ? 'rbDlSelb' : '';
        const quando = dica && dataCurta(dica.quando) ? `, última em ${dataCurta(dica.quando)}` : '';
        const txtDica = !dica ? '' : dica.tipo === 'memoria'
          ? `corrigido pelo treinamento: “${esc(dica.texto)}” já foi corrigido ${dica.n} vez${dica.n > 1 ? 'es' : ''} <button type="button" class="linklike" data-usar="${i}" data-k="${c.k}">usar o lido</button>`
          : dica.tipo === 'corrigida'
          ? `OCR leu “${esc(dica.texto)}” (data impossível) → corrigida; confira <button type="button" class="linklike" data-usar="${i}" data-k="${c.k}">usar o lido</button>`
          : dica.tipo === 'lista'
          ? `OCR leu “${esc(dica.texto)}” → corrigido pela lista <button type="button" class="linklike" data-usar="${i}" data-k="${c.k}">usar “${esc(dica.texto)}”</button>`
          : dica.tipo === 'historico'
          ? `preenchido pelo histórico do SELB ${esc(dica.selb)} (${dica.vezes} entrega${dica.vezes > 1 ? 's' : ''}${quando}) — corrija se mudou${dica.texto ? ` <button type="button" class="linklike" data-usar="${i}" data-k="${c.k}">usar o lido “${esc(dica.texto)}”</button>` : ''}`
          : dica.tipo === 'histSug'
          ? `histórico do SELB ${esc(dica.selb)}: “${esc(dica.valor)}”${quando} <button type="button" class="linklike" data-hist="${i}">usar</button>`
          : `ilegível para o OCR${dica.texto ? ` (leu “${esc(dica.texto)}”)` : ''}: digite olhando a foto`;
        const nSel = c.k === 'selb' ? selbsDe(v).length : 0;
        return `<label class="rb-c rb-${c.k}">${esc(c.rotulo)}${nSel > 1 ? ` <span class="badge" data-nsel>${nSel} SELBs</span>` : ''}${conf != null ? ` <small title="confiança do OCR">${conf}%</small>` : ''}
          <input data-i="${i}" data-k="${c.k}" value="${esc(v)}" class="${ruim ? 'rb-ruim' : ''}" maxlength="${c.k === 'local' ? 160 : c.k === 'selb' ? 300 : 40}" ${lista ? `list="${lista}"` : ''} ${c.k === 'data' ? 'placeholder="dd/mm/aaaa"' : c.k === 'selb' ? 'placeholder="vários: A123, A124"' : ''} autocomplete="off">
          ${txtDica ? `<small class="rb-dica">${txtDica}</small>` : ''}</label>`;
      };
      const src = imgs && imgs[l.n];
      return `<div class="rb-linha ${l.revisado ? 'ok' : ''} ${opt.linha === l.n ? 'rb-alvo' : ''}" data-n="${l.n}">
        <div class="rb-lh"><b>Linha ${l.n}</b>
          <label class="chk"><input type="checkbox" data-rev="${i}" ${l.revisado ? 'checked' : ''}> conferida</label>
          <button class="btn ghost small" data-del="${i}">Remover</button></div>
        <div class="rb-campos">${CAMPOS.map(campo).join('')}</div>
        ${itensEditor(l, i)}
        ${src ? `<figure class="rb-fig"><img class="rb-strip" src="${src}" alt="Foto da linha ${l.n}" title="Clique para ampliar">
          <figcaption>Foto da linha na folha${NA_IMAGEM ? ` (${esc(NA_IMAGEM)})` : ''} · clique para ampliar</figcaption></figure>` : ''}</div>`;
    }).join('');
    box.querySelectorAll('input[data-k]').forEach(inp => inp.addEventListener('input', () => {
      const l = F.linhas[+inp.dataset.i], k = inp.dataset.k;
      l[k] = inp.value; marcarSujo();
      if (l.conf) delete l.conf[k]; // corrigido à mão
      if (l.dica) delete l.dica[k];
      const dc = inp.parentElement.querySelector('.rb-dica'); if (dc) dc.remove(); // corrigido: some o aviso
      inp.classList.remove('rb-ruim');
      if (k === 'data') { const d = RecebOCR.limparData(inp.value); l.dataIso = d.iso; inp.classList.toggle('rb-ruim', !!inp.value && !d.ok); }
    }));
    // Enter vai para o próximo campo (digitação rápida)
    const todos = [...box.querySelectorAll('input[data-k]')];
    todos.forEach((inp, j) => inp.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (todos[j + 1]) todos[j + 1].focus(); else $('#rbAdd').click(); // no último campo, Enter cria nova linha
    }));
    box.querySelectorAll('[data-usar]').forEach(b => b.addEventListener('click', e => {
      e.preventDefault();
      const l = F.linhas[+b.dataset.usar], k = b.dataset.k;
      l[k] = l.dica[k].texto; delete l.dica[k]; marcarSujo(); desenhar();
    }));
    box.querySelectorAll('[data-hist]').forEach(b => b.addEventListener('click', e => {
      e.preventDefault();
      const l = F.linhas[+b.dataset.hist], d = l.dica.local;
      l.dica.local = { ...d, tipo: 'historico', texto: l.local }; l.local = d.valor; marcarSujo(); desenhar();
    }));
    // SELB digitado/alterado: busca o local no histórico (sem perder o foco de quem estava digitando)
    // itens entregues: marcar/desmarcar, quantidade, kit completo
    box.querySelectorAll('input[data-it]').forEach(cb => cb.addEventListener('change', () => {
      const l = F.linhas[+cb.dataset.i], { selb, item } = cb.dataset;
      l.itens = (l.itens || []).filter(it => !(it.selb === selb && it.item === item));
      if (cb.checked) {
        const qtd = Math.max(1, Math.min(99, +cb.closest('.it-chip').querySelector('.it-qtd').value || 1));
        l.itens.push({ selb, item, qtd, tipo: item === 'caixa' ? '' : (cadSelb(selb) || {}).suprimento === 'toner' ? 'toner' : 'tinta' });
      }
      cb.closest('.it-chip').classList.toggle('on', cb.checked); marcarSujo();
    }));
    box.querySelectorAll('.it-qtd').forEach(q => q.addEventListener('input', () => {
      const cb = q.closest('.it-chip').querySelector('input[data-it]'), l = F.linhas[+cb.dataset.i];
      const it = (l.itens || []).find(x => x.selb === cb.dataset.selb && x.item === cb.dataset.item);
      if (it) { it.qtd = Math.max(1, Math.min(99, +q.value || 1)); marcarSujo(); }
    }));
    box.querySelectorAll('[data-kit]').forEach(b => b.addEventListener('click', e => {
      e.preventDefault();
      const l = F.linhas[+b.dataset.i], selb = b.dataset.kit, tipo = (cadSelb(selb) || {}).suprimento === 'toner' ? 'toner' : 'tinta';
      const tem = new Set((l.itens || []).filter(it => it.selb === selb).map(it => it.item));
      l.itens = l.itens || [];
      for (const item of suprimentosDe(selb)) if (!tem.has(item)) l.itens.push({ selb, item, qtd: 1, tipo: item === 'caixa' ? '' : tipo });
      marcarSujo(); desenhar();
    }));
    box.querySelectorAll('input[data-k="selb"]').forEach(inp => inp.addEventListener('change', () => {
      const l = F.linhas[+inp.dataset.i];
      const selbAntes = l.selb;
      l.selb = inp.value = normSelbs(inp.value);
      // itens de SELB que saiu da linha deixam de valer
      const meus = new Set(selbsDe(l.selb).map(x => x.toUpperCase()));
      if (l.itens) l.itens = l.itens.filter(it => meus.has(it.selb));
      const lab = inp.closest('label'), nb = lab.querySelector('[data-nsel]'), n = selbsDe(l.selb).length;
      if (nb) nb.remove();
      if (n > 1) { const bd = document.createElement('span'); bd.className = 'badge'; bd.textContent = `${n} SELBs`; bd.setAttribute('data-nsel', ''); lab.firstChild.after(' ', bd); }
      const antes = JSON.stringify([l.local, l.dica && l.dica.local]);
      aplicarHistorico(l, F);
      // redesenha se o local mudou pelo histórico ou se mudaram os SELBs (seção de itens)
      if (JSON.stringify([l.local, l.dica && l.dica.local]) === antes && selbAntes === l.selb) return;
      marcarSujo();
      // "change" dispara no meio da troca de foco: redesenha depois, devolvendo o foco ao campo para onde o usuário foi
      setTimeout(() => {
        const ativo = document.activeElement, foco = ativo && ativo.dataset && ativo.dataset.k ? [ativo.dataset.i, ativo.dataset.k, ativo.selectionStart] : null;
        desenhar();
        if (foco) { const el = box.querySelector(`input[data-i="${foco[0]}"][data-k="${foco[1]}"]`); if (el) { el.focus(); try { el.setSelectionRange(foco[2], foco[2]); } catch { /* sem cursor */ } } }
      }, 0);
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
  // adiciona a próxima linha livre e já coloca o cursor nela
  $('#rbAdd').addEventListener('click', () => {
    const usados = new Set(F.linhas.map(l => l.n));
    let n = 1; while (usados.has(n)) n++;
    F.linhas.push(novaLinha(n));
    marcarSujo(); desenhar();
    const inp = $(`#rbLinhas .rb-linha[data-n="${n}"] input[data-k]`); if (inp) { inp.scrollIntoView({ block: 'center' }); inp.focus(); }
  });
  if ($('.rb-folha .rb-strip')) $('.rb-folha .rb-strip').addEventListener('click', e => e.target.closest('.rb-fig').classList.toggle('zoom'));
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

// modo treinamento: cada campo lido pelo OCR em linha CONFERIDA vira exemplo (leitura original x texto final)
async function enviarExemplos(folhaId, F, recortes) {
  if (!RB.treino || !RB.treino.ativo) return;
  const exemplos = [];
  for (const l of F.linhas) {
    if (!l.revisado || !l.lido) continue;
    for (const c of CAMPOS) {
      if (l.lido[c.k] == null) continue;
      exemplos.push({ chave: `${folhaId}~${l.n}~${c.k}`, campo: c.k, lido: l.lido[c.k], final: l[c.k] || '', motor: l.motor || '',
        conf: l.confLida ? l.confLida[c.k] : (l.conf || {})[c.k], img: recortes && recortes[l.n] ? recortes[l.n][c.k] : undefined });
    }
  }
  if (!exemplos.length) return;
  await api('api/treino/exemplos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exemplos }) }).catch(() => null);
}

async function enviarAnexo(id, blob, nome, legenda) {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  const r = await api(`api/recebimentos/${id}/anexos`, { method: 'POST', body: u8, headers: {
    'Content-Type': blob.type, 'X-Nome': encodeURIComponent(nome), 'X-Legenda': encodeURIComponent(legenda), 'X-Sha256': await sha256Hex(u8) } }).catch(() => null);
  return !!(r && r.ok);
}

async function salvarNova(F) {
  const A = RB.imp.atual;
  F.linhas = F.linhas.filter(l => l.escrita || CAMPOS.some(c => (l[c.k] || '').trim()));
  const r = await api('api/recebimentos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(F) }).catch(() => null);
  if (!r || !r.ok) { const e = r ? (await r.json().catch(() => ({}))).erro : ''; return alert('Não foi possível salvar: ' + (e || 'servidor indisponível.')); }
  const salvo = await r.json();
  // treinamento: recortes por número da linha na folha
  const r0 = FOLHA_MODELO.cabecalho ? 1 : 0, recs = {};
  for (const [row, v] of Object.entries(A.recortes || {})) recs[+row - r0 + 1] = v;
  await enviarExemplos(salvo.id, F, recs);
  // imagem retificada (usada para mostrar os recortes das linhas) + foto original
  // manual: sem retificada; guarda a imagem da folha (útil para PDF, que o navegador não mostra inline)
  const ret = A.manual ? imagemReduzida(A.canvas, 2400) : recorte(A.R, { x: 0, y: 0, w: A.R.w, h: A.R.h }, 0, false);
  const blobRet = await new Promise(ok => ret.toBlob(ok, 'image/jpeg', 0.82));
  const okRet = A.manual ? await enviarAnexo(salvo.id, blobRet, 'folha.jpg', 'Folha (imagem)') : await enviarAnexo(salvo.id, blobRet, 'folha-retificada.jpg', 'Folha retificada');
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
  await enviarExemplos(F.id, F, null); // conferências feitas depois também ensinam (sem imagem nova)
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
  let imagem = '';
  const inteira = anx.find(a => a.legenda === 'Folha (imagem)') || (!(F.grade && F.grade.linhas.length > 1) && (ret || (orig && /^image\//.test(orig.tipo) && orig)));
  if (inteira) imagem = await api(url(inteira)).then(x => x.ok ? x.blob() : null).then(b => b ? URL.createObjectURL(b) : '').catch(() => '');
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
  renderFolhaEditor(F, imgs, { fotoOriginal: orig ? url(orig) + (pag ? '#page=' + pag : '') : '', linha, imagem });
}

// arrastar imagens para a tela de importação (chamado pelo tratador de "soltar" do app.js)
function recebSoltar(files) {
  if ($('#mod-receb').hidden || !$('#rbDrop') || !RB.pegar) return false;
  RB.pegar(files); return true;
}

window.addEventListener('beforeunload', e => { if (RB.dirty) { e.preventDefault(); e.returnValue = ''; } });

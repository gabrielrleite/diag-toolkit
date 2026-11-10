'use strict';
/*
  Assinatura dos laudos de manutenção
  - Digital: o navegador gera o PDF oficial (pdfmake) com o campo de assinatura e o selo
    visível (pdf-lib); o assinador local do Windows (protocolo diagassina:) escolhe o
    certificado instalado (A1 ou A3/token), preenche o selo, assina e envia ao servidor.
  - Física: imprime para assinar à mão e, depois, recebe a digitalização da via assinada.
  Depende de app.js, saude.js, laudos.js e das bibliotecas em vendor/.
*/

const SIG = {
  W: 240, H: 64,
  CONTENTS: 16384,                        // bytes reservados para a assinatura (CMS)
  NOME: '##DIAGNOME' + '#'.repeat(34),     // 44 caracteres
  CPF: '##DIAGCPF' + '#'.repeat(5),        // 14 caracteres
  DATA: '##DIAGDATA' + '#'.repeat(16),     // 26 caracteres
  EMISSOR: '##DIAGEMISSOR' + '#'.repeat(37), // 50 caracteres
  M: '##DIAGM' + '#'.repeat(16),           // 23 caracteres: D:AAAAMMDDhhmmss-03'00'
  poll: null,
};

const LIBS = ['vendor/pdfmake.min.js', 'vendor/vfs_fonts.js', 'vendor/pdf-lib.min.js'];
let libsP = null;
function ensureLibs() { // carregadas só quando necessário (~3 MB)
  if (!libsP) libsP = LIBS.reduce((p, src) => p.then(() => new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res;
    s.onerror = () => { libsP = null; rej(new Error('Falha ao carregar ' + src)); };
    document.head.appendChild(s);
  })), Promise.resolve());
  return libsP;
}

// ================================================================== PDF oficial (pdfmake)
const PDF_COR = { ink: '#1a1d21', muted: '#5d6673', line: '#cfd5dd', soft: '#f3f5f8', accent: '#1f3f8f', bad: '#b42318' };

async function imagemDataUrl(url) {
  const r = await api(url).catch(() => null);
  if (!r || !r.ok) return null;
  const blob = await r.blob();
  if (/^image\/(jpeg|png)$/.test(blob.type)) {
    return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(blob); });
  }
  try { // webp/gif -> jpeg
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    return c.toDataURL('image/jpeg', 0.9);
  } catch { return null; }
}

function pdfTexto(t, L) { return subst(t || '', L) || '—'; }

function pdfKv(rows) {
  return {
    table: { widths: [110, '*', 110, '*'], body: rows.map(r => r.length === 2
      ? [{ text: r[0], style: 'kvTh' }, { text: r[1], colSpan: 3 }, {}, {}]
      : [{ text: r[0], style: 'kvTh' }, { text: r[1] }, { text: r[2], style: 'kvTh' }, { text: r[3] }]) },
    layout: { hLineColor: () => PDF_COR.line, vLineColor: () => PDF_COR.line, hLineWidth: () => 0.6, vLineWidth: () => 0.6, paddingTop: () => 3, paddingBottom: () => 3, fillColor: () => null },
    margin: [0, 2, 0, 6], fontSize: 9,
  };
}
function pdfTabela(head, rows, widths) {
  return {
    table: { headerRows: 1, widths: widths || head.map(() => '*'), body: [head.map(h => ({ text: h, style: 'thDark' })), ...rows] },
    layout: { hLineColor: () => PDF_COR.line, vLineWidth: () => 0, hLineWidth: (i) => (i === 0 ? 0 : 0.5), paddingTop: () => 3, paddingBottom: () => 3, fillColor: (i) => (i === 0 ? PDF_COR.ink : null) },
    fontSize: 8.5, margin: [0, 2, 0, 6],
  };
}
function pdfExtras(M, L, secao) {
  const cs = (M.camposExtras || []).filter(c => c.secao === secao);
  if (!cs.length) return [];
  return [pdfKv(cs.map(c => { const v = (L.campos || {})[c.id] || ''; return [c.rotulo, c.tipo === 'data' ? (v ? dataBR(v) : '—') : pdfTexto(v, L)]; }))];
}

function pdfConteudo(k, M, L, anexosImg) {
  const S = L.snapshot;
  switch (k) {
    case 'identificacao': return [pdfKv([
      ['Patrimônio', L.patrimonio || '—', 'Nome do computador', L.computador || '—'],
      ['Fabricante / modelo', (S && S.fabricanteModelo) || '—', 'Nº de série (BIOS)', (S && S.serial) || '—'],
      ['Processador', (S && S.cpu) || '—', 'Memória', S && S.memoriaGB ? `${S.memoriaGB} GB` : '—'],
      ['Sistema operacional', (S && S.sistema) || '—'],
      ['Setor', L.setor || '—', 'Local', L.local || '—'],
    ]), ...pdfExtras(M, L, 'identificacao')];
    case 'solicitacao': return [pdfKv([
      ['Solicitante', L.solicitante || '—', 'Data de abertura', dataBR(L.dataAbertura)],
      ...(L.chamado ? [['Chamado / OS', L.chamado]] : []),
    ]), ...pdfExtras(M, L, 'solicitacao'), { text: [{ text: 'Problema relatado: ', bold: true }, pdfTexto(L.problema, L)], margin: [0, 2, 0, 6] }];
    case 'testes': return [pdfTabela(['Teste', 'Resultado', 'Observação'],
      (L.testes || []).filter(t => t.nome && t.resultado).map(t => [t.nome, t.resultado === 'falha' ? { text: RESULTADO_TXT[t.resultado], bold: true, color: PDF_COR.bad } : RESULTADO_TXT[t.resultado], t.obs || '']), ['*', 80, '*'])];
    case 'coleta': {
      const out = [{ text: `${S.tipoColeta === 'diagnostico' ? 'Diagnóstico' : 'Coleta diag-hardware'} de ${S.horaColeta || '—'}${S.coletadoPor ? ', executada por ' + S.coletadoPor : ''}${S.pacoteSha256 ? '. SHA-256 do pacote: ' + S.pacoteSha256 : ''}.`, style: 'small', margin: [0, 0, 0, 4] }];
      if (S.discos && S.discos.length) out.push(pdfTabela(['Disco', 'Tipo', 'Capacidade', 'Saúde', 'Temp.', 'Desgaste', 'Horas'],
        S.discos.map(d => [d.nome || '—', d.tipo || '—', d.gb != null ? d.gb + ' GB' : '—', d.saude ? (/^healthy$/i.test(d.saude) ? 'Saudável' : { text: d.saude, bold: true, color: PDF_COR.bad }) : '—', d.temperatura != null ? d.temperatura + ' °C' : '—', d.desgastePct != null ? d.desgastePct + '%' : '—', d.horasLigado != null ? String(d.horasLigado) : '—']),
        ['*', 30, 50, 50, 35, 42, 40]));
      if (S.volumes && S.volumes.length) out.push({ text: 'Unidades: ' + S.volumes.map(x => `${x.letra} ${x.livreGB} GB livres de ${x.totalGB} GB (${x.livrePct}%)`).join(' · '), style: 'small', margin: [0, 0, 0, 4] });
      if (S.eventos) out.push(pdfKv(EVENTOS_SAUDE.filter(([key]) => S.eventos[key] != null).map(([key, l]) => [l, String(S.eventos[key])])));
      if ((S.testesAuto || []).length) {
        out.push({ text: 'Testes automáticos' + (S.profundoEm ? ' – ' + S.profundoEm : ''), bold: true, margin: [0, 6, 0, 2] });
        out.push(pdfTabela(['Teste', 'Resultado', 'Detalhes'], S.testesAuto.map(t => [t.nome,
          t.resultado === 'falha' ? { text: 'Falha', bold: true, color: PDF_COR.bad } : t.resultado === 'alerta' ? { text: 'Atenção', bold: true } : 'OK', t.obs || '']), [150, 45, '*']));
      }
      return out;
    }
    case 'achados': return (S.achados || []).length
      ? [{ ul: S.achados.map(a => ({ text: [{ text: NIVEL[a.nivel].label + ': ', bold: true }, a.texto] })), margin: [0, 0, 0, 6], fontSize: 9 }]
      : [{ text: 'Nenhum problema identificado automaticamente nos dados coletados.', style: 'small' }];
    case 'analise': return [{ text: pdfTexto(L.diagnostico, L), margin: [0, 0, 0, 6] }];
    case 'servicos': return [{ text: pdfTexto(L.solucao, L), margin: [0, 0, 0, 6] }];
    case 'pecas': return [pdfTabela(['Peça / item', 'Qtd', 'Situação', 'Observação'],
      L.pecas.filter(p => p.item).map(p => [p.item, String(p.qtd), ACAO_TXT[p.acao] || '—', p.obs || '']), ['*', 30, 80, '*'])];
    case 'conclusao': {
      const cls = CONCLUSAO_CLS[L.conclusao];
      const cor = cls === 'ok' ? ['#18794e', '#e8f6ee'] : cls === 'warn' ? ['#9a5b00', '#fdf3e1'] : [PDF_COR.bad, '#fdecea'];
      return [{
        table: { widths: ['*'], body: [[{ stack: [
          { text: secTit(M, 'conclusao').toUpperCase(), fontSize: 7.5, bold: true, color: cor[0], characterSpacing: 0.5 },
          { text: CONCLUSAO_TXT[L.conclusao] || '—', fontSize: 12.5, bold: true, margin: [0, 2, 0, 2] },
          ...(L.justificativa ? [{ text: pdfTexto(L.justificativa, L), fontSize: 9 }] : []),
        ], fillColor: cor[1], margin: [6, 5, 6, 5] }]] },
        layout: { hLineColor: () => cor[0], vLineColor: () => cor[0], hLineWidth: () => 1.2, vLineWidth: () => 1.2 },
        margin: [0, 4, 0, 6],
      }, ...pdfExtras(M, L, 'conclusao')];
    }
    case 'recomendacoes': return [{ text: pdfTexto(L.recomendacoes, L), margin: [0, 0, 0, 6] }];
    case 'observacoes': return [{ text: pdfTexto(L.observacoes, L), margin: [0, 0, 0, 6] }];
    case 'anexos': return [pdfTabela(['Nº', 'Descrição', 'Arquivo', 'Data', 'SHA-256'],
      LD.anexos.map((a, n) => [String(n + 1), a.legenda || '—', `${a.nome}\n${tamanhoTxt(a.tamanho)}`, anexoDataTxt(a), { text: a.sha256, fontSize: 6.5 }]), [18, '*', 80, 70, 150])];
  }
  return [];
}

// modo: 'digital' (reserva o selo) ou 'fisica'
async function gerarPdfLaudo(L, { modo = 'digital' } = {}) {
  await ensureLibs();
  const M = modeloDe(L), A = L.assinatura || {};
  const blocos = blocosLaudo(M, L);
  const content = [];
  const h2 = (t) => [{ text: t.toUpperCase(), style: 'h2' }, { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.2, lineColor: PDF_COR.accent }], margin: [0, 1, 0, 6] }];

  content.push({ columns: [
    { width: '*', stack: [
      { text: (rep.orgao || 'Tecnologia da Informação').toUpperCase(), fontSize: 8, bold: true, color: PDF_COR.muted, characterSpacing: 1 },
      { text: M.titulo, fontSize: 19, bold: true, margin: [0, 2, 0, 0] },
      ...(M.subtitulo ? [{ text: M.subtitulo, color: PDF_COR.muted, fontSize: 10 }] : []),
    ] },
    { width: 170, table: { widths: [65, '*'], body: [
      [{ text: M.rotuloNumero, style: 'metaTh' }, { text: (L.numero || '') + (L.revisao > 1 ? ` · rev. ${L.revisao}` : ''), bold: true }],
      [{ text: 'Patrimônio', style: 'metaTh' }, { text: L.patrimonio || '—', bold: true }],
      [{ text: 'Chamado', style: 'metaTh' }, { text: L.chamado || '—' }],
    ] }, layout: 'noBorders', fontSize: 8.5 },
  ] });
  content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2.5, lineColor: PDF_COR.ink }], margin: [0, 8, 0, 6] });

  blocos.forEach((b, i) => {
    const n = i + 1;
    content.push(...h2(`${n}. ${secTit(M, b.k)}`));
    if (b.k === 'diagnostico') {
      b.filhos.forEach((f, j) => { content.push({ text: `${n}.${j + 1} ${secTit(M, f)}`, style: 'h3' }, ...pdfConteudo(f, M, L)); });
      if (b.extras) content.push(...pdfExtras(M, L, 'diagnostico'));
    } else {
      content.push(...pdfConteudo(b.k, M, L));
      if (b.k === 'servicos') content.push(...pdfExtras(M, L, 'servicos'));
      for (const f of b.filhos || []) content.push({ text: secTit(M, f), style: 'h3' }, ...pdfConteudo(f, M, L));
    }
  });

  // encerramento + assinaturas: nós de primeiro nível (ids "fech*") mantidos na mesma página
  const extras = (M.assinaturasExtras || []).map(t => ({ cargo: t }));
  const linha = (cargo, nome, extra) => ({ width: 245, stack: [
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 240, y2: 0, lineWidth: 0.8, lineColor: PDF_COR.ink }], margin: [0, 38, 0, 3] },
    { text: nome || ' ', bold: true, alignment: 'center', fontSize: 9.5 },
    { text: cargo, alignment: 'center', fontSize: 9 },
    { text: extra || ' ', alignment: 'center', fontSize: 8, color: PDF_COR.muted },
  ] });
  const fech = [];
  if (M.encaminhamento) fech.push({ text: pdfTexto(M.encaminhamento, L), italics: true, margin: [0, 14, 0, 0] });
  fech.push({ text: `${A.cidade || '__________________'}, ${A.data ? dataExtenso(A.data) : '____ / ____ / ________'}`, alignment: 'right', margin: [0, 18, 0, 0] });
  const princ = { cargo: A.cargo || 'Cargo', nome: A.responsavel || '', extra: A.matricula ? 'Matrícula ' + A.matricula : '' };
  let resto = extras;
  if (modo === 'digital') {
    fech.push({ id: 'sigbox', canvas: [{ type: 'rect', x: 0, y: 0, w: SIG.W, h: SIG.H, lineColor: '#ffffff', lineWidth: 0 }], margin: [0, 10, 0, 2] });
    fech.push({ columns: [{ width: SIG.W, stack: [
      { text: princ.cargo, alignment: 'center', fontSize: 9 },
      { text: princ.extra || ' ', alignment: 'center', fontSize: 8, color: PDF_COR.muted },
    ] }, { width: '*', text: '' }] });
  } else {
    resto = [{ ...princ, principal: true }, ...extras];
  }
  for (let i = 0; i < resto.length; i += 2) {
    const a1 = resto[i], a2 = resto[i + 1];
    fech.push({ columns: [linha(a1.cargo, a1.nome, a1.extra), a2 ? linha(a2.cargo, a2.nome, a2.extra) : { width: 245, text: '' }], columnGap: 25, margin: [0, 6, 0, 0] });
  }
  fech.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: PDF_COR.line }], margin: [0, 16, 0, 4] });
  fech.push({ text: `${M.rotuloNumero} ${L.numero}, revisão ${L.revisao} · modelo "${M.nome}" · gerado em ${fmt(new Date())} pelo Visualizador de Coletas (diag-hardware)`, style: 'small', alignment: 'center' });
  fech.forEach((n, i) => { if (!n.id) n.id = 'fech' + i; });
  const primeiroFech = fech[0].id;
  content.push(...fech);

  // reprodução dos anexos
  if (secOn(M, 'anexos') && LD.anexos.length) {
    content.push({ text: 'REPRODUÇÃO DOS ANEXOS', style: 'h2', pageBreak: 'before' });
    for (const [n, a] of LD.anexos.entries()) {
      const img = a.tipo.startsWith('image/') ? await imagemDataUrl(a.url) : null;
      content.push({ unbreakable: true, stack: [
        { text: [{ text: `Anexo ${n + 1}`, bold: true }, a.legenda ? ' – ' + a.legenda : ''], margin: [0, 8, 0, 4] },
        img ? { image: img, fit: [515, 320], alignment: 'center' } : { text: `Documento PDF entregue em separado: ${a.nome}`, italics: true, margin: [0, 10, 0, 10] },
        { text: `${a.nome} · ${tamanhoTxt(a.tamanho)} · ${anexoDataTxt(a)}\nSHA-256 ${a.sha256}`, style: 'small', margin: [0, 4, 0, 0] },
      ] });
    }
  }

  let sigPos = null;
  const dd = {
    pageSize: 'A4', pageMargins: [40, 40, 40, 48],
    info: {
      title: `${M.titulo} ${L.numero}`, author: rep.orgao || 'Tecnologia da Informação',
      subject: `laudo:${L.id};rev:${L.revisao}`, keywords: `diag-viewer laudo:${L.id} rev:${L.revisao}`,
      creator: 'Visualizador de Coletas (diag-hardware)', producer: 'diag-viewer',
    },
    defaultStyle: { font: 'Roboto', fontSize: 9.5, lineHeight: 1.2, color: PDF_COR.ink },
    styles: {
      h2: { fontSize: 10.5, bold: true, color: PDF_COR.accent, characterSpacing: 0.5, margin: [0, 10, 0, 0] },
      h3: { fontSize: 10, bold: true, margin: [0, 6, 0, 3] },
      kvTh: { bold: true, color: PDF_COR.muted, fillColor: PDF_COR.soft, fontSize: 8.5 },
      metaTh: { color: PDF_COR.muted, bold: true },
      thDark: { bold: true, color: '#ffffff', fontSize: 8 },
      small: { fontSize: 7.5, color: PDF_COR.muted },
    },
    content,
    footer: (cur, total) => ({ columns: [
      { text: `${M.titulo} – ${M.rotuloNumero} ${L.numero}`, fontSize: 7.5, color: PDF_COR.muted },
      { text: `Página ${cur} de ${total}`, alignment: 'right', fontSize: 7.5, color: PDF_COR.muted },
    ], margin: [40, 16, 40, 0] }),
    pageBreakBefore: (node, _seguintes, proximaPagina) => {
      if (node.id === 'sigbox' && node.startPosition) sigPos = { ...node.startPosition };
      // não separa o encerramento das assinaturas
      return node.id === primeiroFech && proximaPagina.some(n => n.id && (n.id === 'sigbox' || String(n.id).startsWith('fech')));
    },
  };
  if (L.status !== 'emitido') dd.watermark = { text: L.status === 'cancelado' ? 'CANCELADO' : 'RASCUNHO', color: '#b42318', opacity: 0.08, bold: true };
  const bytes = await new Promise((res, rej) => {
    try { pdfMake.createPdf(dd).getBuffer(b => res(new Uint8Array(b))); } catch (e) { rej(e); }
  });
  return { bytes, sigPos };
}

// ================================================================== campo de assinatura + selo (pdf-lib)
async function prepararAssinatura(bytes, sigPos, L) {
  const { PDFDocument, PDFName, PDFNumber, PDFHexString, PDFString, StandardFonts } = PDFLib;
  if (!sigPos) throw new Error('Não foi possível localizar a área do selo no PDF.');
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = pdf.context;
  const page = pdf.getPages()[sigPos.pageNumber - 1];
  const ph = page.getHeight();
  const x = sigPos.left, y = ph - sigPos.top - SIG.H;
  const fonte = await pdf.embedFont(StandardFonts.Helvetica);
  const negrito = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = SIG.W, H = SIG.H;
  // Selo: texto com marcadores de tamanho fixo que o assinador substitui (stream sem compressão)
  const ops = [
    'q', '0.95 0.97 1 rg', `0 0 ${W} ${H} re f`, '0.12 0.25 0.56 RG 0.8 w', `0.4 0.4 ${W - 0.8} ${H - 0.8} re S`,
    `BT /F2 7 Tf 0.12 0.25 0.56 rg 6 ${H - 11} Td (DOCUMENTO ASSINADO DIGITALMENTE) Tj ET`,
    `BT /F2 8.5 Tf 0 0 0 rg 6 ${H - 23} Td (${SIG.NOME}) Tj ET`,
    `BT /F1 7 Tf 0.2 0.2 0.2 rg 6 ${H - 33} Td (CPF: ${SIG.CPF}   Data: ${SIG.DATA}) Tj ET`,
    `BT /F1 6.5 Tf 0.25 0.25 0.25 rg 6 ${H - 43} Td (Certificado: ${SIG.EMISSOR}) Tj ET`,
    `BT /F1 6.5 Tf 0.35 0.35 0.35 rg 6 ${H - 54} Td (Laudo ${L.numero}, rev. ${L.revisao} - verifique em https://validar.iti.gov.br) Tj ET`,
    'Q',
  ].join('\n');
  const ap = ctx.stream(ops, {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, W, H],
    Resources: { Font: { F1: fonte.ref, F2: negrito.ref } },
  });
  const apRef = ctx.register(ap);
  const sig = ctx.obj({
    Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [PDFNumber.of(0), PDFName.of('**********'), PDFName.of('**********'), PDFName.of('**********')],
    Contents: PDFHexString.of('0'.repeat(SIG.CONTENTS * 2)),
    Reason: PDFHexString.fromText(`Assinatura do ${modeloDe(L).rotuloNumero} ${L.numero}`),
    M: PDFString.of(SIG.M),
  });
  const sigRef = ctx.register(sig);
  const widget = ctx.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: [x, y, x + W, y + H], V: sigRef,
    T: PDFString.of('AssinaturaResponsavel'), F: 132, P: page.ref, AP: { N: apRef },
  });
  const wRef = ctx.register(widget);
  page.node.addAnnot(wRef);
  pdf.catalog.set(PDFName.of('AcroForm'), ctx.obj({ SigFlags: 3, Fields: [wRef] }));
  return await pdf.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

// ================================================================== janela de assinatura
function abrirAssinatura() {
  const L = LD.cur;
  if (!L || !L.id) return ldErr('Salve o laudo antes de assinar.');
  if (LD.dirty) return ldErr('Salve as alterações antes de assinar.');
  let dlg = $('#sigDlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'sigDlg'; dlg.className = 'dlg dlg-wide noprint'; document.body.appendChild(dlg); }
  const hoje = toLocalInput(new Date()).slice(0, 10);
  dlg.innerHTML = `<form id="sf" novalidate>
    <h2>Assinar ${esc(modeloDe(L).rotuloNumero)} ${esc(L.numero)}</h2>
    <div class="seg">
      <label><input type="radio" name="modo" value="digital" checked> <b>Certificado digital</b><br><small>A1 ou A3 (token) instalado neste PC</small></label>
      <label><input type="radio" name="modo" value="fisica"> <b>Assinatura física</b><br><small>Imprimir, assinar à mão e enviar a digitalização</small></label>
    </div>
    <div class="dlg-row">
      <label>Responsável técnico <span id="sfNomeHint">(o nome sai do certificado)</span><input name="responsavel" value="${esc(rep.responsavel)}"></label>
      <label>Cargo *<input name="cargo" required value="${esc(rep.cargo)}"></label>
    </div>
    <div class="dlg-row">
      <label>Matrícula *<input name="matricula" required value="${esc(rep.matricula)}"></label>
      <label>Cidade<input name="cidade" value="${esc(rep.cidade)}"></label>
    </div>
    <div class="dlg-row"><label>Data<input type="date" name="data" value="${esc(rep.data || hoje)}"></label><span></span></div>
    <div id="sfInfo" class="note info" style="margin:0"></div>
    <p class="err" id="sfErr" hidden></p>
    <div class="dlg-actions">
      <button type="button" class="btn ghost" id="sfCancel">Cancelar</button>
      <button type="submit" class="btn" id="sfGo">Assinar</button>
    </div>
  </form>`;
  const f = $('#sf');
  const atualiza = () => {
    const dig = f.elements.modo.value === 'digital';
    $('#sfNomeHint').textContent = dig ? '(no selo vale o nome do certificado)' : '*';
    $('#sfGo').textContent = dig ? 'Assinar com certificado' : 'Imprimir para assinar';
    $('#sfInfo').innerHTML = dig
      ? 'O assinador do Windows vai abrir e pedir para escolher o certificado. Com token A3, o Windows pede o PIN. Na primeira vez, o navegador pergunta se pode abrir o "Assinador diag" — marque <b>sempre permitir</b>. <a href="download/" target="_blank">Instalar o Agente diag neste PC</a>.'
      : 'O laudo será impresso com as linhas de assinatura em branco. Depois de assinado, use <b>"Enviar via assinada"</b> no laudo para anexar a digitalização (PDF ou foto) como versão oficial.';
  };
  f.querySelectorAll('[name=modo]').forEach(r => r.addEventListener('change', atualiza));
  atualiza();
  const err = m => { const e = $('#sfErr'); e.textContent = m || ''; e.hidden = !m; };
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const v = n => f.elements[n].value.trim();
    const dig = f.elements.modo.value === 'digital';
    const falta = ['cargo', 'matricula', ...(dig ? [] : ['responsavel'])].find(n => !v(n));
    if (falta) { err('Preencha cargo, matrícula' + (dig ? '' : ' e responsável') + '.'); f.elements[falta].focus(); return; }
    Object.assign(rep, { responsavel: v('responsavel'), cargo: v('cargo'), matricula: v('matricula'), cidade: v('cidade'), data: v('data') });
    saveRep();
    L.assinatura = { responsavel: rep.responsavel, cargo: rep.cargo, matricula: rep.matricula, cidade: rep.cidade, data: rep.data };
    if (L.status !== 'emitido') L.status = 'emitido';
    LD.dirty = true;
    $('#sfGo').disabled = true; err('');
    try {
      if (!(await saveLaudo({ silent: true }))) { err($('#ldErr').textContent || 'Não foi possível salvar o laudo.'); $('#sfGo').disabled = false; return; }
      if (dig) await iniciarAssinaturaDigital(dlg, err);
      else {
        dlg.close();
        renderEditor();
        setPageFooter(`${modeloDe(LD.cur).titulo} – ${modeloDe(LD.cur).rotuloNumero} ${LD.cur.numero}`);
        setTimeout(async () => { await waitImages(); window.print(); }, 80);
      }
    } catch (ex) { console.error(ex); err(ex.message || String(ex)); $('#sfGo').disabled = false; }
  });
  $('#sfCancel').addEventListener('click', () => { pararPoll(); dlg.close(); });
  dlg.showModal();
}

async function iniciarAssinaturaDigital(dlg, err) {
  const L = LD.cur;
  $('#sfInfo').textContent = 'Gerando o PDF oficial...';
  const { bytes, sigPos } = await gerarPdfLaudo(L, { modo: 'digital' });
  const pronto = await prepararAssinatura(bytes, sigPos, L);
  const r = await api(`api/laudos/${encodeURIComponent(L.id)}/preparar`, { method: 'POST', body: pronto, headers: { 'Content-Type': 'application/pdf', 'X-Revisao': String(L.revisao) } }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok) throw new Error(j.erro || 'Falha ao enviar o PDF ao servidor.');
  const base = location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
  const link = `diagassina:${base}api/assinatura/${j.ticket}`;
  $('#sfInfo').innerHTML = `<b>Aguardando a assinatura no assinador do Windows...</b><br>
    Se nada abriu: <a href="${esc(link)}">abrir o assinador</a> · <a href="download/" target="_blank">instalar o Agente diag</a>.
    <br><small>O pedido vale por 15 minutos.</small>`;
  $('#sfGo').hidden = true;
  location.href = link;
  pararPoll();
  const inicio = Date.now();
  SIG.poll = setInterval(async () => {
    if (Date.now() - inicio > 15 * 60000) { pararPoll(); err('Tempo esgotado. Tente de novo.'); return; }
    const rr = await api('api/laudos/' + encodeURIComponent(L.id)).catch(() => null);
    if (!rr || !rr.ok) return;
    const atual = await rr.json();
    if (atual.assinaturaDigital) {
      pararPoll();
      LD.cur = atual; LD.dirty = false;
      dlg.close();
      renderEditor();
    }
  }, 2500);
}
function pararPoll() { if (SIG.poll) { clearInterval(SIG.poll); SIG.poll = null; } }

// ================================================================== via física digitalizada
function enviarDigitalizada() {
  const L = LD.cur;
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/pdf,image/jpeg,image/png';
  inp.addEventListener('change', async () => {
    const f = inp.files[0]; if (!f) return;
    if (!confirm(`Registrar "${f.name}" como a via assinada oficial do ${modeloDe(L).rotuloNumero} ${L.numero}? Depois disso o laudo fica travado.`)) return;
    const u8 = new Uint8Array(await f.arrayBuffer());
    const r = await api(`api/laudos/${encodeURIComponent(L.id)}/digitalizado`, { method: 'POST', body: u8, headers: {
      'Content-Type': f.type || 'application/octet-stream', 'X-Nome': encodeURIComponent(f.name), 'X-Sha256': await sha256Hex(u8), 'X-Revisao': String(L.revisao) } }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) return ldErr(j.erro || 'Falha ao enviar a via assinada.');
    LD.cur = j; LD.dirty = false; renderEditor();
  });
  inp.click();
}

// ================================================================== baixar PDF (sem assinatura)
async function baixarPdfLaudo() {
  const L = LD.cur;
  try {
    const { bytes } = await gerarPdfLaudo(L, { modo: 'fisica' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    a.download = `${(modeloDe(L).rotuloNumero || 'Laudo').replace(/\s*nº/i, '')}-${(L.numero || 'rascunho').replace('/', '-')}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) { ldErr('Falha ao gerar o PDF: ' + e.message); }
}

// faixa exibida no editor quando o laudo já está assinado
function faixaAssinatura(L) {
  const d = L.assinaturaDigital, f = L.assinaturaFisica;
  if (d) return `<div class="panel sig-ok noprint"><div><b>Assinado digitalmente</b> ·
      ${d.assinaturas.map(s => `${esc(s.nome)}${s.cpf ? ' (CPF ' + esc(s.cpf) + ')' : ''} em ${fmt(new Date(s.data || d.recebidoEm))} · ${esc(s.emissor || '')}`).join('<br>')}
      <br><small>SHA-256 do PDF assinado: <span class="mono">${esc(d.sha256)}</span> · integridade e assinatura conferidas pelo servidor. A cadeia ICP-Brasil pode ser validada em validar.iti.gov.br.</small></div>
      <a class="btn" href="api/laudos/${encodeURIComponent(L.id)}/assinado${srv.token ? '?token=' + encodeURIComponent(srv.token) : ''}">Baixar PDF assinado</a></div>`;
  if (f) return `<div class="panel sig-ok noprint"><div><b>Via física assinada registrada</b> · ${esc(f.nome)} · ${tamanhoTxt(f.tamanho)} · enviada em ${fmt(new Date(f.recebidoEm))}
      <br><small>SHA-256 <span class="mono">${esc(f.sha256)}</span></small></div>
      <a class="btn" href="api/laudos/${encodeURIComponent(L.id)}/digitalizado${srv.token ? '?token=' + encodeURIComponent(srv.token) : ''}">Baixar via assinada</a></div>`;
  return '';
}

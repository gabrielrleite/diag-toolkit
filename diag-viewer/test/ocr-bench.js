'use strict';
/*
  Teste de precisão do OCR das folhas de recebimento (não faz parte dos testes rápidos: precisa de navegador).

  Gera folhas sintéticas parecidas com fotos (tabela, letra irregular em várias fontes, sombra, ruído,
  leve rotação e JPEG), passa pelo mesmo caminho do sistema (detecção da grade, OCR de cada célula,
  interpretação) e mede o acerto de SELB, Data e Local.

  Uso (com o servidor rodando e o Playwright instalado):
    READ_TOKEN=... node diag-viewer/test/ocr-bench.js [url] [modos] [folhas]
    url    padrão http://127.0.0.1:8080
    modos  separados por vírgula: antes, base, multi, e os mesmos com "+lista" (simula locais e
           histórico de SELBs já cadastrados). Padrão: antes,base,antes+lista,multi+lista
    folhas padrão 4 (16-17 linhas preenchidas por folha)
  ERROS=1 mostra exemplos de leituras erradas. As fontes usadas são as do sistema (Linux: FreeSerif,
  DejaVu, Caladea, Carlito); outras fontes mudam os números.
*/
const { chromium } = require('playwright');
(async () => {
  const URL0 = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/$/, '');
  const modos = (process.argv[3] || 'antes,base,antes+lista,multi+lista').split(','), nFolhas = +(process.argv[4] || 4);
  const b = await chromium.launch(); const p = await b.newPage();
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  await p.goto(URL0 + '/'); await p.evaluate(t => sessionStorage.setItem('diagReadToken', t), process.env.READ_TOKEN || '');
  await p.reload(); await p.waitForTimeout(500);
  const res = await p.evaluate(async ({ modos, nFolhas }) => {
    let seed = 12345; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647; const pick = a => a[Math.floor(rnd() * a.length)];
    const LOCAIS = ['ALMOXARIFADO', 'RECEPÇÃO', 'SALA 12', 'DIRETORIA', 'LABORATÓRIO 3', 'BIBLIOTECA', 'SECRETARIA', 'SALA 204 BLOCO B', 'AUDITÓRIO', 'TI', 'FINANCEIRO', 'COORDENAÇÃO'];
    const FONTES = ['italic FreeSerif', 'FreeSerif', 'italic DejaVu Serif', 'DejaVu Sans', 'italic Caladea', 'Carlito', 'italic Carlito', 'FreeSans'];
    const selb = () => pick(['A', 'B', 'C', 'D', 'F', 'P', 'T']) + String(Math.floor(10 + rnd() * 9990));
    const folhas = [];
    for (let fo = 0; fo < nFolhas; fo++) {
      const W = 2000, H = 1300, pesos = COLS.map(c => c.peso), tot = pesos.reduce((a, b) => a + b, 0);
      const xs = [0]; pesos.forEach(pp => xs.push(xs[xs.length - 1] + pp / tot * W));
      const nR = 21, rh = H / nR;
      const c = document.createElement('canvas'); c.width = W + 200; c.height = H + 200;
      const x = c.getContext('2d');
      const grad = x.createLinearGradient(0, 0, c.width, c.height); grad.addColorStop(0, '#f2f1ec'); grad.addColorStop(1, '#c9c8c2');
      x.fillStyle = grad; x.fillRect(0, 0, c.width, c.height);
      x.save(); x.translate(100, 100); x.rotate((rnd() - 0.5) * 0.04);
      x.strokeStyle = '#222'; x.lineWidth = 3;
      for (let r = 0; r <= nR; r++) { x.beginPath(); x.moveTo(0, r * rh); x.lineTo(W, r * rh); x.stroke(); }
      for (const xx of xs) { x.beginPath(); x.moveTo(xx, 0); x.lineTo(xx, H); x.stroke(); }
      x.fillStyle = '#111'; x.font = 'bold 26px DejaVu Sans'; x.textAlign = 'center';
      COLS.forEach((cc, i) => x.fillText(cc.rotulo.toUpperCase(), (xs[i] + xs[i + 1]) / 2, rh * 0.68));
      x.textAlign = 'left';
      const verdade = [];
      for (let r = 1; r < nR; r++) {
        if (rnd() < 0.15) continue; // linha vazia
        const sel = rnd() < 0.2 ? selb() + ', ' + selb() : selb();
        const d = 1 + Math.floor(rnd() * 28), m = 1 + Math.floor(rnd() * 12);
        const data = String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0') + '/' + (rnd() < 0.3 ? '26' : '2026');
        let loc = pick(LOCAIS); if (rnd() < 0.5) loc = loc.toLowerCase().replace(/(^|\s)\S/g, t => t.toUpperCase());
        const vals = { selb: sel, data, local: loc, cpf: '123.456.789-0' + (r % 10), nome: 'Fulano ' + r };
        verdade.push({ r, selb: sel, data, local: loc });
        const fonte = pick(FONTES), tinta = pick(['#14205a', '#1b1b1b', '#0d3a8a']);
        COLS.forEach((cc, i) => {
          const t = vals[cc.k]; const base = r * rh + rh * (0.72 + (rnd() - 0.5) * 0.12);
          let fs = rh * (0.5 + rnd() * 0.15);
          // cabe na célula (quem escreve à mão diminui a letra)
          x.font = `${Math.round(fs)}px ${fonte}`; const larg = x.measureText(t).width * 1.12, disp = xs[i + 1] - xs[i] - 24;
          if (larg > disp) fs *= disp / larg;
          let off = xs[i] + 8 + rnd() * Math.max(2, Math.min(15, disp - Math.min(larg, disp)));
          for (const ch of t) {
            x.save(); x.translate(off, base + (rnd() - 0.5) * fs * 0.18); x.rotate((rnd() - 0.5) * 0.3);
            x.font = `${Math.round(fs * (0.88 + rnd() * 0.24))}px ${fonte}`; x.fillStyle = tinta; x.strokeStyle = tinta; x.lineWidth = rnd() * 1.2;
            x.fillText(ch, 0, 0); if (x.lineWidth > 0.5) x.strokeText(ch, 0, 0);
            off += x.measureText(ch).width * (0.92 + rnd() * 0.2); x.restore();
          }
        });
      }
      x.restore();
      // ruído e JPEG (como foto)
      const id = x.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < id.data.length; i += 4) { const n = (rnd() - 0.5) * 24; id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n; }
      x.putImageData(id, 0, 0);
      const im = new Image(); im.src = c.toDataURL('image/jpeg', 0.75); await im.decode();
      const c2 = document.createElement('canvas'); c2.width = im.width; c2.height = im.height; c2.getContext('2d').drawImage(im, 0, 0);
      folhas.push({ canvas: c2, verdade });
    }
    const w = await ocrWorker();
    const N = RecebOCR.normalizar;
    // regras de interpretação da versão anterior (main), para comparar
    const dataAntiga = (s0, anoPadrao = new Date().getFullYear()) => {
      const t = String(s0 || '').replace(/[OoQD]/g, '0').replace(/[Il|i]/g, '1');
      let m = t.match(/(\d{1,2})\s*[/.\-\\]\s*(\d{1,2})(?:\s*[/.\-\\]\s*(\d{2,4}))?/);
      if (!m) { const d = t.replace(/\D/g, ''); if (d.length === 8 || d.length === 6) m = [d, d.slice(0, 2), d.slice(2, 4), d.slice(4)]; else if (d.length === 4) m = [d, d.slice(0, 2), d.slice(2, 4), '']; }
      if (!m) return '';
      const dia = +m[1], mes = +m[2]; let ano = m[3] ? +m[3] : anoPadrao; if (ano < 100) ano += 2000;
      const dt = new Date(ano, mes - 1, dia); const p2 = n => String(n).padStart(2, '0');
      return mes >= 1 && mes <= 12 && dt.getDate() === dia && ano >= 2000 && ano <= 2100 ? `${ano}-${p2(mes)}-${p2(dia)}` : '';
    };
    const selbsAntigos = t => String(t || '').replace(/\s+e\s+/gi, ',').split(/[,;+|\n]+/).map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean)
      .flatMap(p0 => { const q = p0.split(' '); return q.length > 1 && q.every(x => x.length >= 3 && /\d/.test(x)) ? q : [p0]; });
    const out = {};
    for (const modo of modos) {
      const historico = Array.from({ length: 40 }, selb);
      const antes = modo.startsWith('antes');
      RB.vocab = modo.includes('lista') ? { local: LOCAIS, selb: historico } : null;
      RB.formatoSelb = RB.vocab ? RecebOCR.formatoSelb(RB.vocab.selb) : null;
      const acc = { selb: [0, 0], data: [0, 0], local: [0, 0] }, erros = [];
      const t0 = performance.now(); let leituras = 0;
      for (const fo of folhas) {
        const g = RecebOCR.cinza(fo.canvas.getContext('2d').getImageData(0, 0, fo.canvas.width, fo.canvas.height).data, fo.canvas.width, fo.canvas.height);
        const cantos = RecebOCR.detectarCantos(g), giro = escolherGiro(g, cantos);
        const R = RecebOCR.retificar(g, cantos, giro), G = RecebOCR.analisarGrade(R);
        for (const [ci, cc] of COLS.entries()) {
          if (!cc.ler) continue;
          await w.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: cc.wl, preserve_interword_spaces: '1' });
          for (const v of fo.verdade) {
            if (v.r + 1 >= G.rows.length) continue;
            const q = RecebOCR.celula(G, v.r, ci), t = RecebOCR.tinta(G, R, q);
            acc[cc.k][1]++;
            if (!RecebOCR.temConteudo(t)) { erros.push(`${cc.k}: "${v[cc.k]}" -> (vazio)`); continue; }
            const lido = await lerCelula(w, R, G, { q, t }, cc.k, /^(base|antes)/.test(modo) ? 'base' : 'multi'); leituras++;
            let ok;
            if (cc.k === 'data') ok = (antes ? dataAntiga(lido.texto) : RecebOCR.limparData(lido.texto).iso) === RecebOCR.limparData(v.data).iso;
            else if (cc.k === 'selb' && antes) ok = selbsAntigos(RecebOCR.limparTexto(lido.texto).toUpperCase()).map(RecebOCR.chaveSelb).join(',') === selbsDe(v.selb.toUpperCase()).map(RecebOCR.chaveSelb).join(',');
            else if (cc.k === 'selb') ok = selbsDe(RecebOCR.limparTexto(lido.texto).toUpperCase()).map(z => RecebOCR.chaveSelb(RecebOCR.ajustarAoFormato(z, RB.formatoSelb))).join(',') === selbsDe(v.selb.toUpperCase()).map(RecebOCR.chaveSelb).join(',');
            else {
              let tx = RecebOCR.limparTexto(lido.texto);
              if (RB.vocab) { const sg = RecebOCR.sugerir(tx, RB.vocab.local, 0.7); if (sg) tx = sg.valor; }
              ok = N(tx) === N(v.local);
            }
            if (ok) acc[cc.k][0]++; else if (erros.length < 400) erros.push(`${cc.k}: "${v[cc.k]}" -> "${lido.texto}" (${lido.conf}% ${lido.versao})`);
          }
        }
      }
      out[modo] = { acc, seg: Math.round((performance.now() - t0) / 1000), erros: erros.slice(0, 12) };
    }
    return out;
  }, { modos, nFolhas });
  for (const [m, r] of Object.entries(res)) {
    const pct = k => `${k} ${r.acc[k][0]}/${r.acc[k][1]} (${Math.round(r.acc[k][0] / r.acc[k][1] * 100)}%)`;
    const tot = ['selb', 'data', 'local'].reduce((a, k) => [a[0] + r.acc[k][0], a[1] + r.acc[k][1]], [0, 0]);
    console.log(`${m.padEnd(12)} total ${Math.round(tot[0] / tot[1] * 100)}% · ${pct('selb')} · ${pct('data')} · ${pct('local')} · ${r.seg}s`);
    if (process.env.ERROS) r.erros.forEach(e => console.log('   ', e));
  }
  await b.close();
})();

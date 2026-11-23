'use strict';
/*
  Leitura de folhas de recebimento (tabela com linhas): processamento de imagem sem dependências.
  Tudo trabalha com imagens em tons de cinza { g: Uint8Array, w, h } para poder ser testado no Node.

  Fluxo:
    1. detectarCantos(): acha a grade (maior componente de linhas finas) e devolve os 4 cantos.
    2. retificar(): corrige perspectiva/rotação (homografia) para um retângulo.
    3. analisarGrade(): acha linhas e colunas na imagem retificada (refinando por faixa, porque a folha curva).
    4. celula()/tinta(): recorte de cada célula e se ela tem algo escrito.
  O OCR em si (Tesseract) fica em recebimentos.js.
*/
const RecebOCR = (() => {
  // ---------------------------------------------------------------- utilitários de imagem
  function cinza(rgba, w, h) {
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    return { g, w, h };
  }

  function reduzir(img, maxLado) {
    const f = Math.min(1, maxLado / Math.max(img.w, img.h));
    if (f >= 1) return { img, f: 1 };
    const w = Math.max(1, Math.round(img.w * f)), h = Math.max(1, Math.round(img.h * f));
    const g = new Uint8Array(w * h), inv = 1 / f;
    // média por caixa (evita perder linhas finas ao reduzir)
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y * inv), y1 = Math.max(y0 + 1, Math.min(img.h, Math.floor((y + 1) * inv)));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x * inv), x1 = Math.max(x0 + 1, Math.min(img.w, Math.floor((x + 1) * inv)));
        let s = 0, n = 0, mn = 255;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const v = img.g[yy * img.w + xx]; s += v; n++; if (v < mn) mn = v; }
        // puxa para o mais escuro: preserva traço fino
        g[y * w + x] = n ? ((s / n) + mn) >> 1 : 255;
      }
    }
    return { img: { g, w, h }, f };
  }

  // limiar adaptativo pela média local (imagem integral). 1 = tinta
  function binarizar(img, janela, C = 12) {
    const { g, w, h } = img;
    const W = w + 1, I = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = 0; x < w; x++) { s += g[y * w + x]; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + s; }
    }
    const r = Math.max(4, janela >> 1), b = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const soma = I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
        const media = soma / ((x1 - x0) * (y1 - y0));
        b[y * w + x] = g[y * w + x] < media - C ? 1 : 0;
      }
    }
    return b;
  }

  // pixels de linha: corrida longa numa direção e fina na outra (exclui borda do papel, manchas, texto)
  function mascarasLinhas(b, w, h, minH, minV, maxEsp) {
    const hm = new Uint8Array(w * h), vm = new Uint8Array(w * h);
    const espV = new Uint8Array(w * h), espH = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) {
      let y = 0;
      while (y < h) {
        if (!b[y * w + x]) { y++; continue; }
        let e = y; while (e < h && b[e * w + x]) e++;
        const n = Math.min(255, e - y);
        for (let k = y; k < e; k++) espV[k * w + x] = n;
        y = e;
      }
    }
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        if (!b[y * w + x]) { x++; continue; }
        let e = x; while (e < w && b[y * w + e]) e++;
        const n = Math.min(255, e - x);
        for (let k = x; k < e; k++) espH[y * w + k] = n;
        x = e;
      }
    }
    // segue a linha permitindo desvio de 1 px por passo (foto inclinada) e falhas de até 3 px
    const seguir = (horiz, min, out) => {
      const L = horiz ? w : h, T = horiz ? h : w, esp = horiz ? espV : espH;
      const idx = horiz ? (a, t) => t * w + a : (a, t) => a * w + t;
      const ok = (a, t) => t >= 0 && t < T && b[idx(a, t)] && esp[idx(a, t)] <= maxEsp;
      const vis = new Uint8Array(w * h), cam = [];
      for (let t0 = 0; t0 < T; t0++) for (let a0 = 0; a0 < L; a0++) {
        const i0 = idx(a0, t0);
        if (vis[i0] || !ok(a0, t0)) continue;
        cam.length = 0; cam.push(i0); vis[i0] = 1;
        let t = t0, gap = 0, ult = a0;
        for (let a = a0 + 1; a < L && gap <= 3; a++) {
          const nt = ok(a, t) ? t : ok(a, t - 1) ? t - 1 : ok(a, t + 1) ? t + 1 : -1;
          if (nt < 0) { gap++; continue; }
          t = nt; gap = 0; ult = a;
          const i = idx(a, t); cam.push(i); vis[i] = 1;
        }
        if (ult - a0 + 1 >= min) for (const i of cam) out[i] = 1;
      }
    };
    seguir(true, minH, hm);
    seguir(false, minV, vm);
    return { hm, vm };
  }

  // ---------------------------------------------------------------- 1. cantos da grade
  function detectarCantos(imgOrig) {
    const { img, f } = reduzir(imgOrig, 1100);
    const { w, h } = img;
    const b = binarizar(img, Math.round(Math.max(w, h) / 40), 10);
    const minRun = Math.round(Math.max(w, h) / 25);
    const { hm, vm } = mascarasLinhas(b, w, h, minRun, minRun, Math.max(3, Math.round(Math.max(w, h) / 220)));
    // une as máscaras com dilatação 1 px para conectar cruzamentos
    const m = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (hm[i] || vm[i] || hm[i - 1] || hm[i + 1] || vm[i - w] || vm[i + w]) m[i] = 1;
    }
    // maior componente conexo, pontuado pelo comprimento de linhas nas DUAS direções
    const lab = new Int32Array(w * h), pilha = new Int32Array(w * h);
    let melhor = null, id = 0;
    for (let s = 0; s < m.length; s++) {
      if (!m[s] || lab[s]) continue;
      id++;
      let sp = 0, nh = 0, nv = 0, n = 0;
      let tl = [0, 0, Infinity], tr = [0, 0, -Infinity], br = [0, 0, -Infinity], bl = [0, 0, -Infinity];
      pilha[sp++] = s; lab[s] = id;
      while (sp) {
        const i = pilha[--sp], x = i % w, y = (i / w) | 0;
        n++; if (hm[i]) nh++; if (vm[i]) nv++;
        if (x + y < tl[2]) tl = [x, y, x + y];
        if (x - y > tr[2]) tr = [x, y, x - y];
        if (x + y > br[2]) br = [x, y, x + y];
        if (y - x > bl[2]) bl = [x, y, y - x];
        for (const j of [i - 1, i + 1, i - w, i + w]) if (j >= 0 && j < m.length && m[j] && !lab[j]) { lab[j] = id; pilha[sp++] = j; }
      }
      const score = Math.min(nh, nv);
      if (!melhor || score > melhor.score) melhor = { score, tl, tr, br, bl, n };
    }
    if (!melhor || melhor.score < minRun * 4) return null;
    const p = q => [q[0] / f, q[1] / f];
    return [p(melhor.tl), p(melhor.tr), p(melhor.br), p(melhor.bl)];
  }

  // ---------------------------------------------------------------- 2. homografia
  function resolver(A, bb) { // eliminação de Gauss (8x8)
    const n = bb.length, M = A.map((r, i) => [...r, bb[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) return null;
      for (let r = 0; r < n; r++) if (r !== c) { const k = M[r][c] / M[c][c]; for (let k2 = c; k2 <= n; k2++) M[r][k2] -= k * M[c][k2]; }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  // matriz que leva pontos de "de" para "para" (4 pares)
  function homografia(de, para) {
    const A = [], bb = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = de[i], [u, v] = para[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); bb.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); bb.push(v);
    }
    const s = resolver(A, bb);
    return s && [...s, 1];
  }
  const aplicar = (H, x, y) => { const d = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d]; };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  // cantos em ordem horária a partir do canto que vira o superior esquerdo (giro = 0..3)
  function cantosGirados(c, giro) { return [0, 1, 2, 3].map(i => c[(i + giro) % 4]); }

  function retificar(img, cantos, giro = 0, maxLado = 2200, escala = 1.4) {
    const c = cantosGirados(cantos, giro);
    let W = (dist(c[0], c[1]) + dist(c[3], c[2])) / 2 * escala, Hh = (dist(c[0], c[3]) + dist(c[1], c[2])) / 2 * escala;
    const k = Math.min(1, maxLado / Math.max(W, Hh)); W = Math.round(W * k); Hh = Math.round(Hh * k);
    const H = homografia([[0, 0], [W, 0], [W, Hh], [0, Hh]], c);
    if (!H) return null;
    const out = new Uint8Array(W * Hh), { g, w, h } = img;
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      const [sx, sy] = aplicar(H, x + 0.5, y + 0.5);
      const x0 = Math.floor(sx - 0.5), y0 = Math.floor(sy - 0.5), fx = sx - 0.5 - x0, fy = sy - 0.5 - y0;
      if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) { out[y * W + x] = 255; continue; }
      const i = y0 * w + x0;
      out[y * W + x] = (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
    }
    return { g: out, w: W, h: Hh, H };
  }

  // ---------------------------------------------------------------- 3. grade na imagem retificada
  function picos(perfil, limiar, distMin) {
    const n = perfil.length, s = new Float64Array(n);
    for (let i = 0; i < n; i++) { let a = 0; for (let k = -2; k <= 2; k++) a += perfil[Math.min(n - 1, Math.max(0, i + k))] || 0; s[i] = a / 5; }
    const cand = [];
    for (let i = 0; i < n; i++) if (s[i] >= limiar && s[i] >= (s[i - 1] || 0) && s[i] >= (s[i + 1] || 0)) cand.push(i);
    cand.sort((a, b) => s[b] - s[a]);
    const ok = [];
    for (const c of cand) if (ok.every(o => Math.abs(o - c) >= distMin)) ok.push(c);
    return ok.sort((a, b) => a - b);
  }
  const mediana = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

  // completa linhas que faltaram (intervalo ~2x a mediana) e descarta as muito próximas
  function regularizar(pos, minGap) {
    if (pos.length < 3) return pos;
    const gaps = pos.slice(1).map((p, i) => p - pos[i]), med = mediana(gaps);
    const out = [pos[0]];
    for (let i = 1; i < pos.length; i++) {
      const g = pos[i] - out[out.length - 1];
      if (g < Math.max(minGap, med * 0.45)) continue;
      const n = Math.round(g / med);
      if (i > 1 && n >= 2 && Math.abs(g / n - med) < med * 0.2) for (let k = 1; k < n; k++) out.push(Math.round(out[out.length - 1] + g / n));
      out.push(pos[i]);
    }
    return out;
  }

  function analisarGrade(R) {
    const { w, h } = R;
    const b = binarizar(R, Math.round(Math.max(w, h) / 45), 10);
    const maxEsp = Math.max(4, Math.round(Math.max(w, h) / 250));
    const { hm, vm } = mascarasLinhas(b, w, h, Math.round(w / 40), Math.round(h / 40), maxEsp);
    // colunas: projeção vertical
    const pv = new Float64Array(w), ph = new Float64Array(h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (vm[i]) pv[x]++; if (hm[i]) ph[y]++; }
    let cols = picos(pv, h * 0.25, w / 40);
    let rows = regularizar(picos(ph, w * 0.25, h / 80), h / 80);
    // garante bordas
    if (!cols.length || cols[0] > w * 0.04) cols.unshift(0);
    if (cols[cols.length - 1] < w * 0.96) cols.push(w - 1);
    if (!rows.length || rows[0] > h * 0.04) rows.unshift(0);
    if (rows[rows.length - 1] < h * 0.96) rows.push(h - 1);

    // refino por faixa: a folha curva, então cada linha é localizada dentro de cada coluna (e vice-versa)
    const gapR = mediana(rows.slice(1).map((r, i) => r - rows[i])) || h / 20;
    const gapC = mediana(cols.slice(1).map((c, i) => c - cols[i])) || w / 5;
    const Y = rows.map(() => []), X = cols.map(() => []);
    for (let c = 0; c + 1 < cols.length; c++) {
      const x0 = cols[c] + 2, x1 = cols[c + 1] - 2, perf = new Float64Array(h);
      for (let y = 0; y < h; y++) { let s = 0; for (let x = x0; x < x1; x++) s += hm[y * w + x]; perf[y] = s; }
      rows.forEach((r, i) => {
        const raio = Math.round(gapR * 0.3);
        let best = r, bv = -1;
        for (let y = Math.max(0, r - raio); y <= Math.min(h - 1, r + raio); y++) if (perf[y] > bv) { bv = perf[y]; best = y; }
        Y[i][c] = bv > (x1 - x0) * 0.3 ? best : r;
      });
    }
    for (let r = 0; r + 1 < rows.length; r++) {
      const y0 = rows[r] + 2, y1 = rows[r + 1] - 2, perf = new Float64Array(w);
      for (let x = 0; x < w; x++) { let s = 0; for (let y = y0; y < y1; y++) s += vm[y * w + x]; perf[x] = s; }
      cols.forEach((c, i) => {
        const raio = Math.round(Math.min(gapC * 0.25, gapR));
        let best = c, bv = -1;
        for (let x = Math.max(0, c - raio); x <= Math.min(w - 1, c + raio); x++) if (perf[x] > bv) { bv = perf[x]; best = x; }
        X[i][r] = bv > (y1 - y0) * 0.3 ? best : c;
      });
    }
    return { rows, cols, Y, X, hm, vm, bin: b, esp: maxEsp };
  }

  // retângulo interno da célula (linha r, coluna c), já descontando a espessura das linhas
  function celula(G, r, c) {
    const yTop = Math.max(G.Y[r][c], G.Y[r][c] ?? G.rows[r]), yBot = G.Y[r + 1][c] ?? G.rows[r + 1];
    const xL = G.X[c][r] ?? G.cols[c], xR = G.X[c + 1][r] ?? G.cols[c + 1];
    const m = G.esp + 2;
    return { x: xL + m, y: yTop + m, w: Math.max(1, xR - xL - 2 * m), h: Math.max(1, yBot - yTop - 2 * m) };
  }

  // fração de tinta (sem os restos de linha) e caixa do conteúdo
  // tinta = bem mais escuro que o fundo da própria célula (sombra e granulado da foto não contam)
  function tinta(G, R, q) {
    // fundo estimado em fatias da largura de uma altura de célula (a sombra da foto varia ao longo da linha)
    const fatia = Math.max(8, q.h), hist = new Uint32Array(256), m = new Uint8Array(q.w * q.h);
    for (let fx = q.x; fx < q.x + q.w; fx += fatia) {
      const fw = Math.min(fatia, q.x + q.w - fx);
      hist.fill(0);
      for (let y = q.y; y < q.y + q.h; y++) for (let x = fx; x < fx + fw; x++) hist[R.g[y * R.w + x]]++;
      let acc = 0, fundo = 255;
      const meio = fw * q.h * 0.6; // percentil 60: o fundo domina mesmo com escrita
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= meio) { fundo = v; break; } }
      const lim = fundo - Math.max(40, fundo * 0.28);
      for (let y = q.y; y < q.y + q.h; y++) for (let x = fx; x < fx + fw; x++) {
        const i = y * R.w + x;
        if (R.g[i] < lim && !G.hm[i] && !G.vm[i]) m[(y - q.y) * q.w + (x - q.x)] = 1;
      }
    }
    // só conta pixel de traço (com 2+ vizinhos de tinta): granulado isolado da foto fica de fora
    const porCol = new Uint32Array(q.w);
    let n = 0, y0 = Infinity, y1 = -1;
    const traco = new Uint8Array(q.w * q.h);
    for (let y = 1; y < q.h - 1; y++) for (let x = 1; x < q.w - 1; x++) {
      const i = y * q.w + x;
      if (!m[i]) continue;
      const viz = m[i - 1] + m[i + 1] + m[i - q.w] + m[i + q.w] + m[i - q.w - 1] + m[i - q.w + 1] + m[i + q.w - 1] + m[i + q.w + 1];
      if (viz < 2) continue;
      traco[i] = 1; porCol[x]++;
    }
    // agrupa colunas em blocos separados por espaço grande; descarta blocos pequenos (pontos, sujeira)
    const blocos = [];
    for (let x = 0, gap = Infinity; x < q.w; x++) {
      if (!porCol[x]) { gap++; continue; }
      if (gap > q.h * 0.9 || !blocos.length) blocos.push({ a: x, b: x, n: 0 });
      const bl = blocos[blocos.length - 1]; bl.b = x; bl.n += porCol[x]; gap = 0;
    }
    const maior = blocos.reduce((a, b) => Math.max(a, b.n), 0);
    const bons = blocos.filter(bl => bl.n >= Math.max(25, maior * 0.08));
    const x0r = bons.length ? bons[0].a : 0, x1r = bons.length ? bons[bons.length - 1].b : -1;
    for (let y = 0; y < q.h; y++) for (let x = x0r; x <= x1r; x++) {
      if (!traco[y * q.w + x] || !bons.some(bl => x >= bl.a && x <= bl.b)) continue;
      n++; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const x0 = x0r + q.x, x1 = x1r + q.x; y0 += q.y; y1 += q.y;
    return { frac: n / (q.w * q.h), n, caixa: n ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null };
  }
  const temConteudo = t => t.n > 30 && t.frac > 0.004 && t.caixa && t.caixa.w > 6 && t.caixa.h > 6;

  // ---------------------------------------------------------------- orientação
  // pesos esperados das colunas (proporção da largura) para escolher entre 0° e 180°
  function scoreLarguras(cols, esperado) {
    if (!esperado || cols.length - 1 !== esperado.length) return 0;
    const tot = cols[cols.length - 1] - cols[0], soma = esperado.reduce((a, b) => a + b, 0);
    const d = cols.slice(1).map((c, i) => (c - cols[i]) / tot);
    return -d.reduce((a, v, i) => a + Math.abs(v - esperado[i] / soma), 0);
  }

  // ---------------------------------------------------------------- pós-processamento do texto
  function cpfValido(d) {
    if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
    for (const t of [9, 10]) {
      let s = 0; for (let i = 0; i < t; i++) s += +d[i] * (t + 1 - i);
      if (((s * 10) % 11) % 10 !== +d[t]) return false;
    }
    return true;
  }
  const CONF_DIG = { O: '0', o: '0', Q: '0', D: '0', I: '1', l: '1', i: '1', '|': '1', Z: '2', z: '2', S: '5', s: '5', B: '8', G: '6', b: '6', g: '9', q: '9', T: '7' };
  const soDigitos = s => String(s || '').replace(/[OoQDIli|ZzSsBGbgqT]/g, c => CONF_DIG[c]).replace(/\D/g, '');
  function limparCpf(s) {
    const d = soDigitos(s);
    if (d.length !== 11) return { valor: String(s || '').trim(), ok: false, digitos: d };
    return { valor: `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`, ok: cpfValido(d), digitos: d };
  }
  function limparData(s, anoPadrao = new Date().getFullYear()) {
    const t = String(s || '').replace(/[OoQD]/g, '0').replace(/[Il|i]/g, '1');
    let m = t.match(/(\d{1,2})\s*[/.\-\\]\s*(\d{1,2})(?:\s*[/.\-\\]\s*(\d{2,4}))?/);
    if (!m) { const d = t.replace(/\D/g, ''); if (d.length === 8 || d.length === 6) m = [d, d.slice(0, 2), d.slice(2, 4), d.slice(4)]; else if (d.length === 4) m = [d, d.slice(0, 2), d.slice(2, 4), '']; }
    if (!m) return { valor: String(s || '').trim(), ok: false, iso: '' };
    const dia = +m[1], mes = +m[2];
    let ano = m[3] ? +m[3] : anoPadrao;
    if (ano < 100) ano += 2000;
    const dt = new Date(ano, mes - 1, dia);
    const ok = mes >= 1 && mes <= 12 && dt.getDate() === dia && ano >= 2000 && ano <= 2100;
    const p = n => String(n).padStart(2, '0');
    return ok ? { valor: `${p(dia)}/${p(mes)}/${ano}`, ok: true, iso: `${ano}-${p(mes)}-${p(dia)}` } : { valor: String(s || '').trim(), ok: false, iso: '' };
  }
  function limparTexto(s) {
    return String(s || '').replace(/[|_[\]{}<>~^`"“”]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.,;:'\-]+|[\s.,;:'\-]+$/g, '').trim();
  }

  // ---------------------------------------------------------------- correção pela lista de valores conhecidos
  const normalizar = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  function levenshtein(a, b) {
    if (a === b) return 0;
    let ant = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(ant[j] + 1, cur[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      ant = cur;
    }
    return ant[b.length];
  }
  // 0..1 (1 = igual), ignorando acentos, caixa, pontuação e espaços
  function similaridade(a, b) {
    const x = normalizar(a).replace(/ /g, ''), y = normalizar(b).replace(/ /g, '');
    if (!x || !y) return 0;
    return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  }
  // melhor valor da lista parecido com o texto lido (ou null)
  function sugerir(texto, lista, minimo = 0.72) {
    let melhor = null;
    for (const v of lista) { const s = similaridade(texto, v); if (s >= minimo && (!melhor || s > melhor.sim)) melhor = { valor: v, sim: s }; }
    return melhor;
  }

  // ---------------------------------------------------------------- vários SELBs na mesma entrega
  // Separadores: vírgula, ponto e vírgula, "+", "|", quebra de linha e " e ". Espaço só separa quando
  // todas as partes parecem SELB completos (3+ caracteres com dígito): "A123 A124" -> 2, "B7 7" -> 1.
  const chaveSelb = t => normalizar(t).replace(/ /g, '');
  function separarSelbs(t) {
    const partes = String(t || '').replace(/\s+e\s+/gi, ',').split(/[,;+|\n]+/)
      .map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean)
      .flatMap(p => { const q = p.split(' '); return q.length > 1 && q.every(x => x.length >= 3 && /\d/.test(x)) ? q : [p]; });
    const vistos = new Set();
    return partes.filter(p => { const k = chaveSelb(p); if (!k || vistos.has(k)) return false; vistos.add(k); return true; });
  }
  const juntarSelbs = lista => lista.join(', ');
  const temSelb = (campo, selb) => { const k = chaveSelb(selb); return !!k && separarSelbs(campo).some(x => chaveSelb(x) === k); };

  return {
    normalizar, similaridade, sugerir, chaveSelb, separarSelbs, juntarSelbs, temSelb,
    cinza, reduzir, binarizar, mascarasLinhas, detectarCantos, homografia, aplicar, cantosGirados, retificar,
    analisarGrade, celula, tinta, temConteudo, scoreLarguras, cpfValido, limparCpf, limparData, limparTexto, soDigitos,
  };
})();
if (typeof module !== 'undefined') module.exports = RecebOCR;

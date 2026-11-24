'use strict';
/*
  Cliente SNMP mínimo (v2c com GetBulk; v1 com GetNext como alternativa), sem dependências,
  e a leitura dos suprimentos de impressora pela Printer MIB (RFC 3805):
    prtMarkerSuppliesTable  1.3.6.1.2.1.43.11.1.1   (classe, tipo, descrição, capacidade, nível, cor)
    prtMarkerColorantTable  1.3.6.1.2.1.43.12.1.1.4 (nome da cor: black, cyan, ...)
    hrDeviceDescr           1.3.6.1.2.1.25.3.2.1.3  (modelo)
    prtGeneralSerialNumber  1.3.6.1.2.1.43.5.1.1.17 (nº de série)
*/
const dgram = require('dgram');
const crypto = require('crypto');

// ------------------------------------------------------------------ BER
function len(n) {
  if (n < 128) return Buffer.from([n]);
  const b = []; while (n > 0) { b.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag, v) => Buffer.concat([Buffer.from([tag]), len(v.length), v]);
function int(n) {
  const b = [];
  do { b.unshift(n & 0xff); n = Math.floor(n / 256); } while (n !== 0 && n !== -1);
  if ((n === 0 && b[0] & 0x80) || (n === -1 && !(b[0] & 0x80))) b.unshift(n === 0 ? 0 : 0xff);
  return tlv(0x02, Buffer.from(b));
}
function oid(str) {
  const p = str.split('.').map(Number), out = [40 * p[0] + p[1]];
  for (const n of p.slice(2)) {
    const b = [n & 0x7f]; let v = Math.floor(n / 128);
    while (v > 0) { b.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
const seq = (...partes) => tlv(0x30, Buffer.concat(partes));

function mensagem(versao, comunidade, tipoPdu, id, a, b, oids) {
  const vbs = seq(...oids.map(o => seq(oid(o), Buffer.from([0x05, 0x00]))));
  return seq(int(versao), tlv(0x04, Buffer.from(comunidade, 'utf8')), tlv(tipoPdu, Buffer.concat([int(id), int(a), int(b), vbs])));
}

function ler(buf, off) {
  const tag = buf[off]; let l = buf[off + 1], p = off + 2;
  if (l & 0x80) { const n = l & 0x7f; l = 0; for (let k = 0; k < n; k++) l = l * 256 + buf[p + k]; p += n; }
  return { tag, ini: p, fim: p + l };
}
function filhos(buf, no) { const out = []; let p = no.ini; while (p < no.fim) { const f = ler(buf, p); out.push(f); p = f.fim; } return out; }
function valor(buf, no) {
  const v = buf.subarray(no.ini, no.fim);
  switch (no.tag) {
    case 0x02: return !v.length ? 0 : v.length <= 6 ? v.readIntBE(0, v.length) : Number(BigInt.asIntN(v.length * 8, BigInt('0x' + v.toString('hex'))));
    case 0x04: return v;
    case 0x06: {
      const p = [Math.floor(v[0] / 40), v[0] % 40]; let n = 0;
      for (const x of v.subarray(1)) { n = n * 128 + (x & 0x7f); if (!(x & 0x80)) { p.push(n); n = 0; } }
      return p.join('.');
    }
    case 0x41: case 0x42: case 0x43: case 0x46: { let n = 0; for (const x of v) n = n * 256 + x; return n; }
    case 0x05: return null;
    case 0x80: case 0x81: case 0x82: return { fim: true }; // noSuchObject / noSuchInstance / endOfMibView
    default: return v;
  }
}
function decodificar(buf) {
  const raiz = ler(buf, 0), [, , pdu] = filhos(buf, raiz);
  const [id, erro, indice, vbs] = filhos(buf, pdu);
  return {
    tipo: pdu.tag, id: valor(buf, id), erro: valor(buf, erro), indice: valor(buf, indice), // GetBulk: erro = non-repeaters, indice = max-repetitions
    vbs: filhos(buf, vbs).map(vb => { const [o, v] = filhos(buf, vb); return { oid: valor(buf, o), valor: valor(buf, v), tag: v.tag }; }),
  };
}

// ------------------------------------------------------------------ transporte
function pedir(sock, host, porta, msg, id, timeout) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { sock.removeListener('message', ao); reject(new Error('sem resposta')); }, timeout);
    function ao(buf) {
      let r; try { r = decodificar(buf); } catch { return; }
      if (r.id !== id) return;
      clearTimeout(t); sock.removeListener('message', ao); resolve(r);
    }
    sock.on('message', ao);
    sock.send(msg, porta, host, e => { if (e) { clearTimeout(t); sock.removeListener('message', ao); reject(e); } });
  });
}
async function pedirComRepeticao(sock, host, porta, montar, opc) {
  let ultimo;
  for (let k = 0; k <= opc.repeticoes; k++) {
    const id = crypto.randomInt(1, 2 ** 31 - 1);
    try { return await pedir(sock, host, porta, montar(id), id, opc.timeout); } catch (e) { ultimo = e; }
  }
  throw ultimo;
}
const dentro = (o, raiz) => o === raiz || o.startsWith(raiz + '.');

// percorre as subárvores pedidas; devolve Map(oid -> valor)
// v2c com GetBulk em respostas pequenas (cabem num pacote: alguns firewalls/VPNs descartam UDP fragmentado);
// se falhar, tenta pedaços menores e, por fim, v1 com GetNext (uma linha por pedido).
async function percorrer(host, comunidade, raizes, opc = {}) {
  opc = { porta: 161, timeout: 1500, repeticoes: 1, maxVbs: 30, versao: 'auto', ...opc };
  const sock = dgram.createSocket('udp4'), out = new Map();
  let respondeu = false;
  try {
    await new Promise((ok, erro) => { sock.once('error', erro); sock.bind(0, ok); });
    if (opc.versao !== 'v1') {
      let ativos = raizes.map(r => ({ raiz: r, ultimo: r })), orcamento = opc.maxVbs, falhaV2;
      for (let volta = 0; ativos.length && volta < 300; volta++) {
        // até "orcamento" valores por resposta; com muitas colunas, pede só algumas de cada vez
        const lote = ativos.slice(0, Math.max(1, Math.min(ativos.length, orcamento)));
        const maxRep = Math.max(1, Math.floor(orcamento / lote.length));
        let r;
        try {
          r = await pedirComRepeticao(sock, host, opc.porta, id => mensagem(1, comunidade, 0xa5, id, 0, maxRep, lote.map(a => a.ultimo)), opc);
          respondeu = true;
          if (r.erro === 1) throw new Error('resposta grande demais (tooBig)');
          if (r.erro) throw new Error('erro SNMP ' + r.erro);
        } catch (e) {
          // pedaços menores (sem nenhuma resposta ainda, vai direto ao menor: um valor por pedido)
          if (orcamento > 1) { orcamento = respondeu && orcamento > 8 ? 8 : 1; volta--; continue; }
          falhaV2 = e; break;
        }
        const n = lote.length, acabou = new Set();
        r.vbs.forEach((vb, k) => {
          const a = lote[k % n];
          if (acabou.has(a) || !vb.oid || (vb.valor && vb.valor.fim) || !dentro(vb.oid, a.raiz)) { acabou.add(a); return; }
          if (vb.oid !== a.ultimo) { out.set(vb.oid, vb.valor); a.ultimo = vb.oid; }
        });
        // não avançou nenhuma coluna: evita laço infinito
        if (!r.vbs.length) lote.forEach(a => acabou.add(a));
        ativos = ativos.filter(a => !acabou.has(a));
      }
      if (!falhaV2) return { versao: 'v2c', valores: out };
      if (opc.versao === 'v2c') throw falhaV2;
    }
    for (const raiz of raizes) {
      let atual = raiz;
      for (let k = 0; k < 300; k++) {
        const r = await pedirComRepeticao(sock, host, opc.porta, id => mensagem(0, comunidade, 0xa1, id, 0, 0, [atual]), opc);
        respondeu = true;
        const vb = r.vbs[0];
        if (r.erro || !vb || !dentro(vb.oid, raiz) || (vb.valor && vb.valor.fim)) break;
        out.set(vb.oid, vb.valor); atual = vb.oid;
      }
    }
    return { versao: 'v1', valores: out };
  } catch (e) { e.nenhumaResposta = !respondeu; throw e; } finally { sock.close(); }
}

// sonda rápida (um pedido pequeno, sysDescr): diz se o equipamento responde por SNMP e com qual versão
async function sondar(host, comunidade, opc = {}) {
  opc = { porta: 161, timeout: 1500, repeticoes: 1, ...opc };
  const sock = dgram.createSocket('udp4'), raiz = '1.3.6.1.2.1.1.1';
  try {
    await new Promise((ok, erro) => { sock.once('error', erro); sock.bind(0, ok); });
    for (const [v, nome] of [[1, 'v2c'], [0, 'v1']]) {
      try {
        const r = await pedirComRepeticao(sock, host, opc.porta, id => mensagem(v, comunidade, 0xa1, id, 0, 0, [raiz]), opc);
        const vb = r.vbs[0];
        return { versao: nome, sysDescr: vb && dentro(vb.oid, raiz) ? texto(vb.valor) : '' };
      } catch { /* tenta a próxima versão */ }
    }
    return null;
  } finally { sock.close(); }
}

// ------------------------------------------------------------------ suprimentos da impressora
const MIB = {
  corIdx: '1.3.6.1.2.1.43.11.1.1.3', classe: '1.3.6.1.2.1.43.11.1.1.4', tipo: '1.3.6.1.2.1.43.11.1.1.5', desc: '1.3.6.1.2.1.43.11.1.1.6',
  max: '1.3.6.1.2.1.43.11.1.1.8', nivel: '1.3.6.1.2.1.43.11.1.1.9', corante: '1.3.6.1.2.1.43.12.1.1.4',
  modelo: '1.3.6.1.2.1.25.3.2.1.3', serie: '1.3.6.1.2.1.43.5.1.1.17', sysDescr: '1.3.6.1.2.1.1.1',
};
const TIPO_TXT = { 3: 'toner', 4: 'toner residual', 5: 'tinta', 6: 'cartucho de tinta', 8: 'tinta residual', 9: 'cilindro (drum)', 10: 'revelador',
  15: 'fusor', 18: 'unidade de limpeza', 20: 'unidade de transferência', 21: 'cartucho de toner' };
const texto = v => Buffer.isBuffer(v) ? v.toString('utf8').replace(/\u0000+$/g, '').replace(/[\u0000-\u001f]/g, ' ').trim() : String(v ?? '');
// item da Central diag: preto/azul/magenta/amarelo (tinta ou toner), caixa (manutenção/resíduo) ou outro (drum, fusor...)
function classificar(desc, corante, classe, tipo) {
  const d = `${desc} ${corante}`.toLowerCase();
  // caixa de manutenção / recipiente de resíduo: nomes variam por fabricante e idioma
  if (classe === 4 || tipo === 4 || tipo === 8 || /waste|res[ií]duo|maint|manuten|caixa|collect|absorb|used toner|toner usado|recipiente|bo[iî]te de maint|\bpad\b|almofada/.test(d)) return 'caixa';
  if (![3, 5, 6, 21, 1, 2].includes(tipo) && !/toner|ink|tinta|cartu/.test(d)) return 'outro';
  if (/yellow|amarel|\by\b/.test(d)) return 'amarelo';
  if (/magenta|\bm\b/.test(d)) return 'magenta';
  if (/cyan|ciano|\bc\b/.test(d)) return 'azul';
  if (/black|preto|negro|\bbk\b|\bk\b|mono/.test(d)) return 'preto';
  return 'outro';
}
const LIMITE_BAIXO = 25; // % (tinta/toner e vida útil da caixa)
// código do cartucho/toner quando vem no nome (ex.: "Black Toner Cartridge TN-3472", "HP 26A CF226A", "T544120")
function codigoDe(desc) {
  const cands = String(desc || '').toUpperCase().match(/\b[A-Z]{1,4}-?[A-Z]?\d{2,6}[A-Z]{0,4}\b/g) || [];
  return cands.find(c => /\d/.test(c) && /[A-Z]/.test(c) && c.replace(/\D/g, '').length >= 2) || '';
}
async function lerSuprimentos(ip, comunidade = 'public', opc = {}) {
  const t0 = Date.now();
  const { versao, valores } = await percorrer(ip, comunidade, Object.values(MIB), opc);
  const col = (raiz) => { const m = new Map(); for (const [o, v] of valores) if (o.startsWith(raiz + '.')) m.set(o.slice(raiz.length + 1), v); return m; };
  const desc = col(MIB.desc), classe = col(MIB.classe), tipo = col(MIB.tipo), max = col(MIB.max), nivel = col(MIB.nivel), corIdx = col(MIB.corIdx), corante = col(MIB.corante);
  if (!desc.size && !nivel.size) {
    const sys = texto([...col(MIB.sysDescr).values()][0]);
    const e = new Error(sys ? 'o equipamento responde por SNMP, mas não informa suprimentos (Printer MIB)' : 'resposta SNMP sem dados');
    e.sysDescr = sys; throw e;
  }
  const itens = [...new Set([...desc.keys(), ...nivel.keys()])].map(k => {
    const dev = k.split('.')[0], cIdx = corIdx.get(k);
    const cor = cIdx > 0 ? texto(corante.get(`${dev}.${cIdx}`)) : '';
    const ds = texto(desc.get(k)), cl = classe.get(k) ?? 0, tp = tipo.get(k) ?? 0, mx = max.get(k) ?? -2, nv = nivel.get(k) ?? -2;
    const item = classificar(ds, cor, cl, tp);
    let pct = null, estado = 'ok';
    if (mx > 0 && nv >= 0) pct = Math.max(0, Math.min(100, Math.round(nv / mx * 100)));
    else if (nv === -3) estado = 'tem'; // "há suprimento", sem quantidade
    else if (nv === -2 || mx === -2) estado = 'desconhecido';
    else if (nv === -1) estado = 'sem limite';
    // todo suprimento é lido como o que RESTA (a caixa de manutenção como vida útil: 100% = nova), como as
    // impressoras deste parque informam. Alerta em 25% ou menos; 5% ou menos = vazio/trocar.
    const receptaculo = cl === 4;
    if (pct != null) estado = pct <= 5 ? 'vazio' : pct <= LIMITE_BAIXO ? 'baixo' : 'ok';
    return { idx: k, desc: ds, cor, item, codigo: codigoDe(ds), classe: cl, tipo: tp, tipoTxt: TIPO_TXT[tp] || '', max: mx, nivel: nv, pct, receptaculo, estado };
  });
  return {
    ok: true, versao, ms: Date.now() - t0, lidoEm: new Date().toISOString(),
    modelo: texto([...col(MIB.modelo).values()][0]) || texto([...col(MIB.sysDescr).values()][0]).slice(0, 120),
    serie: texto([...col(MIB.serie).values()][0]), itens,
  };
}

module.exports = { percorrer, sondar, lerSuprimentos, classificar, codigoDe, LIMITE_BAIXO, _ber: { mensagem, decodificar, oid, int, tlv, seq } };

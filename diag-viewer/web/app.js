'use strict';
/*
  Visualizador de coletas do diag-hardware.ps1
  Tudo roda no navegador: o .zip nunca sai desta maquina.
*/

const $ = s => document.querySelector(s);
const state = {
  files: new Map(), zip: null, shaTxt: null, info: {},
  devices: [], boots: [], pnp: [], logons: [], events: [],
  windows: [], offsetMin: 0, coverage: null, anexos: [],
};

// ------------------------------------------------------------------ utilitarios
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const fmt = d => d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : '—';
const fmtDay = d => d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}` : '';
const toDvr = d => d ? new Date(d.getTime() + state.offsetMin * 60000) : null;
const dvrTxt = d => (d && state.offsetMin) ? ` <span class="muted">(DVR ${fmt(toDvr(d))})</span>` : '';
function dur(ms) {
  if (ms == null || ms < 0) return '—';
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3600000) { const m = Math.floor(ms / 60000), sg = Math.round((ms % 60000) / 1000); return sg ? `${m} min ${sg} s` : `${m} min`; }
  const m = Math.round(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
  return [d && `${d} d`, h && `${h} h`, `${mi} min`].filter(Boolean).join(' ');
}
function toLocalInput(d) {
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
}

function decodeText(bytes) {
  if (!bytes) return '';
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}

// Datas exportadas pelo Export-Csv seguem a cultura do Windows (pt-BR: dd/MM/yyyy HH:mm:ss)
function parseDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?)?/);
  if (m) {
    let a = +m[1], b = +m[2], y = +m[3], h = +(m[4] || 0), mi = +(m[5] || 0), se = +(m[6] || 0), day, mon;
    if (m[7]) {               // en-US: M/d/yyyy h:mm:ss AM
      mon = a; day = b;
      const pm = /p/i.test(m[7]);
      if (pm && h < 12) h += 12;
      if (!pm && h === 12) h = 0;
    } else { day = a; mon = b; }
    if (mon > 12 && day <= 12) [day, mon] = [mon, day];
    const d = new Date(y, mon - 1, day, h, mi, se);
    return y < 1980 ? null : d;
  }
  return null;
}

function parseCSV(text) {
  text = (text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  while (rows.length && /^#TYPE/.test(rows[0][0])) rows.shift();
  const head = rows.shift() || [];
  return rows
    .filter(r => !(r.length === 1 && r[0] === ''))
    .map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// ------------------------------------------------------------------ zip
async function inflateRaw(raw) {
  if (typeof DecompressionStream === 'undefined')
    throw new Error('Este navegador não descompacta .zip. Use Chrome/Edge/Firefox atualizados ou abra a pasta extraída.');
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('O arquivo não é um .zip válido.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Diretório do .zip corrompido.');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const nameBytes = u8.subarray(p + 46, p + 46 + nlen);
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'windows-1252').decode(nameBytes).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const raw = u8.subarray(start, start + csize);
    if (method === 0) out.set(name, raw.slice());
    else if (method === 8) out.set(name, await inflateRaw(raw));
    else throw new Error(`Compressão não suportada (${method}) em ${name}.`);
  }
  return out;
}

// ------------------------------------------------------------------ sha256
const K256 = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
function sha256js(data) {
  const l = data.length, total = ((l + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(data); buf[l] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 4, (l * 8) >>> 0);
  dv.setUint32(total - 8, Math.floor((l * 8) / 4294967296));
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  for (let o = 0; o < total; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15], y = W[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K256[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return Array.from(H, x => x.toString(16).padStart(8, '0')).join('').toUpperCase();
}
async function sha256Hex(bytes) {
  if (globalThis.crypto && crypto.subtle) {
    try {
      const h = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(h), b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    } catch { /* cai no js */ }
  }
  return sha256js(bytes);
}

// ------------------------------------------------------------------ carregamento
function showErr(msg) { const e = $('#err'); e.textContent = msg; e.hidden = false; goHome(false); }
function goHome(reload = true) {
  $('#app').hidden = true; $('#home').hidden = false; $('#btnHome').hidden = true; $('#btnPrint').disabled = true;
  if (reload) loadServerList();
}

async function loadFiles(list) {
  $('#err').hidden = true;
  const files = [...list];
  if (!files.length) return;

  // Só o .sha256.txt com uma coleta já aberta: apenas confere
  if (files.every(f => /\.sha256\.txt$/i.test(f.name)) && state.files.size) {
    state.shaTxt = await files[0].text();
    renderIntegridade();
    switchTab('integridade');
    return;
  }

  const map = new Map();
  let zip = null, shaTxt = null;
  try {
    for (const f of files) {
      const lower = f.name.toLowerCase();
      if (lower.endsWith('.zip')) {
        const buf = await f.arrayBuffer();
        for (const [k, v] of await readZip(buf)) map.set(k, v);
        zip = { name: f.name, size: f.size, hash: await sha256Hex(new Uint8Array(buf)) };
      } else if (lower.endsWith('.sha256.txt')) {
        shaTxt = await f.text();
      } else {
        const parts = (f.webkitRelativePath || f.name).replace(/\\/g, '/').split('/');
        if (parts.length > 1) parts.shift();
        map.set(parts.join('/'), new Uint8Array(await f.arrayBuffer()));
      }
    }
    if (!map.size) throw new Error('Nenhum arquivo de coleta encontrado.');
    state.files = map; state.zip = zip; state.shaTxt = shaTxt; state.origin = { tipo: 'local' };
    if (!findFile('02_dispositivos.csv') && !findFile('06_saude.json')) throw new Error('Não encontrei 02_dispositivos.csv nem 06_saude.json. Isso é uma coleta do diag-hardware ou do diagnóstico?');
    build();
  } catch (e) {
    console.error(e);
    showErr(e.message || String(e));
  }
}

function findFile(name) {
  name = name.toLowerCase();
  for (const [k, v] of state.files) if (k.toLowerCase().split('/').pop() === name) return v;
  return null;
}
const readText = n => decodeText(findFile(n));
const readCSV = n => parseCSV(readText(n));

const TABS_REMOCAO = ['analise', 'linha', 'tabelas', 'relatorio'];
function build() {
  state.modo = findFile('02_dispositivos.csv') ? 'remocao' : 'diagnostico';
  // Maquina
  const info = {};
  for (const line of readText('01_maquina.txt').split(/\r?\n/)) {
    if (line.startsWith('---')) break;
    const m = line.match(/^([^:]+?)\s*:\s(.*)$/);
    if (m && !(m[1].trim() in info)) info[m[1].trim()] = m[2].trim();
  }
  state.info = info;

  state.devices = readCSV('02_dispositivos.csv').map(r => ({
    classe: r.Classe || '', nome: r.Nome || '(sem nome)', presente: /^true$/i.test(r.Presente),
    first: parseDate(r.PrimeiraInstalacao), arrival: parseDate(r.UltimaChegada),
    removal: parseDate(r.UltimaRemocao), id: r.InstanceId || '',
  }));
  const byId = new Map(state.devices.map(d => [d.id.toUpperCase(), d]));

  state.boots = readCSV('03_boots.csv').map(r => ({ t: parseDate(r.TimeCreated), id: +r.Id, desc: r.Descricao, det: r.Detalhe })).filter(x => x.t);
  state.pnp = readCSV('04_kernel_pnp.csv').map(r => {
    const dev = byId.get((r.Dispositivo || '').toUpperCase());
    return { t: parseDate(r.TimeCreated), id: +r.Id, evento: r.Evento, disp: r.Dispositivo, nome: dev ? dev.nome : '' };
  }).filter(x => x.t);
  state.saude = readSaudeFrom(state.files);
  state.logons = readCSV('05_logons.csv').map(r => ({ t: parseDate(r.Hora), user: r.Usuario, tipo: r.Tipo, origem: r.Origem })).filter(x => x.t);

  // Linha do tempo unificada
  const ev = [];
  for (const b of state.boots) {
    const tipo = b.id === 6005 ? 'boot' : (b.id === 6006 || b.id === 1074) ? 'desl' : 'falha';
    ev.push({ t: b.t, tipo, code: b.id, titulo: b.desc || `Evento ${b.id}`, det: b.det || '' });
  }
  for (const p of state.pnp)
    ev.push({ t: p.t, tipo: 'pnp', code: p.id, titulo: `PnP ${p.id} · ${p.evento || ''}`, det: p.nome ? `${p.nome} — ${p.disp}` : p.disp });
  for (const l of state.logons)
    ev.push({ t: l.t, tipo: 'logon', code: 4624, titulo: `Logon ${l.tipo || ''}`, det: `${l.user}${l.origem && l.origem !== '-' ? ' · origem ' + l.origem : ''}` });
  for (const d of state.devices) {
    if (!(d.classe === 'Display' || !d.presente)) continue;
    const tag = `${d.nome}${d.presente ? '' : ' (AUSENTE)'}`;
    if (d.first) ev.push({ t: d.first, tipo: 'disp', titulo: 'Primeira instalação do dispositivo', det: tag });
    if (d.arrival) ev.push({ t: d.arrival, tipo: 'disp', titulo: 'Última chegada do dispositivo', det: tag });
    if (d.removal) ev.push({ t: d.removal, tipo: 'disp', titulo: 'Remoção registrada', det: tag });
  }
  ev.sort((a, b) => a.t - b.t);
  state.events = ev;

  const logTimes = [...state.boots, ...state.pnp, ...state.logons].map(x => x.t).sort((a, b) => a - b);
  state.coverage = logTimes.length ? { from: logTimes[0], to: logTimes[logTimes.length - 1] } : null;

  computeWindows();

  $('#home').hidden = true;
  $('#app').hidden = false;
  const diag = state.modo === 'diagnostico';
  $('#btnPrint').disabled = diag;
  $('#btnHome').hidden = !srv.ok;
  document.querySelectorAll('#tabs button').forEach(b => { b.hidden = diag && TABS_REMOCAO.includes(b.dataset.tab); });
  switchTab(diag ? 'saude' : 'analise');
  renderAll();
  renderIntegridade();
  loadAnexos().then(renderRelatorio);
}

// ------------------------------------------------------------------ janela de remocao
function isRelevant(d) { return !d.presente && (d.classe === 'Display' || /^PCI\\/i.test(d.id)); }

function computeWindows() {
  const boots6005 = state.boots.filter(b => b.id === 6005).map(b => b.t);
  state.windows = state.devices.filter(isRelevant)
    .sort((a, b) => (a.classe === 'Display' ? 0 : 1) - (b.classe === 'Display' ? 0 : 1) || (b.arrival || 0) - (a.arrival || 0))
    .map((d, i) => {
      const last = d.arrival || d.first;
      const w = { idx: i, dev: d, last, start: last, end: null, shut: null, nextBoot: null, crash: null, before: [], after: [], substitutes: [], basis: '' };
      if (!last) return w;
      // O boot em que a placa "chegou" gera o 6005 alguns segundos/minutos depois; pula ele.
      w.nextBoot = boots6005.find(t => t - last > 3 * 60000) || null;
      w.end = w.nextBoot;
      if (d.removal && d.removal > last && (!w.end || d.removal < w.end)) w.end = d.removal;
      const inRange = t => t > last && (!w.end || t < w.end);
      const shuts = state.boots.filter(b => (b.id === 6006 || b.id === 1074) && inRange(b.t));
      w.shut = shuts.length ? shuts[shuts.length - 1] : null;
      if (w.shut) w.start = w.shut.t;
      w.crash = w.end ? state.boots.find(b => (b.id === 6008 || b.id === 41) && Math.abs(b.t - w.end) < 15 * 60000) || null : null;
      w.before = state.logons.filter(l => l.t >= last && (!w.end || l.t < w.end));
      w.after = w.end ? state.logons.filter(l => l.t >= w.end).slice(0, 5) : [];
      w.substitutes = state.devices.filter(o => o.presente && o.classe === 'Display' && o.first &&
        o.first >= new Date(last.getTime() - 5 * 60000) && (!w.end || o.first <= new Date(w.end.getTime() + 2 * 3600000)));
      w.basis = w.shut ? 'shutdown' : 'arrival';
      return w;
    });
}

// ------------------------------------------------------------------ render
function renderAll() {
  renderMachine();
  renderAnalise();
  renderLinha();
  renderTabelas();
  renderTextos();
  renderSaude();
  renderRelatorio();
}

function renderMachine() {
  const i = state.info;
  const ch = smbiosTxt(i['Intrusao no chassis'] || 'Não informado');
  const chCls = /viola[cç][aã]o|tentativa/i.test(ch) && !/sem viola/i.test(ch) ? 'bad' : /sem viola/i.test(ch) ? 'ok' : '';
  const patr = (i['Patrimonio'] || '—') + (i['Origem patrimonio'] === 'informado manualmente' ? ' (informado manualmente)' : '');
  $('#machine').innerHTML = `
    <div>
      <div class="m-title">${esc(i['Computador'] || 'Computador ?')}</div>
      <div class="m-sub">Patrimônio <b>${esc(patr)}</b> · Serial BIOS <b>${esc(i['Serial (BIOS)'] || '—')}</b> · ${esc(i['Fabricante / Modelo'] || '')}</div>
      <div class="m-sub">Coleta em <b>${esc(i['Hora da coleta'] || '—')}</b> por ${esc(i['Coletado por'] || '—')} · Fuso ${esc(i['Fuso horario'] || '—')}</div>
      <div class="m-sub">SO instalado em ${esc(i['Instalacao do SO'] || '—')} · Intrusão no chassis: <span class="badge ${chCls}">${esc(ch)}</span></div>
    </div>
    ${state.modo === 'diagnostico' ? `<div class="m-dvr"><span class="badge">Diagnóstico de manutenção</span>
      ${state.origin && state.origin.tipo === 'servidor' ? '<button class="btn small" id="btnLaudo" style="margin-top:10px">Criar laudo de manutenção</button>' : '<small>Abra pelo servidor para criar um laudo.</small>'}</div>` : `<div class="m-dvr">
      <label>Diferença do DVR (minutos)
        <input id="dvrOff" type="number" step="1" value="${state.offsetMin}">
      </label>
      <small>Positivo se o DVR está adiantado em relação ao PC.</small>
      <div class="print-only">Diferença DVR aplicada: ${state.offsetMin} min</div>
      ${state.origin && state.origin.tipo === 'servidor' ? '<button class="btn small" id="btnLaudo" style="margin-top:10px">Criar laudo de manutenção</button>' : ''}
    </div>`}`;
  if ($('#btnLaudo')) $('#btnLaudo').addEventListener('click', () => novoLaudoDaColeta());
  if ($('#dvrOff')) $('#dvrOff').addEventListener('change', e => {
    state.offsetMin = parseInt(e.target.value, 10) || 0;
    renderAll();
  });
}

function renderAnalise() {
  const removed = state.devices.filter(d => !d.presente);
  const gpusRemoved = removed.filter(d => d.classe === 'Display');
  const del420 = state.pnp.filter(p => p.id === 420);
  const cov = state.coverage;
  let h = `
  <div class="stats">
    <div class="stat"><div class="v">${state.devices.length}</div><div class="l">dispositivos listados</div></div>
    <div class="stat ${removed.length ? 'bad' : ''}"><div class="v">${removed.length}</div><div class="l">não presentes</div></div>
    <div class="stat ${gpusRemoved.length ? 'bad' : ''}"><div class="v">${gpusRemoved.length}</div><div class="l">placas de vídeo ausentes</div></div>
    <div class="stat"><div class="v">${state.boots.filter(b => b.id === 6005).length}</div><div class="l">boots no período</div></div>
    <div class="stat ${del420.length ? 'bad' : ''}"><div class="v">${del420.length}</div><div class="l">dispositivos excluídos (420)</div></div>
  </div>
  <div class="note info">Os logs desta coleta cobrem de <b>${fmt(cov && cov.from)}</b> até <b>${fmt(cov && cov.to)}</b>.
  As datas dos dispositivos vêm do registro e não dependem desse período.</div>`;

  if (!state.windows.length) {
    h += `<div class="panel"><h2>Nenhuma placa de vídeo ou dispositivo PCI ausente</h2>
      <p>Se uma GPU foi removida e não aparece aqui, o histórico pode não estar mais disponível (por exemplo, após reinstalação do Windows, limpeza de dispositivos ou reinstalação de drivers durante manutenção).</p>
      <p>Confira a data de instalação do SO acima e os eventos 420 abaixo.</p></div>`;
  }

  for (const w of state.windows) h += windowCard(w);

  if (del420.length) {
    h += `<div class="panel"><h2>Dispositivos excluídos (evento 420)</h2>
      <p class="muted">Registra que o dispositivo foi desinstalado no Windows. Isso acontece em manutenções comuns (troca ou reinstalação de driver, limpeza de dispositivos antigos) e ajuda a explicar ausências no histórico.</p>
      ${simpleTable(['Data', 'Dispositivo'], del420.map(p => [fmt(p.t) + dvrTxt(p.t), esc(p.nome ? p.nome + ' — ' : '') + `<span class="mono">${esc(p.disp)}</span>`]), true)}</div>`;
  }

  const others = removed.filter(d => !isRelevant(d));
  if (others.length) {
    h += `<div class="panel"><h2>Outros dispositivos ausentes (${others.length})</h2>
      <p class="muted">Normalmente pendrives, periféricos USB e monitores desconectados. Em geral não são relevantes para este diagnóstico.</p>
      ${simpleTable(['Classe', 'Nome', 'Última chegada', 'Remoção'], others.map(d => [esc(d.classe), esc(d.nome), fmt(d.arrival), fmt(d.removal)]), true)}</div>`;
  }
  $('#tab-analise').innerHTML = h;
  $('#tab-analise').querySelectorAll('[data-win]').forEach(b =>
    b.addEventListener('click', () => { focusWindow(+b.dataset.win); }));
}

function windowCard(w) {
  const d = w.dev;
  let body;
  if (!w.last) {
    body = `<div class="note">O registro não tem data de chegada nem de instalação desta placa. Use a linha do tempo dos boots para estimar.</div>`;
  } else {
    const endTxt = w.end ? fmt(w.end) + dvrTxt(w.end) : 'sem boot posterior nos logs (limite: hora da coleta)';
    const how = w.basis === 'shutdown'
      ? `Último desligamento registrado com a placa: <b>${fmt(w.start)}</b>${dvrTxt(w.start)}`
      : `Sem desligamento normal registrado depois da última chegada. Janela contada a partir da última chegada.`;
    body = `
      <div class="window">
        <div class="big">Removida entre ${fmt(w.start)} e ${w.end ? fmt(w.end) : '—'}</div>
        ${state.offsetMin ? `<div class="dvr">No relógio do DVR: ${fmt(toDvr(w.start))} → ${w.end ? fmt(toDvr(w.end)) : '—'}</div>` : ''}
        <div class="dvr">Duração da janela: ${w.end ? dur(w.end - w.start) : '—'}</div>
      </div>
      <div class="kv">
        <div>Última vez vista pelo Windows</div><div>${fmt(w.last)}${dvrTxt(w.last)}</div>
        <div>Desligamento</div><div>${how}${w.shut && w.shut.det ? `<br><small>${esc(w.shut.det)}</small>` : ''}</div>
        <div>Primeiro boot sem a placa</div><div>${endTxt}</div>
        <div>Remoção registrada (registro)</div><div>${d.removal ? fmt(d.removal) + dvrTxt(d.removal) : 'não preenchida'}</div>
        <div>Primeira instalação</div><div>${fmt(d.first)}</div>
        ${w.crash ? `<div>Desligamento anormal</div><div><span class="badge warn">${esc(w.crash.desc || 'Evento ' + w.crash.id)}</span> ${fmt(w.crash.t)} — o Windows não registrou um desligamento normal (ex.: queda de energia, botão de desligar pressionado ou travamento)</div>` : ''}
        ${w.substitutes.length ? `<div>Vídeo que assumiu</div><div>${w.substitutes.map(s => `${esc(s.nome)} <small>(1ª instalação ${fmt(s.first)})</small>`).join('<br>')}</div>` : ''}
      </div>
      <h3>Logons com a placa ainda instalada (sessão antes da remoção)</h3>
      ${w.before.length ? simpleTable(['Hora', 'Usuário', 'Tipo'], w.before.slice(-10).map(l => [fmt(l.t) + dvrTxt(l.t), esc(l.user), esc(l.tipo)]), true) : '<p class="muted">Nenhum logon registrado nesse intervalo (ou log de Segurança já sobrescrito).</p>'}
      <h3>Primeiros logons depois da remoção</h3>
      ${w.after.length ? simpleTable(['Hora', 'Usuário', 'Tipo'], w.after.map(l => [fmt(l.t) + dvrTxt(l.t), esc(l.user), esc(l.tipo)]), true) : '<p class="muted">Nenhum.</p>'}`;
    if (state.coverage && w.last < state.coverage.from)
      body += `<div class="note">A última chegada é anterior ao início dos logs desta coleta. Boots e logons dessa época já foram sobrescritos; a janela pode estar incompleta.</div>`;
  }
  return `<div class="panel card">
    <div class="head">
      <div><span class="badge bad">AUSENTE</span> <span class="badge">${esc(d.classe || 'sem classe')}</span>
      <div class="name">${esc(d.nome)}</div><div class="mono muted">${esc(d.id)}</div></div>
      ${w.last ? `<button class="btn small ghost noprint" data-win="${w.idx}">Ver na linha do tempo</button>` : ''}
    </div>${body}</div>`;
}

function simpleTable(head, rows, timeFirst) {
  return `<div class="tablewrap"><table><thead><tr>${head.map(x => `<th class="nosort">${esc(x)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${timeFirst && i === 0 ? 't' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// ------------------------------------------------------------------ linha do tempo
const TIPOS = {
  boot: { label: 'Boot', color: 'var(--c-boot)' },
  desl: { label: 'Desligamento', color: 'var(--c-desl)' },
  falha: { label: 'Desligamento anormal', color: 'var(--c-falha)' },
  pnp: { label: 'Kernel-PnP', color: 'var(--c-pnp)' },
  logon: { label: 'Logon', color: 'var(--c-logon)' },
  disp: { label: 'Datas do dispositivo', color: 'var(--c-disp)' },
};
const tl = { tipos: new Set(['boot', 'desl', 'falha', 'pnp', 'logon', 'disp']), from: null, to: null, q: '', win: null, onlyPci: true };

function focusWindow(idx) {
  const w = state.windows[idx];
  if (!w || !w.last) return;
  tl.win = w;
  tl.from = new Date(w.last.getTime() - 2 * 3600000);
  tl.to = new Date((w.end || state.coverage?.to || w.last).getTime() + 2 * 3600000);
  renderLinha();
  switchTab('linha');
}

function renderLinha() {
  const el = $('#tab-linha');
  el.innerHTML = `
    <div class="panel">
      <div class="chart" id="chart"></div>
      <div class="filters" style="margin-top:10px">
        ${Object.entries(TIPOS).map(([k, v]) => `<label><input type="checkbox" data-tipo="${k}" ${tl.tipos.has(k) ? 'checked' : ''}><span class="dot" style="background:${v.color}"></span>${v.label}</label>`).join('')}
      </div>
      <div class="filters">
        <label>De <input type="datetime-local" id="tlFrom" value="${toLocalInput(tl.from)}"></label>
        <label>Até <input type="datetime-local" id="tlTo" value="${toLocalInput(tl.to)}"></label>
        <label>Janela <select id="tlWin"><option value="">—</option>${state.windows.filter(w => w.last).map(w => `<option value="${w.idx}" ${tl.win === w ? 'selected' : ''}>${esc(w.dev.nome)}</option>`).join('')}</select></label>
        <label>Buscar <input type="search" id="tlQ" value="${esc(tl.q)}" placeholder="usuário, dispositivo..."></label>
        <label title="Esconde eventos PnP de USB, software e afins"><input type="checkbox" id="tlPci" ${tl.onlyPci ? 'checked' : ''}> PnP só PCI/vídeo</label>
        <button class="btn small ghost" id="tlClear">Limpar filtros</button>
      </div>
      <div id="tlCount" class="muted"></div>
    </div>
    <div class="tablewrap" id="tlTable"></div>`;

  el.querySelectorAll('[data-tipo]').forEach(c => c.addEventListener('change', () => {
    c.checked ? tl.tipos.add(c.dataset.tipo) : tl.tipos.delete(c.dataset.tipo); drawTimeline();
  }));
  const parseInput = v => v ? new Date(v) : null;
  $('#tlFrom').addEventListener('change', e => { tl.from = parseInput(e.target.value); drawTimeline(); });
  $('#tlTo').addEventListener('change', e => { tl.to = parseInput(e.target.value); drawTimeline(); });
  $('#tlQ').addEventListener('input', e => { tl.q = e.target.value; drawTimeline(); });
  $('#tlPci').addEventListener('change', e => { tl.onlyPci = e.target.checked; drawTimeline(); });
  $('#tlWin').addEventListener('change', e => {
    if (e.target.value === '') { tl.win = null; drawTimeline(); } else focusWindow(+e.target.value);
  });
  $('#tlClear').addEventListener('click', () => {
    tl.from = tl.to = tl.win = null; tl.q = ''; tl.onlyPci = true;
    Object.keys(TIPOS).forEach(k => tl.tipos.add(k));
    renderLinha();
  });
  drawTimeline();
}

function filteredEvents() {
  const q = tl.q.trim().toLowerCase();
  return state.events.filter(e =>
    tl.tipos.has(e.tipo) &&
    (!tl.from || e.t >= tl.from) && (!tl.to || e.t <= tl.to) &&
    (!tl.onlyPci || e.tipo !== 'pnp' || /PCI\\|DISPLAY/i.test(e.det)) &&
    (!q || (e.titulo + ' ' + e.det).toLowerCase().includes(q)));
}

function drawTimeline() {
  const evs = filteredEvents();
  const inWin = e => tl.win && tl.win.last && e.t >= tl.win.start && (!tl.win.end || e.t <= tl.win.end);
  const showDvr = !!state.offsetMin;
  $('#tlCount').textContent = `${evs.length} eventos${evs.length > 3000 ? ' (mostrando os 3000 primeiros)' : ''}`;
  $('#tlTable').innerHTML = `<table><thead><tr><th class="nosort">Data/hora PC</th>${showDvr ? '<th class="nosort">Hora DVR</th>' : ''}<th class="nosort">Tipo</th><th class="nosort">Evento</th><th class="nosort">Detalhe</th></tr></thead><tbody>
    ${evs.slice(0, 3000).map(e => `<tr class="${inWin(e) ? 'inwin' : ''}"><td class="t">${fmt(e.t)}</td>${showDvr ? `<td class="t">${fmt(toDvr(e.t))}</td>` : ''}
      <td><span class="dot" style="background:${TIPOS[e.tipo].color}"></span> ${TIPOS[e.tipo].label}</td><td>${esc(e.titulo)}</td><td class="${e.tipo === 'pnp' ? 'id' : ''}">${esc(e.det)}</td></tr>`).join('')}
    </tbody></table>`;
  drawChart(evs);
}

function drawChart(evs) {
  const box = $('#chart');
  if (!box) return;
  const W = Math.max(320, box.clientWidth || 900), lanes = Object.keys(TIPOS), laneH = 22, top = 8, left = 150, right = 12;
  const H = top + lanes.length * laneH + 26;
  if (!evs.length) { box.innerHTML = '<p class="muted">Nenhum evento com esses filtros.</p>'; return; }
  let t0 = (tl.from || evs[0].t).getTime(), t1 = (tl.to || evs[evs.length - 1].t).getTime();
  if (t1 - t0 < 60000) { t0 -= 1800000; t1 += 1800000; }
  const x = t => left + ((t - t0) / (t1 - t0)) * (W - left - right);
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Linha do tempo de eventos">`;
  for (const w of state.windows) {
    if (!w.last) continue;
    const a = Math.max(t0, w.start.getTime()), b = Math.min(t1, (w.end || new Date(t1)).getTime());
    if (b > a) s += `<rect x="${x(a)}" y="${top - 4}" width="${Math.max(2, x(b) - x(a))}" height="${lanes.length * laneH + 4}" fill="var(--win)"><title>Janela de remoção: ${esc(w.dev.nome)}</title></rect>`;
  }
  lanes.forEach((k, i) => {
    const y = top + i * laneH + laneH / 2;
    s += `<text x="0" y="${y + 4}">${TIPOS[k].label}</text><line x1="${left}" x2="${W - right}" y1="${y}" y2="${y}" stroke="var(--line)"/>`;
  });
  for (const e of evs.slice(0, 5000)) {
    const y = top + lanes.indexOf(e.tipo) * laneH + laneH / 2;
    s += `<circle cx="${x(e.t.getTime()).toFixed(1)}" cy="${y}" r="3.5" fill="${TIPOS[e.tipo].color}" fill-opacity=".8"><title>${esc(fmt(e.t) + ' — ' + e.titulo + (e.det ? ' — ' + e.det : ''))}</title></circle>`;
  }
  const ticks = Math.min(8, Math.max(2, Math.floor((W - left) / 110)));
  const span = t1 - t0;
  for (let i = 0; i <= ticks; i++) {
    const t = new Date(t0 + span * i / ticks);
    const label = span < 2 * 86400000 ? `${fmtDay(t)} ${pad(t.getHours())}:${pad(t.getMinutes())}` : `${fmtDay(t)}/${String(t.getFullYear()).slice(2)}`;
    s += `<text x="${x(t.getTime())}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}">${label}</text>`;
  }
  box.innerHTML = s + '</svg>';
}
window.addEventListener('resize', () => { if (!$('#app').hidden && $('#tab-linha').classList.contains('on')) drawChart(filteredEvents()); });

// ------------------------------------------------------------------ tabelas
const TABLES = {
  dispositivos: {
    label: 'Dispositivos', rows: () => state.devices,
    cols: [['classe', 'Classe'], ['nome', 'Nome'], ['presente', 'Presente', v => v ? '<span class="badge ok">Sim</span>' : '<span class="badge bad">Não</span>'],
      ['first', 'Primeira instalação', fmt], ['arrival', 'Última chegada', fmt], ['removal', 'Última remoção', fmt], ['id', 'InstanceId', null, 'id']],
  },
  boots: { label: 'Boots e desligamentos', rows: () => state.boots, cols: [['t', 'Data/hora', fmt, 't'], ['id', 'Evento'], ['desc', 'Descrição'], ['det', 'Detalhe']] },
  pnp: { label: 'Kernel-PnP', rows: () => state.pnp, cols: [['t', 'Data/hora', fmt, 't'], ['id', 'Evento'], ['evento', 'Tipo'], ['nome', 'Nome'], ['disp', 'Dispositivo', null, 'id']] },
  logons: { label: 'Logons', rows: () => state.logons, cols: [['t', 'Data/hora', fmt, 't'], ['user', 'Usuário'], ['tipo', 'Tipo'], ['origem', 'Origem']] },
};
const tb = { name: 'dispositivos', q: '', sort: null, dir: 1, onlyAbsent: false };

function renderTabelas() {
  $('#tab-tabelas').innerHTML = `
    <div class="filters">
      <label>Tabela <select id="tbName">${Object.entries(TABLES).map(([k, v]) => `<option value="${k}" ${tb.name === k ? 'selected' : ''}>${v.label} (${v.rows().length})</option>`).join('')}</select></label>
      <label>Buscar <input type="search" id="tbQ" value="${esc(tb.q)}"></label>
      <label id="tbAbsWrap"><input type="checkbox" id="tbAbs" ${tb.onlyAbsent ? 'checked' : ''}> só ausentes</label>
      <span class="muted" id="tbCount"></span>
    </div>
    <div class="tablewrap" id="tbTable"></div>`;
  $('#tbName').addEventListener('change', e => { tb.name = e.target.value; tb.sort = null; drawTable(); });
  $('#tbQ').addEventListener('input', e => { tb.q = e.target.value; drawTable(); });
  $('#tbAbs').addEventListener('change', e => { tb.onlyAbsent = e.target.checked; drawTable(); });
  drawTable();
}

function drawTable() {
  const def = TABLES[tb.name];
  $('#tbAbsWrap').style.display = tb.name === 'dispositivos' ? '' : 'none';
  const q = tb.q.trim().toLowerCase();
  let rows = def.rows().filter(r =>
    (!tb.onlyAbsent || tb.name !== 'dispositivos' || !r.presente) &&
    (!q || def.cols.some(([k, , f]) => String(f && r[k] instanceof Date ? f(r[k]) : r[k] ?? '').toLowerCase().includes(q))));
  if (tb.sort) {
    const k = tb.sort;
    rows = [...rows].sort((a, b) => {
      const va = a[k], vb = b[k];
      if (va == null || va === '') return 1;
      if (vb == null || vb === '') return -1;
      return (va > vb ? 1 : va < vb ? -1 : 0) * tb.dir;
    });
  }
  $('#tbCount').textContent = `${rows.length} linhas`;
  $('#tbTable').innerHTML = `<table><thead><tr>${def.cols.map(([k, l]) => `<th data-k="${k}">${esc(l)}${tb.sort === k ? (tb.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>
    <tbody>${rows.slice(0, 5000).map(r => `<tr class="${tb.name === 'dispositivos' && !r.presente ? 'inwin' : ''}">${def.cols.map(([k, , f, cls]) => `<td class="${cls || ''}">${f ? f(r[k]) : esc(r[k])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  $('#tbTable').querySelectorAll('th[data-k]').forEach(th => th.addEventListener('click', () => {
    if (tb.sort === th.dataset.k) tb.dir = -tb.dir; else { tb.sort = th.dataset.k; tb.dir = 1; }
    drawTable();
  }));
}

// ------------------------------------------------------------------ integridade
async function renderIntegridade() {
  const el = $('#tab-integridade');
  el.innerHTML = '<div class="panel">Calculando hashes...</div>';
  const list = readCSV('hashes_sha256.csv');
  const norm = s => s.replace(/\\/g, '/').toLowerCase();
  const keys = [...state.files.keys()];
  const results = [];
  for (const r of list) {
    const want = norm(r.Arquivo || '');
    const key = keys.find(k => norm(k) === want || norm(k).endsWith('/' + want));
    if (!key) { results.push({ arq: r.Arquivo, exp: r.Hash, got: null, st: 'falta' }); continue; }
    const got = await sha256Hex(state.files.get(key));
    results.push({ arq: r.Arquivo, exp: r.Hash, got, st: got === String(r.Hash).toUpperCase() ? 'ok' : 'diff' });
  }
  const listed = new Set(list.map(r => norm(r.Arquivo || '')));
  const extra = keys.filter(k => !/hashes_sha256\.csv$/i.test(k) && ![...listed].some(l => norm(k) === l || norm(k).endsWith('/' + l)));

  const ok = results.filter(r => r.st === 'ok').length;
  const bad = results.length - ok;
  const shaM = (state.shaTxt || '').match(/[A-Fa-f0-9]{64}/);
  const srvMeta = state.origin && state.origin.tipo === 'servidor' ? state.origin.meta : null;
  state.integ = { results, extra, ok, bad, shaTxt: shaM ? shaM[0].toUpperCase() : null, srvMeta };
  let zipBlock = '';
  if (state.zip) {
    const m = (state.shaTxt || '').match(/[A-Fa-f0-9]{64}/);
    const exp = m ? m[0].toUpperCase() : null;
    zipBlock = `<h3>Pacote .zip</h3>
      <div class="kv"><div>Arquivo</div><div>${esc(state.zip.name)} (${(state.zip.size / 1048576).toFixed(2)} MB)</div>
      <div>SHA256 calculado</div><div class="mono">${state.zip.hash}</div>
      <div>SHA256 do .sha256.txt</div><div>${exp ? `<span class="mono">${exp}</span> ${exp === state.zip.hash ? '<span class="badge ok">confere</span>' : '<span class="badge bad">NÃO confere</span>'}` : '<span class="muted">não carregado (arraste o .zip.sha256.txt para conferir)</span>'}</div>
      ${srvMeta ? `<div>SHA256 registrado no recebimento</div><div><span class="mono">${esc(srvMeta.sha256)}</span> ${srvMeta.sha256 === state.zip.hash ? '<span class="badge ok">confere</span>' : '<span class="badge bad">NÃO confere</span>'}</div>
      <div>Recebido pelo servidor</div><div>${fmt(new Date(srvMeta.recebidoEm))} · de ${esc(srvMeta.ip)} · enviado por ${esc(srvMeta.usuario || '—')}${srvMeta.hashConferido ? ' · <span class="badge ok">hash conferido na chegada</span>' : ''}</div>` : ''}
      <div class="noprint">Conferir com hash anotado</div><div class="noprint"><input id="hashCheck" class="mono" style="width:100%;max-width:560px" placeholder="cole aqui o SHA256 anotado no memorando"> <span id="hashRes"></span></div></div>`;
  } else {
    zipBlock = `<div class="note">Coleta aberta como pasta. O hash do .zip só pode ser conferido abrindo o .zip.</div>`;
  }

  el.innerHTML = `<div class="panel">
    <h2>Integridade da coleta</h2>
    <p>${!results.length ? '<span class="badge warn">hashes_sha256.csv não encontrado</span>' :
      bad ? `<span class="badge bad">${bad} arquivo(s) com problema</span>` : `<span class="badge ok">Todos os ${ok} arquivos conferem</span>`}
      ${extra.length ? ` <span class="badge warn">${extra.length} arquivo(s) fora da lista de hashes</span>` : ''}</p>
    ${zipBlock}
    <h3>Arquivos</h3>
    ${simpleTable(['Arquivo', 'Situação', 'SHA256'], [
      ...results.map(r => [esc(r.arq), r.st === 'ok' ? '<span class="badge ok">confere</span>' : r.st === 'falta' ? '<span class="badge bad">ausente</span>' : '<span class="badge bad">ALTERADO</span>', `<span class="mono">${esc(r.got || r.exp)}</span>`]),
      ...extra.map(k => [esc(k), '<span class="badge warn">não listado</span>', '']),
    ])}
  </div>`;
  const hc = $('#hashCheck');
  if (hc) hc.addEventListener('input', () => {
    const v = hc.value.replace(/\s/g, '').toUpperCase();
    $('#hashRes').innerHTML = !v ? '' : v === state.zip.hash ? '<span class="badge ok">confere</span>' : '<span class="badge bad">não confere</span>';
  });
  renderRelatorio();
}

// ------------------------------------------------------------------ textos
function renderTextos() {
  const names = [...state.files.keys()].filter(k => /\.(txt|log)$/i.test(k)).sort();
  $('#tab-textos').innerHTML = `<div class="filters"><label>Arquivo <select id="txSel">${names.map(n => `<option>${esc(n)}</option>`).join('')}</select></label></div><pre class="raw" id="txPre"></pre>`;
  const show = () => { $('#txPre').textContent = decodeText(state.files.get($('#txSel').value)); };
  $('#txSel').addEventListener('change', show);
  if (names.length) {
    const i = names.findIndex(n => /00_RESUMO/i.test(n));
    if (i >= 0) $('#txSel').selectedIndex = i;
    show();
  }
}

// ------------------------------------------------------------------ abas, arquivos, impressao
function switchTab(name) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + name));
  if (name === 'linha') drawChart(filteredEvents());
  if (name === 'relatorio') renderRelatorio();
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) switchTab(b.dataset.tab); });

$('#inZip').addEventListener('change', e => { loadFiles(e.target.files); e.target.value = ''; });
$('#inDir').addEventListener('change', e => { loadFiles(e.target.files); e.target.value = ''; });
$('#btnPrint').addEventListener('click', () => { switchTab('relatorio'); askPrint(); });
$('#btnHome').addEventListener('click', () => goHome());
window.addEventListener('beforeprint', () => { if (state.modo !== 'diagnostico' && !$('#mod-coletas').hidden && !$('#app').hidden && !$('#tab-relatorio').classList.contains('on')) switchTab('relatorio'); });

let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('#dropOverlay').hidden = false; });
window.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true;
  if (e.dataTransfer.files.length) { if (typeof showModule === 'function') { history.replaceState(null, '', location.pathname); showModule('coletas'); } loadFiles(e.dataTransfer.files); }
});

// ------------------------------------------------------------------ servidor
const srv = { ok: false, info: null, list: [], q: '', token: '' };
try { srv.token = sessionStorage.getItem('diagReadToken') || ''; } catch { /* sem storage */ }

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (srv.token) headers['X-Token'] = srv.token;
  return fetch(path, { ...opts, headers, cache: 'no-store' });
}

async function loadServerList() {
  const box = $('#server');
  if (location.protocol === 'file:') return;
  try {
    const ri = await api('api/info');
    if (!ri.ok) return;
    srv.info = await ri.json();
    srv.ok = true;
  } catch { return; }
  box.hidden = false;
  const r = await api('api/coletas');
  if (r.status === 401) {
    box.innerHTML = `<h2>Coletas recebidas pelo servidor</h2>
      <p>Este servidor exige o token de leitura.</p>
      <div class="filters"><input id="rtok" type="password" placeholder="token de leitura" style="min-width:280px"><button class="btn small" id="rtokOk">Entrar</button>
      ${srv.token ? '<span class="badge bad">token recusado</span>' : ''}</div>`;
    const go = () => { srv.token = $('#rtok').value.trim(); try { sessionStorage.setItem('diagReadToken', srv.token); } catch {} loadServerList(); };
    $('#rtokOk').addEventListener('click', go);
    $('#rtok').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    return;
  }
  srv.list = r.ok ? await r.json() : [];
  drawServerList();
}

function drawServerList() {
  const q = srv.q.trim().toLowerCase();
  const rows = srv.list.filter(m => !q || [m.computador, m.patrimonio, m.usuario, m.arquivo, m.ip, m.tipo === 'diagnostico' ? 'diagnóstico' : 'remoção'].join(' ').toLowerCase().includes(q));
  const box = $('#server');
  box.innerHTML = `<div class="head-row"><h2>Coletas recebidas pelo servidor</h2>
      <div class="filters" style="margin:0"><input type="search" id="srvQ" placeholder="computador, patrimônio, usuário..." value="${esc(srv.q)}">
      <button class="btn small ghost" id="srvRe">Atualizar</button></div></div>
    ${!srv.info.envioAtivo ? '<div class="note">Recebimento desativado: defina UPLOAD_TOKEN no servidor.</div>' : ''}
    ${!srv.list.length ? '<p class="muted">Nenhuma coleta recebida ainda. Baixe os scripts em <a href="download/">Downloads</a>; com o diag-servidor.cfg, o envio já vem ativado.</p>' :
      `<div class="tablewrap" style="max-height:50vh"><table><thead><tr>
        <th class="nosort">Recebida em</th><th class="nosort">Tipo</th><th class="nosort">Computador</th><th class="nosort">Patrimônio</th><th class="nosort">Enviada por</th><th class="nosort">Tamanho</th><th class="nosort">SHA256</th><th class="nosort"></th></tr></thead>
      <tbody>${rows.map(m => `<tr>
        <td class="t">${fmt(new Date(m.recebidoEm))}</td><td>${m.tipo === 'diagnostico' ? '<span class="badge ok">Diagnóstico</span>' : '<span class="badge">Remoção</span>'}</td><td><b>${esc(m.computador)}</b></td><td>${esc(m.patrimonio)}</td>
        <td>${esc(m.usuario)}<br><small>${esc(m.ip)}</small></td><td>${(m.tamanho / 1048576).toFixed(2)} MB</td>
        <td class="id" title="${esc(m.sha256)}">${esc(m.sha256.slice(0, 16))}…</td>
        <td style="white-space:nowrap"><button class="btn small" data-open="${esc(m.id)}">Abrir</button>
          <a class="btn small ghost" href="api/coletas/${encodeURIComponent(m.id)}/zip${srv.token ? '?token=' + encodeURIComponent(srv.token) : ''}">Baixar</a></td></tr>`).join('')}
      </tbody></table></div>`}`;
  const qi = $('#srvQ');
  qi.addEventListener('input', () => { srv.q = qi.value; drawServerList(); const n = $('#srvQ'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); });
  $('#srvRe').addEventListener('click', loadServerList);
  box.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openFromServer(b.dataset.open, b)));
}

async function openFromServer(id, btn) {
  const meta = srv.list.find(m => m.id === id);
  $('#err').hidden = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Abrindo...'; }
  try {
    const r = await api(`api/coletas/${encodeURIComponent(id)}/zip`);
    if (!r.ok) throw new Error(`Servidor respondeu ${r.status}.`);
    const buf = await r.arrayBuffer();
    const map = new Map(await readZip(buf));
    state.files = map;
    state.zip = { name: meta.arquivo, size: buf.byteLength, hash: await sha256Hex(new Uint8Array(buf)) };
    state.shaTxt = null;
    state.origin = { tipo: 'servidor', meta };
    if (!findFile('02_dispositivos.csv') && !findFile('06_saude.json')) throw new Error('O .zip não contém dados de coleta (02_dispositivos.csv ou 06_saude.json).');
    build();
  } catch (e) {
    console.error(e); showErr(e.message || String(e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Abrir'; }
  }
}

// ------------------------------------------------------------------ relatorio
const REP_FIELDS = [
  ['orgao', 'Órgão / setor', 'ex.: Departamento de TI'],
  ['processo', 'Processo / memorando nº', ''],
  ['solicitante', 'Solicitante', ''],
  ['local', 'Local do equipamento', 'sala / setor'],
];
const rep = { orgao: '', processo: '', solicitante: '', responsavel: '', cargo: '', matricula: '', local: '', cidade: '', obs: '' };
try { Object.assign(rep, JSON.parse(localStorage.getItem('diagReport') || '{}')); } catch { /* ok */ }
function saveRep() { try { localStorage.setItem('diagReport', JSON.stringify({ orgao: rep.orgao, responsavel: rep.responsavel, cargo: rep.cargo, matricula: rep.matricula, cidade: rep.cidade })); } catch { /* ok */ } }

const SMBIOS_TXT = { 'Sem violacao': 'Sem violação', 'Tentativa de violacao': 'Tentativa de violação', 'Violacao detectada': 'Violação detectada', 'Nao informado pela BIOS': 'Não informado pela BIOS', 'Outro': 'Outro', 'Desconhecido': 'Desconhecido' };
const smbiosTxt = v => SMBIOS_TXT[v] || v || '—';

function constatacoes() {
  const out = [];
  const gpus = state.windows.filter(w => w.dev.classe === 'Display');
  const outros = state.windows.filter(w => w.dev.classe !== 'Display');
  if (!state.windows.length) {
    out.push('Não há, nos registros de dispositivos do sistema operacional, adaptador de vídeo ou dispositivo PCI com status "não presente".');
  } else {
    out.push(`Dispositivos com status "não presente": ${state.windows.length} (${gpus.length} adaptador(es) de vídeo${outros.length ? `, ${outros.length} outro(s) dispositivo(s) PCI` : ''}).`);
  }
  for (const w of state.windows) {
    if (!w.last) {
      out.push(`<b>${esc(w.dev.nome)}</b>: sem datas de instalação/detecção no registro; intervalo não estimado.`);
      continue;
    }
    let t = `<b>${esc(w.dev.nome)}</b>: intervalo estimado de remoção de <b>${fmt(w.start)}</b> a <b>${w.end ? fmt(w.end) : 'data da coleta'}</b>`;
    if (w.end) t += ` (${dur(w.end - w.start)})`;
    t += w.basis === 'shutdown' ? ', com o equipamento desligado.' : '.';
    if (w.substitutes.length) t += ` Adaptador de vídeo ativo após o intervalo: ${w.substitutes.map(x => esc(x.nome)).join(', ')}.`;
    if (w.crash) t += ` Registrado desligamento não controlado próximo ao intervalo (ID ${w.crash.id}).`;
    out.push(t);
  }
  const ch = state.info['Intrusao no chassis'] || '';
  if (/violacao|tentativa/i.test(ch)) out.push(`Sensor de intrusão do chassi (SMBIOS): <b>${esc(smbiosTxt(ch))}</b>.`);
  const del = state.pnp.filter(p => p.id === 420);
  if (del.length) out.push(`Eventos de exclusão de dispositivo (Kernel-PnP ID 420) no período dos logs: ${del.length}.`);
  const ig = state.integ;
  if (ig && ig.results.length) out.push(ig.bad ? `<b>Integridade:</b> ${ig.bad} de ${ig.results.length} arquivo(s) divergem do hash SHA-256 registrado na coleta.` : `Integridade: os ${ig.ok} arquivos da coleta conferem com os hashes SHA-256 registrados no momento da coleta.`);
  return out;
}

function renderRelatorio() {
  const el = $('#tab-relatorio');
  if (!el || !state.devices) return;
  const i = state.info, ig = state.integ || { results: [], ok: 0, bad: 0 };
  const now = new Date();
  const hasW = state.windows.length > 0;
  const sec = (() => { let n = 0; return () => ++n; })();
  const formHtml = `<div class="panel noprint rep-form">
      <h2>Dados do relatório</h2>
      <div class="rep-grid">${REP_FIELDS.map(([k, l, ph]) => `<label>${l}<input data-rep="${k}" value="${esc(rep[k])}" placeholder="${esc(ph)}"></label>`).join('')}</div>
      <label class="rep-obs">Observações do técnico<textarea data-rep="obs" rows="3" placeholder="ex.: lacre do gabinete rompido; imagens do DVR solicitadas em ...">${esc(rep.obs)}</textarea></label>
      ${anexosFormHtml()}
      <div class="filters" style="margin:10px 0 0"><button class="btn" id="repPrint">Imprimir / salvar PDF</button>
      <small>Responsável, cargo, matrícula, cidade e data são pedidos ao imprimir. No diálogo de impressão, escolha "Salvar como PDF" e ative "Gráficos de plano de fundo".</small></div>
    </div>`;

  const sIdent = sec(), sMet = sec(), sRes = sec(), sDet = hasW ? sec() : 0, sInt = sec(), sAnx = state.anexos.length ? sec() : 0, sLim = sec(), sObs = rep.obs ? sec() : 0;

  const windowsHtml = state.windows.map((w, n) => {
    const d = w.dev;
    const evs = w.last ? state.events.filter(e => e.t >= new Date(w.last.getTime() - 3600000) && e.t <= new Date((w.end || now).getTime() + 3600000) &&
      (e.tipo !== 'pnp' || /PCI\\|DISPLAY/i.test(e.det))).slice(0, 60) : [];
    const inW = e => w.last && e.t >= w.start && (!w.end || e.t <= w.end);
    const criterio = w.basis === 'shutdown'
      ? 'Início: último desligamento (ID 6006/1074) após a última detecção. Fim: primeira inicialização (ID 6005) sem o dispositivo.'
      : 'Início: última detecção do dispositivo (sem desligamento registrado depois dela). Fim: primeira inicialização (ID 6005) sem o dispositivo.';
    return `<div class="r-block">
      <h3>${sDet}.${n + 1} ${esc(d.nome)}</h3>
      <table class="r-kv">
        <tr><th>Classe</th><td>${esc(d.classe)}</td><th>Status</th><td><b class="r-bad">Não presente</b></td></tr>
        <tr><th>InstanceId</th><td colspan="3" class="r-mono">${esc(d.id)}</td></tr>
        <tr><th>Primeira instalação</th><td>${fmt(d.first)}</td><th>Última detecção</th><td>${fmt(w.last)}</td></tr>
        <tr><th>Último desligamento após a detecção</th><td>${w.shut ? `${fmt(w.shut.t)} <span class="r-small">(ID ${w.shut.id})</span>` : '—'}</td><th>Primeira inicialização sem o dispositivo</th><td>${fmt(w.end)}</td></tr>
        <tr><th>Remoção registrada pelo SO</th><td>${d.removal ? fmt(d.removal) : 'não registrada'}</td><th>Adaptador de vídeo ativo após</th><td>${w.substitutes.map(x => esc(x.nome)).join(', ') || '—'}</td></tr>
      </table>
      ${w.last ? `<div class="r-window">
        <div class="r-window-l">Intervalo estimado</div>
        <div class="r-window-v">${fmt(w.start)} &nbsp;→&nbsp; ${w.end ? fmt(w.end) : 'data da coleta'}</div>
        <div class="r-window-s">Duração: ${w.end ? dur(w.end - w.start) : '—'}${state.offsetMin ? ` · Com defasagem de ${state.offsetMin > 0 ? '+' : ''}${state.offsetMin} min: ${fmt(toDvr(w.start))} → ${w.end ? fmt(toDvr(w.end)) : '—'}` : ''}</div>
        <div class="r-window-s">Critério: ${criterio}</div>
      </div>` : '<p>Datas insuficientes no registro para estimar o intervalo.</p>'}
      ${evs.length ? `<h4>Eventos de 1 h antes da última detecção até 1 h após a primeira inicialização sem o dispositivo</h4>
      <table class="r-table"><thead><tr><th>Data/hora (equipamento)</th>${state.offsetMin ? '<th>Data/hora ajustada</th>' : ''}<th>Origem</th><th>ID</th><th>Evento</th><th>Detalhe</th></tr></thead>
      <tbody>${evs.map(e => `<tr class="${inW(e) ? 'r-in' : ''}"><td class="r-dt">${fmt(e.t)}</td>${state.offsetMin ? `<td class="r-dt">${fmt(toDvr(e.t))}</td>` : ''}<td>${TIPOS[e.tipo].label}</td><td class="r-dt">${e.code || '—'}</td><td>${esc(e.titulo.replace(/^PnP \d+ · /, ''))}</td><td class="r-small">${esc(e.det)}</td></tr>`).join('')}</tbody></table>
      <p class="r-small">Linhas destacadas: eventos dentro do intervalo estimado.</p>` : ''}
    </div>`;
  }).join('');

  const origem = state.origin && state.origin.tipo === 'servidor'
    ? `Recebido pelo servidor em ${fmt(new Date(state.origin.meta.recebidoEm))} · id ${esc(state.origin.meta.id)} · origem ${esc(state.origin.meta.ip)}`
    : 'Arquivo aberto localmente';
  const fuso = i['Fuso horario'] ? esc(i['Fuso horario']) : 'não informado';

  const paper = `<article class="paper">
    <header class="r-head">
      <div>
        <div class="r-org">${esc(rep.orgao || 'Tecnologia da Informação')}</div>
        <h1>Relatório Técnico</h1>
        <div class="r-sub">Diagnóstico de hardware: verificação de ausência de componente</div>
      </div>
      <table class="r-meta">
        <tr><th>Processo</th><td>${esc(rep.processo || '—')}</td></tr>
        <tr><th>Emissão</th><td>${fmt(now).slice(0, 10)}</td></tr>
        <tr><th>Patrimônio</th><td><b>${esc(i['Patrimonio'] || '—')}</b></td></tr>
      </table>
    </header>

    <section>
      <h2>${sIdent}. Identificação do equipamento</h2>
      <table class="r-kv">
        <tr><th>Nome do computador</th><td>${esc(i['Computador'] || '—')}</td><th>Patrimônio</th><td>${esc(i['Patrimonio'] || '—')}${i['Origem patrimonio'] ? `<br><span class="r-small">${esc(i['Origem patrimonio'])}</span>` : ''}</td></tr>
        <tr><th>Fabricante / modelo</th><td>${esc(i['Fabricante / Modelo'] || '—')}</td><th>Número de série (BIOS)</th><td>${esc(i['Serial (BIOS)'] || '—')}</td></tr>
        <tr><th>Sistema operacional</th><td>${esc(i['Sistema'] || '—')}</td><th>Instalação do SO</th><td>${esc(i['Instalacao do SO'] || '—')}</td></tr>
        <tr><th>Localização</th><td>${esc(rep.local || '—')}</td><th>Solicitante</th><td>${esc(rep.solicitante || '—')}</td></tr>
        <tr><th>Sensor de intrusão (SMBIOS)</th><td colspan="3">${esc(smbiosTxt(i['Intrusao no chassis']))}</td></tr>
      </table>
    </section>

    <section>
      <h2>${sMet}. Coleta e método</h2>
      <table class="r-kv">
        <tr><th>Data/hora da coleta</th><td>${esc(i['Hora da coleta'] || '—')}</td><th>Executada por</th><td>${esc(i['Coletado por'] || '—')}</td></tr>
        <tr><th>Fuso horário</th><td>${fuso}</td><th>Período coberto pelos logs</th><td>${state.coverage ? `${fmt(state.coverage.from)} a ${fmt(state.coverage.to)}` : '—'}</td></tr>
        <tr><th>Origem do pacote</th><td colspan="3">${origem}</td></tr>
      </table>
      <p>Coleta automatizada em modo somente leitura (script diag-hardware), com cálculo de hash SHA-256 de cada arquivo no momento da coleta. Fontes analisadas:</p>
      <table class="r-table">
        <thead><tr><th>Fonte</th><th>Dados utilizados</th></tr></thead>
        <tbody>
          <tr><td>Registro de dispositivos Plug and Play</td><td>Status de presença e datas de primeira instalação, última detecção e remoção (DEVPKEY_Device_FirstInstallDate, LastArrivalDate, LastRemovalDate)</td></tr>
          <tr><td>Log System</td><td>Inicialização (ID 6005), desligamento (6006, 1074) e desligamento não controlado (6008, 41)</td></tr>
          <tr><td>Log Microsoft-Windows-Kernel-PnP/Configuration</td><td>Configuração, inicialização e exclusão de dispositivos (ID 400, 410, 420, 430)</td></tr>
          <tr><td>Log Security</td><td>Logons interativos, desbloqueio e remotos (ID 4624, tipos 2, 7, 10 e 11)</td></tr>
          <tr><td>SMBIOS / WMI</td><td>Identificação do equipamento e estado do sensor de intrusão do chassi</td></tr>
        </tbody>
      </table>
    </section>

    <section>
      <h2>${sRes}. Resultados</h2>
      <ol class="r-list">${constatacoes().map(c => `<li>${c}</li>`).join('')}</ol>
    </section>

    ${hasW ? `<section><h2>${sDet}. Detalhamento por dispositivo</h2>${windowsHtml}</section>` : ''}

    <section class="r-break-avoid">
      <h2>${sInt}. Integridade da coleta</h2>
      <table class="r-kv">
        <tr><th>Pacote</th><td colspan="3">${state.zip ? `${esc(state.zip.name)} · ${(state.zip.size / 1048576).toFixed(2)} MB` : 'aberto como pasta (sem verificação do pacote)'}</td></tr>
        ${state.zip ? `<tr><th>SHA-256 do pacote</th><td colspan="3" class="r-mono">${state.zip.hash}</td></tr>` : ''}
        ${ig.srvMeta ? `<tr><th>Verificação no recebimento</th><td colspan="3">${ig.srvMeta.sha256 === (state.zip && state.zip.hash) ? 'hash idêntico ao registrado pelo servidor' : '<b class="r-bad">hash diferente do registrado pelo servidor</b>'} em ${fmt(new Date(ig.srvMeta.recebidoEm))}</td></tr>` : ''}
        ${ig.shaTxt ? `<tr><th>Arquivo .sha256.txt</th><td colspan="3">${ig.shaTxt === (state.zip && state.zip.hash) ? 'hash idêntico' : '<b class="r-bad">hash diferente</b>'}</td></tr>` : ''}
        <tr><th>Arquivos internos</th><td colspan="3">${ig.results.length ? (ig.bad ? `<b class="r-bad">${ig.bad} divergente(s)</b> de ${ig.results.length}` : `${ig.ok} de ${ig.results.length} idênticos ao registrado na coleta`) : 'lista de hashes não encontrada'}</td></tr>
      </table>
      ${ig.results.length ? `<table class="r-table r-hash"><thead><tr><th>Arquivo</th><th>Verificação</th><th>SHA-256</th></tr></thead><tbody>
        ${ig.results.map(r => `<tr><td>${esc(r.arq)}</td><td>${r.st === 'ok' ? 'idêntico' : r.st === 'falta' ? '<b class="r-bad">ausente</b>' : '<b class="r-bad">divergente</b>'}</td><td class="r-mono">${esc(r.got || r.exp)}</td></tr>`).join('')}
      </tbody></table>` : ''}
    </section>

    ${state.anexos.length ? `<section class="r-break-avoid">
      <h2>${sAnx}. Anexos</h2>
      <table class="r-table r-hash"><thead><tr><th>Nº</th><th>Descrição</th><th>Arquivo</th><th>Data</th><th>SHA-256</th></tr></thead><tbody>
      ${state.anexos.map((a, n) => `<tr><td>${n + 1}</td><td>${esc(a.legenda || '—')}</td><td>${esc(a.nome)}<br><span class="r-small">${tamanhoTxt(a.tamanho)}</span></td><td class="r-small">${anexoDataTxt(a)}</td><td class="r-mono">${esc(a.sha256)}</td></tr>`).join('')}
      </tbody></table>
      <p class="r-small">Os anexos de imagem estão reproduzidos ao final deste relatório.${state.anexos.some(a => a.tipo === 'application/pdf') ? ' Documentos PDF são entregues em separado; a integridade pode ser conferida pelo SHA-256.' : ''}</p>
    </section>` : ''}

    ${rep.obs ? '' : '<div class="r-break-avoid">'}
    <section class="r-break-avoid">
      <h2>${sLim}. Escopo e limitações do método</h2>
      <ol class="r-list r-small">
        <li><b>Referência de tempo.</b> Os horários são do relógio do equipamento (fuso ${fuso}). A correlação com outras fontes, como CFTV ou controle de acesso, depende da defasagem entre os relógios${state.offsetMin ? `; defasagem aplicada neste relatório: ${state.offsetMin > 0 ? '+' : ''}${state.offsetMin} min` : ''}.</li>
        <li><b>Natureza do intervalo.</b> O intervalo indica quando o dispositivo deixou de ser enumerado pelo sistema operacional. O método não identifica autoria nem motivo da alteração.</li>
        <li><b>Registro de remoção.</b> A data de remoção (LastRemovalDate) nem sempre é gravada quando o componente é retirado com o equipamento desligado; nesses casos o intervalo é delimitado pelos eventos de desligamento e inicialização.</li>
        <li><b>Retenção dos logs.</b> Os logs do Windows têm tamanho máximo e são sobrescritos de forma circular. Eventos anteriores a ${state.coverage ? fmt(state.coverage.from) : 'o período coberto'} não estão disponíveis nesta coleta.</li>
        <li><b>Histórico removido.</b> Reinstalação do sistema, exclusão de dispositivos (ID 420) ou limpeza de drivers eliminam o histórico de dispositivos anteriores.</li>
        <li><b>Componente idêntico.</b> Dispositivos PCI são identificados por fabricante, modelo, subsistema e posição no barramento. A substituição por componente idêntico no mesmo slot não altera o identificador e não é detectável por este método.</li>
        <li><b>Registros de logon.</b> Os eventos 4624 indicam sessões abertas no equipamento e não estabelecem relação com a alteração de hardware.</li>
        <li><b>Conferência complementar.</b> Recomenda-se confrontar os resultados com o cadastro patrimonial e com as ordens de serviço de manutenção do equipamento.</li>
      </ol>
    </section>

    ${rep.obs ? `<div class="r-break-avoid"><section><h2>${sObs}. Observações</h2><p class="r-obs">${esc(rep.obs).replace(/\n/g, '<br>')}</p></section>` : ''}

    <footer class="r-sign">
      <div class="r-sign-line">
        <div class="r-sign-name">${esc(rep.responsavel || 'Responsável técnico')}</div>
        <div class="r-sign-role">${esc(rep.cargo || 'Cargo')}</div>
        <div class="r-small">${rep.matricula ? 'Matrícula ' + esc(rep.matricula) : 'Matrícula'}</div>
      </div>
      <div class="r-sign-date">${esc(rep.cidade || '__________________')}, ${rep.data ? esc(dataExtenso(rep.data)) : '____ / ____ / ________'}</div>
    </footer>
    </div>
    <div class="r-foot r-small">Gerado em ${fmt(now)} pelo Visualizador de Coletas (diag-hardware) <br>SHA-256 do pacote: <span class="r-mono">${state.zip ? state.zip.hash : '—'}</span></div>
    ${state.anexos.length ? `<section class="r-anexos"><h2>Reprodução dos anexos</h2>${state.anexos.map((a, n) => `<figure class="r-anexo">
      <figcaption><b>Anexo ${n + 1}</b>${a.legenda ? ' – ' + esc(a.legenda) : ''}</figcaption>
      ${a.tipo.startsWith('image/') ? `<img src="${esc(a.url)}" alt="Anexo ${n + 1}">` : `<div class="r-pdf">Documento PDF entregue em separado: <b>${esc(a.nome)}</b></div>`}
      <div class="r-small">${esc(a.nome)} · ${tamanhoTxt(a.tamanho)} · ${anexoDataTxt(a)}<br>SHA-256 <span class="r-mono">${esc(a.sha256)}</span></div>
    </figure>`).join('')}</section>` : ''}
  </article>`;

  const active = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.rep : null;
  el.innerHTML = formHtml + paper;
  el.querySelectorAll('[data-rep]').forEach(inp => inp.addEventListener('change', () => {
    rep[inp.dataset.rep] = inp.value; saveRep(); renderRelatorio();
  }));
  if (active) { const a = el.querySelector(`[data-rep="${active}"]`); if (a) a.focus(); }
  $('#repPrint').addEventListener('click', askPrint);
  bindAnexos(el);
}

loadServerList();

// ------------------------------------------------------------------ dados de assinatura (pedidos ao imprimir)
function dataExtenso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function setPageFooter(texto) {
  let st = document.getElementById('pageFooter');
  if (!st) { st = document.createElement('style'); st.id = 'pageFooter'; document.head.appendChild(st); }
  st.textContent = `@page { @bottom-left { content: "${String(texto).replace(/["\\]/g, '')}"; font: 8pt "Segoe UI", Arial, sans-serif; color: #5d6673; } }`;
}

function askPrint(after) {
  let dlg = $('#printDlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'printDlg';
    dlg.className = 'dlg noprint';
    document.body.appendChild(dlg);
  }
  const hoje = toLocalInput(new Date()).slice(0, 10);
  dlg.innerHTML = `<form id="pf" novalidate>
      <h2>Assinatura do relatório</h2>
      <p class="muted">Estes dados vão no rodapé do relatório impresso.</p>
      <label>Responsável técnico *<input name="responsavel" required autocomplete="name" value="${esc(rep.responsavel)}"></label>
      <div class="dlg-row">
        <label>Cargo *<input name="cargo" required autocomplete="organization-title" value="${esc(rep.cargo)}" placeholder="ex.: Técnico de Informática"></label>
        <label>Matrícula *<input name="matricula" required value="${esc(rep.matricula)}"></label>
      </div>
      <div class="dlg-row">
        <label>Cidade<input name="cidade" value="${esc(rep.cidade)}"></label>
        <label>Data<input type="date" name="data" value="${esc(rep.data || hoje)}"></label>
      </div>
      <p class="err" id="pfErr" hidden>Preencha responsável, cargo e matrícula.</p>
      <div class="dlg-actions">
        <button type="button" class="btn ghost" id="pfCancel">Cancelar</button>
        <button type="submit" class="btn">Imprimir</button>
      </div>
    </form>`;
  const f = $('#pf');
  f.addEventListener('submit', e => {
    e.preventDefault();
    const v = n => f.elements[n].value.trim();
    const falta = ['responsavel', 'cargo', 'matricula'].find(n => !v(n));
    if (falta) {
      $('#pfErr').hidden = false;
      f.elements[falta].focus();
      return;
    }
    rep.responsavel = v('responsavel'); rep.cargo = v('cargo'); rep.matricula = v('matricula');
    rep.cidade = v('cidade'); rep.data = v('data');
    saveRep();
    dlg.close();
    if (typeof after === 'function') after();
    else { setPageFooter('Relatório técnico – diagnóstico de hardware'); renderRelatorio(); }
    setTimeout(async () => { await waitImages(); window.print(); }, 60);
  });
  $('#pfCancel').addEventListener('click', () => dlg.close());
  dlg.showModal();
  const first = [...f.querySelectorAll('input[required]')].find(i => !i.value) || f.querySelector('button[type=submit]');
  first.focus();
}

// ------------------------------------------------------------------ anexos do relatorio
const ANX_OK = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/;
const isServidor = () => state.origin && state.origin.tipo === 'servidor';
const anxBase = () => `api/coletas/${encodeURIComponent(state.origin.meta.id)}/anexos`;
const anxUrl = aid => `${anxBase()}/${aid}${srv.token ? '?token=' + encodeURIComponent(srv.token) : ''}`;
function tamanhoTxt(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
function anexoDataTxt(a) {
  if (a.capturada) { const d = parseDate(a.capturada); if (d) return 'Foto tirada em ' + fmt(d); }
  if (a.modificado) { const d = new Date(a.modificado); if (!isNaN(d)) return 'Arquivo modificado em ' + fmt(d); }
  return '—';
}

// Data de captura gravada pela câmera (EXIF DateTimeOriginal) em JPEG
function exifDate(u8) {
  try {
    if (u8[0] !== 0xFF || u8[1] !== 0xD8) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = 2;
    while (p + 10 < u8.length) {
      if (u8[p] !== 0xFF) return null;
      const mk = u8[p + 1], len = dv.getUint16(p + 2);
      if (mk === 0xDA) return null;
      if (mk === 0xE1 && dv.getUint32(p + 4) === 0x45786966) {
        const t = p + 10, le = dv.getUint16(t) === 0x4949;
        const g16 = o => dv.getUint16(t + o, le), g32 = o => dv.getUint32(t + o, le);
        const ifd = off => { const n = g16(off), tags = {}; for (let i = 0; i < n; i++) { const e = off + 2 + i * 12; tags[g16(e)] = { count: g32(e + 4), val: g32(e + 8), pos: e + 8 }; } return tags; };
        const str = tg => { if (!tg) return null; const o = tg.count > 4 ? tg.val : tg.pos; let x = ''; for (let i = 0; i < tg.count - 1; i++) x += String.fromCharCode(u8[t + o + i]); return x; };
        const i0 = ifd(g32(4));
        let d = null;
        if (i0[0x8769]) { const ex = ifd(i0[0x8769].val); d = str(ex[0x9003]) || str(ex[0x9004]); }
        d = d || str(i0[0x0132]);
        const m = d && d.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})/);
        return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}` : null;
      }
      p += 2 + len;
    }
  } catch { /* sem exif */ }
  return null;
}

async function loadAnexos() {
  state.anexos.forEach(a => { if (a.local) URL.revokeObjectURL(a.url); });
  state.anexos = [];
  if (!isServidor()) return;
  try {
    const r = await api(anxBase());
    if (r.ok) state.anexos = (await r.json()).map(m => ({ ...m, url: anxUrl(m.aid) }));
  } catch { /* sem anexos */ }
}

function anexosFormHtml() {
  const list = state.anexos.map((a, n) => `<div class="anx-item">
      <div class="anx-thumb">${a.tipo.startsWith('image/') ? `<img src="${esc(a.url)}" alt="">` : '<span>PDF</span>'}</div>
      <div class="anx-info">
        <div><b>Anexo ${n + 1}</b> · ${esc(a.nome)} · ${tamanhoTxt(a.tamanho)} · <span class="muted">${anexoDataTxt(a)}</span></div>
        <div class="mono anx-hash">SHA-256 ${esc(a.sha256)}</div>
        <input data-anx="${esc(a.aid)}" value="${esc(a.legenda || '')}" maxlength="300" placeholder="Descrição (ex.: lacre de garantia do gabinete rompido)">
      </div>
      <button class="btn small ghost" data-anxdel="${esc(a.aid)}" title="Remover anexo">Remover</button>
    </div>`).join('');
  return `<div class="rep-anx">
      <div class="head-row"><h3 style="margin:0">Anexos (${state.anexos.length})</h3>
        <label class="btn small">Adicionar fotos / PDF<input id="anxIn" type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" multiple hidden></label></div>
      <p class="muted" style="margin:0 0 8px">${isServidor() ? 'Os anexos ficam guardados no servidor junto com esta coleta.' : '<b>Coleta aberta localmente:</b> os anexos ficam só nesta página e se perdem ao fechar. Abra a coleta pela lista do servidor para guardá-los.'}</p>
      <p class="err" id="anxMsg" hidden></p>
      <div class="anx-list">${list}</div>
    </div>`;
}

function anxErr(msg) { const e = $('#anxMsg'); if (!e) return; e.textContent = msg; e.hidden = !msg; }

function bindAnexos(el) {
  const inp = el.querySelector('#anxIn');
  if (inp) inp.addEventListener('change', () => { const f = [...inp.files]; inp.value = ''; addAnexos(f); });
  el.querySelectorAll('[data-anx]').forEach(i => i.addEventListener('change', () => setLegenda(i.dataset.anx, i.value)));
  el.querySelectorAll('[data-anxdel]').forEach(b => b.addEventListener('click', () => removeAnexo(b.dataset.anxdel)));
}

async function addAnexos(files) {
  const erros = [];
  for (const f of files) {
    const tipo = (f.type || '').toLowerCase();
    if (!ANX_OK.test(tipo)) { erros.push(`${f.name}: tipo não suportado (use JPG, PNG, WEBP, GIF ou PDF).`); continue; }
    const u8 = new Uint8Array(await f.arrayBuffer());
    const meta = {
      nome: f.name, legenda: '', tipo, tamanho: f.size, sha256: await sha256Hex(u8),
      modificado: new Date(f.lastModified).toISOString(), capturada: tipo === 'image/jpeg' ? exifDate(u8) : null,
    };
    if (isServidor()) {
      try {
        const r = await api(anxBase(), { method: 'POST', body: u8, headers: {
          'Content-Type': tipo, 'X-Nome': encodeURIComponent(f.name), 'X-Sha256': meta.sha256,
          'X-Modificado': meta.modificado, 'X-Capturada': meta.capturada || '' } });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { erros.push(`${f.name}: ${j.erro || 'falha no envio (' + r.status + ')'}`); continue; }
        state.anexos.push({ ...j, url: anxUrl(j.aid) });
      } catch { erros.push(`${f.name}: sem conexão com o servidor.`); }
    } else {
      state.anexos.push({ ...meta, aid: 'l' + Math.random().toString(36).slice(2, 10), local: true, url: URL.createObjectURL(f) });
    }
  }
  renderRelatorio();
  anxErr(erros.join(' '));
}

async function setLegenda(aid, legenda) {
  const a = state.anexos.find(x => x.aid === aid);
  if (!a) return;
  a.legenda = legenda;
  if (isServidor() && !a.local) {
    const r = await api(`${anxBase()}/${aid}`, { method: 'PUT', body: JSON.stringify({ legenda }), headers: { 'Content-Type': 'application/json' } }).catch(() => null);
    if (!r || !r.ok) { renderRelatorio(); anxErr('Não foi possível salvar a descrição no servidor.'); return; }
  }
  renderRelatorio();
}

async function removeAnexo(aid) {
  const a = state.anexos.find(x => x.aid === aid);
  if (!a || !window.confirm(`Remover o anexo "${a.nome}" do relatório?`)) return;
  if (isServidor() && !a.local) {
    const r = await api(`${anxBase()}/${aid}`, { method: 'DELETE' }).catch(() => null);
    if (!r || !r.ok) { anxErr('Não foi possível remover no servidor.'); return; }
  }
  if (a.local) URL.revokeObjectURL(a.url);
  state.anexos = state.anexos.filter(x => x.aid !== aid);
  renderRelatorio();
}

function waitImages(ms = 8000) {
  const imgs = [...document.querySelectorAll('.paper img')].filter(i => !i.complete);
  if (!imgs.length) return Promise.resolve();
  return Promise.race([
    Promise.all(imgs.map(i => new Promise(res => { i.addEventListener('load', res, { once: true }); i.addEventListener('error', res, { once: true }); }))),
    new Promise(res => setTimeout(res, ms)),
  ]);
}

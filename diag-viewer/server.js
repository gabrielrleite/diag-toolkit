'use strict';
/*
  Servidor da Central diag (coletas, laudos, equipamentos e recebimentos)
  - Serve a interface web (pasta web/)
  - POST /api/coletas           recebe o .zip enviado pelo script (token obrigatorio)
  - GET  /api/coletas           lista as coletas recebidas
  - GET  /api/coletas/:id/zip   baixa uma coleta
  - GET  /api/info              estado do servidor (envio ativo, leitura protegida)
  - GET/POST   /api/coletas/:id/anexos        lista / adiciona anexo (foto ou PDF)
  - GET/PUT/DELETE /api/coletas/:id/anexos/:aid  baixa / altera legenda / remove
  - GET/POST   /api/laudos                    lista / cria laudo de manutencao
  - GET/PUT    /api/laudos/:id                le / atualiza (guarda revisoes)
  - .../api/laudos/:id/anexos[/:aid]          anexos do laudo (mesmas regras)
  - GET/POST /api/modelos, GET/PUT/DELETE /api/modelos/:id, POST /api/modelos/:id/restaurar
  - POST /api/laudos/:id/preparar   PDF com campo de assinatura -> ticket para o assinador local
  - GET  /api/assinatura/:ticket/pdf, POST /api/assinatura/:ticket   (assinador do Windows)
  - GET  /api/laudos/:id/assinado    PDF assinado digitalmente
  - GET/POST /api/laudos/:id/digitalizado   via fisica assinada (digitalizada)
  - GET  /api/coleta/pacote.zip     scripts de coleta com diag-servidor.cfg preenchido
  - GET/POST /api/recebimentos, GET/PUT/DELETE /api/recebimentos/:id   folhas de recebimento (lidas por OCR no navegador)
  - .../api/recebimentos/:id/anexos[/:aid]   foto original e imagem retificada da folha
  - GET/POST /api/receb-locais, PUT/DELETE /api/receb-locais/:id   cadastro de locais (endereço completo)
  - POST /api/recebimentos/lote     corrige/apaga um local ou SELB em todas as folhas
  - GET /api/receb-selbs, PUT/DELETE /api/receb-selbs/:selb   cadastro dos SELBs (equipamento, cores, tinta/toner)
  - GET /api/monitor, POST /api/monitor/verificar   ping das impressoras com IP (a cada MONITOR_MIN minutos)
  - POST/DELETE /api/monitor/pausa, GET /api/monitor/historico?selb=&dias=, GET /api/monitor/quedas?dias=
  - GET /api/suprimentos, POST /api/suprimentos/ler, POST /api/suprimentos/testar, GET /api/suprimentos/historico
    níveis de tinta/toner/caixa pelas impressoras (SNMP, Printer MIB), a cada SUPRIMENTOS_HORAS horas
  - GET /api/ocr/saude, POST /api/ocr   repasse ao serviço diag-ocr (TrOCR), se OCR_URL estiver definido
  - GET /api/treino, PUT /api/treino/config, POST /api/treino/exemplos, POST /api/treino/esquecer,
    GET /api/treino/exportar.zip, DELETE /api/treino   modo treinamento (aprender com as correções)
  Sem dependencias externas: so Node.js.
*/
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const PORT = +process.env.PORT || 8080;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const WEB = path.join(__dirname, 'web');
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';
const READ_TOKEN = process.env.READ_TOKEN || '';
const MAX_BYTES = (+process.env.MAX_MB || 500) * 1048576;
const OCR_URL = (process.env.OCR_URL || '').replace(/\/$/, ''); // serviço diag-ocr (ex.: http://ocr:8000)
const MONITOR_MIN = Math.max(1, +process.env.MONITOR_MIN || 5); // intervalo do ping das impressoras (minutos)
// alertas (queda/retorno de impressora, suprimento abaixo de 25%) enviados por POST JSON a este endereço:
// Teams/Google Chat/Slack (campo "text"), Discord ("content") ou ntfy. Vazio = só na tela.
const ALERTA_WEBHOOK = (process.env.ALERTA_WEBHOOK || '').trim();
const DIR = path.join(DATA, 'coletas');
const ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const AID_RE = /^[0-9a-f]{12}$/;
const ANX_MAX = (+process.env.ANEXO_MAX_MB || 25) * 1048576;
const ANX_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' };

fs.mkdirSync(DIR, { recursive: true });

const SEC = {
  // wasm-unsafe-eval: o OCR (Tesseract) roda em WebAssembly no navegador
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8',
  '.ps1': 'application/octet-stream', '.bat': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8', '.zip': 'application/zip',
};

function json(res, code, obj) {
  res.writeHead(code, { ...SEC, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const ipOf = req => (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
function safeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
const tokenOf = (req, url) => req.headers['x-token'] || url.searchParams.get('token') || '';
function hdr(req, name, max = 200) {
  let v = req.headers[name] || '';
  try { v = decodeURIComponent(v); } catch { /* mantem bruto */ }
  return v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}
async function audit(ev) {
  const line = JSON.stringify({ quando: new Date().toISOString(), ...ev }) + '\n';
  await fsp.appendFile(path.join(DATA, 'audit.log'), line).catch(e => console.error('audit:', e.message));
}
function canRead(req, url) { return !READ_TOKEN || safeEq(tokenOf(req, url), READ_TOKEN); }

async function listMeta() {
  const names = (await fsp.readdir(DIR)).filter(n => n.endsWith('.json') && ID_RE.test(n.slice(0, -5)));
  const out = [];
  for (const n of names) {
    try {
      const m = JSON.parse(await fsp.readFile(path.join(DIR, n), 'utf8'));
      m.anexos = (await readAnx(owner('coleta', m.id))).length;
      out.push(m);
    } catch { /* ignora corrompido */ }
  }
  return out.sort((a, b) => String(b.recebidoEm).localeCompare(String(a.recebidoEm)));
}

// ------------------------------------------------------------------ upload
async function upload(req, res, url) {
  const ip = ipOf(req);
  const reject = async (code, erro, extra = {}) => {
    req.resume();
    await audit({ acao: 'envio_recusado', motivo: erro, ip, ...extra });
    json(res, code, { erro });
  };
  if (!UPLOAD_TOKEN) return reject(503, 'Envio desativado no servidor (UPLOAD_TOKEN não definido).');
  const tokEnvio = tokenOf(req, url);
  if (!safeEq(tokEnvio, UPLOAD_TOKEN)) return reject(401, 'Token de envio inválido.');
  if (+req.headers['content-length'] > MAX_BYTES) return reject(413, `Arquivo maior que o limite de ${MAX_BYTES / 1048576} MB.`);

  const meta = {
    arquivo: path.basename(hdr(req, 'x-arquivo', 160)).replace(/[^\w.\-]/g, '_') || 'coleta.zip',
    computador: hdr(req, 'x-computador', 64),
    patrimonio: hdr(req, 'x-patrimonio', 64),
    usuario: hdr(req, 'x-usuario', 128),
    tipo: hdr(req, 'x-tipo', 20) === 'diagnostico' ? 'diagnostico' : 'remocao',
    shaInformado: hdr(req, 'x-sha256', 64).toUpperCase(),
  };
  const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + crypto.randomBytes(3).toString('hex');
  const tmp = path.join(DIR, id + '.part');
  const hash = crypto.createHash('sha256');
  let size = 0, head = Buffer.alloc(0);
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_BYTES) return cb(new Error('LIMITE'));
      if (head.length < 4) head = Buffer.concat([head, chunk.subarray(0, 4 - head.length)]);
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, meter, fs.createWriteStream(tmp));
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    if (e.message === 'LIMITE') return reject(413, `Arquivo maior que o limite de ${MAX_BYTES / 1048576} MB.`, meta);
    await audit({ acao: 'envio_interrompido', ip, erro: e.message, ...meta });
    if (!res.headersSent) json(res, 400, { erro: 'Envio interrompido.' });
    return;
  }

  const sha = hash.digest('hex').toUpperCase();
  if (size === 0 || !head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    await fsp.rm(tmp, { force: true });
    return reject(400, 'O conteúdo recebido não é um .zip.', meta);
  }
  if (meta.shaInformado && meta.shaInformado !== sha) {
    await fsp.rm(tmp, { force: true });
    return reject(422, 'SHA256 recebido não confere com o informado. Arquivo corrompido no envio; tente de novo.', { ...meta, shaRecebido: sha });
  }

  const dup = (await listMeta()).find(m => m.sha256 === sha);
  if (dup) {
    await fsp.rm(tmp, { force: true });
    await audit({ acao: 'envio_duplicado', id: dup.id, ip, sha256: sha });
    return json(res, 200, { ok: true, duplicado: true, id: dup.id, sha256: sha, recebidoEm: dup.recebidoEm });
  }

  const final = {
    id, ...meta, sha256: sha, tamanho: size,
    hashConferido: !!meta.shaInformado,
    recebidoEm: new Date().toISOString(),
    ip, userAgent: hdr(req, 'user-agent', 200),
  };
  delete final.shaInformado;
  await fsp.rename(tmp, path.join(DIR, id + '.zip'));
  await fsp.writeFile(path.join(DIR, id + '.json'), JSON.stringify(final, null, 2));
  await audit({ acao: 'envio_recebido', id, ip, sha256: sha, tamanho: size, computador: meta.computador, usuario: meta.usuario });
  console.log(`[recebido] ${id} ${meta.computador} ${size} bytes de ${ip}`);
  json(res, 201, { ok: true, id, sha256: sha, recebidoEm: final.recebidoEm });
}

// ------------------------------------------------------------------ anexos (coletas e laudos)
// "dono" do anexo: uma coleta ou um laudo
const LDIR = path.join(DATA, 'laudos');
fs.mkdirSync(LDIR, { recursive: true });
const LID_RE = /^\d{4}-\d{4}$/;
const RDIR = path.join(DATA, 'recebimentos');
fs.mkdirSync(RDIR, { recursive: true });
const RID_RE = /^\d{8}-[0-9a-f]{6}$/;
function owner(tipo, id) {
  const base = { laudo: LDIR, receb: RDIR }[tipo] || DIR;
  const re = { laudo: LID_RE, receb: RID_RE }[tipo] || ID_RE;
  return {
    tipo, id, chave: tipo + ':' + id,
    dir: path.join(base, id + '.anexos'),
    idx: path.join(base, id + '.anexos.json'),
    existe: () => re.test(id) && fs.existsSync(path.join(base, id + '.json')),
  };
}
async function readAnx(o) {
  try { return JSON.parse(await fsp.readFile(o.idx, 'utf8')); } catch { return []; }
}
async function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}
const writeAnx = (o, list) => writeJsonAtomic(o.idx, list);
// serializa alteracoes concorrentes no mesmo recurso
const locks = new Map();
function withLock(key, fn) {
  const p = (locks.get(key) || Promise.resolve()).then(fn, fn);
  locks.set(key, p.catch(() => {}));
  return p;
}

async function readJsonBody(req, max = 65536) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) throw new Error('grande'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function anexoUpload(req, res, o) {
  const ip = ipOf(req);
  const fail = (code, erro) => { req.resume(); json(res, code, { erro }); };
  const tipo = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = ANX_TYPES[tipo];
  if (!ext) return fail(415, 'Tipo de arquivo não permitido. Use JPG, PNG, WEBP, GIF ou PDF.');
  if (+req.headers['content-length'] > ANX_MAX) return fail(413, `Anexo maior que ${ANX_MAX / 1048576} MB.`);
  await fsp.mkdir(o.dir, { recursive: true });
  const aid = crypto.randomBytes(6).toString('hex');
  const file = path.join(o.dir, aid + ext), tmp = file + '.part';
  const hash = crypto.createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _e, cb) {
      size += chunk.length;
      if (size > ANX_MAX) return cb(new Error('LIMITE'));
      hash.update(chunk); cb(null, chunk);
    },
  });
  try {
    await pipeline(req, meter, fs.createWriteStream(tmp));
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    return fail(e.message === 'LIMITE' ? 413 : 400, e.message === 'LIMITE' ? `Anexo maior que ${ANX_MAX / 1048576} MB.` : 'Envio interrompido.');
  }
  const sha = hash.digest('hex').toUpperCase();
  const informado = hdr(req, 'x-sha256', 64).toUpperCase();
  if (!size || (informado && informado !== sha)) {
    await fsp.rm(tmp, { force: true });
    return json(res, 422, { erro: 'Arquivo vazio ou hash diferente do calculado no navegador. Tente de novo.' });
  }
  await fsp.rename(tmp, file);
  const meta = {
    aid, nome: hdr(req, 'x-nome', 160) || 'anexo' + ext, legenda: hdr(req, 'x-legenda', 300),
    tipo, tamanho: size, sha256: sha,
    modificado: hdr(req, 'x-modificado', 40), capturada: hdr(req, 'x-capturada', 40),
    enviadoEm: new Date().toISOString(), ip,
  };
  await withLock(o.chave, async () => { const l = await readAnx(o); l.push(meta); await writeAnx(o, l); });
  await audit({ acao: 'anexo_adicionado', [o.tipo]: o.id, aid, nome: meta.nome, sha256: sha, tamanho: size, ip });
  json(res, 201, meta);
}

async function anexoRoute(req, res, url, o, aid) {
  if (!canRead(req, url)) { req.resume(); return json(res, 401, { erro: 'Token de leitura necessário.' }); }
  if (!o.existe()) { req.resume(); return json(res, 404, { erro: { laudo: 'Laudo não encontrado.', receb: 'Folha não encontrada.' }[o.tipo] || 'Coleta não encontrada.' }); }
  if (!aid) {
    if (req.method === 'GET') return json(res, 200, await readAnx(o));
    if (req.method === 'POST') return anexoUpload(req, res, o);
    return json(res, 405, { erro: 'Método não permitido.' });
  }
  if (!AID_RE.test(aid)) return json(res, 400, { erro: 'id de anexo inválido' });
  const meta = (await readAnx(o)).find(a => a.aid === aid);
  if (!meta) { req.resume(); return json(res, 404, { erro: 'Anexo não encontrado.' }); }
  const file = path.join(o.dir, aid + ANX_TYPES[meta.tipo]);

  if (req.method === 'GET') {
    const st = await fsp.stat(file).catch(() => null);
    if (!st) return json(res, 404, { erro: 'Arquivo do anexo não encontrado no servidor.' });
    res.writeHead(200, {
      ...SEC, 'Content-Type': meta.tipo, 'Content-Length': st.size, 'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `inline; filename="${meta.nome.replace(/[^\w.\- ]/g, '_')}"`, 'X-Sha256': meta.sha256,
    });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === 'PUT') {
    let body;
    try { body = await readJsonBody(req); } catch { return json(res, 400, { erro: 'JSON inválido.' }); }
    const legenda = String(body.legenda || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 300);
    const upd = await withLock(o.chave, async () => {
      const l = await readAnx(o); const a = l.find(x => x.aid === aid);
      if (!a) return null;
      a.legenda = legenda; await writeAnx(o, l); return a;
    });
    if (!upd) return json(res, 404, { erro: 'Anexo não encontrado.' });
    await audit({ acao: 'anexo_legenda', [o.tipo]: o.id, aid, ip: ipOf(req) });
    return json(res, 200, upd);
  }
  if (req.method === 'DELETE') {
    // o arquivo nao e apagado: fica renomeado como .removido (rastro de auditoria)
    await withLock(o.chave, async () => {
      const l = (await readAnx(o)).filter(x => x.aid !== aid); await writeAnx(o, l);
    });
    await fsp.rename(file, file + '.removido').catch(() => {});
    await audit({ acao: 'anexo_removido', [o.tipo]: o.id, aid, nome: meta.nome, sha256: meta.sha256, ip: ipOf(req) });
    return json(res, 200, { ok: true });
  }
  json(res, 405, { erro: 'Método não permitido.' });
}

// ------------------------------------------------------------------ laudos de manutencao
const CONCLUSOES = ['', 'reparado', 'aguardando_peca', 'garantia', 'sem_defeito', 'antieconomico', 'baixa'];
const STATUS = ['rascunho', 'emitido', 'cancelado'];
const RESULTADOS = ['', 'ok', 'falha', 'na'];
const ACOES_PECA = ['', 'substituida', 'a_substituir', 'recuperada', 'removida'];
const txt = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
const pick = (v, list) => (list.includes(v) ? v : list[0]);

function sanitizeLaudo(b) {
  const L = {
    status: pick(b.status, STATUS),
    coletaId: ID_RE.test(b.coletaId || '') ? b.coletaId : '',
    patrimonio: txt(b.patrimonio, 40), computador: txt(b.computador, 64),
    setor: txt(b.setor, 120), local: txt(b.local, 120), solicitante: txt(b.solicitante, 120),
    chamado: txt(b.chamado, 60), dataAbertura: txt(b.dataAbertura, 10),
    problema: txt(b.problema, 4000), diagnostico: txt(b.diagnostico, 8000), solucao: txt(b.solucao, 8000),
    conclusao: pick(b.conclusao, CONCLUSOES), justificativa: txt(b.justificativa, 4000),
    recomendacoes: txt(b.recomendacoes, 4000), observacoes: txt(b.observacoes, 4000),
    testes: (Array.isArray(b.testes) ? b.testes : []).slice(0, 30).map(t => ({ nome: txt(t && t.nome, 120), resultado: pick(t && t.resultado, RESULTADOS), obs: txt(t && t.obs, 300) })),
    pecas: (Array.isArray(b.pecas) ? b.pecas : []).slice(0, 50).map(p => ({ item: txt(p && p.item, 160), qtd: Math.max(0, Math.min(999, parseInt(p && p.qtd, 10) || 0)), acao: pick(p && p.acao, ACOES_PECA), obs: txt(p && p.obs, 300) })),
    assinatura: {},
    snapshot: null,
  };
  const a = b.assinatura || {};
  L.assinatura = { responsavel: txt(a.responsavel, 120), cargo: txt(a.cargo, 120), matricula: txt(a.matricula, 40), cidade: txt(a.cidade, 80), data: txt(a.data, 10) };
  if (b.snapshot && typeof b.snapshot === 'object' && JSON.stringify(b.snapshot).length <= 100000) L.snapshot = b.snapshot;
  // modelo usado: id + copia (o laudo continua igual mesmo se o modelo for editado depois)
  L.modeloId = MID_RE.test(b.modeloId || '') ? b.modeloId : '';
  L.modeloSnap = b.modeloSnap && typeof b.modeloSnap === 'object' ? { id: L.modeloId, ...sanitizeModelo(b.modeloSnap) } : null;
  L.campos = {};
  if (b.campos && typeof b.campos === 'object') {
    for (const [k, v] of Object.entries(b.campos).slice(0, 30)) if (/^[a-z0-9_]{1,30}$/.test(k)) L.campos[k] = txt(v, 2000);
  }
  return L;
}

async function proximoNumero() {
  return withLock('laudo-seq', async () => {
    const ano = new Date().getFullYear();
    const f = path.join(LDIR, `seq-${ano}.txt`);
    const n = (parseInt(await fsp.readFile(f, 'utf8').catch(() => '0'), 10) || 0) + 1;
    await fsp.writeFile(f, String(n));
    const seq = String(n).padStart(4, '0');
    return { id: `${ano}-${seq}`, numero: `${seq}/${ano}` };
  });
}

async function listLaudos() {
  const names = (await fsp.readdir(LDIR)).filter(n => LID_RE.test(n.replace(/\.json$/, '')) && n.endsWith('.json'));
  const out = [];
  for (const n of names) {
    try {
      const l = JSON.parse(await fsp.readFile(path.join(LDIR, n), 'utf8'));
      out.push({
        id: l.id, numero: l.numero, status: l.status, conclusao: l.conclusao, revisao: l.revisao,
        patrimonio: l.patrimonio, computador: l.computador, setor: l.setor, chamado: l.chamado,
        problema: (l.problema || '').slice(0, 160), coletaId: l.coletaId,
        modeloId: l.modeloId || '', modeloNome: l.modeloSnap ? l.modeloSnap.nome : '',
        assinado: l.assinaturaDigital ? 'digital' : l.assinaturaFisica ? 'fisica' : '',
        criadoEm: l.criadoEm, atualizadoEm: l.atualizadoEm, anexos: (await readAnx(owner('laudo', l.id))).length,
      });
    } catch { /* ignora */ }
  }
  return out.sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
}

async function laudoRoute(req, res, url, id) {
  if (!canRead(req, url)) { req.resume(); return json(res, 401, { erro: 'Token de leitura necessário.' }); }
  const ip = ipOf(req);
  if (!id) {
    if (req.method === 'GET') return json(res, 200, await listLaudos());
    if (req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req, 300000); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
      const { id: nid, numero } = await proximoNumero();
      const agora = new Date().toISOString();
      const l = { id: nid, numero, revisao: 1, criadoEm: agora, atualizadoEm: agora, criadoPorIp: ip, ...sanitizeLaudo(body) };
      await writeJsonAtomic(path.join(LDIR, nid + '.json'), l);
      await audit({ acao: 'laudo_criado', laudo: nid, patrimonio: l.patrimonio, ip });
      return json(res, 201, l);
    }
    return json(res, 405, { erro: 'Método não permitido.' });
  }
  if (!LID_RE.test(id)) { req.resume(); return json(res, 400, { erro: 'id de laudo inválido' }); }
  const file = path.join(LDIR, id + '.json');
  if (req.method === 'GET') {
    const l = await fsp.readFile(file, 'utf8').catch(() => null);
    return l ? json(res, 200, JSON.parse(l)) : json(res, 404, { erro: 'Laudo não encontrado.' });
  }
  if (req.method === 'PUT') {
    let body;
    try { body = await readJsonBody(req, 300000); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
    const out = await withLock('laudo:' + id, async () => {
      const atual = JSON.parse(await fsp.readFile(file, 'utf8').catch(() => 'null'));
      if (!atual) return null;
      if (atual.assinaturaDigital || atual.assinaturaFisica) return { travado: true };
      if (body.revisao && +body.revisao !== atual.revisao) return { conflito: atual.revisao };
      // guarda a versao anterior (historico de revisoes)
      await fsp.writeFile(path.join(LDIR, `${id}.r${atual.revisao}.json.bak`), JSON.stringify(atual, null, 2));
      const novo = { ...atual, ...sanitizeLaudo(body), id: atual.id, numero: atual.numero, criadoEm: atual.criadoEm, criadoPorIp: atual.criadoPorIp, revisao: atual.revisao + 1, atualizadoEm: new Date().toISOString() };
      await writeJsonAtomic(file, novo);
      return novo;
    });
    if (!out) return json(res, 404, { erro: 'Laudo não encontrado.' });
    if (out.travado) return json(res, 409, { erro: 'Laudo assinado: não pode mais ser alterado.' });
    if (out.conflito) return json(res, 409, { erro: `O laudo foi alterado em outro lugar (revisão ${out.conflito}). Recarregue antes de salvar.` });
    await audit({ acao: 'laudo_atualizado', laudo: id, revisao: out.revisao, status: out.status, ip });
    return json(res, 200, out);
  }
  json(res, 405, { erro: 'Método não permitido.' });
}

// ------------------------------------------------------------------ folhas de recebimento (OCR)
// Cada folha: várias linhas (SELB, data, local, CPF, nome). A leitura é feita no navegador;
// o servidor guarda o resultado conferido, a foto original e a imagem retificada (anexos).
const COLS_RECEB = ['selb', 'data', 'local', 'cpf', 'nome'];
const ITENS_RECEB = ['preto', 'azul', 'magenta', 'amarelo', 'caixa']; // cores (azul = ciano) e caixa de manutenção
// mesma regra do navegador para separar vários SELBs numa entrega ("A123, A124")
const RecebOCR = require(path.join(WEB, 'receb-ocr.js'));
function sanitizeFolha(b) {
  const F = {
    titulo: txt(b.titulo, 160), obs: txt(b.obs, 2000), dataFolha: /^\d{4}-\d{2}-\d{2}$/.test(b.dataFolha || '') ? b.dataFolha : '',
    linhas: (Array.isArray(b.linhas) ? b.linhas : []).slice(0, 300).map(l => {
      const o = { n: Math.max(0, Math.min(999, parseInt(l && l.n, 10) || 0)), revisado: !!(l && l.revisado), escrita: !!(l && l.escrita), conf: {} };
      for (const k of COLS_RECEB) o[k] = txt(l && l[k], k === 'local' || k === 'nome' ? 160 : k === 'selb' ? 300 : 40).replace(/[\r\n\t]+/g, ' ').trim();
      o.selb = RecebOCR.juntarSelbs(RecebOCR.separarSelbs(o.selb).map(x => x.toUpperCase().slice(0, 40)).slice(0, 30));
      o.dataIso = /^\d{4}-\d{2}-\d{2}$/.test((l && l.dataIso) || '') ? l.dataIso : '';
      for (const k of COLS_RECEB) { const c = l && l.conf && +l.conf[k]; if (c >= 0 && c <= 100) o.conf[k] = Math.round(c); }
      // leitura original do OCR e motor usado (modo treinamento: compara com o texto conferido)
      o.lido = {};
      if (l && l.lido && typeof l.lido === 'object') for (const k of ['selb', 'data', 'local']) if (l.lido[k] != null) o.lido[k] = txt(l.lido[k], 300);
      o.motor = ['servidor', 'navegador'].includes(l && l.motor) ? l.motor : '';
      // itens entregues (tintas/toners por cor e caixa de manutenção), por SELB da linha
      o.itens = (Array.isArray(l && l.itens) ? l.itens : []).slice(0, 80).map(it => ({
        selb: txt(it && it.selb, 40).toUpperCase().trim(), item: ITENS_RECEB.includes(it && it.item) ? it.item : '',
        qtd: Math.max(1, Math.min(99, parseInt(it && it.qtd, 10) || 1)), tipo: ['tinta', 'toner'].includes(it && it.tipo) ? it.tipo : '',
      })).filter(it => it.item);
      return o;
    }).filter(l => l.escrita || COLS_RECEB.some(k => l[k]) || l.itens.length), // escrita: linha preenchida só com nome/assinatura também conta
    grade: null,
  };
  // posições das linhas na imagem retificada (para mostrar o recorte de cada linha)
  const g = b.grade;
  if (g && Array.isArray(g.linhas) && g.linhas.length <= 400) {
    F.grade = { w: +g.w || 0, h: +g.h || 0, linhas: g.linhas.map(v => Math.max(0, Math.round(+v || 0))), colunas: (Array.isArray(g.colunas) ? g.colunas : []).slice(0, 20).map(v => Math.max(0, Math.round(+v || 0))) };
  }
  return F;
}
const resumoFolha = f => ({
  id: f.id, titulo: f.titulo, dataFolha: f.dataFolha, criadoEm: f.criadoEm, atualizadoEm: f.atualizadoEm, revisao: f.revisao, manual: f.manual ? { hora: f.manual.hora || '' } : false,
  total: f.linhas.length, pendentes: f.linhas.filter(l => !l.revisado).length,
});
async function listFolhas(completo) {
  const names = (await fsp.readdir(RDIR)).filter(n => n.endsWith('.json') && RID_RE.test(n.slice(0, -5)));
  const out = [];
  for (const n of names) {
    try {
      const f = JSON.parse(await fsp.readFile(path.join(RDIR, n), 'utf8'));
      out.push(completo ? { ...resumoFolha(f), linhas: f.linhas } : resumoFolha(f));
    } catch { /* ignora */ }
  }
  return out.sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
}
async function recebRoute(req, res, url, id) {
  if (!canRead(req, url)) { req.resume(); return json(res, 401, { erro: 'Token de leitura necessário.' }); }
  const ip = ipOf(req);
  if (!id) {
    if (req.method === 'GET') return json(res, 200, await listFolhas(url.searchParams.get('linhas') === '1'));
    if (req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req, 500000); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
      const agora = new Date();
      const nid = agora.toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex');
      const f = { id: nid, revisao: 1, criadoEm: agora.toISOString(), atualizadoEm: agora.toISOString(), criadoPorIp: ip, ...sanitizeFolha(body) };
      await writeJsonAtomic(path.join(RDIR, nid + '.json'), f);
      await audit({ acao: 'folha_recebimento_criada', folha: nid, linhas: f.linhas.length, ip });
      return json(res, 201, f);
    }
    return json(res, 405, { erro: 'Método não permitido.' });
  }
  if (!RID_RE.test(id)) { req.resume(); return json(res, 400, { erro: 'id de folha inválido' }); }
  const file = path.join(RDIR, id + '.json');
  if (req.method === 'GET') {
    const f = await fsp.readFile(file, 'utf8').catch(() => null);
    return f ? json(res, 200, JSON.parse(f)) : json(res, 404, { erro: 'Folha não encontrada.' });
  }
  if (req.method === 'PUT') {
    let body;
    try { body = await readJsonBody(req, 500000); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
    const out = await withLock('receb:' + id, async () => {
      const atual = JSON.parse(await fsp.readFile(file, 'utf8').catch(() => 'null'));
      if (!atual) return null;
      if (body.revisao && +body.revisao !== atual.revisao) return { conflito: atual.revisao };
      await fsp.writeFile(path.join(RDIR, `${id}.r${atual.revisao}.json.bak`), JSON.stringify(atual, null, 2));
      const san = sanitizeFolha(body);
      const novo = { ...atual, ...san, grade: san.grade || atual.grade, id, criadoEm: atual.criadoEm, criadoPorIp: atual.criadoPorIp, revisao: atual.revisao + 1, atualizadoEm: new Date().toISOString() };
      await writeJsonAtomic(file, novo);
      return novo;
    });
    if (!out) return json(res, 404, { erro: 'Folha não encontrada.' });
    if (out.conflito) return json(res, 409, { erro: `A folha foi alterada em outro lugar (revisão ${out.conflito}). Recarregue antes de salvar.` });
    await audit({ acao: 'folha_recebimento_atualizada', folha: id, revisao: out.revisao, ip });
    return json(res, 200, out);
  }
  if (req.method === 'DELETE') {
    // não apaga: renomeia (rastro de auditoria), igual aos anexos
    const ok = await withLock('receb:' + id, async () => fsp.rename(file, file + '.removido').then(() => true, () => false));
    if (!ok) return json(res, 404, { erro: 'Folha não encontrada.' });
    await audit({ acao: 'folha_recebimento_removida', folha: id, ip });
    return json(res, 200, { ok: true });
  }
  json(res, 405, { erro: 'Método não permitido.' });
}

// ------------------------------------------------------------------ cadastro de locais e correção em lote
const LOCAIS_FILE = path.join(RDIR, 'locais.json');
const LOCID_RE = /^[0-9a-f]{10}$/;
const CATID_RE = /^[0-9a-f]{8}$/;
const CAT_CORES = ['azul', 'verde', 'ambar', 'vermelho', 'violeta', 'rosa', 'ciano', 'cinza'];
const normRec = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const chaveSelbRec = t => normRec(t).replace(/ /g, '');
async function lerLocais() { try { return JSON.parse(await fsp.readFile(LOCAIS_FILE, 'utf8')); } catch { return { locais: [], removidos: [] }; } }
function sanitizeLocal(b) {
  const t = (k, max) => txt(b && b[k], max).replace(/[\r\n\t]+/g, ' ').trim();
  return {
    nome: t('nome', 160), logradouro: t('logradouro', 200), numero: t('numero', 20), complemento: t('complemento', 120),
    bairro: t('bairro', 120), cidade: t('cidade', 120), uf: t('uf', 2).toUpperCase().replace(/[^A-Z]/g, ''),
    cep: t('cep', 9).replace(/[^\d-]/g, ''), referencia: t('referencia', 300), obs: txt(b && b.obs, 1000),
    pai: LOCID_RE.test(t('pai', 10)) ? t('pai', 10) : '', // sublocal (sala, bloco...) de um local principal
    categoria: CATID_RE.test(t('categoria', 8)) ? t('categoria', 8) : '', // categoria personalizada (Escola, UBS...)
  };
}
// sublocal: um nível só. O principal não pode ser sublocal; quem vira sublocal passa os seus sublocais para o novo principal
function ajustarPai(db, L, id) {
  if (!L.pai) return null;
  const p = db.locais.find(x => x.id === L.pai);
  if (!p || L.pai === id) return 'Local principal inválido.';
  if (p.pai) L.pai = p.pai; // escolheu um sublocal: usa o principal dele
  if (L.pai === id) return 'Local principal inválido.';
  if (id) for (const x of db.locais) if (x.pai === id) x.pai = L.pai;
  return null;
}
async function locaisRoute(req, res, url, id) {
  if (!canRead(req, url)) { req.resume(); return json(res, 401, { erro: 'Token de leitura necessário.' }); }
  const ip = ipOf(req);
  if (id === 'unificar') return unificarLocais(req, res, ip);
  if (id === 'categorias') return categoriasRoute(req, res, ip);
  if (id === 'categorizar') return categorizarLocais(req, res, ip);
  if (id && !LOCID_RE.test(id)) { req.resume(); return json(res, 400, { erro: 'id de local inválido' }); }
  if (req.method === 'GET' && !id) return json(res, 200, (await lerLocais()).locais);
  let body = {};
  if (req.method === 'POST' || req.method === 'PUT') {
    try { body = await readJsonBody(req, 20000); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
  }
  const out = await withLock('receb-locais', async () => {
    const db = await lerLocais();
    const agora = new Date().toISOString();
    const dup = (nome, exceto) => db.locais.find(l => l.id !== exceto && normRec(l.nome) === normRec(nome));
    if (req.method === 'POST' && !id) {
      const L = sanitizeLocal(body);
      if (!L.nome) return { code: 400, erro: 'Informe o nome do local.' };
      if (dup(L.nome)) return { code: 409, erro: `Já existe o local "${dup(L.nome).nome}".` };
      const ep = ajustarPai(db, L, ''); if (ep) return { code: 400, erro: ep };
      if (L.categoria && !(db.categorias || []).some(c => c.id === L.categoria)) L.categoria = '';
      const novo = { id: crypto.randomBytes(5).toString('hex'), ...L, criadoEm: agora, atualizadoEm: agora };
      db.locais.push(novo); await writeJsonAtomic(LOCAIS_FILE, db);
      return { code: 201, obj: novo, audit: { acao: 'local_cadastrado', local: novo.id, nome: novo.nome } };
    }
    const i = db.locais.findIndex(l => l.id === id);
    if (!id || i < 0) return { code: id ? 404 : 405, erro: id ? 'Local não encontrado.' : 'Método não permitido.' };
    if (req.method === 'PUT') {
      const L = sanitizeLocal(body);
      if (!L.nome) return { code: 400, erro: 'Informe o nome do local.' };
      if (dup(L.nome, id)) return { code: 409, erro: `Já existe o local "${dup(L.nome, id).nome}".` };
      const ep = ajustarPai(db, L, id); if (ep) return { code: 400, erro: ep };
      if (L.categoria && !(db.categorias || []).some(c => c.id === L.categoria)) L.categoria = '';
      db.locais[i] = { ...db.locais[i], ...L, atualizadoEm: agora };
      await writeJsonAtomic(LOCAIS_FILE, db);
      return { code: 200, obj: db.locais[i], audit: { acao: 'local_alterado', local: id, nome: L.nome } };
    }
    if (req.method === 'DELETE') {
      // fica guardado em "removidos" (auditoria); as entregas não são alteradas
      const [rem] = db.locais.splice(i, 1);
      for (const x of db.locais) if (x.pai === id) x.pai = ''; // sublocais viram locais principais
      db.removidos = [...(db.removidos || []), { ...rem, removidoEm: agora, removidoPorIp: ip }];
      await writeJsonAtomic(LOCAIS_FILE, db);
      return { code: 200, obj: { ok: true }, audit: { acao: 'local_removido', local: id, nome: rem.nome } };
    }
    return { code: 405, erro: 'Método não permitido.' };
  });
  if (out.audit) await audit({ ...out.audit, ip });
  return json(res, out.code, out.erro ? { erro: out.erro } : out.obj);
}

// categorias dos locais (personalizáveis): GET lista; PUT grava a lista inteira [{id?, nome, cor}].
// Categoria removida sai dos locais que a usavam.
async function categoriasRoute(req, res, ip) {
  if (req.method === 'GET') return json(res, 200, (await lerLocais()).categorias || []);
  if (req.method !== 'PUT') { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
  let b; try { b = await readJsonBody(req, 50000); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
  const lista = (Array.isArray(b) ? b : Array.isArray(b && b.categorias) ? b.categorias : []).slice(0, 100);
  const out = await withLock('receb-locais', async () => {
    const db = await lerLocais(), novas = [];
    for (const c of lista) {
      const nome = txt(c && c.nome, 60).replace(/[\r\n\t]+/g, ' ').trim();
      if (!nome) continue;
      if (novas.some(x => normRec(x.nome) === normRec(nome))) return { erro: `Categoria repetida: "${nome}".` };
      const id = CATID_RE.test(c.id) && (db.categorias || []).some(x => x.id === c.id) ? c.id : crypto.randomBytes(4).toString('hex');
      novas.push({ id, nome, cor: CAT_CORES.includes(c.cor) ? c.cor : CAT_CORES[novas.length % CAT_CORES.length] });
    }
    const ids = new Set(novas.map(c => c.id));
    let limpos = 0;
    for (const l of db.locais) if (l.categoria && !ids.has(l.categoria)) { l.categoria = ''; limpos++; }
    db.categorias = novas;
    await writeJsonAtomic(LOCAIS_FILE, db);
    return { categorias: novas, limpos };
  });
  if (out.erro) return json(res, 400, { erro: out.erro });
  await audit({ acao: 'locais_categorias', categorias: out.categorias.map(c => c.nome), ip });
  return json(res, 200, out.categorias);
}
// define a categoria de vários locais de uma vez (nomes sem cadastro são cadastrados)
async function categorizarLocais(req, res, ip) {
  if (req.method !== 'POST') { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
  let b; try { b = await readJsonBody(req, 50000); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
  const nomes = [...new Set((Array.isArray(b.nomes) ? b.nomes : []).map(v => txt(v, 160).replace(/[\r\n\t]+/g, ' ').trim()).filter(Boolean))].slice(0, 500);
  const cat = txt(b.categoria, 8);
  if (!nomes.length) return json(res, 400, { erro: 'Selecione ao menos um local.' });
  const out = await withLock('receb-locais', async () => {
    const db = await lerLocais(), agora = new Date().toISOString();
    if (cat && !(db.categorias || []).some(c => c.id === cat)) return { erro: 'Categoria não encontrada.' };
    for (const nome of nomes) {
      let L = db.locais.find(l => normRec(l.nome) === normRec(nome));
      if (!L) { L = { id: crypto.randomBytes(5).toString('hex'), ...sanitizeLocal({ nome }), criadoEm: agora }; db.locais.push(L); }
      L.categoria = cat; L.atualizadoEm = agora;
    }
    await writeJsonAtomic(LOCAIS_FILE, db);
    return { n: nomes.length };
  });
  if (out.erro) return json(res, 400, { erro: out.erro });
  await audit({ acao: 'locais_categorizados', categoria: cat, nomes, ip });
  return json(res, 200, out);
}

// textos da aba Recebimentos e submenus (títulos, abas, ajudas) personalizados; vazio = texto padrão
const TEXTOS_FILE = path.join(RDIR, 'textos.json');
async function textosRoute(req, res, url) {
  if (!canRead(req, url)) { req.resume(); return json(res, 401, { erro: 'Token de leitura necessário.' }); }
  if (req.method === 'GET') { try { return json(res, 200, JSON.parse(await fsp.readFile(TEXTOS_FILE, 'utf8'))); } catch { return json(res, 200, {}); } }
  if (req.method !== 'PUT') { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
  let b; try { b = await readJsonBody(req, 100000); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
  const out = {};
  for (const [k, v] of Object.entries(b && typeof b === 'object' ? b : {}).slice(0, 200)) {
    if (!/^[a-z]+\.[a-zA-Z]+$/.test(k) || k.length > 60 || typeof v !== 'string') continue;
    const t = v.replace(/\r/g, '').trim().slice(0, 1000);
    if (t) out[k] = t;
  }
  await writeJsonAtomic(TEXTOS_FILE, out);
  await audit({ acao: 'recebimentos_textos', chaves: Object.keys(out), ip: ipOf(req) });
  return json(res, 200, out);
}

// garante cadastro para os nomes de local informados (ex.: local vinculado no cadastro do SELB); devolve os criados
async function garantirLocais(nomes) {
  nomes = [...new Set(nomes.map(n => String(n || '').trim()).filter(Boolean))];
  if (!nomes.length) return [];
  return withLock('receb-locais', async () => {
    const db = await lerLocais(), agora = new Date().toISOString(), criados = [];
    for (const nome of nomes) {
      if (db.locais.some(l => normRec(l.nome) === normRec(nome))) continue;
      const n = { id: crypto.randomBytes(5).toString('hex'), ...sanitizeLocal({ nome }), criadoEm: agora, atualizadoEm: agora };
      db.locais.push(n); criados.push(n.nome);
    }
    if (criados.length) await writeJsonAtomic(LOCAIS_FILE, db);
    return criados;
  });
}

// unificar: os locais escolhidos viram sublocais (salas, blocos...) de um local principal.
// Nomes sem cadastro são cadastrados; as entregas não mudam (continuam com o nome da sala).
async function unificarLocais(req, res, ip) {
  if (req.method !== 'POST') { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
  let b; try { b = await readJsonBody(req, 50000); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
  const limpa = v => txt(v, 160).replace(/[\r\n\t]+/g, ' ').trim();
  const principal = limpa(b.principal);
  const subs = [...new Set((Array.isArray(b.sublocais) ? b.sublocais : []).map(limpa).filter(n => n && normRec(n) !== normRec(principal)))].slice(0, 500);
  if (!principal || !subs.length) return json(res, 400, { erro: 'Informe o local principal e ao menos um sublocal.' });
  const out = await withLock('receb-locais', async () => {
    const db = await lerLocais(), agora = new Date().toISOString();
    const achar = nome => db.locais.find(l => normRec(l.nome) === normRec(nome));
    const criar = nome => { const n = { id: crypto.randomBytes(5).toString('hex'), ...sanitizeLocal({ nome }), criadoEm: agora, atualizadoEm: agora }; db.locais.push(n); return n; };
    const P = achar(principal) || criar(principal);
    if (P.pai) { P.pai = ''; P.atualizadoEm = agora; } // era sala de outro: vira principal
    for (const nome of subs) {
      const L = achar(nome) || criar(nome);
      for (const x of db.locais) if (x.pai === L.id) x.pai = P.id; // as salas dele passam para o novo principal
      L.pai = P.id; L.atualizadoEm = agora;
    }
    await writeJsonAtomic(LOCAIS_FILE, db);
    return { principal: P, n: subs.length };
  });
  await audit({ acao: 'locais_unificados', principal: out.principal.nome, sublocais: subs, ip });
  return json(res, 200, out);
}

// ------------------------------------------------------------------ entregas manuais (assinadas no celular)
// Uma entrega manual vira uma "folha" de uma linha (local, SELB, data, itens, quem recebeu) com manual: {...}:
// campos personalizados, assinatura desenhada na tela (PNG) e fotos opcionais (anexos da folha).
const CAMPOS_FILE = path.join(RDIR, 'entrega-campos.json');
const TIPOS_CAMPO_ENTREGA = ['texto', 'texto_longo', 'numero', 'data', 'lista', 'sim_nao'];
const CAMPOS_PADRAO = {
  recebedor: { ativo: true, obrigatorio: true, rotulo: 'Nome de quem recebeu' },
  documento: { ativo: false, obrigatorio: false, rotulo: 'CPF / matrícula' },
  assinatura: { obrigatoria: true },
  fotos: { ativo: true, max: 4 },
  termo: 'Declaro que recebi os itens acima em perfeito estado.',
  campos: [],
};
async function lerCamposEntrega() {
  let c = {};
  try { c = JSON.parse(await fsp.readFile(CAMPOS_FILE, 'utf8')); } catch { /* padrão */ }
  return { ...CAMPOS_PADRAO, ...c, recebedor: { ...CAMPOS_PADRAO.recebedor, ...(c.recebedor || {}) }, documento: { ...CAMPOS_PADRAO.documento, ...(c.documento || {}) },
    assinatura: { ...CAMPOS_PADRAO.assinatura, ...(c.assinatura || {}) }, fotos: { ...CAMPOS_PADRAO.fotos, ...(c.fotos || {}) } };
}
function sanitizeCamposEntrega(b) {
  const lim = (v, n) => txt(v, n).replace(/[\r\n\t]+/g, ' ').trim();
  const fixo = (o, pad) => ({ ativo: o ? !!o.ativo : pad.ativo, obrigatorio: o ? !!o.obrigatorio && !!o.ativo : pad.obrigatorio, rotulo: lim(o && o.rotulo, 60) || pad.rotulo });
  const ids = new Set();
  return {
    recebedor: fixo(b.recebedor, CAMPOS_PADRAO.recebedor), documento: fixo(b.documento, CAMPOS_PADRAO.documento),
    assinatura: { obrigatoria: !!(b.assinatura && b.assinatura.obrigatoria) },
    fotos: { ativo: !!(b.fotos && b.fotos.ativo), max: Math.max(1, Math.min(10, parseInt(b.fotos && b.fotos.max, 10) || 4)) },
    termo: txt(b.termo, 500).trim(),
    campos: (Array.isArray(b.campos) ? b.campos : []).slice(0, 30).map(c => {
      let id = c && typeof c.id === 'string' && /^[a-z0-9]{6,12}$/.test(c.id) ? c.id : crypto.randomBytes(4).toString('hex');
      if (ids.has(id)) id = crypto.randomBytes(4).toString('hex');
      ids.add(id);
      return { id, rotulo: lim(c && c.rotulo, 60), tipo: TIPOS_CAMPO_ENTREGA.includes(c && c.tipo) ? c.tipo : 'texto', obrigatorio: !!(c && c.obrigatorio), ativo: c ? c.ativo !== false : true,
        opcoes: (Array.isArray(c && c.opcoes) ? c.opcoes : []).map(o => lim(o, 60)).filter(Boolean).slice(0, 30) };
    }).filter(c => c.rotulo),
  };
}
async function camposEntregaRoute(req, res, url) {
  if (!canRead(req, url)) { req.resume(); return json(res, 401, { erro: 'Token de leitura necessário.' }); }
  if (req.method === 'GET') return json(res, 200, await lerCamposEntrega());
  if (req.method !== 'PUT') { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
  let b; try { b = await readJsonBody(req, 50000); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
  const c = sanitizeCamposEntrega(b || {});
  await writeJsonAtomic(CAMPOS_FILE, c);
  await audit({ acao: 'entrega_campos', campos: c.campos.map(x => x.rotulo), ip: ipOf(req) });
  return json(res, 200, c);
}
// grava uma imagem (data URL) como anexo da folha
async function salvarImagemAnexo(o, dataUrl, nome, legenda, ip) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > ANX_MAX) return null;
  await fsp.mkdir(o.dir, { recursive: true });
  const aid = crypto.randomBytes(6).toString('hex'), ext = ANX_TYPES[m[1]];
  await fsp.writeFile(path.join(o.dir, aid + ext), buf);
  const meta = { aid, nome: nome + ext, legenda, tipo: m[1], tamanho: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex').toUpperCase(),
    modificado: '', capturada: '', enviadoEm: new Date().toISOString(), ip };
  await withLock(o.chave, async () => { const l = await readAnx(o); l.push(meta); await writeAnx(o, l); });
  return meta;
}
async function entregaManualRoute(req, res, url) {
  if (!canRead(req, url)) { req.resume(); return json(res, 401, { erro: 'Token de leitura necessário.' }); }
  if (req.method !== 'POST') { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
  let b; try { b = await readJsonBody(req, 12 * ANX_MAX); } catch { return json(res, 413, { erro: 'Entrega grande demais (fotos). Use menos fotos.' }); }
  const ip = ipOf(req), cfg = await lerCamposEntrega();
  const lim = (v, n) => txt(v, n).replace(/[\r\n\t]+/g, ' ').trim();
  // reenvio da fila offline: a mesma entrega (idCliente) não é gravada duas vezes
  const idCliente = /^[A-Za-z0-9-]{8,64}$/.test(b.idCliente || '') ? b.idCliente : '';
  if (idCliente) for (const f of await listFolhas(false)) if (f.manual) {
    const full = JSON.parse(await fsp.readFile(path.join(RDIR, f.id + '.json'), 'utf8').catch(() => 'null'));
    if (full && full.manual && full.manual.idCliente === idCliente) return json(res, 200, full);
  }
  const local = lim(b.local, 160), selb = RecebOCR.juntarSelbs(RecebOCR.separarSelbs(lim(b.selb, 300)).map(x => x.toUpperCase().slice(0, 40)).slice(0, 30));
  const dataIso = /^\d{4}-\d{2}-\d{2}$/.test(b.dataIso || '') ? b.dataIso : new Date().toISOString().slice(0, 10);
  const recebedor = lim(b.recebedor, 160), documento = lim(b.documento, 40);
  const hora = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.hora || '') ? b.hora : '';
  const erros = [];
  if (!local) erros.push('local');
  if (!selb) erros.push('SELB');
  if (cfg.recebedor.ativo && cfg.recebedor.obrigatorio && !recebedor) erros.push(cfg.recebedor.rotulo);
  if (cfg.documento.ativo && cfg.documento.obrigatorio && !documento) erros.push(cfg.documento.rotulo);
  if (cfg.assinatura.obrigatoria && !/^data:image\/png;base64,/.test(b.assinatura || '')) erros.push('assinatura');
  const campos = {};
  for (const c of cfg.campos.filter(x => x.ativo)) {
    let v = b.campos && b.campos[c.id];
    v = c.tipo === 'sim_nao' ? (v === true || v === 'sim' ? 'sim' : v === false || v === 'nao' ? 'não' : '') : txt(v, c.tipo === 'texto_longo' ? 2000 : 300).trim();
    if (c.tipo === 'lista' && v && c.opcoes.length && !c.opcoes.includes(v)) v = '';
    if (c.obrigatorio && !v) erros.push(c.rotulo);
    if (v) campos[c.id] = { rotulo: c.rotulo, valor: v };
  }
  if (erros.length) return json(res, 400, { erro: 'Preencha: ' + erros.join(', ') + '.' });
  const agora = new Date();
  const nid = agora.toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex');
  const [a, m, d] = dataIso.split('-');
  const linha = sanitizeFolha({ linhas: [{ n: 1, revisado: true, escrita: true, local, selb, data: `${d}/${m}/${a}`, dataIso, nome: recebedor, cpf: documento, itens: b.itens }] }).linhas[0];
  const f = {
    id: nid, revisao: 1, criadoEm: agora.toISOString(), atualizadoEm: agora.toISOString(), criadoPorIp: ip,
    titulo: `Entrega manual · ${local}`, obs: txt(b.obs, 2000), dataFolha: dataIso, linhas: [linha], grade: null,
    manual: { idCliente, recebedor, documento, hora, campos, termo: cfg.termo, feitaEm: /^\d{4}-\d{2}-\d{2}T/.test(b.feitaEm || '') ? b.feitaEm.slice(0, 30) : agora.toISOString(), assinatura: '', fotos: [] },
  };
  await writeJsonAtomic(path.join(RDIR, nid + '.json'), f);
  const o = owner('receb', nid);
  if (b.assinatura) { const s = await salvarImagemAnexo(o, b.assinatura, 'assinatura', 'Assinatura de quem recebeu', ip); if (s) f.manual.assinatura = s.aid; }
  for (const [i, ft] of (Array.isArray(b.fotos) ? b.fotos : []).slice(0, cfg.fotos.ativo ? cfg.fotos.max : 0).entries()) {
    const s = await salvarImagemAnexo(o, ft && ft.dataUrl, `foto-${i + 1}`, lim(ft && ft.legenda, 300) || `Foto da entrega ${i + 1}`, ip);
    if (s) f.manual.fotos.push(s.aid);
  }
  await writeJsonAtomic(path.join(RDIR, nid + '.json'), f);
  await audit({ acao: 'entrega_manual', folha: nid, local, selb, itens: linha.itens.length, fotos: f.manual.fotos.length, assinada: !!f.manual.assinatura, ip });
  return json(res, 201, f);
}

// troca (ou apaga, com para = '') um valor de local/SELB em todas as folhas.
// Opcional: só nas linhas de um SELB (corrigir o local de um SELB).
async function loteRoute(req, res, url) {
  if (!canRead(req, url)) { req.resume(); return json(res, 401, { erro: 'Token de leitura necessário.' }); }
  if (req.method !== 'POST') { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
  let b;
  try { b = await readJsonBody(req, 20000); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
  const campo = b.campo === 'selb' ? 'selb' : b.campo === 'local' ? 'local' : '';
  const de = txt(b.de, 160).trim(), para = txt(b.para, campo === 'local' ? 160 : 40).replace(/[\r\n\t]+/g, ' ').trim();
  const soSelb = txt(b.selb, 40).trim();
  if (campo === 'selb' && RecebOCR.separarSelbs(para).length > 1) return json(res, 400, { erro: 'Corrija um SELB por vez.' });
  if (!campo || !de) return json(res, 400, { erro: 'Informe o campo e o valor a corrigir.' });
  const igual = campo === 'selb' ? (x, y) => chaveSelbRec(x) === chaveSelbRec(y) : (x, y) => normRec(x) === normRec(y);
  const novoValor = campo === 'selb' ? para.toUpperCase() : para;
  const names = (await fsp.readdir(RDIR)).filter(n => n.endsWith('.json') && RID_RE.test(n.slice(0, -5)));
  let linhas = 0, folhas = 0;
  for (const n of names) {
    const id = n.slice(0, -5), file = path.join(RDIR, n);
    const mudou = await withLock('receb:' + id, async () => {
      const f = JSON.parse(await fsp.readFile(file, 'utf8').catch(() => 'null'));
      if (!f) return 0;
      let c = 0;
      for (const l of f.linhas || []) {
        if (!l[campo] || (soSelb && !RecebOCR.temSelb(l.selb, soSelb))) continue;
        if (campo === 'selb') {
          // troca/apaga só o SELB indicado dentro da lista da entrega
          const lista = RecebOCR.separarSelbs(l.selb);
          if (!lista.some(x => igual(x, de))) continue;
          const nova = [];
          for (const x of lista) { const v = igual(x, de) ? novoValor : x; if (v && !nova.some(y => igual(y, v))) nova.push(v); }
          l.selb = RecebOCR.juntarSelbs(nova); c++;
          // itens entregues acompanham o SELB (apagado: os itens dele saem da linha)
          if (Array.isArray(l.itens)) l.itens = l.itens.map(it => igual(it.selb, de) ? { ...it, selb: novoValor } : it).filter(it => it.selb);
          if (!l.selb) l.revisado = false;
          if (l.conf) delete l.conf.selb;
          continue;
        }
        if (!igual(l[campo], de)) continue;
        l[campo] = novoValor; c++;
        if (!novoValor) l.revisado = false; // ficou sem valor: volta para conferência
        if (l.conf) delete l.conf[campo];
      }
      if (!c) return 0;
      await fsp.writeFile(path.join(RDIR, `${id}.r${f.revisao}.json.bak`), JSON.stringify(f, null, 2));
      f.revisao++; f.atualizadoEm = new Date().toISOString();
      await writeJsonAtomic(file, f);
      return c;
    });
    if (mudou) { linhas += mudou; folhas++; }
  }
  // SELB corrigido: o cadastro vai junto (se o SELB certo ainda não tiver cadastro)
  if (campo === 'selb' && novoValor) {
    await withLock('receb-selbs', async () => {
      const db = await lerSelbsCad();
      const velho = db.selbs.find(x => igual(x.selb, de));
      if (velho && !db.selbs.some(x => igual(x.selb, novoValor))) { velho.selb = novoValor; velho.atualizadoEm = new Date().toISOString(); await writeJsonAtomic(SELBS_FILE, db); }
    });
  }
  await audit({ acao: 'recebimentos_lote', campo, de, para: novoValor, selb: soSelb, linhas, folhas, ip: ipOf(req) });
  json(res, 200, { linhas, folhas });
}

// ------------------------------------------------------------------ cadastro dos SELBs (impressoras/scanners)
const SELBS_FILE = path.join(RDIR, 'selbs.json');
const TIPOS_EQUIP = ['impressora', 'multifuncional', 'scanner', 'outro'];
async function lerSelbsCad() { try { return JSON.parse(await fsp.readFile(SELBS_FILE, 'utf8')); } catch { return { selbs: [], removidos: [] }; } }
function sanitizeSelbCad(b) {
  const t = (k, max) => txt(b && b[k], max).replace(/[\r\n\t]+/g, ' ').trim();
  const cor = b && b.cor === 'pb' ? 'pb' : 'colorida';
  const suprimento = ['tinta', 'toner', 'nenhum'].includes(b && b.suprimento) ? b.suprimento : 'tinta';
  let cores = (Array.isArray(b && b.cores) ? b.cores : []).filter(c => ['preto', 'azul', 'magenta', 'amarelo'].includes(c));
  if (cor === 'pb') cores = ['preto'];
  if (suprimento === 'nenhum') cores = [];
  return {
    tipo: TIPOS_EQUIP.includes(b && b.tipo) ? b.tipo : 'impressora', marca: t('marca', 80), modelo: t('modelo', 120), serie: t('serie', 80),
    cor, suprimento, cores: [...new Set(cores)],
    // toda impressora usa caixa de manutenção; scanner (sem suprimento) não
    caixa: !(b && b.tipo === 'scanner') && suprimento !== 'nenhum',
    comunidade: t('comunidade', 64), // comunidade SNMP de leitura (vazio = "public")
    local: t('local', 160), // local vinculado no cadastro (vale mesmo sem entrega e prevalece sobre o das folhas)
    ip: /^(\d{1,3}\.){3}\d{1,3}$/.test(t('ip', 15)) && t('ip', 15).split('.').every(n => +n <= 255) ? t('ip', 15) : '',
    obs: txt(b && b.obs, 2000),
  };
}
async function selbsRoute(req, res, url, chave) {
  if (!canRead(req, url)) { req.resume(); return json(res, 401, { erro: 'Token de leitura necessário.' }); }
  const ip = ipOf(req);
  if (!chave) {
    if (req.method === 'GET') return json(res, 200, (await lerSelbsCad()).selbs);
    req.resume(); return json(res, 405, { erro: 'Método não permitido.' });
  }
  let selb;
  try { selb = decodeURIComponent(chave).toUpperCase().trim().slice(0, 40); } catch { selb = ''; }
  if (!selb || RecebOCR.separarSelbs(selb).length !== 1) { req.resume(); return json(res, 400, { erro: 'SELB inválido.' }); }
  let body = {};
  if (req.method === 'PUT') { try { body = await readJsonBody(req, 20000); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); } }
  const out = await withLock('receb-selbs', async () => {
    const db = await lerSelbsCad();
    const i = db.selbs.findIndex(x => chaveSelbRec(x.selb) === chaveSelbRec(selb));
    const agora = new Date().toISOString();
    if (req.method === 'PUT') {
      const novo = { selb, ...sanitizeSelbCad(body), criadoEm: i >= 0 ? db.selbs[i].criadoEm : agora, atualizadoEm: agora };
      // cadastro novo ("Cadastrar SELB") não sobrescreve um SELB que já existe
      if (body.novo && i >= 0) return { code: 409, erro: `O SELB ${db.selbs[i].selb} já tem cadastro. Abra o cadastro dele para alterar.` };
      // IP repetido: bloqueia IP novo/alterado que já é de outro SELB (repetições antigas não travam outras edições)
      const outro = novo.ip && db.selbs.find((x, k) => k !== i && x.ip === novo.ip);
      if (outro && (i < 0 || db.selbs[i].ip !== novo.ip)) return { code: 409, erro: `O IP ${novo.ip} já é do SELB ${outro.selb}.` };
      if (i >= 0) db.selbs[i] = novo; else db.selbs.push(novo);
      await writeJsonAtomic(SELBS_FILE, db);
      setTimeout(() => rodadaMonitor().catch(() => {}), 500); // IP novo/alterado: verifica logo
      return { code: 200, obj: novo, audit: { acao: 'selb_cadastrado', selb } };
    }
    if (req.method === 'DELETE') {
      if (i < 0) return { code: 404, erro: 'SELB sem cadastro.' };
      const [rem] = db.selbs.splice(i, 1);
      db.removidos = [...(db.removidos || []), { ...rem, removidoEm: agora, removidoPorIp: ip }];
      await writeJsonAtomic(SELBS_FILE, db);
      return { code: 200, obj: { ok: true }, audit: { acao: 'selb_cadastro_removido', selb } };
    }
    return { code: 405, erro: 'Método não permitido.' };
  });
  if (out.audit) await audit({ ...out.audit, ip });
  // local vinculado sem cadastro: cadastra na aba Locais
  if (req.method === 'PUT' && out.code === 200 && out.obj.local) {
    const criados = await garantirLocais([out.obj.local]);
    if (criados.length) await audit({ acao: 'local_cadastrado_pelo_selb', selb: out.obj.selb, nome: criados[0], ip });
  }
  return json(res, out.code, out.erro ? { erro: out.erro } : out.obj);
}
// na subida: locais vinculados a SELBs antes desta versão também ganham cadastro
setTimeout(async () => {
  try { const c = await garantirLocais((await lerSelbsCad()).selbs.map(x => x.local)); if (c.length) console.log('locais cadastrados pelos SELBs:', c.join(', ')); } catch (e) { console.error('locais dos SELBs:', e.message); }
}, 1000);

// ------------------------------------------------------------------ monitoramento das impressoras (ping)
// A cada MONITOR_MIN minutos: 1 ping com o MENOR pacote possível (0 bytes de dados = pacote IP de 28 bytes:
// 20 de IP + 8 de ICMP) por impressora com IP cadastrado. Se falhar, confirma com um 2º ping e com as portas
// de impressora (9100/631/515) — impressora que só bloqueia ping não vira alarme falso.
// Histórico: recebimentos/monitor/ping-AAAA-MM-DD.jsonl (cada verificação, MONITOR_DIAS dias) e
// recebimentos/monitor/quedas.json (início, fim e duração de cada queda). Pausa geral ou por SELB.
const { execFile } = require('child_process');
const net = require('net');
const MONITOR_FILE = path.join(RDIR, 'monitor.json');
const MON_DIR = path.join(RDIR, 'monitor');
fs.mkdirSync(MON_DIR, { recursive: true });
const QUEDAS_FILE = path.join(MON_DIR, 'quedas.json');
const MONITOR_DIAS = Math.max(1, +process.env.MONITOR_DIAS || 30);
const IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const ipOk = ip => IP_RE.test(ip || '') && ip.split('.').every(n => +n <= 255);
// estados[ip] = { online, desde, verificadoEm, ms, via }; pausa = { geral: {ate, em} | null, selbs: { SELB: {ate, em, motivo} } }
let monitor = { rodada: null, ping: null, estados: {}, pausa: { geral: null, selbs: {} } };
let monitorRodando = null, resumoCache = null;
try { monitor = { ...monitor, ...JSON.parse(fs.readFileSync(MONITOR_FILE, 'utf8')) }; monitor.pausa = { geral: null, selbs: {}, ...(monitor.pausa || {}) }; } catch { /* primeira vez */ }
const salvarMonitor = () => writeJsonAtomic(MONITOR_FILE, monitor).catch(e => console.error('monitor:', e.message));
const diaDe = iso => iso.slice(0, 10);
const arqPing = dia => path.join(MON_DIR, `ping-${dia}.jsonl`);

function pingar(ip) {
  return new Promise(resolve => {
    if (!ipOk(ip)) return resolve({ ok: false, erro: 'ip' });
    const t0 = Date.now();
    // -s 0: sem dados (o ping não consegue medir o tempo sozinho; medimos aqui, aproximado)
    execFile('ping', ['-c', '1', '-W', '2', '-s', '0', ip], { timeout: 6000 }, (err, out) => {
      if (err && err.code === 'ENOENT') return resolve({ ok: false, semPing: true });
      if (err) return resolve({ ok: false });
      const m = String(out).match(/time[=<]\s*([\d.]+)/) || String(out).match(/min\/avg\/max[^=]*=\s*([\d.]+)/);
      resolve({ ok: true, ms: m ? Math.round(+m[1]) : Date.now() - t0 });
    });
  });
}
function portaAberta(ip, porta, ms = 2000) {
  return new Promise(resolve => {
    const sock = net.connect({ host: ip, port: porta });
    const fim = ok => { sock.destroy(); resolve(ok); };
    sock.setTimeout(ms, () => fim(false));
    sock.once('connect', () => fim(true));
    sock.once('error', () => fim(false));
  });
}
async function verificarImpressora(ip) {
  let r = await pingar(ip);
  if (r.semPing) monitor.ping = 'indisponivel';
  else if (monitor.ping !== 'ok') monitor.ping = 'ok';
  if (r.ok) return { online: true, ms: r.ms, via: 'ping' };
  if (!r.semPing) { r = await pingar(ip); if (r.ok) return { online: true, ms: r.ms, via: 'ping' }; }
  // portas próprias de impressora (JetDirect, IPP, LPD). 80/443 não: proxy transparente da rede aceita conexão em qualquer IP
  for (const porta of [9100, 631, 515]) if (await portaAberta(ip, porta)) return { online: true, ms: null, via: 'porta ' + porta };
  return { online: false, ms: null, via: r.semPing ? 'portas' : 'ping' };
}

// ---- pausa
function limparPausasVencidas() {
  const agora = Date.now();
  let mudou = false;
  if (monitor.pausa.geral && monitor.pausa.geral.ate && Date.parse(monitor.pausa.geral.ate) <= agora) { monitor.pausa.geral = null; mudou = true; }
  for (const [k, v] of Object.entries(monitor.pausa.selbs)) if (v.ate && Date.parse(v.ate) <= agora) { delete monitor.pausa.selbs[k]; mudou = true; }
  return mudou;
}
const selbPausado = selb => !!monitor.pausa.selbs[chaveSelbRec(selb)];

// ---- quedas
async function lerQuedas() { try { return JSON.parse(await fsp.readFile(QUEDAS_FILE, 'utf8')); } catch { return []; } }
async function registrarQuedas(mudancas) {
  if (!mudancas.length) return;
  await withLock('monitor-quedas', async () => {
    const q = await lerQuedas();
    for (const m of mudancas) {
      const aberta = q.find(x => x.ip === m.ip && !x.fim);
      if (!m.online && !aberta) q.push({ id: crypto.randomBytes(4).toString('hex'), ip: m.ip, selb: m.selb, inicio: m.quando, fim: null, min: null });
      if (m.online && aberta) { aberta.fim = m.quando; aberta.min = Math.max(0, Math.round((Date.parse(m.quando) - Date.parse(aberta.inicio)) / 60000)); }
    }
    const limite = Date.now() - 400 * 86400000; // guarda ~1 ano de quedas
    await writeJsonAtomic(QUEDAS_FILE, q.filter(x => !x.fim || Date.parse(x.fim) > limite));
  });
}

// ---- alertas: registro (monitor/alertas.json, últimos 2000) e envio opcional por webhook
const ALERTAS_FILE = path.join(MON_DIR, 'alertas.json');
async function lerAlertas() { try { return JSON.parse(await fsp.readFile(ALERTAS_FILE, 'utf8')); } catch { return []; } }
async function enviarWebhook(texto, dados) {
  if (!ALERTA_WEBHOOK) return { enviado: false };
  try {
    const ntfy = /ntfy/i.test(ALERTA_WEBHOOK);
    const r = await fetch(ALERTA_WEBHOOK, {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': ntfy ? 'text/plain; charset=utf-8' : 'application/json', ...(ntfy ? { Title: 'Central diag' } : {}) },
      body: ntfy ? texto : JSON.stringify({ text: texto, content: texto, origem: 'Central diag', ...dados }),
    });
    return { enviado: r.ok, status: r.status };
  } catch (e) { console.error('webhook:', e.message); return { enviado: false, erro: e.message }; }
}
async function registrarAlerta(a) {
  const al = { id: crypto.randomBytes(4).toString('hex'), quando: new Date().toISOString(), ...a };
  const envio = await enviarWebhook(al.texto, { evento: al.tipo, selb: al.selb, item: al.item, pct: al.pct, ip: al.ip });
  al.enviado = envio.enviado;
  await withLock('monitor-alertas', async () => {
    const lista = await lerAlertas(); lista.push(al);
    await writeJsonAtomic(ALERTAS_FILE, lista.slice(-2000));
  });
  await audit({ acao: 'alerta_' + al.tipo, selb: al.selb, item: al.item, pct: al.pct, enviado: al.enviado });
  return al;
}
// local de cada SELB: o da última entrega registrada
// nome do local principal de um sublocal (sala) pelo cadastro de locais; '' se não for sublocal
function principalDe(locais) {
  const porNome = new Map(locais.map(l => [normRec(l.nome), l])), porId = new Map(locais.map(l => [l.id, l]));
  return nome => { const l = nome && porNome.get(normRec(nome)); const p = l && l.pai && porId.get(l.pai); return p ? p.nome : ''; };
}
// "Principal › Sala" para mensagens
async function localCompleto(nome) { const p = nome ? principalDe((await lerLocais()).locais)(nome) : ''; return p ? `${p} › ${nome}` : nome || ''; }
async function ultimosLocais() {
  const m = new Map();
  for (const f of await listFolhas(true)) for (const l of f.linhas) {
    if (!l.local) continue;
    for (const sel of RecebOCR.separarSelbs(l.selb)) {
      const k = chaveSelbRec(sel), q = l.dataIso || (f.criadoEm || '').slice(0, 10), u = m.get(k);
      if (!u || q >= u.q) m.set(k, { local: l.local, q });
    }
  }
  // local vinculado no cadastro do SELB prevalece (e vale para SELB sem entrega)
  for (const c of (await lerSelbsCad()).selbs) if (c.local) m.set(chaveSelbRec(c.selb), { local: c.local, q: '9999', vinculado: true });
  return m;
}
const descImp = (c, local) => [c.selb, [c.marca, c.modelo].filter(Boolean).join(' '), local].filter(Boolean).join(' · ');

async function rodadaMonitor({ forcar = false } = {}) {
  if (monitorRodando) return monitorRodando;
  monitorRodando = (async () => {
    if (limparPausasVencidas()) await salvarMonitor();
    if (monitor.pausa.geral && !forcar) return; // monitoramento pausado
    const cads = (await lerSelbsCad()).selbs.filter(c => ipOk(c.ip));
    // IP é verificado se ao menos um SELB dele não estiver pausado
    const porIp = new Map();
    for (const c of cads) (porIp.get(c.ip) || porIp.set(c.ip, []).get(c.ip)).push(c.selb);
    const ips = [...porIp.keys()].filter(ip => porIp.get(ip).some(s => !selbPausado(s)));
    const fila = [...ips], linhas = [], mudancas = [];
    const trabalhar = async () => {
      while (fila.length) {
        const ip = fila.shift();
        const r = await verificarImpressora(ip);
        const quando = new Date().toISOString(), sel = porIp.get(ip).join(', ');
        const ant = monitor.estados[ip];
        const mudou = !ant || ant.online !== r.online;
        monitor.estados[ip] = { online: r.online, desde: mudou ? quando : ant.desde, verificadoEm: quando, ms: r.ms, via: r.via };
        linhas.push(JSON.stringify({ t: quando, ip, s: sel, on: r.online ? 1 : 0, ms: r.ms, v: r.via }));
        if ((ant && mudou) || (!ant && !r.online)) { // queda/retorno; ou já fora do ar na 1ª verificação
          mudancas.push({ ip, selb: sel, online: r.online, quando });
          await audit({ acao: r.online ? 'impressora_voltou' : 'impressora_caiu', ip, selb: sel });
          console.log(`[monitor] ${sel} (${ip}) ${r.online ? 'voltou' : 'FORA DO AR'}`);
          const c0 = cads.find(c => c.ip === ip), loc = c0 ? await localCompleto(((await ultimosLocais()).get(chaveSelbRec(c0.selb)) || {}).local) : '';
          await registrarAlerta({ tipo: r.online ? 'retorno' : 'queda', selb: sel, ip,
            texto: r.online ? `✅ Impressora voltou: ${descImp({ ...c0, selb: sel }, loc)} (${ip})` : `🔴 Impressora fora do ar: ${descImp({ ...c0, selb: sel }, loc)} (${ip})` });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, ips.length) }, trabalhar)); // até 16 ao mesmo tempo
    if (linhas.length) await fsp.appendFile(arqPing(diaDe(new Date().toISOString())), linhas.join('\n') + '\n');
    await registrarQuedas(mudancas);
    for (const ip of Object.keys(monitor.estados)) if (!porIp.has(ip)) delete monitor.estados[ip]; // IP saiu do cadastro
    monitor.rodada = new Date().toISOString();
    resumoCache = null;
    await salvarMonitor();
  })().finally(() => { monitorRodando = null; });
  return monitorRodando;
}

// ---- histórico
async function lerPings(dias, filtro) {
  const out = [], hoje = Date.now();
  for (let d = dias - 1; d >= 0; d--) {
    const dia = new Date(hoje - d * 86400000).toISOString().slice(0, 10);
    const txt0 = await fsp.readFile(arqPing(dia), 'utf8').catch(() => '');
    for (const l of txt0.split('\n')) {
      if (!l) continue;
      try { const o = JSON.parse(l); if (!filtro || filtro(o)) out.push(o); } catch { /* linha incompleta */ }
    }
  }
  return out;
}
const temSelbNoPing = (o, selb) => String(o.s || '').split(', ').some(x => chaveSelbRec(x) === chaveSelbRec(selb));
// resumo por SELB: disponibilidade 24 h / 7 dias, 48 faixas de 30 min das últimas 24 h, quedas em 7 dias
async function resumoMonitor() {
  if (resumoCache) return resumoCache;
  const pings = await lerPings(8, null), agora = Date.now(), quedas = await lerQuedas();
  const por = new Map();
  for (const o of pings) for (const sel of String(o.s || '').split(', ')) {
    const k = chaveSelbRec(sel); if (!k) continue;
    (por.get(k) || por.set(k, []).get(k)).push(o);
  }
  const resumo = {};
  for (const [k, lista] of por) {
    const janela = ms => { const l = lista.filter(o => agora - Date.parse(o.t) <= ms); return l.length ? Math.round(l.filter(o => o.on).length / l.length * 1000) / 10 : null; };
    const faixas = Array.from({ length: 48 }, () => [0, 0]);
    for (const o of lista) {
      const idade = agora - Date.parse(o.t);
      if (idade > 86400000) continue;
      const f = 47 - Math.floor(idade / 1800000);
      if (f >= 0) { faixas[f][1]++; if (o.on) faixas[f][0]++; }
    }
    resumo[k] = { d24: janela(86400000), d7: janela(7 * 86400000), faixas: faixas.map(([on, n]) => n ? Math.round(on / n * 100) / 100 : null) };
  }
  for (const q of quedas) {
    if (agora - Date.parse(q.inicio) > 7 * 86400000 && q.fim) continue;
    for (const sel of String(q.selb).split(', ')) { const k = chaveSelbRec(sel); (resumo[k] = resumo[k] || { d24: null, d7: null, faixas: Array(48).fill(null) }).quedas7 = (resumo[k].quedas7 || 0) + 1; }
  }
  resumoCache = resumo;
  return resumo;
}
// limpeza do histórico antigo (1x por dia)
async function limparHistoricoMonitor() {
  const limite = new Date(Date.now() - MONITOR_DIAS * 86400000).toISOString().slice(0, 10);
  for (const n of await fsp.readdir(MON_DIR).catch(() => [])) {
    const m = n.match(/^ping-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (m && m[1] < limite) await fsp.rm(path.join(MON_DIR, n), { force: true });
  }
}

async function monitorRoute(req, res, url, acao) {
  if (!canRead(req, url)) { req.resume(); return json(res, 401, { erro: 'Token de leitura necessário.' }); }
  const ip = ipOf(req);
  if (acao === 'verificar') {
    if (req.method !== 'POST') { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
    req.resume();
    await rodadaMonitor({ forcar: true });
  } else if (acao === 'pausa') {
    // POST {alvo: 'todos' | SELB, horas: número | null (até retomar), motivo}; DELETE ?alvo=... retoma
    let alvo, horas = null, motivo = '';
    if (req.method === 'POST') {
      let b; try { b = await readJsonBody(req); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
      alvo = txt(b.alvo, 40).trim(); horas = b.horas == null ? null : Math.max(0.25, Math.min(24 * 90, +b.horas || 1)); motivo = txt(b.motivo, 200);
    } else if (req.method === 'DELETE') { req.resume(); alvo = txt(url.searchParams.get('alvo'), 40).trim(); }
    else { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
    if (!alvo) return json(res, 400, { erro: 'Informe o alvo ("todos" ou um SELB).' });
    const ate = horas ? new Date(Date.now() + horas * 3600000).toISOString() : null, em = new Date().toISOString();
    if (alvo === 'todos') monitor.pausa.geral = req.method === 'POST' ? { ate, em, motivo } : null;
    else if (req.method === 'POST') monitor.pausa.selbs[chaveSelbRec(alvo)] = { selb: alvo.toUpperCase(), ate, em, motivo };
    else delete monitor.pausa.selbs[chaveSelbRec(alvo)];
    resumoCache = null;
    await salvarMonitor();
    await audit({ acao: req.method === 'POST' ? 'monitor_pausado' : 'monitor_retomado', alvo, ate, motivo, ip });
    if (req.method === 'DELETE') setTimeout(() => rodadaMonitor().catch(() => {}), 300); // retomou: verifica logo
  } else if (acao === 'historico') {
    // ?selb=X&dias=7 -> pings e quedas daquele SELB
    const selb = txt(url.searchParams.get('selb'), 40).trim(), dias = Math.max(1, Math.min(MONITOR_DIAS, +url.searchParams.get('dias') || 7));
    if (!selb) return json(res, 400, { erro: 'Informe o SELB.' });
    const pings = (await lerPings(dias, o => temSelbNoPing(o, selb))).map(o => ({ t: o.t, on: o.on, ms: o.ms, v: o.v }));
    const quedas = (await lerQuedas()).filter(q => String(q.selb).split(', ').some(x => chaveSelbRec(x) === chaveSelbRec(selb)) && (!q.fim || Date.now() - Date.parse(q.inicio) <= dias * 86400000));
    return json(res, 200, { selb, dias, intervaloMin: MONITOR_MIN, pings, quedas: quedas.reverse() });
  } else if (acao === 'alertas') {
    const dias = Math.max(1, Math.min(400, +url.searchParams.get('dias') || 30)), desde = Date.now() - dias * 86400000;
    return json(res, 200, { dias, webhook: !!ALERTA_WEBHOOK, alertas: (await lerAlertas()).filter(a => Date.parse(a.quando) >= desde).reverse() });
  } else if (acao === 'alerta-teste') {
    if (req.method !== 'POST') { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
    req.resume();
    if (!ALERTA_WEBHOOK) return json(res, 400, { erro: 'ALERTA_WEBHOOK não configurado no servidor.' });
    return json(res, 200, await enviarWebhook('🔔 Teste de alerta da Central diag: o envio está funcionando.', { evento: 'teste' }));
  } else if (acao === 'quedas') {
    const dias = Math.max(1, Math.min(400, +url.searchParams.get('dias') || 30));
    const quedas = (await lerQuedas()).filter(q => !q.fim || Date.now() - Date.parse(q.inicio) <= dias * 86400000).reverse();
    return json(res, 200, { dias, quedas });
  } else if (req.method !== 'GET') { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
  if (limparPausasVencidas()) await salvarMonitor();
  // local de cada SELB: o da última entrega registrada (com o local principal, se for uma sala/sublocal)
  const ultimoLocal = await ultimosLocais(), principal = principalDe((await lerLocais()).locais);
  const resumo = await resumoMonitor();
  const impressoras = (await lerSelbsCad()).selbs.filter(c => ipOk(c.ip)).map(c => {
    const e = monitor.estados[c.ip] || null, k = chaveSelbRec(c.selb), p = monitor.pausa.selbs[k] || null, r = resumo[k] || {};
    return { selb: c.selb, ip: c.ip, tipo: c.tipo, marca: c.marca, modelo: c.modelo, local: (ultimoLocal.get(k) || {}).local || '', localPrincipal: principal((ultimoLocal.get(k) || {}).local),
      online: e ? e.online : null, desde: e ? e.desde : null, verificadoEm: e ? e.verificadoEm : null, ms: e ? e.ms : null, via: e ? e.via : null,
      pausada: p ? { ate: p.ate, em: p.em, motivo: p.motivo } : null,
      d24: r.d24 ?? null, d7: r.d7 ?? null, faixas: r.faixas || Array(48).fill(null), quedas7: r.quedas7 || 0 };
  });
  json(res, 200, { intervaloMin: MONITOR_MIN, dias: MONITOR_DIAS, webhook: !!ALERTA_WEBHOOK, rodada: monitor.rodada, ping: monitor.ping, verificando: !!monitorRodando,
    pausa: monitor.pausa.geral, impressoras });
}
setTimeout(() => rodadaMonitor().catch(e => console.error('monitor:', e.message)), 15000).unref();
setInterval(() => rodadaMonitor().catch(e => console.error('monitor:', e.message)), MONITOR_MIN * 60000).unref();
setTimeout(() => limparHistoricoMonitor().catch(() => {}), 60000).unref();
setInterval(() => limparHistoricoMonitor().catch(() => {}), 86400000).unref();

// ------------------------------------------------------------------ suprimentos das impressoras (SNMP)
// A cada SUPRIMENTOS_HORAS horas (padrão 6) lê, por SNMP, os níveis de tinta/toner e da caixa de manutenção
// de cada SELB com IP (pula as fora do ar e as pausadas). Consulta de ~100 bytes; resposta de poucas centenas.
// Último resultado em recebimentos/monitor/suprimentos.json; histórico em suprimentos-AAAA-MM.jsonl.
const snmp = require('./snmp');
const SUPR_HORAS = Math.max(1, +process.env.SUPRIMENTOS_HORAS || 6);
const SUPR_DIAS = Math.max(30, +process.env.SUPRIMENTOS_DIAS || 365);
const SUPR_FILE = path.join(MON_DIR, 'suprimentos.json');
const SNMP_COMUNIDADE = process.env.SNMP_COMUNIDADE || 'public';
const SNMP_PORTA = +process.env.SNMP_PORTA || 161;
let supr = { rodada: null, selbs: {} }, suprRodando = null;
try { supr = { ...supr, ...JSON.parse(fs.readFileSync(SUPR_FILE, 'utf8')) }; } catch { /* primeira vez */ }
// quando a leitura falha, uma sonda pequena separa as causas: SNMP desligado, comunidade errada ou rede
async function diagnosticarSnmp(c, com, e) {
  const opc = { timeout: 2000, repeticoes: 0, porta: SNMP_PORTA };
  if (!/sem resposta/.test(e.message)) return e.message;
  // já respondeu algo na leitura (ou responde à sonda): SNMP ok, problema no meio do caminho
  const r = e.nenhumaResposta ? null : await snmp.sondar(c.ip, com, opc).catch(() => null);
  if (!e.nenhumaResposta || r) return `a impressora responde por SNMP${r ? ` (${r.versao})` : ''}, mas a leitura dos suprimentos não terminou (respostas não chegaram). Tente de novo; se repetir, a rede até ela pode estar descartando pacotes UDP grandes (VPN/firewall)`;
  if (com !== 'public' && await snmp.sondar(c.ip, 'public', opc).catch(() => null)) return `comunidade SNMP "${com}" não aceita; a impressora responde com "public" — corrija no cadastro do SELB`;
  const est = monitor.estados[c.ip];
  if (est && est.online === false) return 'a impressora está fora do ar (não responde ao ping)';
  return `a impressora ${est && est.online ? 'está na rede (responde ao ping), mas ' : ''}não responde por SNMP com a comunidade "${com}". Na página da impressora (pelo IP), confira: SNMPv1/v2c ativado, comunidade de leitura "${com}" e se não há filtro de IP/acesso restrito. Epson: Web Config > Segurança de rede > Protocolo > SNMPv1/v2c`;
}
async function lerUma(c) {
  const com = c.comunidade || SNMP_COMUNIDADE;
  try {
    const r = await snmp.lerSuprimentos(c.ip, com, { timeout: 2500, repeticoes: 1, porta: SNMP_PORTA });
    return { ...r, ip: c.ip };
  } catch (e) { return { ok: false, ip: c.ip, erro: await diagnosticarSnmp(c, com, e), sysDescr: e.sysDescr || '', lidoEm: new Date().toISOString() }; }
}
async function rodadaSuprimentos({ selb = '', forcar = false } = {}) {
  if (suprRodando) return suprRodando;
  suprRodando = (async () => {
    limparPausasVencidas();
    if (monitor.pausa.geral && !forcar) return;
    let cads = (await lerSelbsCad()).selbs.filter(c => ipOk(c.ip));
    if (selb) cads = cads.filter(c => chaveSelbRec(c.selb) === chaveSelbRec(selb));
    // automática: pula pausadas e fora do ar; manual ("Ler suprimentos"): tenta todas as não pausadas
    else cads = cads.filter(c => !selbPausado(c.selb) && (forcar || !(monitor.estados[c.ip] && monitor.estados[c.ip].online === false)));
    const fila = [...cads], linhas = [];
    const trabalhar = async () => {
      while (fila.length) {
        const c = fila.shift(), r = await lerUma(c);
        const ant = supr.selbs[chaveSelbRec(c.selb)];
        supr.selbs[chaveSelbRec(c.selb)] = { selb: c.selb, ...r };
        if (r.ok) await alertasSuprimento(c, ant, r);
        if (r.ok) await registrarTrocas(c, ant, r).catch(e => console.error('trocas:', e.message));
        if (r.ok) linhas.push(JSON.stringify({ t: r.lidoEm, s: c.selb, i: r.itens.map(i => [i.item, i.pct, i.estado, i.desc]) }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, cads.length) }, trabalhar));
    if (linhas.length) await fsp.appendFile(path.join(MON_DIR, `suprimentos-${new Date().toISOString().slice(0, 7)}.jsonl`), linhas.join('\n') + '\n');
    if (!selb) supr.rodada = new Date().toISOString();
    // SELB que saiu do cadastro (ou ficou sem IP) sai da lista
    const validos = new Set((await lerSelbsCad()).selbs.filter(c => ipOk(c.ip)).map(c => chaveSelbRec(c.selb)));
    for (const k of Object.keys(supr.selbs)) if (!validos.has(k)) delete supr.selbs[k];
    await writeJsonAtomic(SUPR_FILE, supr).catch(e => console.error('suprimentos:', e.message));
  })().finally(() => { suprRodando = null; });
  return suprRodando;
}
// alerta quando tinta/toner/caixa cruza 25% (baixo) ou 5% (vazio) — uma vez por cruzamento
const NOME_ITEM = { preto: 'preto', azul: 'azul', magenta: 'magenta', amarelo: 'amarelo' };
async function alertasSuprimento(c, ant, r) {
  const grav = { ok: 0, baixo: 1, vazio: 2 };
  const antes = new Map(((ant && ant.ok && ant.itens) || []).map(i => [i.item + '|' + i.idx, i]));
  // códigos: o anotado no SELB vale mais que o da tabela do modelo (calculado só se houver alerta)
  let cods = null;
  const codsDe = async () => cods || (cods = { ...codsDoModelo(await catalogoCodigos(), modeloDoSelb(c, r)), ...RecebOCR.codigosObs(c.obs, c.cor === 'pb') });
  let local = null;
  for (const i of r.itens) {
    if (i.item === 'outro' || !['baixo', 'vazio'].includes(i.estado)) continue;
    const a = antes.get(i.item + '|' + i.idx);
    if (a && (grav[a.estado] ?? 0) >= grav[i.estado]) continue; // já estava assim (ou pior)
    if (local === null) local = await localCompleto(((await ultimosLocais()).get(chaveSelbRec(c.selb)) || {}).local);
    const toner = c.suprimento === 'toner' || /toner/i.test(i.desc + i.tipoTxt);
    const nome = i.item === 'caixa' ? 'Caixa de manutenção' : `${toner ? 'Toner' : 'Tinta'} ${NOME_ITEM[i.item]}`;
    const codigo = i.codigo || (await codsDe())[i.item] || '';
    const quanto = i.item === 'caixa' ? `${i.pct}% de vida útil` : `${i.pct}%`;
    await registrarAlerta({ tipo: 'suprimento', selb: c.selb, ip: c.ip, item: i.item, pct: i.pct, estado: i.estado, codigo,
      texto: `${i.estado === 'vazio' ? '🔴' : '🟡'} ${nome} ${i.estado === 'vazio' ? (i.item === 'caixa' ? 'precisa ser trocada' : 'acabando') : (i.item === 'caixa' ? 'perto do fim' : toner ? 'baixo' : 'baixa')}: ${quanto} — ${descImp(c, local)}${codigo ? ` · código ${codigo}` : ''}` });
  }
}
async function limparHistoricoSuprimentos() {
  const limite = new Date(Date.now() - SUPR_DIAS * 86400000).toISOString().slice(0, 7);
  for (const n of await fsp.readdir(MON_DIR).catch(() => [])) {
    const m = n.match(/^suprimentos-(\d{4}-\d{2})\.jsonl$/);
    if (m && m[1] < limite) await fsp.rm(path.join(MON_DIR, n), { force: true });
  }
}
// ---- códigos de tinta/toner/caixa por modelo: a maioria das impressoras não informa o código por SNMP.
// A tabela junta o que qualquer impressora do mesmo modelo informa, os códigos anotados na observação dos
// SELBs desse modelo e o que foi digitado na tabela (manual, prevalece). Vale para todas as do modelo.
const CODIGOS_FILE = path.join(RDIR, 'codigos.json');
const ITENS_COD = ['preto', 'azul', 'magenta', 'amarelo', 'caixa'];
async function lerCodigosManuais() { try { return JSON.parse(await fsp.readFile(CODIGOS_FILE, 'utf8')); } catch { return {}; } }
function modeloDoSelb(c, r) {
  const eq = r && r.ok ? (r.equipamento || snmp.equipamentoDe(r)) : null;
  const marca = (c && c.marca) || (eq && eq.marca) || '', modelo = (c && c.modelo) || (eq && eq.modelo) || '';
  return modelo ? { chave: normRec(`${marca} ${modelo}`), nome: [marca, modelo].filter(Boolean).join(' ') } : null;
}
async function catalogoCodigos() {
  const manual = await lerCodigosManuais(), mod = new Map();
  for (const c of (await lerSelbsCad()).selbs) {
    const r = supr.selbs[chaveSelbRec(c.selb)], m = modeloDoSelb(c, r);
    if (!m) continue;
    const e = mod.get(m.chave) || { chave: m.chave, nome: m.nome, selbs: [], votos: {} };
    e.selbs.push(c.selb);
    const votar = (item, cod, origem) => { if (!cod) return; const v = e.votos[item] = e.votos[item] || {}; v[cod + '|' + origem] = (v[cod + '|' + origem] || 0) + 1; };
    if (r && r.ok) for (const i of r.itens) if (ITENS_COD.includes(i.item)) votar(i.item, i.codigo, 'impressora');
    for (const [item, cod] of Object.entries(RecebOCR.codigosObs(c.obs, c.cor === 'pb'))) if (ITENS_COD.includes(item)) votar(item, cod, 'cadastro');
    mod.set(m.chave, e);
  }
  for (const [chave, v] of Object.entries(manual)) if (!mod.has(chave)) mod.set(chave, { chave, nome: v.nome || chave, selbs: [], votos: {} });
  for (const e of mod.values()) {
    e.codigos = {}; e.manual = {};
    for (const item of ITENS_COD) {
      const man = (manual[e.chave] || {})[item];
      if (man) e.manual[item] = man;
      // o que a impressora informa vale mais que o anotado; entre iguais, o mais comum
      const votos = Object.entries(e.votos[item] || {}).map(([k, n]) => { const [cod, origem] = k.split('|'); return { cod, origem, n: n + (origem === 'impressora' ? 1000 : 0) }; }).sort((a, b) => b.n - a.n);
      if (votos[0]) e.aprendido = { ...(e.aprendido || {}), [item]: { cod: votos[0].cod, origem: votos[0].origem } };
      e.codigos[item] = man ? { cod: man, origem: 'manual' } : votos[0] ? { cod: votos[0].cod, origem: votos[0].origem } : null;
      if (!e.codigos[item]) delete e.codigos[item];
    }
    delete e.votos;
  }
  return mod;
}
const codsDoModelo = (cat, m) => m && cat.get(m.chave) ? Object.fromEntries(Object.entries(cat.get(m.chave).codigos).map(([k, v]) => [k, v.cod])) : {};

// ---- trocas de tinta/toner/caixa: o nível de um item sobe de repente entre duas leituras
// (ex.: 4% -> 100%). Fica em monitor/trocas.json (não expira com o histórico de níveis).
const TROCAS_FILE = path.join(MON_DIR, 'trocas.json');
const TROCA_SALTO = 25, TROCA_MIN = 50; // subiu pelo menos 25 pontos e foi a 50% ou mais
async function lerTrocas() { try { return JSON.parse(await fsp.readFile(TROCAS_FILE, 'utf8')); } catch { return null; } }
const ehTroca = (de, para) => de != null && para != null && para - de >= TROCA_SALTO && para >= TROCA_MIN;
async function registrarTrocas(c, ant, r) {
  if (!ant || !ant.ok || !ant.itens) return;
  const antes = new Map(ant.itens.map(i => [i.item + '|' + i.idx, i]));
  const novas = [];
  for (const i of r.itens) {
    if (i.item === 'outro') continue;
    const a = antes.get(i.item + '|' + i.idx);
    if (a && ehTroca(a.pct, i.pct)) novas.push({ item: i.item, de: a.pct, para: i.pct, desc: i.desc, codigo: i.codigo });
  }
  if (!novas.length) return;
  const cods = { ...codsDoModelo(await catalogoCodigos(), modeloDoSelb(c, r)), ...RecebOCR.codigosObs(c.obs, c.cor === 'pb') };
  const loc = ((await ultimosLocais()).get(chaveSelbRec(c.selb)) || {}).local || '';
  const regs = novas.map(n => ({ id: crypto.randomBytes(5).toString('hex'), t: r.lidoEm, selb: c.selb, item: n.item, de: n.de, para: n.para,
    codigo: n.codigo || cods[n.item] || '', local: loc, modelo: [c.marca, c.modelo].filter(Boolean).join(' ') || r.modelo || '', origem: 'leitura' }));
  await withLock('trocas', async () => { const l = (await lerTrocas()) || []; l.push(...regs); await writeJsonAtomic(TROCAS_FILE, l.slice(-50000)); });
  for (const t of regs) await audit({ acao: 'suprimento_trocado', selb: t.selb, item: t.item, de: t.de, para: t.para, codigo: t.codigo });
}
// primeira vez: procura trocas no histórico de níveis já guardado (suprimentos-AAAA-MM.jsonl)
async function trocasDoHistorico() {
  if (await lerTrocas()) return;
  const cads = new Map((await lerSelbsCad()).selbs.map(c => [chaveSelbRec(c.selb), c]));
  const ult = new Map(), out = [];
  for (const n of (await fsp.readdir(MON_DIR).catch(() => [])).filter(n => /^suprimentos-\d{4}-\d{2}\.jsonl$/.test(n)).sort()) {
    for (const l of (await fsp.readFile(path.join(MON_DIR, n), 'utf8').catch(() => '')).split('\n')) {
      let o; try { o = l && JSON.parse(l); } catch { o = null; }
      if (!o || !Array.isArray(o.i)) continue;
      for (const [item, pct, , desc] of o.i) {
        if (item === 'outro') continue;
        const k = chaveSelbRec(o.s) + '|' + item + '|' + desc, a = ult.get(k);
        if (a != null && ehTroca(a, pct)) { const c = cads.get(chaveSelbRec(o.s)) || {}; out.push({ id: crypto.randomBytes(5).toString('hex'), t: o.t, selb: o.s, item, de: a, para: pct, codigo: '', local: c.local || '', modelo: [c.marca, c.modelo].filter(Boolean).join(' '), origem: 'historico' }); }
        if (pct != null) ult.set(k, pct);
      }
    }
  }
  await withLock('trocas', async () => { if (!(await lerTrocas())) await writeJsonAtomic(TROCAS_FILE, out); });
  if (out.length) console.log(`trocas encontradas no histórico: ${out.length}`);
}
setTimeout(() => trocasDoHistorico().catch(e => console.error('trocas:', e.message)), 3000).unref();

async function suprimentosRoute(req, res, url, acao) {
  if (!canRead(req, url)) { req.resume(); return json(res, 401, { erro: 'Token de leitura necessário.' }); }
  if (acao === 'testar') {
    // teste avulso (botão "Testar leitura" no cadastro): não grava nada
    if (req.method !== 'POST') { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
    let b; try { b = await readJsonBody(req); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
    const ip = txt(b.ip, 15).trim();
    if (!ipOk(ip)) return json(res, 400, { erro: 'IP inválido.' });
    const r = await lerUma({ ip, comunidade: txt(b.comunidade, 64).trim() });
    await audit({ acao: 'suprimentos_teste', ip, ok: r.ok, ipCliente: ipOf(req) });
    // códigos do modelo (pelo que está no formulário ou pelo que a impressora informou)
    if (r.ok) r.modeloCod = codsDoModelo(await catalogoCodigos(), modeloDoSelb({ marca: txt(b.marca, 80).trim(), modelo: txt(b.modelo, 120).trim() }, r));
    return json(res, 200, r);
  }
  if (acao === 'ler') {
    if (req.method !== 'POST') { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
    let b = {}; try { b = await readJsonBody(req); } catch { /* sem corpo = todas */ }
    await rodadaSuprimentos({ selb: txt(b.selb, 40).trim(), forcar: true });
  } else if (acao === 'cadastro') {
    // dados do equipamento lidos pela rede (marca, modelo, série, tipo, cores, tinta/toner) que diferem do cadastro
    const sugestoes = [];
    for (const c of (await lerSelbsCad()).selbs) {
      const r = supr.selbs[chaveSelbRec(c.selb)];
      const eq = r && r.ok ? (r.equipamento || snmp.equipamentoDe(r)) : null;
      if (!eq) continue;
      const dif = {};
      for (const k of ['marca', 'modelo', 'serie']) if (eq[k] && normRec(eq[k]) !== normRec(c[k])) dif[k] = eq[k];
      // tipo: o nome do modelo só indica multifuncional com segurança; não rebaixa nem mexe em scanner
      if (eq.tipo && (eq.tipo === 'multifuncional' ? c.tipo === 'impressora' : !c.modelo && c.tipo !== eq.tipo && c.tipo !== 'scanner')) dif.tipo = eq.tipo;
      if (eq.cor && eq.cor !== c.cor) dif.cor = eq.cor;
      const ordem = a => ['preto', 'azul', 'magenta', 'amarelo'].filter(x => (a || []).includes(x)).join();
      if (eq.cores && ordem(eq.cores) !== ordem(c.cores)) dif.cores = eq.cores;
      if (eq.suprimento && eq.suprimento !== c.suprimento) dif.suprimento = eq.suprimento;
      if (Object.keys(dif).length) sugestoes.push({ selb: c.selb, lidoEm: r.lidoEm, modeloLido: r.modelo, dif });
    }
    return json(res, 200, { sugestoes });
  } else if (acao === 'trocas') {
    if (req.method !== 'GET') { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
    const dias = Math.max(1, Math.min(3650, +url.searchParams.get('dias') || 90)), desde = Date.now() - dias * 86400000;
    const selb = txt(url.searchParams.get('selb'), 40).trim();
    // código e local atuais para as trocas antigas que não tinham (achadas no histórico)
    const cat = await catalogoCodigos(), cads = new Map((await lerSelbsCad()).selbs.map(c => [chaveSelbRec(c.selb), c]));
    const locs = await ultimosLocais(), principal = principalDe((await lerLocais()).locais);
    const trocas = ((await lerTrocas()) || []).filter(t => Date.parse(t.t) >= desde && (!selb || chaveSelbRec(t.selb) === chaveSelbRec(selb))).reverse().map(t => {
      const c = cads.get(chaveSelbRec(t.selb)), local = t.local || ((locs.get(chaveSelbRec(t.selb)) || {}).local || '');
      return { ...t, codigo: t.codigo || (c ? { ...codsDoModelo(cat, modeloDoSelb(c, supr.selbs[chaveSelbRec(t.selb)])), ...RecebOCR.codigosObs(c.obs, c.cor === 'pb') }[t.item] || '' : ''),
        local, localPrincipal: principal(local), modelo: t.modelo || (c ? [c.marca, c.modelo].filter(Boolean).join(' ') : '') };
    });
    return json(res, 200, { dias, maxDias: SUPR_DIAS, trocas });
  } else if (acao === 'codigos') {
    if (req.method === 'PUT') {
      // grava os códigos digitados de um modelo ({chave, nome, codigos: {item: código}}); vazio = volta ao aprendido
      let b; try { b = await readJsonBody(req, 20000); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
      const chave = normRec(txt(b.chave, 200));
      if (!chave) return json(res, 400, { erro: 'Modelo inválido.' });
      const limpo = v => txt(v, 30).toUpperCase().replace(/[^A-Z0-9 .\-\/]/g, '').trim();
      await withLock('codigos', async () => {
        const db = await lerCodigosManuais(), e = { nome: txt(b.nome, 200).trim() || chave };
        for (const item of ITENS_COD) { const v = limpo(b.codigos && b.codigos[item]); if (v) e[item] = v; }
        if (ITENS_COD.some(k => e[k])) db[chave] = e; else delete db[chave];
        await writeJsonAtomic(CODIGOS_FILE, db);
      });
      await audit({ acao: 'codigos_modelo', modelo: chave, ip: ipOf(req) });
    } else if (req.method !== 'GET') { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
    const cat = await catalogoCodigos();
    return json(res, 200, { modelos: [...cat.values()].sort((a, b) => b.selbs.length - a.selbs.length || a.nome.localeCompare(b.nome)) });
  } else if (acao === 'historico') {
    const selb = txt(url.searchParams.get('selb'), 40).trim(), dias = Math.max(1, Math.min(SUPR_DIAS, +url.searchParams.get('dias') || 90));
    if (!selb) return json(res, 400, { erro: 'Informe o SELB.' });
    const desde = Date.now() - dias * 86400000, pontos = [];
    for (const n of (await fsp.readdir(MON_DIR).catch(() => [])).filter(n => /^suprimentos-\d{4}-\d{2}\.jsonl$/.test(n)).sort()) {
      if (n.slice(12, 19) < new Date(desde).toISOString().slice(0, 7)) continue;
      for (const l of (await fsp.readFile(path.join(MON_DIR, n), 'utf8').catch(() => '')).split('\n')) {
        if (!l) continue;
        try { const o = JSON.parse(l); if (chaveSelbRec(o.s) === chaveSelbRec(selb) && Date.parse(o.t) >= desde) pontos.push({ t: o.t, itens: o.i }); } catch { /* linha incompleta */ }
      }
    }
    return json(res, 200, { selb, dias, pontos });
  } else if (req.method !== 'GET') { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
  // cada leitura leva os códigos do modelo (para quando a impressora não informa)
  const cat = await catalogoCodigos(), cads = new Map((await lerSelbsCad()).selbs.map(c => [chaveSelbRec(c.selb), c]));
  const selbs = Object.fromEntries(Object.entries(supr.selbs).map(([k, r]) => [k, { ...r, modeloCod: codsDoModelo(cat, modeloDoSelb(cads.get(k), r)) }]));
  json(res, 200, { horas: SUPR_HORAS, rodada: supr.rodada, lendo: !!suprRodando, selbs });
}
setTimeout(() => rodadaSuprimentos().catch(e => console.error('suprimentos:', e.message)), 120000).unref(); // 2 min após subir
setInterval(() => rodadaSuprimentos().catch(e => console.error('suprimentos:', e.message)), SUPR_HORAS * 3600000).unref();
setInterval(() => limparHistoricoSuprimentos().catch(() => {}), 86400000).unref();

// ------------------------------------------------------------------ OCR no servidor (repasse ao diag-ocr)
async function ocrRoute(req, res, url, acao) {
  if (!canRead(req, url)) { req.resume(); return json(res, 401, { erro: 'Token de leitura necessário.' }); }
  if (!OCR_URL) { req.resume(); return json(res, acao === 'saude' ? 200 : 503, { estado: 'desativado', erro: 'OCR do servidor não configurado (OCR_URL).' }); }
  try {
    if (acao === 'saude') {
      const r = await fetch(OCR_URL + '/saude', { signal: AbortSignal.timeout(4000) });
      return json(res, 200, await r.json());
    }
    if (req.method !== 'POST') { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
    const corpo = await lerCorpo(req, 20 * 1048576);
    const r = await fetch(OCR_URL + '/ocr', { method: 'POST', body: corpo, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(300000) });
    return json(res, r.status, await r.json());
  } catch (e) {
    return json(res, acao === 'saude' ? 200 : 502, { estado: 'indisponivel', erro: 'Serviço de OCR indisponível.', detalhe: String(e.message || e).slice(0, 200) });
  }
}

// ------------------------------------------------------------------ modo treinamento (aprender com as correções)
// Cada célula conferida (Local/SELB/Data: o que o OCR leu, o texto final e, se houver, o recorte da imagem)
// vira um exemplo. Daí saem as estatísticas de acerto e as "regras": leituras que já foram corrigidas
// antes são corrigidas sozinhas. CPF e nome nunca entram (não são lidos).
const TDIR = path.join(DATA, 'treino');
fs.mkdirSync(path.join(TDIR, 'img'), { recursive: true });
const TEX = path.join(TDIR, 'exemplos.json'), TCFG = path.join(TDIR, 'config.json');
const CAMPOS_TREINO = ['local', 'selb', 'data'];
const lerJson = async (f, padrao) => { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch { return padrao; } };
const normTreino = (campo, v) => campo === 'selb' ? chaveSelbRec(v) : normRec(v);
function semanaIso(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dia = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dia);
  const ini = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-S${String(Math.ceil(((t - ini) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}
function resumoTreino(ex, cfg) {
  const lista = Object.values(ex);
  const porCampo = {}, porMotor = {}, porSemana = {}, grupos = new Map();
  for (const e of lista) {
    const certo = normTreino(e.campo, e.lido) === normTreino(e.campo, e.final);
    for (const [obj, k] of [[porCampo, e.campo], [porMotor, e.motor || '?'], [porSemana, semanaIso(new Date(e.quando))]]) {
      const o = obj[k] || (obj[k] = { n: 0, certos: 0 }); o.n++; if (certo) o.certos++;
    }
    if (e.ignorado || !e.lido) continue;
    const g = e.campo + '|' + normTreino(e.campo, e.lido);
    const G = grupos.get(g) || { campo: e.campo, lido: e.lido, total: 0, finais: new Map() };
    G.total++; G.finais.set(e.final, (G.finais.get(e.final) || 0) + 1); grupos.set(g, G);
  }
  // regra: a mesma leitura foi corrigida para o mesmo texto na maioria (60%+) das vezes
  const regras = [];
  for (const G of grupos.values()) {
    const [final, n] = [...G.finais.entries()].sort((a, b) => b[1] - a[1])[0];
    if (normTreino(G.campo, final) === normTreino(G.campo, G.lido) || n / G.total < 0.6) continue;
    regras.push({ campo: G.campo, lido: G.lido, final, n, total: G.total });
  }
  regras.sort((a, b) => b.n - a.n);
  const memoria = {};
  for (const r of regras) (memoria[r.campo] = memoria[r.campo] || {})[normTreino(r.campo, r.lido)] = { final: r.final, n: r.n };
  return {
    ativo: cfg.ativo !== false, total: lista.length, comImagem: lista.filter(e => e.img).length,
    porCampo, porMotor, porSemana: Object.entries(porSemana).sort().map(([semana, v]) => ({ semana, ...v })).slice(-26),
    regras: regras.slice(0, 500), memoria,
  };
}
async function treinoRoute(req, res, url, acao) {
  if (!canRead(req, url)) { req.resume(); return json(res, 401, { erro: 'Token de leitura necessário.' }); }
  const ip = ipOf(req);
  const cfg = await lerJson(TCFG, { ativo: true });
  if (!acao && req.method === 'GET') return json(res, 200, resumoTreino(await lerJson(TEX, {}), cfg));
  if (acao === 'config' && req.method === 'PUT') {
    let b; try { b = await readJsonBody(req); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
    await writeJsonAtomic(TCFG, { ...cfg, ativo: !!b.ativo });
    await audit({ acao: 'treino_config', ativo: !!b.ativo, ip });
    return json(res, 200, { ativo: !!b.ativo });
  }
  if (acao === 'exemplos' && req.method === 'POST') {
    let b; try { b = await readJsonBody(req, 8 * 1048576); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
    if (cfg.ativo === false) return json(res, 200, { gravados: 0, ignorado: 'modo treinamento desligado' });
    const novos = (Array.isArray(b.exemplos) ? b.exemplos : []).slice(0, 500);
    const gravados = await withLock('treino', async () => {
      const ex = await lerJson(TEX, {});
      let n = 0;
      for (const e of novos) {
        const campo = CAMPOS_TREINO.includes(e && e.campo) ? e.campo : '';
        const chave = txt(e && e.chave, 80).replace(/[^\w:~-]/g, '');
        if (!campo || !chave) continue;
        const atual = ex[chave] || {};
        const reg = {
          chave, campo, lido: txt(e.lido, 300).trim(), final: txt(e.final, 300).trim(), motor: txt(e.motor, 20),
          conf: Math.max(0, Math.min(100, +e.conf || 0)), quando: new Date().toISOString(), img: atual.img || '',
        };
        // recorte da célula (PNG/JPEG pequeno, em base64): guardado para estatística e exportação
        const m = typeof e.img === 'string' && e.img.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
        if (m && m[2].length < 400000) {
          const buf = Buffer.from(m[2], 'base64');
          const nome = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 20) + (m[1] === 'png' ? '.png' : '.jpg');
          await fsp.writeFile(path.join(TDIR, 'img', nome), buf);
          reg.img = nome;
        }
        ex[chave] = reg; n++;
      }
      if (n) await writeJsonAtomic(TEX, ex);
      return n;
    });
    return json(res, 200, { gravados });
  }
  if (acao === 'esquecer' && req.method === 'POST') {
    let b; try { b = await readJsonBody(req); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
    const campo = CAMPOS_TREINO.includes(b.campo) ? b.campo : '', alvo = normTreino(campo, txt(b.lido, 300));
    if (!campo || !alvo) return json(res, 400, { erro: 'Informe o campo e a leitura.' });
    const n = await withLock('treino', async () => {
      const ex = await lerJson(TEX, {}); let c = 0;
      for (const e of Object.values(ex)) if (e.campo === campo && normTreino(campo, e.lido) === alvo && !e.ignorado) { e.ignorado = true; c++; }
      if (c) await writeJsonAtomic(TEX, ex);
      return c;
    });
    await audit({ acao: 'treino_regra_esquecida', campo, lido: txt(b.lido, 300), exemplos: n, ip });
    return json(res, 200, { exemplos: n });
  }
  if (acao === 'exportar.zip' && req.method === 'GET') {
    // conjunto de dados (imagens + rótulos) para treinar um modelo no futuro
    const ex = Object.values(await lerJson(TEX, {})).filter(e => e.img && e.final);
    const arquivos = [], linhas = ['arquivo\tcampo\ttexto\tlido_pelo_ocr\tmotor'];
    for (const e of ex) {
      const buf = await fsp.readFile(path.join(TDIR, 'img', e.img)).catch(() => null);
      if (!buf) continue;
      arquivos.push({ nome: 'imagens/' + e.img, dados: buf });
      linhas.push([e.img, e.campo, e.final, e.lido, e.motor].map(v => String(v).replace(/[\t\r\n]/g, ' ')).join('\t'));
    }
    arquivos.push({ nome: 'rotulos.tsv', dados: Buffer.from(linhas.join('\n') + '\n', 'utf8') });
    const zip = criarZip(arquivos);
    await audit({ acao: 'treino_exportado', exemplos: arquivos.length - 1, ip });
    res.writeHead(200, { ...SEC, 'Content-Type': 'application/zip', 'Content-Length': zip.length, 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="treino-ocr-${new Date().toISOString().slice(0, 10)}.zip"` });
    return res.end(zip);
  }
  if (!acao && req.method === 'DELETE') {
    // apaga os exemplos (o arquivo fica como .removido, para auditoria)
    await withLock('treino', async () => { await fsp.rename(TEX, TEX + '.' + Date.now() + '.removido').catch(() => {}); });
    await audit({ acao: 'treino_apagado', ip });
    return json(res, 200, { ok: true });
  }
  req.resume(); json(res, 405, { erro: 'Método não permitido.' });
}

// ------------------------------------------------------------------ modelos de laudo
const MDIR = path.join(DATA, 'modelos');
fs.mkdirSync(MDIR, { recursive: true });
const MID_RE = /^[a-z0-9_-]{2,40}$/;
const SECOES = ['identificacao', 'solicitacao', 'diagnostico', 'testes', 'coleta', 'achados', 'analise', 'servicos', 'pecas', 'conclusao', 'recomendacoes', 'observacoes', 'anexos'];
const SECOES_CAMPO = ['identificacao', 'solicitacao', 'diagnostico', 'servicos', 'conclusao'];
const TIPOS_CAMPO = ['texto', 'textarea', 'data', 'selecao'];
const TEXTOS_MODELO = ['problema', 'diagnostico', 'solucao', 'justificativa', 'recomendacoes', 'observacoes'];

const TESTES_BASE = ['Inicialização (POST / BIOS)', 'Fonte de alimentação', 'Memória RAM', 'Armazenamento (SMART / leitura)', 'Temperatura e ventilação', 'Vídeo / monitor', 'Rede', 'Periféricos (teclado, mouse, USB)', 'Sistema operacional'];
const sec = (on, titulo) => ({ on, titulo });
const SECOES_BASE = () => ({
  identificacao: sec(true, 'Identificação do equipamento'), solicitacao: sec(true, 'Solicitação'),
  diagnostico: sec(true, 'Diagnóstico'), testes: sec(true, 'Testes realizados'), coleta: sec(true, 'Dados coletados automaticamente'),
  achados: sec(true, 'Achados automáticos'), analise: sec(true, 'Análise técnica'),
  servicos: sec(true, 'Serviços executados'), pecas: sec(true, 'Peças'),
  conclusao: sec(true, 'Conclusão'), recomendacoes: sec(true, 'Recomendações'),
  observacoes: sec(true, 'Observações'), anexos: sec(true, 'Anexos'),
});
const MODELOS_PADRAO = [
  {
    id: 'completo', ordem: 1, nome: 'Laudo técnico completo', descricao: 'Diagnóstico completo com testes, dados da coleta, serviços, peças e conclusão.',
    titulo: 'Laudo Técnico', subtitulo: 'Manutenção de equipamento de informática', rotuloNumero: 'Laudo nº',
    secoes: SECOES_BASE(), testes: TESTES_BASE,
    conclusoes: ['reparado', 'aguardando_peca', 'garantia', 'sem_defeito', 'antieconomico', 'baixa'], conclusaoPadrao: '',
    textos: {}, camposExtras: [], encaminhamento: '', assinaturasExtras: [],
  },
  {
    id: 'baixa', ordem: 2, nome: 'Laudo de baixa patrimonial', descricao: 'Fundamenta a inservibilidade ou o reparo antieconômico para baixa do bem.',
    titulo: 'Laudo Técnico de Inservibilidade', subtitulo: 'Subsídio para baixa patrimonial de equipamento de informática', rotuloNumero: 'Laudo nº',
    secoes: { ...SECOES_BASE(), servicos: sec(false, 'Serviços executados'), pecas: sec(true, 'Componentes com defeito'), conclusao: sec(true, 'Parecer técnico') },
    testes: TESTES_BASE,
    conclusoes: ['antieconomico', 'baixa'], conclusaoPadrao: 'baixa',
    textos: {
      justificativa: 'O equipamento de patrimônio nº {patrimonio} apresenta defeito(s) cujo reparo é tecnicamente inviável ou economicamente desvantajoso em relação ao valor de um equipamento equivalente novo, considerando a idade, a obsolescência e a disponibilidade de peças.',
    },
    camposExtras: [
      { id: 'conservacao', rotulo: 'Estado de conservação', tipo: 'selecao', opcoes: ['Bom', 'Regular', 'Ruim', 'Sucata'], secao: 'conclusao', obrigatorio: true },
      { id: 'destinacao', rotulo: 'Destinação sugerida', tipo: 'selecao', opcoes: ['Reaproveitamento de peças', 'Leilão', 'Doação', 'Descarte ambientalmente adequado'], secao: 'conclusao', obrigatorio: true },
      { id: 'aquisicao', rotulo: 'Ano de aquisição (aprox.)', tipo: 'texto', opcoes: [], secao: 'identificacao', obrigatorio: false },
    ],
    encaminhamento: 'Encaminha-se ao Setor de Patrimônio para as providências de baixa do bem, conforme as normas internas aplicáveis.',
    assinaturasExtras: ['Responsável pelo setor de origem'],
  },
  {
    id: 'garantia', ordem: 3, nome: 'Encaminhamento para garantia / assistência', descricao: 'Registra o defeito e os dados da compra para acionar a garantia ou a assistência técnica.',
    titulo: 'Laudo Técnico para Garantia', subtitulo: 'Encaminhamento de equipamento à assistência técnica', rotuloNumero: 'Laudo nº',
    secoes: { ...SECOES_BASE(), servicos: sec(false, 'Serviços executados'), pecas: sec(true, 'Componentes com defeito'), recomendacoes: sec(false, 'Recomendações') },
    testes: TESTES_BASE,
    conclusoes: ['garantia'], conclusaoPadrao: 'garantia',
    textos: { justificativa: 'Defeito constatado em equipamento dentro do prazo de garantia. Não foram realizadas intervenções que comprometam a garantia do fabricante.' },
    camposExtras: [
      { id: 'fornecedor', rotulo: 'Fornecedor / assistência técnica', tipo: 'texto', opcoes: [], secao: 'identificacao', obrigatorio: true },
      { id: 'notafiscal', rotulo: 'Nota fiscal nº', tipo: 'texto', opcoes: [], secao: 'identificacao', obrigatorio: false },
      { id: 'datacompra', rotulo: 'Data da compra', tipo: 'data', opcoes: [], secao: 'identificacao', obrigatorio: false },
      { id: 'garantiaate', rotulo: 'Garantia válida até', tipo: 'data', opcoes: [], secao: 'identificacao', obrigatorio: false },
      { id: 'protocolo', rotulo: 'Protocolo de atendimento do fornecedor', tipo: 'texto', opcoes: [], secao: 'conclusao', obrigatorio: false },
    ],
    encaminhamento: 'Solicita-se o acionamento da garantia junto ao fornecedor indicado.',
    assinaturasExtras: [],
  },
  {
    id: 'atendimento', ordem: 4, nome: 'Registro de atendimento', descricao: 'Versão curta para atendimentos do dia a dia: problema, o que foi feito e situação final.',
    titulo: 'Registro de Atendimento Técnico', subtitulo: 'Suporte e manutenção de informática', rotuloNumero: 'Atendimento nº',
    secoes: { ...SECOES_BASE(), testes: sec(false, 'Testes realizados'), coleta: sec(false, 'Dados coletados automaticamente'), achados: sec(false, 'Achados automáticos'), analise: sec(true, 'Diagnóstico'), diagnostico: sec(false, 'Diagnóstico'), pecas: sec(false, 'Peças'), recomendacoes: sec(false, 'Recomendações'), conclusao: sec(true, 'Situação final') },
    testes: [],
    conclusoes: ['reparado', 'sem_defeito', 'aguardando_peca'], conclusaoPadrao: 'reparado',
    textos: {}, camposExtras: [], encaminhamento: '', assinaturasExtras: ['Usuário / solicitante (ciência)'],
  },
  {
    id: 'pecas', ordem: 5, nome: 'Requisição de peças', descricao: 'Justifica tecnicamente a aquisição de peças ou componentes.',
    titulo: 'Laudo Técnico para Aquisição de Peças', subtitulo: 'Manutenção de equipamento de informática', rotuloNumero: 'Laudo nº',
    secoes: { ...SECOES_BASE(), servicos: sec(false, 'Serviços executados'), pecas: sec(true, 'Peças necessárias'), recomendacoes: sec(false, 'Recomendações') },
    testes: TESTES_BASE,
    conclusoes: ['aguardando_peca'], conclusaoPadrao: 'aguardando_peca',
    textos: { justificativa: 'A substituição das peças relacionadas restabelece o funcionamento do equipamento de patrimônio nº {patrimonio}, sendo o reparo tecnicamente viável e economicamente vantajoso.' },
    camposExtras: [
      { id: 'estimativa', rotulo: 'Estimativa de custo', tipo: 'texto', opcoes: [], secao: 'conclusao', obrigatorio: false },
      { id: 'urgencia', rotulo: 'Urgência', tipo: 'selecao', opcoes: ['Baixa', 'Média', 'Alta – serviço parado'], secao: 'conclusao', obrigatorio: true },
    ],
    encaminhamento: 'Solicita-se a aquisição das peças relacionadas acima.',
    assinaturasExtras: ['Chefia do setor de TI'],
  },
];

function sanitizeModelo(b, base = {}) {
  b = b && typeof b === 'object' ? b : {};
  const sb = b.secoes || {};
  const secoes = {};
  for (const k of SECOES) {
    const s = sb[k] || (base.secoes || {})[k] || {};
    secoes[k] = { on: s.on !== false, titulo: txt(s.titulo, 80) || (SECOES_BASE()[k] || {}).titulo || k };
  }
  const conclusoes = (Array.isArray(b.conclusoes) ? b.conclusoes : []).filter(c => CONCLUSOES.includes(c) && c).filter((c, i, a) => a.indexOf(c) === i);
  if (!conclusoes.length) conclusoes.push(...CONCLUSOES.filter(Boolean));
  const textos = {};
  for (const k of TEXTOS_MODELO) textos[k] = txt((b.textos || {})[k], 4000);
  const ids = new Set();
  const camposExtras = (Array.isArray(b.camposExtras) ? b.camposExtras : []).slice(0, 20).map((c, i) => {
    let id = String((c && c.id) || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30) || 'campo' + (i + 1);
    while (ids.has(id)) id += '_';
    ids.add(id);
    return {
      id, rotulo: txt(c && c.rotulo, 80) || 'Campo', tipo: pick(c && c.tipo, TIPOS_CAMPO),
      opcoes: (Array.isArray(c && c.opcoes) ? c.opcoes : []).map(o => txt(o, 80)).filter(Boolean).slice(0, 20),
      secao: pick(c && c.secao, SECOES_CAMPO), obrigatorio: !!(c && c.obrigatorio),
    };
  });
  return {
    nome: txt(b.nome, 80) || 'Modelo sem nome', descricao: txt(b.descricao, 200),
    titulo: txt(b.titulo, 80) || 'Laudo Técnico', subtitulo: txt(b.subtitulo, 120), rotuloNumero: txt(b.rotuloNumero, 30) || 'Laudo nº',
    secoes, testes: (Array.isArray(b.testes) ? b.testes : []).map(t => txt(t, 120)).filter(Boolean).slice(0, 30),
    conclusoes, conclusaoPadrao: conclusoes.includes(b.conclusaoPadrao) ? b.conclusaoPadrao : '',
    textos, camposExtras, encaminhamento: txt(b.encaminhamento, 2000),
    assinaturasExtras: (Array.isArray(b.assinaturasExtras) ? b.assinaturasExtras : []).map(t => txt(t, 80)).filter(Boolean).slice(0, 4),
    ativo: b.ativo !== false, ordem: Math.max(0, Math.min(9999, parseInt(b.ordem, 10) || 100)),
  };
}

async function seedModelos() {
  for (const m of MODELOS_PADRAO) {
    const f = path.join(MDIR, m.id + '.json');
    if (!fs.existsSync(f)) await writeJsonAtomic(f, { id: m.id, padrao: true, ...sanitizeModelo(m), criadoEm: new Date().toISOString() });
  }
}
async function listModelos() {
  const out = [];
  for (const n of await fsp.readdir(MDIR)) {
    if (!n.endsWith('.json') || !MID_RE.test(n.slice(0, -5))) continue;
    try { out.push(JSON.parse(await fsp.readFile(path.join(MDIR, n), 'utf8'))); } catch { /* ignora */ }
  }
  return out.sort((a, b) => (a.ordem - b.ordem) || a.nome.localeCompare(b.nome));
}

async function modeloRoute(req, res, url, id, acao) {
  if (!canRead(req, url)) { req.resume(); return json(res, 401, { erro: 'Token de leitura necessário.' }); }
  const ip = ipOf(req);
  if (!id) {
    if (req.method === 'GET') return json(res, 200, await listModelos());
    if (req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req, 200000); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
      const nid = 'm' + crypto.randomBytes(4).toString('hex');
      const m = { id: nid, padrao: false, ...sanitizeModelo(body), criadoEm: new Date().toISOString() };
      await writeJsonAtomic(path.join(MDIR, nid + '.json'), m);
      await audit({ acao: 'modelo_criado', modelo: nid, nome: m.nome, ip });
      return json(res, 201, m);
    }
    return json(res, 405, { erro: 'Método não permitido.' });
  }
  if (!MID_RE.test(id)) { req.resume(); return json(res, 400, { erro: 'id de modelo inválido' }); }
  const file = path.join(MDIR, id + '.json');
  const atual = JSON.parse(await fsp.readFile(file, 'utf8').catch(() => 'null'));
  if (!atual) { req.resume(); return json(res, 404, { erro: 'Modelo não encontrado.' }); }
  if (acao === 'restaurar' && req.method === 'POST') {
    const orig = MODELOS_PADRAO.find(m => m.id === id);
    if (!orig) return json(res, 400, { erro: 'Só modelos padrão podem ser restaurados.' });
    const m = { id, padrao: true, ...sanitizeModelo(orig), criadoEm: atual.criadoEm, atualizadoEm: new Date().toISOString() };
    await writeJsonAtomic(file, m);
    await audit({ acao: 'modelo_restaurado', modelo: id, ip });
    return json(res, 200, m);
  }
  if (acao) return json(res, 404, { erro: 'Rota não encontrada.' });
  if (req.method === 'GET') return json(res, 200, atual);
  if (req.method === 'PUT') {
    let body;
    try { body = await readJsonBody(req, 200000); } catch { return json(res, 400, { erro: 'Dados inválidos.' }); }
    const m = { id, padrao: !!atual.padrao, ...sanitizeModelo(body, atual), criadoEm: atual.criadoEm, atualizadoEm: new Date().toISOString() };
    await writeJsonAtomic(file, m);
    await audit({ acao: 'modelo_atualizado', modelo: id, ip });
    return json(res, 200, m);
  }
  if (req.method === 'DELETE') {
    if (atual.padrao) return json(res, 400, { erro: 'Modelos padrão não podem ser excluídos. Desative ou restaure.' });
    await fsp.rename(file, file + '.removido');
    await audit({ acao: 'modelo_removido', modelo: id, nome: atual.nome, ip });
    return json(res, 200, { ok: true });
  }
  json(res, 405, { erro: 'Método não permitido.' });
}

// ------------------------------------------------------------------ assinatura de laudos
// DER minimo para ler a assinatura CMS (PKCS#7) embutida no PDF
function derNode(buf, off) {
  const tag = buf[off];
  let len = buf[off + 1], hdr = 2;
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i]; hdr = 2 + n; }
  return { tag, off, hdr, len, start: off + hdr, end: off + hdr + len };
}
function derChildren(buf, node) {
  const out = []; let p = node.start;
  while (p < node.end) { const c = derNode(buf, p); out.push(c); p = c.end; }
  return out;
}
function derOid(buf, node) {
  const b = buf.slice(node.start, node.end); const parts = [Math.floor(b[0] / 40), b[0] % 40]; let v = 0;
  for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 0x7f); if (!(b[i] & 0x80)) { parts.push(v); v = 0; } }
  return parts.join('.');
}
const HASH_OID = { '2.16.840.1.101.3.4.2.1': 'sha256', '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512', '1.3.14.3.2.26': 'sha1' };

function lerCms(der) {
  const ci = derNode(der, 0);
  const [, ctx0] = derChildren(der, ci);
  const sd = derChildren(der, ctx0)[0];
  const ch = derChildren(der, sd);
  const certs = [], signers = [];
  for (const c of ch) {
    if (c.tag === 0xa0) for (const cc of derChildren(der, c)) certs.push(der.slice(cc.off, cc.end));
  }
  const sis = ch[ch.length - 1];
  for (const si of derChildren(der, sis)) {
    const f = derChildren(der, si);
    let i = 1;
    const sid = f[i++];
    let serial = null;
    if (sid.tag === 0x30) { const s = derChildren(der, sid); serial = der.slice(s[1].start, s[1].end).toString('hex').replace(/^(00)+/, '').toUpperCase(); }
    const digAlg = derOid(der, derChildren(der, f[i++])[0]);
    let attrs = null, md = null, signingTime = null;
    if (f[i].tag === 0xa0) {
      attrs = f[i++];
      for (const a of derChildren(der, attrs)) {
        const [oid, set] = derChildren(der, a);
        const o = derOid(der, oid);
        const v = derChildren(der, set)[0];
        if (o === '1.2.840.113549.1.9.4') md = der.slice(v.start, v.end);
        if (o === '1.2.840.113549.1.9.5') signingTime = der.slice(v.start, v.end).toString('latin1');
      }
    }
    const sigAlg = derOid(der, derChildren(der, f[i++])[0]);
    const sigv = f[i++];
    const signedAttrs = attrs ? Buffer.concat([Buffer.from([0x31]), der.slice(attrs.off + 1, attrs.end)]) : null;
    signers.push({ serial, digAlg, md, signedAttrs, sigAlg, signature: der.slice(sigv.start, sigv.end), signingTime });
  }
  return { certs, signers };
}

function cpfDoCertificado(raw, cn) {
  // ICP-Brasil: SAN otherName 2.16.76.1.3.1 = nascimento(8) + CPF(11) + ...
  const oid = Buffer.from([0x06, 0x05, 0x60, 0x4c, 0x01, 0x03, 0x01]);
  const i = raw.indexOf(oid);
  if (i >= 0) {
    const s = raw.slice(i + oid.length, i + oid.length + 60).toString('latin1');
    const m = s.match(/\d{19}/);
    if (m) return m[0].slice(8, 19);
  }
  const m = String(cn || '').match(/:(\d{11})$/);
  return m ? m[1] : '';
}
const mascaraCpf = c => (c && c.length === 11 ? `***.${c.slice(3, 6)}.${c.slice(6, 9)}-**` : '');
const cnDe = dn => { const m = String(dn || '').match(/CN=([^\n]+)/); return m ? m[1].trim() : String(dn || ''); };

function verificarPdf(buf) {
  const s = buf.toString('latin1');
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  const out = [];
  let m;
  while ((m = re.exec(s))) {
    const [a, b, c, d] = m.slice(1).map(Number);
    const r = { byteRange: [a, b, c, d], cobreArquivo: c + d === buf.length, integra: false, assinaturaOk: false };
    try {
      if (a !== 0 || b >= c || c + d > buf.length || s[b] !== '<' || s[c - 1] !== '>') throw new Error('ByteRange inválido');
      let der = Buffer.from(s.slice(b + 1, c - 1), 'hex');
      der = der.slice(0, derNode(der, 0).end);
      const cms = lerCms(der);
      const sg = cms.signers[0];
      const alg = HASH_OID[sg.digAlg];
      if (!alg) throw new Error('Algoritmo de resumo não suportado: ' + sg.digAlg);
      const dados = Buffer.concat([buf.slice(a, a + b), buf.slice(c, c + d)]);
      const resumo = crypto.createHash(alg).update(dados).digest();
      const certs = cms.certs.map(x => new crypto.X509Certificate(x));
      const cert = certs.find(x => x.serialNumber.replace(/^0+/, '').toUpperCase() === sg.serial) || certs[0];
      r.integra = sg.md ? resumo.equals(sg.md) : false;
      const assinado = sg.signedAttrs || dados;
      r.assinaturaOk = crypto.verify(alg, assinado, cert.publicKey, sg.signature);
      const cn = cnDe(cert.subject);
      const cpf = cpfDoCertificado(cert.raw, cn);
      r.nome = cn.split(':')[0];
      r.cpf = mascaraCpf(cpf);
      r.emissor = cnDe(cert.issuer);
      r.serial = cert.serialNumber;
      r.validade = [cert.validFrom, cert.validTo];
      r.certValido = new Date(cert.validFrom) <= new Date() && new Date() <= new Date(cert.validTo);
      r.algoritmo = alg;
      const mm = s.slice(Math.max(0, m.index - 3000), m.index + 3000).match(/\/M\s*\(D:(\d{14})([+\-Z])(\d{2})?'?(\d{2})?/);
      if (mm) {
        const t = mm[1];
        r.data = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}${mm[2] === 'Z' ? 'Z' : `${mm[2]}${mm[3] || '00'}:${mm[4] || '00'}`}`;
      }
    } catch (e) { r.erro = e.message; }
    out.push(r);
  }
  return out;
}

const tickets = new Map(); // ticket -> { id, revisao, expira }
function limparTickets() { const agora = Date.now(); for (const [k, v] of tickets) if (v.expira < agora) tickets.delete(k); }
async function lerCorpo(req, max) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw new Error('LIMITE'); chunks.push(c); }
  return Buffer.concat(chunks);
}
const laudoFile = id => path.join(LDIR, id + '.json');
async function lerLaudo(id) { return JSON.parse(await fsp.readFile(laudoFile(id), 'utf8').catch(() => 'null')); }
const PDF_MAX = 60 * 1048576;

// laudo travado depois de assinado
const laudoAssinado = l => !!(l && (l.assinaturaDigital || l.assinaturaFisica));

async function assinaturaLaudoRoute(req, res, url, id, acao) {
  if (!canRead(req, url)) { req.resume(); return json(res, 401, { erro: 'Token de leitura necessário.' }); }
  if (!LID_RE.test(id)) { req.resume(); return json(res, 400, { erro: 'id de laudo inválido' }); }
  const ip = ipOf(req);
  const L = await lerLaudo(id);
  if (!L) { req.resume(); return json(res, 404, { erro: 'Laudo não encontrado.' }); }

  if (req.method === 'GET' && (acao === 'assinado' || acao === 'digitalizado')) {
    const info = acao === 'assinado' ? L.assinaturaDigital : L.assinaturaFisica;
    if (!info) return json(res, 404, { erro: 'Não há versão assinada.' });
    const file = path.join(LDIR, info.arquivo);
    const st = await fsp.stat(file);
    await audit({ acao: 'download_' + acao, laudo: id, ip });
    res.writeHead(200, { ...SEC, 'Content-Type': info.tipo || 'application/pdf', 'Content-Length': st.size, 'Cache-Control': 'no-store',
      'Content-Disposition': `inline; filename="laudo-${L.numero.replace('/', '-')}-${acao}${path.extname(info.arquivo)}"`, 'X-Sha256': info.sha256 });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method !== 'POST') { req.resume(); return json(res, 405, { erro: 'Método não permitido.' }); }
  if (laudoAssinado(L)) { req.resume(); return json(res, 409, { erro: 'Este laudo já está assinado.' }); }
  if (+req.headers['x-revisao'] !== L.revisao) { req.resume(); return json(res, 409, { erro: 'O laudo foi alterado depois de gerado. Gere de novo.' }); }
  let body;
  try { body = await lerCorpo(req, PDF_MAX); } catch { return json(res, 413, { erro: 'Arquivo grande demais.' }); }

  if (acao === 'preparar') {
    if (L.status !== 'emitido') return json(res, 400, { erro: 'Emita o laudo antes de assinar.' });
    if (body.slice(0, 5).toString() !== '%PDF-') return json(res, 400, { erro: 'Conteúdo não é PDF.' });
    await fsp.writeFile(path.join(LDIR, `${id}.preparado.pdf`), body);
    limparTickets();
    const ticket = crypto.randomBytes(24).toString('hex');
    tickets.set(ticket, { id, revisao: L.revisao, expira: Date.now() + 15 * 60000 });
    await audit({ acao: 'assinatura_preparada', laudo: id, revisao: L.revisao, ip });
    return json(res, 200, { ticket, expiraEm: new Date(Date.now() + 15 * 60000).toISOString() });
  }
  if (acao === 'digitalizado') {
    const tipo = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
    const ext = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' }[tipo];
    if (!ext) return json(res, 415, { erro: 'Envie PDF, JPG ou PNG.' });
    const sha = crypto.createHash('sha256').update(body).digest('hex').toUpperCase();
    const informado = hdr(req, 'x-sha256', 64).toUpperCase();
    if (informado && informado !== sha) return json(res, 422, { erro: 'Hash diferente do calculado no navegador. Envie de novo.' });
    const arquivo = `${id}.via-assinada${ext}`;
    await fsp.writeFile(path.join(LDIR, arquivo), body);
    const out = await withLock('laudo:' + id, async () => {
      const atual = await lerLaudo(id);
      atual.assinaturaFisica = { arquivo, tipo, nome: hdr(req, 'x-nome', 160) || arquivo, tamanho: body.length, sha256: sha, recebidoEm: new Date().toISOString(), ip, revisao: atual.revisao };
      atual.status = 'emitido';
      await writeJsonAtomic(laudoFile(id), atual);
      return atual;
    });
    await audit({ acao: 'via_fisica_registrada', laudo: id, sha256: sha, ip });
    return json(res, 200, out);
  }
  json(res, 404, { erro: 'Rota não encontrada.' });
}

// rotas usadas pelo assinador local (autenticadas pelo ticket, sem token de leitura)
async function ticketRoute(req, res, ticket, acao) {
  limparTickets();
  const t = tickets.get(ticket);
  if (!t) { req.resume(); return json(res, 404, { erro: 'Pedido de assinatura expirado ou inválido. Gere de novo no sistema.' }); }
  const L = await lerLaudo(t.id);
  const prep = path.join(LDIR, `${t.id}.preparado.pdf`);
  if (!L || !fs.existsSync(prep)) { req.resume(); return json(res, 404, { erro: 'Pedido de assinatura expirado ou inválido. Gere de novo no sistema.' }); }
  const M = L && L.modeloSnap ? L.modeloSnap : { titulo: 'Laudo Técnico', rotuloNumero: 'Laudo nº' };
  if (req.method === 'GET' && acao === 'pdf') {
    const st = await fsp.stat(prep);
    res.writeHead(200, { ...SEC, 'Content-Type': 'application/pdf', 'Content-Length': st.size, 'Cache-Control': 'no-store',
      'X-Laudo': encodeURIComponent(`${M.titulo} - ${M.rotuloNumero} ${L.numero} - patrimônio ${L.patrimonio || '-'}`) });
    return fs.createReadStream(prep).pipe(res);
  }
  if (req.method === 'POST' && !acao) {
    const ip = ipOf(req);
    let body;
    try { body = await lerCorpo(req, PDF_MAX); } catch { return json(res, 413, { erro: 'Arquivo grande demais.' }); }
    if (!L || laudoAssinado(L) || L.revisao !== t.revisao) return json(res, 409, { erro: 'O laudo mudou ou já foi assinado.' });
    const orig = await fsp.readFile(prep);
    // o PDF assinado tem que ser o preparado, mudando só os marcadores do selo e a assinatura
    if (body.length !== orig.length) return json(res, 422, { erro: 'O PDF devolvido não corresponde ao que foi preparado.' });
    const so = orig.toString('latin1');
    const livres = [];
    for (const mk of ['##DIAGNOME', '##DIAGCPF', '##DIAGDATA', '##DIAGEMISSOR', '##DIAGM']) {
      let p = so.indexOf(mk);
      while (p >= 0) { let e = p + mk.length; while (so[e] === '#') e++; livres.push([p, e]); p = so.indexOf(mk, e); }
    }
    const br = so.match(/\/ByteRange\s*\[[^\]]*\]/); if (br) livres.push([br.index, br.index + br[0].length]);
    const ct = so.indexOf('<' + '0'.repeat(64)); if (ct >= 0) { let e = ct + 1; while (so[e] === '0') e++; livres.push([ct, e + 1]); }
    livres.sort((a, b) => a[0] - b[0]);
    let p = 0;
    for (const [a, b] of [...livres, [orig.length, orig.length]]) {
      if (!orig.slice(p, a).equals(body.slice(p, a))) return json(res, 422, { erro: 'O conteúdo do PDF foi alterado fora da área da assinatura.' });
      p = Math.max(p, b);
    }
    const sigs = verificarPdf(body);
    const ultima = sigs[sigs.length - 1];
    if (!ultima || !ultima.integra || !ultima.assinaturaOk || !ultima.cobreArquivo) {
      await audit({ acao: 'assinatura_recusada', laudo: t.id, motivo: ultima ? (ultima.erro || 'verificação falhou') : 'sem assinatura', ip });
      return json(res, 422, { erro: 'Assinatura inválida: ' + (ultima ? ultima.erro || 'integridade/assinatura não conferem' : 'nenhuma assinatura encontrada') });
    }
    if (!ultima.certValido) return json(res, 422, { erro: 'Certificado fora do prazo de validade.' });
    const sha = crypto.createHash('sha256').update(body).digest('hex').toUpperCase();
    const arquivo = `${t.id}.assinado.pdf`;
    await fsp.writeFile(path.join(LDIR, arquivo), body);
    const out = await withLock('laudo:' + t.id, async () => {
      const atual = await lerLaudo(t.id);
      atual.assinaturaDigital = {
        arquivo, tipo: 'application/pdf', sha256: sha, tamanho: body.length, recebidoEm: new Date().toISOString(), ip, revisao: atual.revisao,
        assinaturas: sigs.map(x => ({ nome: x.nome, cpf: x.cpf, emissor: x.emissor, serial: x.serial, validade: x.validade, data: x.data, integra: x.integra, assinaturaOk: x.assinaturaOk, algoritmo: x.algoritmo })),
      };
      await writeJsonAtomic(laudoFile(t.id), atual);
      return atual;
    });
    tickets.delete(ticket);
    await fsp.rm(prep, { force: true });
    await audit({ acao: 'laudo_assinado', laudo: t.id, sha256: sha, assinante: ultima.nome, cpf: ultima.cpf, serial: ultima.serial, ip });
    return json(res, 200, { ok: true, numero: out.numero, assinante: ultima.nome, sha256: sha });
  }
  req.resume(); json(res, 405, { erro: 'Método não permitido.' });
}

// ------------------------------------------------------------------ coleta pelo site
// pacote .zip do script (com diag-servidor.cfg preenchido)
const zlib = require('zlib');
const CRC_TAB = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TAB[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function criarZip(arquivos) {
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const locais = [], central = []; let off = 0;
  for (const f of arquivos) {
    const nome = Buffer.from(f.nome, 'utf8'), dados = zlib.deflateRawSync(f.dados), crc = crc32(f.dados);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(dados.length, 18); lh.writeUInt32LE(f.dados.length, 22); lh.writeUInt16LE(nome.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(dados.length, 20); ch.writeUInt32LE(f.dados.length, 24); ch.writeUInt16LE(nome.length, 28); ch.writeUInt32LE(off, 42);
    locais.push(lh, nome, dados); central.push(ch, nome);
    off += 30 + nome.length + dados.length;
  }
  const cd = Buffer.concat(central), fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(arquivos.length, 8); fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(cd.length, 12); fim.writeUInt32LE(off, 16);
  return Buffer.concat([...locais, cd, fim]);
}
const baseUrl = req => `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
const SCRIPTS_DIR = path.join(WEB, 'coleta');

async function pacoteColeta(req, res, url) {
  const ip = ipOf(req);
  if (req.method === 'GET') {
    if (!canRead(req, url)) return json(res, 401, { erro: 'Token de leitura necessário.' });
    const diag = url.searchParams.get('tipo') === 'diagnostico';
    const cfg = `SERVIDOR=${baseUrl(req)}\r\nTOKEN=${UPLOAD_TOKEN}\r\n`;
    const arquivos = [];
    const lista = diag ? [['diagnostico.bat'], ['diagnostico.ps1'], ['baixar-sensores.ps1'], ['LEIA-ME-diagnostico.txt', 'LEIA-ME.txt']]
                       : [['diag-hardware.bat'], ['diag-hardware.ps1'], ['LEIA-ME.txt']];
    for (const [n, nomeZip] of lista) {
      const f = path.join(SCRIPTS_DIR, n);
      if (fs.existsSync(f)) arquivos.push({ nome: nomeZip || n, dados: await fsp.readFile(f) });
    }
    // LibreHardwareMonitor (tensões, ventoinhas, temperaturas): vai junto se estiver em web/coleta/sensores
    const sens = path.join(SCRIPTS_DIR, 'sensores');
    if (diag && fs.existsSync(sens)) {
      for (const e of await fsp.readdir(sens, { recursive: true, withFileTypes: true })) {
        if (!e.isFile()) continue;
        const f = path.join(e.parentPath || e.path, e.name);
        arquivos.push({ nome: 'sensores/' + path.relative(sens, f).split(path.sep).join('/'), dados: await fsp.readFile(f) });
      }
    }
    arquivos.push({ nome: 'diag-servidor.cfg', dados: Buffer.from(cfg) });
    const zip = criarZip(arquivos);
    const nomeZip = diag ? 'diag-diagnostico.zip' : 'diag-remocao.zip';
    await audit({ acao: 'download_pacote_coleta', tipo: diag ? 'diagnostico' : 'remocao', ip });
    res.writeHead(200, { ...SEC, 'Content-Type': 'application/zip', 'Content-Length': zip.length, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${nomeZip}"` });
    return res.end(zip);
  }
  req.resume(); json(res, 404, { erro: 'Não encontrado.' });
}

// ------------------------------------------------------------------ estaticos
async function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400, SEC); return res.end(); }
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(WEB, rel));
  if (!file.startsWith(WEB + path.sep)) { res.writeHead(403, SEC); return res.end(); }
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new Error('nf');
    res.writeHead(200, { ...SEC, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { ...SEC, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Não encontrado');
  }
}

// ------------------------------------------------------------------ roteamento
const server = http.createServer(async (req, res) => {
  // caminhos como "//" fazem o new URL() lançar erro: responde 400 em vez de derrubar o servidor
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400, SEC); return res.end(); }
  const p = url.pathname;
  try {
    if (p === '/api/info' && req.method === 'GET') {
      return json(res, 200, { envioAtivo: !!UPLOAD_TOKEN, leituraProtegida: !!READ_TOKEN, limiteMB: MAX_BYTES / 1048576, ocrServidor: !!OCR_URL });
    }
    if (p === '/api/coletas' && req.method === 'POST') return await upload(req, res, url);
    if (p === '/api/coletas' && req.method === 'GET') {
      if (!canRead(req, url)) return json(res, 401, { erro: 'Token de leitura necessário.' });
      return json(res, 200, await listMeta());
    }
    const ma = p.match(/^\/api\/coletas\/([^/]+)\/anexos(?:\/([^/]+))?$/);
    if (ma) return await anexoRoute(req, res, url, owner('coleta', ma[1]), ma[2]);
    const la = p.match(/^\/api\/laudos\/([^/]+)\/anexos(?:\/([^/]+))?$/);
    if (la) return await anexoRoute(req, res, url, owner('laudo', la[1]), la[2]);
    const ra = p.match(/^\/api\/recebimentos\/([^/]+)\/anexos(?:\/([^/]+))?$/);
    if (ra) return await anexoRoute(req, res, url, owner('receb', ra[1]), ra[2]);
    if (p === '/api/recebimentos/lote') return await loteRoute(req, res, url);
    if (p === '/api/recebimentos/manual') return await entregaManualRoute(req, res, url);
    if (p === '/api/receb-entrega-campos') return await camposEntregaRoute(req, res, url);
    const oc = p.match(/^\/api\/ocr(?:\/(saude))?$/);
    if (oc) return await ocrRoute(req, res, url, oc[1]);
    const tr = p.match(/^\/api\/treino(?:\/(config|exemplos|esquecer|exportar\.zip))?$/);
    if (tr) return await treinoRoute(req, res, url, tr[1]);
    const su = p.match(/^\/api\/suprimentos(?:\/(ler|testar|historico|cadastro|codigos|trocas))?$/);
    if (su) return await suprimentosRoute(req, res, url, su[1]);
    const mo = p.match(/^\/api\/monitor(?:\/(verificar|pausa|historico|quedas|alertas|alerta-teste))?$/);
    if (mo) return await monitorRoute(req, res, url, mo[1]);
    const sc = p.match(/^\/api\/receb-selbs(?:\/([^/]+))?$/);
    if (sc) return await selbsRoute(req, res, url, sc[1]);
    if (p === '/api/receb-textos') return await textosRoute(req, res, url);
    const lc = p.match(/^\/api\/receb-locais(?:\/([^/]+))?$/);
    if (lc) return await locaisRoute(req, res, url, lc[1]);
    const rr = p.match(/^\/api\/recebimentos(?:\/([^/]+))?$/);
    if (rr) return await recebRoute(req, res, url, rr[1]);
    const mm = p.match(/^\/api\/modelos(?:\/([^/]+))?(?:\/(restaurar))?$/);
    if (mm) return await modeloRoute(req, res, url, mm[1], mm[2]);
    const la2 = p.match(/^\/api\/laudos\/([^/]+)\/(preparar|assinado|digitalizado)$/);
    if (la2) return await assinaturaLaudoRoute(req, res, url, la2[1], la2[2]);
    if (p === '/api/coleta/pacote.zip') return await pacoteColeta(req, res, url);
    const tk = p.match(/^\/api\/assinatura\/([0-9a-f]{48})(?:\/(pdf))?$/);
    if (tk) return await ticketRoute(req, res, tk[1], tk[2]);
    const ll = p.match(/^\/api\/laudos(?:\/([^/]+))?$/);
    if (ll) return await laudoRoute(req, res, url, ll[1]);
    const m = p.match(/^\/api\/coletas\/([^/]+)\/zip$/);
    if (m && req.method === 'GET') {
      if (!canRead(req, url)) return json(res, 401, { erro: 'Token de leitura necessário.' });
      if (!ID_RE.test(m[1])) return json(res, 400, { erro: 'id inválido' });
      const meta = JSON.parse(await fsp.readFile(path.join(DIR, m[1] + '.json'), 'utf8').catch(() => 'null'));
      if (!meta) return json(res, 404, { erro: 'Coleta não encontrada.' });
      const file = path.join(DIR, m[1] + '.zip');
      const st = await fsp.stat(file);
      await audit({ acao: 'download', id: m[1], ip: ipOf(req) });
      res.writeHead(200, {
        ...SEC, 'Content-Type': 'application/zip', 'Content-Length': st.size, 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${meta.arquivo}"`, 'X-Sha256': meta.sha256,
      });
      return fs.createReadStream(file).pipe(res);
    }
    if (p.startsWith('/api/')) return json(res, 404, { erro: 'Rota não encontrada.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SEC); return res.end(); }
    return await serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { erro: 'Erro interno.' });
  }
});
server.requestTimeout = 15 * 60 * 1000;
seedModelos().catch(e => console.error('modelos:', e.message));
server.listen(PORT, () => {
  console.log(`Central diag ouvindo na porta ${PORT}. Dados em ${DATA}`);
  if (!UPLOAD_TOKEN) console.warn('AVISO: UPLOAD_TOKEN não definido. O recebimento de coletas está DESATIVADO.');
  if (!READ_TOKEN) console.warn('AVISO: READ_TOKEN não definido. Qualquer um na rede pode listar e baixar as coletas.');
});

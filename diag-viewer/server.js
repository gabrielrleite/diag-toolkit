'use strict';
/*
  Servidor do Visualizador de Coletas (diag-hardware)
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
const DIR = path.join(DATA, 'coletas');
const ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const AID_RE = /^[0-9a-f]{12}$/;
const ANX_MAX = (+process.env.ANEXO_MAX_MB || 25) * 1048576;
const ANX_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' };

fs.mkdirSync(DIR, { recursive: true });

const SEC = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8',
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
function owner(tipo, id) {
  const base = tipo === 'laudo' ? LDIR : DIR;
  const re = tipo === 'laudo' ? LID_RE : ID_RE;
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
  if (!o.existe()) { req.resume(); return json(res, 404, { erro: o.tipo === 'laudo' ? 'Laudo não encontrado.' : 'Coleta não encontrada.' }); }
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
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/info' && req.method === 'GET') {
      return json(res, 200, { envioAtivo: !!UPLOAD_TOKEN, leituraProtegida: !!READ_TOKEN, limiteMB: MAX_BYTES / 1048576 });
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
  console.log(`Visualizador ouvindo na porta ${PORT}. Dados em ${DATA}`);
  if (!UPLOAD_TOKEN) console.warn('AVISO: UPLOAD_TOKEN não definido. O recebimento de coletas está DESATIVADO.');
  if (!READ_TOKEN) console.warn('AVISO: READ_TOKEN não definido. Qualquer um na rede pode listar e baixar as coletas.');
});

'use strict';
// ================================================================== modo offline (parte das impressoras)
// Sem conexão com o servidor, as abas SELBs, Impressoras e Suprimentos continuam funcionando com a última
// cópia dos dados (guardada no navegador, IndexedDB). Alterações nelas (cadastro do SELB, códigos por modelo,
// pausas) ficam numa fila e são enviadas na ordem quando o servidor volta. O que só o servidor faz (ping,
// leitura SNMP) fica para quando ele voltar.
const OFF = { online: true, desde: null, fila: [], mem: new Map(), dbp: null, sincronizando: false, enviados: 0 };

// leituras guardadas para uso offline (caminho sem a barra inicial)
const OFF_GET = [/^api\/monitor(\?|$)/, /^api\/monitor\/(quedas|alertas|historico)(\?|$)/, /^api\/suprimentos(\?|$)/,
  /^api\/suprimentos\/(codigos|historico|cadastro)(\?|$)/, /^api\/receb-selbs$/, /^api\/receb-locais(\/categorias)?$/,
  /^api\/receb-textos$/, /^api\/recebimentos\?linhas=1$/, /^api\/receb-entrega-campos$/];
// alterações que podem esperar na fila
const OFF_FILA = [[/^api\/recebimentos\/manual$/, ['POST']], [/^api\/receb-selbs\/[^/?]+$/, ['PUT', 'DELETE']], [/^api\/suprimentos\/codigos$/, ['PUT']], [/^api\/monitor\/pausa(\?|$)/, ['POST', 'DELETE']]];

// ---------------------------------------------------------------- armazenamento (IndexedDB; sem ele, só memória)
function offDb() {
  if (!OFF.dbp) OFF.dbp = new Promise(ok => {
    try {
      const r = indexedDB.open('central-diag-offline', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('cache'); r.result.createObjectStore('fila', { keyPath: 'id' }); };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ok(null);
    } catch { ok(null); }
  });
  return OFF.dbp;
}
async function offOp(store, modo, fn) {
  const db = await offDb();
  if (!db) return null;
  return new Promise(ok => {
    try {
      const tx = db.transaction(store, modo), req = fn(tx.objectStore(store));
      tx.oncomplete = () => ok(req ? req.result : null);
      tx.onerror = tx.onabort = () => ok(null);
    } catch { ok(null); }
  });
}
const offChave = p => String(p).replace(/^\.?\//, '');
async function cacheLer(p) { const k = offChave(p); return (await offOp('cache', 'readonly', s => s.get(k))) || OFF.mem.get(k) || null; }
async function cacheGravar(p, corpo) { const k = offChave(p), v = { t: new Date().toISOString(), corpo }; OFF.mem.set(k, v); await offOp('cache', 'readwrite', s => s.put(v, k)); }
async function cacheEditar(p, fn) {
  const v = await cacheLer(p);
  if (!v) return;
  try { const j = JSON.parse(v.corpo); const novo = fn(j); await cacheGravar(p, JSON.stringify(novo === undefined ? j : novo)); } catch { /* cópia inválida */ }
}
async function filaCarregar() { OFF.fila = ((await offOp('fila', 'readonly', s => s.getAll())) || OFF.fila).sort((a, b) => a.id - b.id); return OFF.fila; }
async function filaGravar(it) { OFF.fila = [...OFF.fila.filter(x => x.id !== it.id), it].sort((a, b) => a.id - b.id); await offOp('fila', 'readwrite', s => s.put(it)); }
async function filaRemover(id) { OFF.fila = OFF.fila.filter(x => x.id !== id); await offOp('fila', 'readwrite', s => s.delete(id)); }
const offTemDados = async () => !!(await cacheLer('api/receb-selbs') || await cacheLer('api/monitor'));

// ---------------------------------------------------------------- respostas
const respJson = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...extra } });
const ehRede = e => e && (e.name === 'TypeError' || e.name === 'AbortError' || e.name === 'TimeoutError');
function marcarOffline() {
  if (OFF.online) { OFF.online = false; OFF.desde = new Date().toISOString(); }
  desenharBarraOffline(); agendarTentativa();
}
function marcarOnline() {
  const voltou = !OFF.online;
  OFF.online = true; OFF.desde = null;
  desenharBarraOffline();
  if (voltou || OFF.fila.some(x => !x.erro)) sincronizarFila();
}

// api() da Central diag passa por aqui: rede normal; sem servidor, cópia guardada (leituras) ou fila (alterações)
async function apiOffline(path, opts = {}) {
  const metodo = (opts.method || 'GET').toUpperCase(), k = offChave(path);
  const guarda = metodo === 'GET' && OFF_GET.some(re => re.test(k));
  const enfileira = OFF_FILA.some(([re, ms]) => re.test(k) && ms.includes(metodo));
  // já sabidamente offline: não espera o tempo todo da rede
  const sinal = !OFF.online && !opts.signal && (guarda || enfileira) ? AbortSignal.timeout(4000) : opts.signal;
  let r;
  try {
    r = await apiRede(path, sinal ? { ...opts, signal: sinal } : opts);
  } catch (e) {
    if (!ehRede(e)) throw e;
    marcarOffline();
    if (guarda) { const c = await cacheLer(k); if (c) return new Response(c.corpo, { status: 200, headers: { 'Content-Type': 'application/json', 'X-Offline': c.t } }); }
    if (enfileira) return enfileirar(k, metodo, opts.body);
    if (guarda || metodo !== 'GET') return respJson({ erro: 'Sem conexão com o servidor (offline).' }, 503, { 'X-Offline': '1' });
    throw e;
  }
  // proxy/servidor fora: trata como offline só para o que tem cópia ou fila
  if ([502, 503, 504].includes(r.status) && (guarda || enfileira)) {
    marcarOffline();
    if (guarda) { const c = await cacheLer(k); if (c) return new Response(c.corpo, { status: 200, headers: { 'Content-Type': 'application/json', 'X-Offline': c.t } }); }
    if (enfileira) return enfileirar(k, metodo, opts.body);
    return r;
  }
  if (!OFF.online || r.ok) marcarOnline();
  if (guarda && r.ok) {
    const corpo = await r.clone().text();
    // com alterações ainda na fila, a cópia guardada mantém o que foi feito offline
    await cacheGravar(k, corpo);
    if (OFF.fila.some(x => !x.erro)) for (const it of OFF.fila.filter(x => !x.erro)) await aplicarLocal(it, k);
    if (OFF.fila.some(x => !x.erro)) { const c = await cacheLer(k); return new Response(c.corpo, { status: 200, headers: { 'Content-Type': 'application/json' } }); }
  }
  return r;
}

// ---------------------------------------------------------------- fila de alterações
function descreverAlteracao(k, metodo, corpo) {
  const sel = decodeURIComponent((k.match(/^api\/receb-selbs\/([^/?]+)/) || [])[1] || '');
  if (sel) return metodo === 'DELETE' ? `Excluir o cadastro do SELB ${sel}` : `Cadastro do SELB ${sel}${corpo && corpo.local ? ` (local ${corpo.local})` : ''}`;
  if (k === 'api/recebimentos/manual') return `Entrega manual${corpo ? ` · ${corpo.local || ''} · ${corpo.selb || ''}${corpo.assinatura ? ' · assinada' : ''}${corpo.fotos && corpo.fotos.length ? ` · ${corpo.fotos.length} foto(s)` : ''}` : ''}`;
  if (k.startsWith('api/suprimentos/codigos')) return `Códigos do modelo ${(corpo && corpo.nome) || ''}`;
  if (k.startsWith('api/monitor/pausa')) {
    if (metodo === 'DELETE') { const alvo = decodeURIComponent((k.match(/alvo=([^&]+)/) || [])[1] || ''); return alvo === 'todos' ? 'Retomar o monitoramento' : `Retomar ${alvo}`; }
    return corpo && corpo.alvo === 'todos' ? 'Pausar o monitoramento' : `Pausar ${corpo && corpo.alvo}`;
  }
  return `${metodo} ${k}`;
}
async function enfileirar(k, metodo, bodyTxt) {
  let corpo = null;
  try { corpo = bodyTxt ? JSON.parse(bodyTxt) : null; } catch { corpo = null; }
  // mesmas regras do servidor, para não deixar passar o que ele vai recusar
  const sel = decodeURIComponent((k.match(/^api\/receb-selbs\/([^/?]+)$/) || [])[1] || '');
  if (sel && metodo === 'PUT') {
    const c = await cacheLer('api/receb-selbs'), lista = c ? JSON.parse(c.corpo) : [];
    const ks = x => RecebOCR.normalizar(x).replace(/ /g, ''), atual = lista.find(x => ks(x.selb) === ks(sel));
    if (corpo && corpo.novo && atual) return respJson({ erro: `O SELB ${atual.selb} já tem cadastro. Abra o cadastro dele para alterar.` }, 409);
    const outro = corpo && corpo.ip && lista.find(x => x.ip === corpo.ip && ks(x.selb) !== ks(sel));
    if (outro && (!atual || atual.ip !== corpo.ip)) return respJson({ erro: `O IP ${corpo.ip} já é do SELB ${outro.selb}.` }, 409);
  }
  const it = { id: Date.now() * 1000 + Math.floor(Math.random() * 1000), quando: new Date().toISOString(), metodo, path: k, body: bodyTxt || null, desc: descreverAlteracao(k, metodo, corpo) };
  await filaGravar(it);
  for (const p of ['api/receb-selbs', 'api/monitor', 'api/suprimentos/codigos', 'api/recebimentos?linhas=1']) await aplicarLocal(it, p);
  desenharBarraOffline();
  if (sel && metodo === 'PUT') return respJson({ selb: sel.toUpperCase(), ...(corpo || {}), offline: true }, 200, { 'X-Offline-Fila': '1' });
  if (k === 'api/recebimentos/manual') return respJson({ id: 'pendente-' + ((corpo && corpo.idCliente) || it.id), offline: true }, 200, { 'X-Offline-Fila': '1' });
  return respJson({ ok: true, offline: true }, 200, { 'X-Offline-Fila': '1' });
}
// aplica uma alteração da fila na cópia guardada (para a tela já mostrar o que foi feito)
async function aplicarLocal(it, p) {
  let corpo = null;
  try { corpo = it.body ? JSON.parse(it.body) : null; } catch { /* sem corpo */ }
  const ks = x => RecebOCR.normalizar(x).replace(/ /g, '');
  const sel = decodeURIComponent((it.path.match(/^api\/receb-selbs\/([^/?]+)$/) || [])[1] || '');
  if (p === 'api/receb-selbs' && sel) await cacheEditar(p, lista => {
    const i = lista.findIndex(x => ks(x.selb) === ks(sel));
    if (it.metodo === 'DELETE') { if (i >= 0) lista.splice(i, 1); return lista; }
    const { novo, ...resto } = corpo || {};
    const reg = { ...(i >= 0 ? lista[i] : {}), ...resto, selb: i >= 0 ? lista[i].selb : sel.toUpperCase(), pendente: true };
    if (reg.cor === 'pb') reg.cores = ['preto'];
    if (i >= 0) lista[i] = reg; else lista.push(reg);
    return lista;
  });
  if (p === 'api/monitor' && it.path.startsWith('api/monitor/pausa')) await cacheEditar(p, D => {
    const alvo = it.metodo === 'DELETE' ? decodeURIComponent((it.path.match(/alvo=([^&]+)/) || [])[1] || '') : corpo && corpo.alvo;
    const pausa = it.metodo === 'DELETE' ? null : { ate: corpo && corpo.horas ? new Date(Date.parse(it.quando) + corpo.horas * 3600000).toISOString() : null, em: it.quando };
    if (alvo === 'todos') D.pausa = pausa;
    else for (const imp of D.impressoras || []) if (ks(imp.selb) === ks(alvo)) imp.pausada = pausa;
    return D;
  });
  // entrega manual feita offline: aparece na lista de entregas como "aguardando envio" (sem as imagens)
  if (p === 'api/recebimentos?linhas=1' && it.path === 'api/recebimentos/manual' && corpo) await cacheEditar(p, lista => {
    const id = 'pendente-' + (corpo.idCliente || it.id);
    if (lista.some(f => f.id === id)) return lista;
    const [a, m, d] = String(corpo.dataIso || '').split('-');
    const cfg = (typeof EM !== 'undefined' && EM.cfg) || { campos: [] };
    const campos = Object.fromEntries(Object.entries(corpo.campos || {}).filter(([, v]) => v).map(([k, v]) => [k, { rotulo: (cfg.campos.find(c => c.id === k) || {}).rotulo || k, valor: v === 'nao' ? 'não' : v }]));
    lista.unshift({ id, titulo: `Entrega manual · ${corpo.local}`, dataFolha: corpo.dataIso, criadoEm: it.quando, atualizadoEm: it.quando, revisao: 0, manual: { recebedor: corpo.recebedor, documento: corpo.documento, hora: corpo.hora, campos, termo: cfg.termo, feitaEm: corpo.feitaEm, fotos: [] }, pendente: true,
      total: 1, pendentes: 0, obs: corpo.obs, linhas: [{ n: 1, revisado: true, local: corpo.local, selb: corpo.selb, data: d ? `${d}/${m}/${a}` : '', dataIso: corpo.dataIso, nome: corpo.recebedor, itens: corpo.itens || [] }] });
    return lista;
  });
  if (p === 'api/suprimentos/codigos' && it.path.startsWith('api/suprimentos/codigos') && corpo) await cacheEditar(p, D => {
    const m = (D.modelos || []).find(x => x.chave === corpo.chave);
    if (m) for (const [item, cod] of Object.entries(corpo.codigos || {})) {
      if (cod) { m.manual[item] = cod; m.codigos[item] = { cod, origem: 'manual' }; }
      else { delete m.manual[item]; if (m.aprendido && m.aprendido[item]) m.codigos[item] = m.aprendido[item]; else delete m.codigos[item]; }
    }
    return D;
  });
}
// envia a fila na ordem; recusada pelo servidor (4xx) fica marcada com o motivo e não trava as outras
async function sincronizarFila() {
  if (OFF.sincronizando) return;
  OFF.sincronizando = true; desenharBarraOffline();
  let enviados = 0, parou = false;
  try {
    for (const it of [...(await filaCarregar())]) {
      if (it.erro) continue;
      let r;
      try { r = await apiRede(it.path, { method: it.metodo, headers: it.body ? { 'Content-Type': 'application/json' } : {}, body: it.body || undefined, signal: AbortSignal.timeout(15000) }); } catch { parou = true; break; }
      if (r.status >= 500 || r.status === 401) { parou = true; break; } // servidor fora ou sem token: tenta depois
      if (r.ok) { await filaRemover(it.id); enviados++; continue; }
      const j = await r.json().catch(() => ({}));
      await filaGravar({ ...it, erro: j.erro || `recusado (HTTP ${r.status})` });
    }
  } finally {
    OFF.sincronizando = false;
    if (parou) marcarOffline(); else { OFF.online = true; OFF.desde = null; }
    OFF.enviados += enviados;
    desenharBarraOffline();
  }
  // tudo enviado: recarrega a tela com os dados do servidor (menos em formulário aberto)
  if (enviados && !parou && !OFF.fila.some(x => !x.erro) && /^#receb(\/(selbs|impressoras|suprimentos))?$/.test(location.hash)) route();
}
let offTimer = null;
function agendarTentativa() {
  if (offTimer) return;
  offTimer = setInterval(async () => {
    if (OFF.online && !OFF.fila.some(x => !x.erro)) { clearInterval(offTimer); offTimer = null; return; }
    try { const r = await apiRede('api/info', { signal: AbortSignal.timeout(4000) }); if (r.ok) marcarOnline(); } catch { /* ainda offline */ }
  }, 20000);
}

// ---------------------------------------------------------------- barra de situação
function desenharBarraOffline() {
  let b = document.getElementById('offBarra');
  if (!b) { b = document.createElement('div'); b.id = 'offBarra'; b.className = 'off-barra'; b.setAttribute('role', 'status'); document.body.appendChild(b); }
  const pend = OFF.fila.filter(x => !x.erro), recus = OFF.fila.filter(x => x.erro);
  if (OFF.online && !OFF.fila.length) { b.hidden = true; b.classList.remove('aberta'); document.body.classList.remove('com-offbarra'); return; }
  b.hidden = false;
  document.body.classList.add('com-offbarra'); // a página ganha espaço embaixo: a barra não cobre botões
  const quando = iso => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const titulo = !OFF.online ? '<b>Sem conexão com o servidor</b> — impressoras, SELBs e suprimentos com a última cópia salva'
    : OFF.sincronizando ? `<b>Enviando ${pend.length} alteração(ões)…</b>` : pend.length ? `<b>${pend.length} alteração(ões) aguardando envio</b>` : `<b>${recus.length} alteração(ões) recusada(s) pelo servidor</b>`;
  b.className = `off-barra ${!OFF.online ? 'off' : recus.length && !pend.length ? 'erro' : 'sync'}${b.classList.contains('aberta') ? ' aberta' : ''}`;
  b.innerHTML = `<div class="off-cab"><span class="off-bola"></span><span>${titulo}${!OFF.online && pend.length ? ` · ${pend.length} alteração(ões) na fila` : ''}${recus.length && pend.length ? ` · ${recus.length} recusada(s)` : ''}</span>
      ${OFF.fila.length ? `<button type="button" class="linklike" id="offVer">${b.classList.contains('aberta') ? 'ocultar' : 'ver'}</button>` : ''}
      <button type="button" class="btn ghost small" id="offTentar" ${OFF.sincronizando ? 'disabled' : ''}>${OFF.online ? 'Enviar agora' : 'Tentar agora'}</button></div>
    ${OFF.fila.length ? `<ul class="off-lista">${OFF.fila.map(it => `<li class="${it.erro ? 'erro' : ''}"><span>${esc(it.desc)} <small>${quando(it.quando)}</small>${it.erro ? `<br><small class="off-motivo">${esc(it.erro)}</small>` : ''}</span>
      <button type="button" class="linklike" data-desc="${it.id}" title="Não enviar esta alteração">descartar</button></li>`).join('')}</ul>
      <p class="off-nota">As alterações são enviadas na ordem em que foram feitas assim que o servidor responder. Ping e leitura de tinta/toner só o servidor faz.</p>` : ''}`;
  b.querySelector('#offTentar').onclick = async () => {
    try { const r = await apiRede('api/info', { signal: AbortSignal.timeout(5000) }); if (r.ok) { OFF.online = true; OFF.desde = null; await sincronizarFila(); return; } } catch { /* segue offline */ }
    marcarOffline(); alert('O servidor ainda não respondeu. As alterações continuam guardadas.');
  };
  if (b.querySelector('#offVer')) b.querySelector('#offVer').onclick = () => { b.classList.toggle('aberta'); desenharBarraOffline(); };
  b.querySelectorAll('[data-desc]').forEach(x => x.onclick = async () => {
    const it = OFF.fila.find(y => String(y.id) === x.dataset.desc);
    if (!it || !confirm(`Descartar "${it.desc}"? A alteração não será enviada ao servidor.`)) return;
    await filaRemover(it.id);
    // a cópia guardada volta a valer quando o servidor responder (descartada só some da fila)
    desenharBarraOffline();
  });
}

// ---------------------------------------------------------------- início
(async () => {
  await filaCarregar();
  desenharBarraOffline();
  if (OFF.fila.some(x => !x.erro)) { agendarTentativa(); setTimeout(() => sincronizarFila(), 1500); }
  window.addEventListener('online', () => { setTimeout(() => sincronizarFila(), 1000); });
  window.addEventListener('offline', () => marcarOffline());
  // abrir a página sem servidor (só em HTTPS ou localhost: exigência dos navegadores para o service worker)
  if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();

'use strict';
/*
  Monitoramento das impressoras (SELBs com IP cadastrado).
  O servidor faz o ping a cada MONITOR_MIN minutos (padrão 5) e guarda o histórico; aqui:
  - tela inicial: painel vermelho com as impressoras fora do ar, linha verde se está tudo bem,
    ou aviso de monitoramento pausado;
  - menu lateral: contador vermelho em "Recebimentos";
  - Recebimentos › Impressoras: situação, disponibilidade, barra das últimas 24 h, pausa (geral ou por
    impressora), histórico de quedas e o detalhe de cada impressora (linha do tempo e latência);
  - aba SELBs: bolinha de situação ao lado do IP (situacaoHtml).
  A tela consulta o servidor a cada minuto. Depende de app.js (api, esc, IC) e de receb-cadastro.js (abasReceb).
*/
const MON = { dados: null, porIp: new Map(), timer: null, diasDet: 7 };

const haQuanto = iso => {
  if (!iso) return '';
  const min = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `há ${h} h${min % 60 ? ' ' + (min % 60) + ' min' : ''}`;
  return `há ${Math.floor(h / 24)} dias`;
};
const duracao = min => {
  if (min == null) return '—';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h${min % 60 ? ' ' + (min % 60) + ' min' : ''}`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
};
const dataHora = iso => { if (!iso) return '—'; const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const hora = iso => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const nomeImp = i => [i.marca, i.modelo].filter(Boolean).join(' ') || ({ impressora: 'Impressora', multifuncional: 'Multifuncional', scanner: 'Scanner' }[i.tipo] || 'Equipamento');
const ateTxt = p => p && p.ate ? `até ${dataHora(p.ate)}` : 'até retomar';
const pctTxt = v => v == null ? '—' : `${String(v).replace('.', ',')}%`;

// bolinha de situação (usada também na aba SELBs)
function situacaoHtml(ip) {
  const i = MON.porIp.get(ip);
  if (i && (i.pausada || (MON.dados && MON.dados.pausa))) return `<span class="mon-bola pausa" title="Monitoramento pausado ${ateTxt(i.pausada || MON.dados.pausa)}"></span>`;
  if (!i || i.online === null) return `<span class="mon-bola" title="Ainda não verificada"></span>`;
  return i.online
    ? `<span class="mon-bola on" title="Online${i.ms != null ? ` · ~${i.ms} ms` : ''} · verificada ${haQuanto(i.verificadoEm)}${i.via && i.via !== 'ping' ? ` (responde na ${i.via}, não ao ping)` : ''}"></span>`
    : `<span class="mon-bola off" title="Fora do ar ${haQuanto(i.desde)} · verificada ${haQuanto(i.verificadoEm)}"></span>`;
}

async function atualizarMonitor(verificarAgora = false) {
  let r;
  try { r = await api(verificarAgora ? 'api/monitor/verificar' : 'api/monitor', verificarAgora ? { method: 'POST' } : {}); } catch { return; }
  if (!r || !r.ok) { MON.dados = null; desenharMonitor(); return; }
  MON.dados = await r.json();
  MON.porIp = new Map(MON.dados.impressoras.map(i => [i.ip, i]));
  desenharMonitor();
}
async function pausar(alvo, horas) {
  const r = await api('api/monitor/pausa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alvo, horas }) }).catch(() => null);
  if (!r || !r.ok) return alert('Não foi possível pausar.');
  await atualizarMonitor();
}
async function retomar(alvo) {
  const r = await api('api/monitor/pausa?alvo=' + encodeURIComponent(alvo), { method: 'DELETE' }).catch(() => null);
  if (!r || !r.ok) return alert('Não foi possível retomar.');
  await new Promise(ok => setTimeout(ok, 1500)); // o servidor verifica logo ao retomar
  await atualizarMonitor();
}
// menu "Pausar…" (1 h, 8 h, 24 h, até retomar)
const menuPausa = (alvo, rotulo = 'Pausar') => `<details class="menu-acoes"><summary class="btn ghost small">${IC('relogio')}${rotulo}</summary><div>
  ${[[1, 'Por 1 hora'], [8, 'Por 8 horas'], [24, 'Por 24 horas'], [null, 'Até eu retomar']].map(([h, t]) => `<button class="btn ghost small" data-pausar="${esc(alvo)}" data-horas="${h ?? ''}">${t}</button>`).join('')}</div></details>`;
function ligarPausa(raiz, depois) {
  raiz.querySelectorAll('[data-pausar]').forEach(b => b.addEventListener('click', async () => {
    await pausar(b.dataset.pausar, b.dataset.horas ? +b.dataset.horas : null); depois();
  }));
  raiz.querySelectorAll('[data-retomar]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true; await retomar(b.dataset.retomar); depois();
  }));
}

// ================================================================== tela inicial + contador do menu
function desenharMonitor() {
  const box = document.getElementById('impStatus'), badge = document.getElementById('sideImp');
  const D = MON.dados, imps = D ? D.impressoras : [];
  const ativas = imps.filter(i => !i.pausada);
  const fora = D && D.pausa ? [] : ativas.filter(i => i.online === false).sort((a, b) => String(a.desde).localeCompare(String(b.desde)));
  const on = ativas.filter(i => i.online === true).length, pausadas = imps.length - ativas.length;
  if (badge) { badge.hidden = !fora.length; badge.textContent = fora.length; badge.title = `${fora.length} impressora(s) fora do ar`; }
  if (!box) return;
  if (!D || !imps.length) { box.hidden = true; return; }
  box.hidden = false;
  const rodape = `Ping a cada ${D.intervaloMin} min${D.rodada ? ` · última verificação ${haQuanto(D.rodada)}` : ' · primeira verificação em andamento'}${pausadas ? ` · ${pausadas} pausada(s)` : ''}${D.ping === 'indisponivel' ? ' · sem ping no servidor: verificando pelas portas da impressora' : ''}`;
  const botoes = `<button class="btn ghost small" id="monVerificar">${IC('raio')}Verificar agora</button><a class="btn ghost small" href="#receb/impressoras">${IC('grafico')}Histórico</a>`;
  if (D.pausa) {
    box.className = 'panel imp-status pausa';
    box.innerHTML = `<div class="imp-linha"><span class="imp-ic pausa">${IC('relogio')}</span>
      <div><b>Monitoramento das impressoras pausado ${ateTxt(D.pausa)}</b><br><small>Pausado ${haQuanto(D.pausa.em)} · ${imps.length} impressora(s) com IP</small></div>
      <div class="imp-acoes"><button class="btn small" data-retomar="todos">Retomar agora</button><a class="btn ghost small" href="#receb/impressoras">${IC('grafico')}Histórico</a></div></div>`;
  } else if (!fora.length) {
    box.className = 'panel imp-status ok';
    box.innerHTML = `<div class="imp-linha"><span class="imp-ic ok">${IC('impressora')}</span>
      <div><b>${on === ativas.length ? `Todas as ${ativas.length} impressoras estão online` : `${on} de ${ativas.length} impressoras online`}</b><br><small>${rodape}</small></div>
      <div class="imp-acoes">${botoes}</div></div>`;
  } else {
    box.className = 'panel imp-status alerta';
    box.innerHTML = `<div class="imp-linha"><span class="imp-ic bad">${IC('alerta')}</span>
      <div><b>${fora.length === 1 ? '1 impressora fora do ar' : `${fora.length} impressoras fora do ar`}</b><br><small>${on} online de ${ativas.length} · ${rodape}</small></div>
      <div class="imp-acoes">${botoes}</div></div>
      <div class="imp-lista">${fora.map(i => `<div class="imp-item"><span class="mon-bola off"></span>
        <div><b>${esc(i.selb)}</b> <span class="muted">${esc(nomeImp(i))}</span><br><small>${i.local ? esc(i.local) + ' · ' : ''}fora do ar ${haQuanto(i.desde)}</small></div>
        <a class="ip-link" href="http://${esc(i.ip)}" target="_blank" rel="noopener" title="Abrir o painel da impressora">${IC('monitor')}${esc(i.ip)}</a></div>`).join('')}</div>`;
  }
  const b = document.getElementById('monVerificar');
  if (b) b.addEventListener('click', async () => { b.disabled = true; b.innerHTML = `${IC('relogio')}Verificando…`; await atualizarMonitor(true); });
  ligarPausa(box, () => {});
}

// ================================================================== Recebimentos › Impressoras
// barra das últimas 24 h: 48 faixas de 30 min (verde = online, âmbar = parcial, vermelho = fora, cinza = sem dados/pausada)
function barra24h(faixas) {
  const agora = Date.now();
  return `<div class="mon-barra" role="img" aria-label="Disponibilidade nas últimas 24 horas">${faixas.map((v, k) => {
    const ini = new Date(agora - (48 - k) * 1800000), cls = v == null ? 'nd' : v >= 1 ? 'on' : v <= 0 ? 'off' : 'parc';
    const txt = v == null ? 'sem dados' : v >= 1 ? 'online' : v <= 0 ? 'fora do ar' : `${Math.round(v * 100)}% online`;
    return `<i class="${cls}" title="${hora(ini.toISOString())}–${hora(new Date(+ini + 1800000).toISOString())} · ${txt}"></i>`;
  }).join('')}</div>`;
}
const legendaStatus = () => `<div class="mon-legenda"><span><i class="on"></i>online</span><span><i class="parc"></i>parcial</span><span><i class="off"></i>fora do ar</span><span><i class="nd"></i>sem dados / pausada</span></div>`;

async function renderImpressoras(arg = '') {
  const el = $('#mod-receb');
  if (arg) return renderImpressora(arg);
  el.innerHTML = abasReceb('impressoras') + '<div class="panel">Carregando...</div>';
  if (!(await needServer(el))) return;
  await atualizarMonitor();
  const D = MON.dados;
  const rq = await api('api/monitor/quedas?dias=30').catch(() => null);
  const quedas = rq && rq.ok ? (await rq.json()).quedas : [];
  if (!D) { el.innerHTML = abasReceb('impressoras') + '<div class="panel"><p class="err">Não foi possível carregar o monitoramento.</p></div>'; return; }
  const imps = [...D.impressoras].sort((a, b) => (a.online === false && !a.pausada ? 0 : 1) - (b.online === false && !b.pausada ? 0 : 1) || a.selb.localeCompare(b.selb, 'pt-BR', { numeric: true }));
  const ativas = imps.filter(i => !i.pausada);
  const fora = D.pausa ? 0 : ativas.filter(i => i.online === false).length;
  const d7 = ativas.filter(i => i.d7 != null), media7 = d7.length ? Math.round(d7.reduce((a, i) => a + i.d7, 0) / d7.length * 10) / 10 : null;
  el.innerHTML = abasReceb('impressoras') + `
    <div class="panel">
      <div class="head-row"><h2>Monitoramento das impressoras</h2><div class="filters" style="margin:0">
        ${D.pausa ? `<span class="badge warn">pausado ${esc(ateTxt(D.pausa))}</span><button class="btn small" data-retomar="todos">Retomar</button>` : menuPausa('todos', 'Pausar monitoramento')}
        <button class="btn ghost small" id="impVerificar">${IC('raio')}Verificar agora</button></div></div>
      <div class="stats">
        ${statHtml(ativas.length - fora, 'online', 'check', 'ok')}
        ${statHtml(fora, 'fora do ar', 'alerta', fora ? 'bad' : '')}
        ${statHtml(imps.length - ativas.length, 'pausadas', 'relogio', '')}
        ${statHtml(pctTxt(media7), 'disponibilidade média em 7 dias', 'grafico', 'violeta')}
      </div>
      <p class="muted">Ping com o menor pacote possível a cada ${D.intervaloMin} min; histórico de ${D.dias} dias. ${D.rodada ? `Última verificação ${haQuanto(D.rodada)}.` : ''}
        Só entram SELBs com IP no cadastro (aba SELBs).</p>
      ${!imps.length ? vazioHtml('impressora', 'Nenhuma impressora com IP', 'Cadastre o IP das impressoras na aba SELBs para monitorar.') : `
      ${legendaStatus()}
      <div class="tablewrap"><table class="clickable"><thead><tr><th class="nosort">Impressora</th><th class="nosort">Situação</th><th class="nosort">Últimas 24 h</th><th class="nosort">24 h</th><th class="nosort">7 dias</th><th class="nosort">Quedas (7 d)</th><th class="nosort"></th></tr></thead><tbody>
      ${imps.map(i => `<tr data-imp="${esc(i.selb)}">
        <td><b>${esc(i.selb)}</b> <span class="muted">${esc(nomeImp(i))}</span><br><small>${i.local ? esc(i.local) + ' · ' : ''}<a class="ip-link" href="http://${esc(i.ip)}" target="_blank" rel="noopener">${esc(i.ip)}</a></small></td>
        <td>${i.pausada || D.pausa ? `<span class="badge">pausada ${esc(ateTxt(i.pausada || D.pausa))}</span>`
          : i.online === null ? '<span class="badge">aguardando</span>' : i.online ? `<span class="badge ok">online</span><br><small>${i.ms != null ? `~${i.ms} ms · ` : ''}${haQuanto(i.verificadoEm)}</small>`
          : `<span class="badge bad">fora do ar</span><br><small>${haQuanto(i.desde)}</small>`}</td>
        <td>${barra24h(i.faixas)}</td>
        <td class="t">${pctTxt(i.d24)}</td><td class="t">${pctTxt(i.d7)}</td><td>${i.quedas7 || 0}</td>
        <td class="acoes">${i.pausada ? `<button class="btn ghost small" data-retomar="${esc(i.selb)}">Retomar</button>` : menuPausa(i.selb)}</td></tr>`).join('')}
      </tbody></table></div>`}
    </div>
    <div class="panel">
      <div class="head-row"><h2>Histórico de quedas (30 dias)</h2></div>
      ${!quedas.length ? vazioHtml('check', 'Nenhuma queda nos últimos 30 dias', '') : `
      <div class="tablewrap"><table class="clickable"><thead><tr><th class="nosort">Impressora</th><th class="nosort">Caiu em</th><th class="nosort">Voltou em</th><th class="nosort">Tempo fora</th></tr></thead><tbody>
      ${quedas.map(q => `<tr data-imp="${esc(String(q.selb).split(', ')[0])}"><td><b>${esc(q.selb)}</b><br><small class="mono">${esc(q.ip)}</small></td>
        <td class="t">${dataHora(q.inicio)}</td><td class="t">${q.fim ? dataHora(q.fim) : '<span class="badge bad">fora do ar agora</span>'}</td>
        <td>${q.fim ? duracao(q.min) : duracao(Math.round((Date.now() - Date.parse(q.inicio)) / 60000)) + ' (em andamento)'}</td></tr>`).join('')}
      </tbody></table></div>`}
    </div>`;
  el.querySelectorAll('tr[data-imp]').forEach(tr => tr.addEventListener('click', e => {
    if (e.target.closest('a, button, details')) return;
    location.hash = 'receb/impressoras~' + encodeURIComponent(tr.dataset.imp);
  }));
  $('#impVerificar').addEventListener('click', async e => { e.target.disabled = true; e.target.textContent = 'Verificando…'; await atualizarMonitor(true); renderImpressoras(); });
  ligarPausa(el, () => renderImpressoras());
}

// ---------------------------------------------------------------- detalhe de uma impressora
async function renderImpressora(selb) {
  const el = $('#mod-receb');
  el.innerHTML = abasReceb('impressoras') + '<div class="panel">Carregando...</div>';
  if (!(await needServer(el))) return;
  if (!MON.dados) await atualizarMonitor();
  const i = MON.dados && MON.dados.impressoras.find(x => RecebOCR.chaveSelb(x.selb) === RecebOCR.chaveSelb(selb));
  const dias = MON.diasDet;
  const r = await api(`api/monitor/historico?selb=${encodeURIComponent(selb)}&dias=${dias}`).catch(() => null);
  const H = r && r.ok ? await r.json() : { pings: [], quedas: [], intervaloMin: 5 };
  const pings = H.pings, on = pings.filter(p => p.on).length;
  const ms = pings.filter(p => p.on && p.ms != null).map(p => p.ms);
  const foraMin = H.quedas.reduce((a, q) => a + (q.fim ? q.min : Math.round((Date.now() - Date.parse(q.inicio)) / 60000)), 0);
  el.innerHTML = abasReceb('impressoras') + `
    <div class="panel ld-bar"><div><a href="#receb/impressoras" class="btn small ghost">← Impressoras</a>
        <b class="ld-title">${esc(selb)}</b><small>${i ? esc(nomeImp(i)) + (i.local ? ' · ' + esc(i.local) : '') : ''}</small>
        ${i ? `<a class="ip-link" href="http://${esc(i.ip)}" target="_blank" rel="noopener">${situacaoHtml(i.ip)}${esc(i.ip)}</a>` : ''}</div>
      <div class="filters" style="margin:0">
        <div class="seg2">${[[1, '24 h'], [7, '7 dias'], [30, '30 dias']].map(([d, t]) => `<label class="seg-op"><input type="radio" name="impDias" value="${d}" ${d === dias ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div>
        ${i && i.pausada ? `<button class="btn small" data-retomar="${esc(selb)}">Retomar</button>` : menuPausa(selb)}</div></div>
    <div class="stats">
      ${statHtml(pctTxt(pings.length ? Math.round(on / pings.length * 1000) / 10 : null), `disponibilidade (${dias === 1 ? '24 h' : dias + ' dias'})`, 'grafico', 'ok')}
      ${statHtml(H.quedas.length, 'quedas no período', 'alerta', H.quedas.length ? 'bad' : '')}
      ${statHtml(duracao(foraMin), 'tempo fora do ar', 'relogio', '')}
      ${statHtml(ms.length ? '~' + Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) + ' ms' : '—', 'latência média', 'raio', 'violeta')}
    </div>
    <div class="panel"><div class="head-row"><h2>Linha do tempo</h2><small class="muted">faixas de 15 min · ${pings.length} verificações</small></div>
      ${pings.length ? linhaDoTempo(pings, dias) + legendaStatus() : vazioHtml('grafico', 'Sem verificações no período', 'O histórico começa a partir do cadastro do IP.')}</div>
    <div class="panel"><div class="head-row"><h2>Latência (últimas 24 h)</h2><small class="muted">aproximada: o ping usa pacote mínimo, sem carimbo de tempo</small></div>
      <div id="impLat">${graficoLatencia(pings.filter(p => Date.now() - Date.parse(p.t) <= 86400000))}</div></div>
    <div class="panel"><div class="head-row"><h2>Quedas no período</h2></div>
      ${!H.quedas.length ? vazioHtml('check', 'Nenhuma queda no período', '') : `<div class="tablewrap"><table><thead><tr><th class="nosort">Caiu em</th><th class="nosort">Voltou em</th><th class="nosort">Tempo fora</th></tr></thead><tbody>
      ${H.quedas.map(q => `<tr><td class="t">${dataHora(q.inicio)}</td><td class="t">${q.fim ? dataHora(q.fim) : '<span class="badge bad">fora do ar agora</span>'}</td>
        <td>${q.fim ? duracao(q.min) : duracao(Math.round((Date.now() - Date.parse(q.inicio)) / 60000)) + ' (em andamento)'}</td></tr>`).join('')}</tbody></table></div>`}</div>`;
  el.querySelectorAll('input[name="impDias"]').forEach(rd => rd.addEventListener('change', () => { MON.diasDet = +rd.value; renderImpressora(selb); }));
  ligarPausa(el, () => renderImpressora(selb));
  ligarLatencia($('#impLat'));
}

// linha do tempo: um dia por linha, 96 faixas de 15 min
function linhaDoTempo(pings, dias) {
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const linhas = [];
  for (let d = dias - 1; d >= 0; d--) {
    const ini = +hoje - d * 86400000, faixas = Array.from({ length: 96 }, () => [0, 0]);
    for (const p of pings) {
      const t = Date.parse(p.t) - ini;
      if (t < 0 || t >= 86400000) continue;
      const f = Math.floor(t / 900000); faixas[f][1]++; if (p.on) faixas[f][0]++;
    }
    const dia = new Date(ini);
    linhas.push(`<div class="mon-dia"><span class="t">${String(dia.getDate()).padStart(2, '0')}/${String(dia.getMonth() + 1).padStart(2, '0')}</span><div class="mon-barra fina">${faixas.map(([o, n], k) => {
      const cls = !n ? 'nd' : o === n ? 'on' : o === 0 ? 'off' : 'parc', h0 = `${String(Math.floor(k / 4)).padStart(2, '0')}:${String(k % 4 * 15).padStart(2, '0')}`;
      return `<i class="${cls}" title="${h0} · ${!n ? 'sem dados' : o === n ? 'online' : o === 0 ? 'fora do ar' : `${o} de ${n} verificações online`}"></i>`;
    }).join('')}</div></div>`);
  }
  return `<div class="mon-tempo">${linhas.join('')}<div class="mon-dia eixo"><span></span><div>${['00h', '06h', '12h', '18h', '24h'].map(h => `<span>${h}</span>`).join('')}</div></div></div>`;
}

// gráfico de latência (SVG, uma série, linha de 2 px) com cursor e dica ao passar o mouse
function graficoLatencia(pts) {
  const p = pts.filter(x => x.on && x.ms != null);
  if (p.length < 2) return vazioHtml('raio', 'Sem medições suficientes', 'A latência aparece depois de algumas verificações por ping.');
  const W = 900, Hh = 200, m = { l: 44, r: 12, t: 12, b: 26 };
  const t0 = Date.now() - 86400000, t1 = Date.now();
  const max = Math.max(5, ...p.map(x => x.ms)), topo = Math.ceil(max / 5) * 5;
  const X = t => m.l + (t - t0) / (t1 - t0) * (W - m.l - m.r), Y = v => Hh - m.b - v / topo * (Hh - m.t - m.b);
  const caminho = p.map((x, k) => `${k ? 'L' : 'M'}${X(Date.parse(x.t)).toFixed(1)},${Y(x.ms).toFixed(1)}`).join('');
  const grade = [0, topo / 2, topo].map(v => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" class="g"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v} ms</text>`).join('');
  const marcas = [0, 6, 12, 18, 24].map(h => { const t = t0 + h * 3600000; return `<text x="${X(t)}" y="${Hh - 6}" text-anchor="middle">${hora(new Date(t).toISOString())}</text>`; }).join('');
  return `<div class="mon-lat" data-pts='${JSON.stringify(p.map(x => [Date.parse(x.t), x.ms]))}' data-t0="${t0}" data-t1="${t1}" data-topo="${topo}">
    <svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Latência nas últimas 24 horas">${grade}${marcas}
      <path d="${caminho}" class="linha"/><line class="cursor" y1="${m.t}" y2="${Hh - m.b}" x1="-10" x2="-10"/><circle class="ponto" r="4" cx="-10" cy="-10"/></svg>
    <div class="mon-dica" hidden></div></div>`;
}
function ligarLatencia(box) {
  const g = box && box.querySelector('.mon-lat');
  if (!g) return;
  const pts = JSON.parse(g.dataset.pts), t0 = +g.dataset.t0, t1 = +g.dataset.t1, topo = +g.dataset.topo;
  const svg = g.querySelector('svg'), cur = g.querySelector('.cursor'), pt = g.querySelector('.ponto'), dica = g.querySelector('.mon-dica');
  const W = 900, Hh = 200, m = { l: 44, r: 12, t: 12, b: 26 };
  svg.addEventListener('mousemove', e => {
    const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * W;
    const t = t0 + (x - m.l) / (W - m.l - m.r) * (t1 - t0);
    let mais = pts[0]; for (const q of pts) if (Math.abs(q[0] - t) < Math.abs(mais[0] - t)) mais = q;
    const px = m.l + (mais[0] - t0) / (t1 - t0) * (W - m.l - m.r), py = Hh - m.b - mais[1] / topo * (Hh - m.t - m.b);
    cur.setAttribute('x1', px); cur.setAttribute('x2', px); pt.setAttribute('cx', px); pt.setAttribute('cy', py);
    dica.hidden = false; dica.innerHTML = `<b>~${mais[1]} ms</b><br>${hora(new Date(mais[0]).toISOString())}`;
    dica.style.left = `${px / W * 100}%`; dica.style.top = `${py / Hh * 100}%`;
  });
  svg.addEventListener('mouseleave', () => { dica.hidden = true; cur.setAttribute('x1', -10); cur.setAttribute('x2', -10); pt.setAttribute('cx', -10); });
}

function iniciarMonitor() {
  if (location.protocol === 'file:') return;
  atualizarMonitor();
  clearInterval(MON.timer);
  MON.timer = setInterval(() => { if (!document.hidden) atualizarMonitor(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) atualizarMonitor(); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciarMonitor); else iniciarMonitor();

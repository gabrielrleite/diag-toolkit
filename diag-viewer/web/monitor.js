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
// níveis de tinta/toner/caixa lidos por SNMP (GET /api/suprimentos)
const SUP = { dados: null };

// ---------------------------------------------------------------- suprimentos: barras nas cores reais
const SUP_NOME = { preto: 'Preto', azul: 'Azul', magenta: 'Magenta', amarelo: 'Amarelo', caixa: 'Caixa' };
const SUP_ALERTA = ['baixo', 'vazio'];
const LIMITE_SUP = 25;
// caixa de manutenção: o nível é a vida útil (100% = nova, 0% = trocar)
function valorSup(i) {
  if (i.pct != null) return i.item === 'caixa' ? `${i.pct}% de vida útil` : `${i.pct}%`;
  return { tem: i.item === 'caixa' ? 'com espaço' : 'há suprimento', desconhecido: 'não informado', 'sem limite': '—' }[i.estado] || '—';
}
const rotuloEstado = i => i.item === 'caixa' ? (i.estado === 'vazio' ? 'trocar' : 'trocar em breve') : i.estado;
const nomeSup = i => i.item === 'outro' ? i.desc || i.tipoTxt || 'Outro' : SUP_NOME[i.item];
// código do cartucho: o que a impressora informa ou, na falta, o anotado na observação do SELB
// "ref" é o SELB ou o próprio cadastro ({ obs, cor, tipo, suprimento }), p.ex. o formulário ainda não salvo
function cadDe(ref) {
  if (ref && typeof ref === 'object') return ref;
  try { return ref && typeof cadSelb === 'function' ? cadSelb(ref) : null; } catch { return null; }
}
function codigoSup(i, ref) {
  if (i.codigo) return { cod: i.codigo, cad: false };
  const c = cadDe(ref);
  const cod = c && c.obs && i.item !== 'outro' ? RecebOCR.codigosObs(c.obs, c.cor === 'pb')[i.item] : '';
  return cod ? { cod, cad: true } : null;
}
const semCaixa = (itens, ref) => !itens.some(i => i.item === 'caixa') && (typeof usaCaixa !== 'function' || usaCaixa(cadDe(ref)));
// lista completa (cadastro, detalhe): uma barra por suprimento
function suprimentosHtml(itens, selb = '') {
  if (!itens || !itens.length) return '<p class="muted">A impressora não informou suprimentos.</p>';
  const ordem = ['preto', 'azul', 'magenta', 'amarelo', 'caixa', 'outro'];
  return `<div class="sup-lista">${[...itens].sort((a, b) => ordem.indexOf(a.item) - ordem.indexOf(b.item)).map(i => {
    const cd = codigoSup(i, selb);
    return `
    <div class="sup-linha est-${esc(i.estado.replace(' ', '-'))}" title="${esc(i.desc)}${i.tipoTxt ? ' · ' + esc(i.tipoTxt) : ''}">
      <span class="sup-nome"><span class="it-bola it-${i.item === 'outro' ? 'nd' : i.item}">${i.item === 'caixa' ? IC('caixa') : ''}</span>${esc(nomeSup(i))}${cd ? ` <small class="mono sup-cod" title="${cd.cad ? 'código anotado no cadastro do SELB' : 'código informado pela impressora'}">${esc(cd.cod)}${cd.cad ? ' *' : ''}</small>` : ''}</span>
      <span class="sup-trilho"><span class="sup-fill it-${i.item}" style="width:${i.pct ?? (i.estado === 'tem' ? 100 : 0)}%"></span></span>
      <span class="sup-val">${esc(valorSup(i))}${SUP_ALERTA.includes(i.estado) ? ` <span class="badge ${i.estado === 'vazio' ? 'bad' : 'warn'}">${esc(rotuloEstado(i))}</span>` : ''}</span>
    </div>`;
  }).join('')}${semCaixa(itens, selb) ? `
    <div class="sup-linha est-desconhecido" title="A impressora não lista a caixa de manutenção entre os suprimentos (SNMP). Alguns modelos só mostram na própria tela ou na interface web.">
      <span class="sup-nome"><span class="it-bola it-caixa">${IC('caixa')}</span>Caixa</span>
      <span class="sup-trilho"></span><span class="sup-val muted">não informada pela impressora</span></div>` : ''}</div>
    ${itens.some(i => codigoSup(i, selb)?.cad) ? '<p class="muted"><small>* código anotado na observação do SELB (a impressora não informou).</small></p>' : ''}`;
}
// versão compacta (tabela de impressoras): só tintas/toners e caixa
function suprimentosMini(s, selb = '') {
  if (!s) return '<span class="muted">—</span>';
  if (!s.ok) return `<span class="badge" title="${esc(s.erro || '')}">sem leitura</span>`;
  const it = s.itens.filter(i => i.item !== 'outro');
  if (!it.length) return '<span class="muted">—</span>';
  return `<div class="sup-mini">${it.map(i => { const cd = codigoSup(i, selb); return `<span class="sup-m est-${esc(i.estado.replace(' ', '-'))}" title="${esc(nomeSup(i))}${cd ? ' ' + esc(cd.cod) : ''}: ${esc(valorSup(i))}">
    <span class="sup-trilho"><span class="sup-fill it-${i.item}" style="width:${i.pct ?? (i.estado === 'tem' ? 100 : 0)}%"></span></span><small>${i.pct != null ? i.pct + '%' : '·'}</small></span>`; }).join('')}${semCaixa(it, selb) ? '<span class="sup-m est-desconhecido" title="Caixa de manutenção: não informada pela impressora"><span class="sup-trilho"></span><small>cx ?</small></span>' : ''}</div>`;
}
const supDe = selb => SUP.dados && SUP.dados.selbs[RecebOCR.chaveSelb(selb)];
const alertasSup = s => s && s.ok ? s.itens.filter(i => i.item !== 'outro' && SUP_ALERTA.includes(i.estado)) : [];
async function lerSuprimentosAgora(selb = '') {
  const r = await api('api/suprimentos/ler', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selb }) }).catch(() => null);
  if (r && r.ok) SUP.dados = await r.json();
}

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
// local com o principal, quando é sala/sublocal: "Escola X › Sala 3"
const localImp = i => i.local && i.localPrincipal ? `${i.localPrincipal} › ${i.local}` : i.local || '';
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
  const rs = await api('api/suprimentos').catch(() => null);
  if (rs && rs.ok) SUP.dados = await rs.json();
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
        <div><b>${esc(i.selb)}</b> <span class="muted">${esc(nomeImp(i))}</span><br><small>${i.local ? esc(localImp(i)) + ' · ' : ''}fora do ar ${haQuanto(i.desde)}</small></div>
        <a class="ip-link" href="http://${esc(i.ip)}" target="_blank" rel="noopener" title="Abrir o painel da impressora">${IC('monitor')}${esc(i.ip)}</a></div>`).join('')}</div>`;
  }
  const b = document.getElementById('monVerificar');
  if (b) b.addEventListener('click', async () => { b.disabled = true; b.innerHTML = `${IC('relogio')}Verificando…`; await atualizarMonitor(true); });
  ligarPausa(box, () => {});
  desenharSuprStatus();
}

// tela inicial: tinta/toner ou vida útil da caixa de manutenção baixa
function desenharSuprStatus() {
  const box = document.getElementById('suprStatus');
  if (!box) return;
  const imps = (MON.dados && !MON.dados.pausa ? MON.dados.impressoras : []).filter(i => !i.pausada);
  const com = imps.map(i => ({ i, a: alertasSup(supDe(i.selb)) })).filter(x => x.a.length)
    .sort((x, y) => Math.min(...x.a.map(z => z.pct ?? 0)) - Math.min(...y.a.map(z => z.pct ?? 0)));
  if (!com.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="imp-linha"><span class="imp-ic warn">${IC('caixa')}</span>
    <div><b>${com.length === 1 ? '1 impressora com suprimento baixo' : `${com.length} impressoras com suprimento baixo`}</b><br><small>Tinta/toner ou vida útil da caixa de manutenção com ${LIMITE_SUP}% ou menos · leitura a cada ${SUP.dados.horas} h${SUP.dados.rodada ? `, última ${haQuanto(SUP.dados.rodada)}` : ''}</small></div>
    <div class="imp-acoes"><a class="btn ghost small" href="#receb/suprimentos">${IC('caixa')}Ver suprimentos</a></div></div>
    <div class="imp-lista">${com.map(({ i, a }) => `<div class="imp-item sup">
      <div><b>${esc(i.selb)}</b> <span class="muted">${esc(nomeImp(i))}</span>${i.local ? `<br><small>${esc(localImp(i))}</small>` : ''}</div>
      <div class="sup-tags">${a.map(z => `<span class="sup-tag ${z.estado === 'vazio' ? 'bad' : 'warn'}"><span class="it-bola it-${z.item}">${z.item === 'caixa' ? IC('caixa') : ''}</span>${esc(SUP_NOME[z.item])} ${esc(valorSup(z))}</span>`).join('')}</div></div>`).join('')}</div>`;
}

// ================================================================== Recebimentos › Suprimentos (resumo de todas)
const SR = { q: '', filtro: 'todas', ordem: 'nivel', cat: '' };
const ORDEM_SUP = ['preto', 'azul', 'magenta', 'amarelo', 'caixa'];
// menor nível entre tintas/toners e caixa (para ordenar; sem leitura vai para o fim)
const menorNivel = s => s && s.ok ? Math.min(101, ...s.itens.filter(i => i.item !== 'outro' && i.pct != null).map(i => i.pct)) : 102;
function cartaoSup(i) {
  const s = supDe(i.selb), c = cadDe(i.selb), scanner = c && (c.tipo === 'scanner' || c.suprimento === 'nenhum');
  const it = s && s.ok ? s.itens.filter(x => x.item !== 'outro').sort((a, b) => ORDEM_SUP.indexOf(a.item) - ORDEM_SUP.indexOf(b.item)) : [];
  const al = alertasSup(s), pior = al.some(x => x.estado === 'vazio') ? 'bad' : al.length ? 'warn' : '';
  const linha = x => { const cd = codigoSup(x, i.selb); return `
      <div class="sr-sup est-${esc(x.estado.replace(' ', '-'))}" title="${esc(nomeSup(x))}${cd ? ' · ' + esc(cd.cod) : ''}: ${esc(valorSup(x))}">
        <span class="sr-nome"><span class="it-bola it-${x.item}">${x.item === 'caixa' ? IC('caixa') : ''}</span><span>${esc(SUP_NOME[x.item])}${cd ? `<small class="mono">${esc(cd.cod)}${cd.cad ? ' *' : ''}</small>` : ''}</span></span>
        <span class="sup-trilho"><span class="sup-fill it-${x.item}" style="width:${x.pct ?? (x.estado === 'tem' ? 100 : 0)}%"></span></span>
        <span class="sr-val">${x.pct != null ? x.pct + '%' : x.estado === 'tem' ? 'ok' : '?'}</span></div>`; };
  return `<article class="sr-card ${pior}" data-imp="${esc(i.selb)}" tabindex="0">
    <header><div class="sr-tit">${situacaoHtml(i.ip)}<b>${esc(i.selb)}</b><span class="muted">${esc(nomeImp(i))}</span></div>
      ${pior ? `<span class="badge ${pior}">${al.length === 1 ? '1 alerta' : al.length + ' alertas'}</span>` : ''}</header>
    <small class="sr-local">${i.local ? catBadge(categoriaDoLocal(i.local)) + ' ' + esc(localImp(i)) : '<span class="muted">sem local</span>'}</small>
    ${scanner ? '<p class="muted sr-msg">Scanner: sem tinta/toner.</p>'
      : !s ? '<p class="muted sr-msg">Ainda não lida.</p>'
      : !s.ok ? `<p class="sr-msg"><span class="badge">sem leitura</span> <small class="muted">${esc(s.erro || '')}</small></p>`
      : `<div class="sr-sups">${it.map(linha).join('')}${semCaixa(it, i.selb) ? `<div class="sr-sup est-desconhecido" title="A impressora não informa a caixa de manutenção por SNMP"><span class="sr-nome"><span class="it-bola it-caixa">${IC('caixa')}</span><span>Caixa</span></span><span class="sup-trilho"></span><span class="sr-val muted">n/i</span></div>` : ''}</div>`}
    ${s ? `<small class="muted sr-lido">lido ${haQuanto(s.lidoEm)}</small>` : ''}
  </article>`;
}
async function renderSuprimentosResumo() {
  const el = $('#mod-receb');
  el.innerHTML = abasReceb('suprimentos') + '<div class="panel">Carregando...</div>';
  if (!(await needServer(el))) return;
  await Promise.all([atualizarMonitor(), carregarSelbsCad(), carregarLocais()]);
  const D = MON.dados;
  if (!D) { el.innerHTML = abasReceb('suprimentos') + '<div class="panel"><p class="err">Não foi possível carregar as impressoras.</p></div>'; return; }
  const imps = D.impressoras;
  const lidas = imps.filter(i => supDe(i.selb) && supDe(i.selb).ok);
  const comAl = imps.filter(i => alertasSup(supDe(i.selb)).length);
  const trocar = imps.filter(i => alertasSup(supDe(i.selb)).some(x => x.estado === 'vazio'));
  const semLeitura = imps.filter(i => { const c = cadDe(i.selb); return !(c && (c.tipo === 'scanner' || c.suprimento === 'nenhum')) && !(supDe(i.selb) && supDe(i.selb).ok); });
  // o que precisa comprar: itens em alerta agrupados por código (ou cor + modelo, sem código)
  const compra = new Map();
  for (const i of comAl) for (const x of alertasSup(supDe(i.selb))) {
    const cd = codigoSup(x, i.selb), k = cd ? cd.cod : x.item + '|' + nomeImp(i);
    const g = compra.get(k) || { cod: cd ? cd.cod : '', item: x.item, modelo: nomeImp(i), selbs: [], trocar: 0 };
    g.selbs.push(i.selb); if (x.estado === 'vazio') g.trocar++;
    compra.set(k, g);
  }
  const compras = [...compra.values()].sort((a, b) => b.trocar - a.trocar || b.selbs.length - a.selbs.length || ORDEM_SUP.indexOf(a.item) - ORDEM_SUP.indexOf(b.item));
  el.innerHTML = abasReceb('suprimentos') + `
    <div class="panel">
      <div class="head-row"><h2>${TX('suprimentos.titulo')}</h2><div class="filters" style="margin:0">
        <small class="muted">${SUP.dados && SUP.dados.rodada ? `leitura automática a cada ${SUP.dados.horas} h · última ${haQuanto(SUP.dados.rodada)}` : ''}</small>
        <button class="btn ghost small" id="srLer">${IC('caixa')}Ler todas agora</button></div></div>
      <div class="stats">
        ${statHtml(`${lidas.length}<small>/${imps.length}</small>`, 'impressoras com leitura', 'check', 'ok')}
        ${statHtml(comAl.length, `com algum item em ${LIMITE_SUP}% ou menos`, 'caixa', comAl.length ? 'warn' : '')}
        ${statHtml(trocar.length, 'com item para trocar (5% ou menos)', 'alerta', trocar.length ? 'bad' : '')}
        ${statHtml(semLeitura.length, 'sem leitura', 'relogio', '')}
      </div>
      ${compras.length ? `<h3 class="sr-h3">${TX('suprimentos.compras')}</h3>
      <div class="tablewrap"><table><thead><tr><th class="nosort">Código</th><th class="nosort">Item</th><th class="nosort">Impressoras</th><th class="nosort t">Qtd.</th></tr></thead><tbody>
      ${compras.map(g => `<tr><td class="mono"><b>${esc(g.cod || '—')}</b>${g.cod ? '' : ` <small class="muted">sem código no cadastro</small>`}</td>
        <td><span class="sr-item"><span class="it-bola it-${g.item}">${g.item === 'caixa' ? IC('caixa') : ''}</span><span>${esc(SUP_NOME[g.item])}<br><small class="muted">${esc(g.modelo)}</small></span></span></td>
        <td>${g.selbs.map(x => `<a href="#receb/impressoras~${encodeURIComponent(x)}">${esc(x)}</a>`).join(', ')}</td>
        <td class="t"><b>${g.selbs.length}</b>${g.trocar ? ` <span class="badge bad" title="com 5% ou menos">${g.trocar} trocar</span>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    </div>
    <div class="panel">
      <div class="filters">
        <label>Buscar <input type="search" id="srQ" value="${esc(SR.q)}" placeholder="SELB, local, modelo, código" style="min-width:240px"></label>
        <div class="seg2">${[['todas', 'Todas'], ['alerta', 'Com alerta'], ['sem', 'Sem leitura']].map(([v, t]) => `<label class="seg-op"><input type="radio" name="srF" value="${v}" ${SR.filtro === v ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div>
        ${CAD.categorias.length ? `<label>Categoria ${selectCategoria('srCat', SR.cat)}</label>` : ''}
        <label>Ordenar <select id="srOrdem">${[['nivel', 'menor nível primeiro'], ['selb', 'SELB'], ['local', 'local']].map(([v, t]) => `<option value="${v}" ${SR.ordem === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <span class="muted" id="srN"></span></div>
      <div id="srGrade"></div>
      <p class="muted"><small>${TX('suprimentos.rodape')}</small></p>
    </div>`;
  const desenhar = () => {
    const q = nrm(SR.q);
    const lista = imps.filter(i => {
      if (SR.filtro === 'alerta' && !alertasSup(supDe(i.selb)).length) return false;
      if (SR.filtro === 'sem' && !semLeitura.includes(i)) return false;
      if (!casaCategoria(i.local, SR.cat)) return false;
      if (!q) return true;
      const s = supDe(i.selb), c = cadDe(i.selb);
      const cods = s && s.ok ? s.itens.map(x => (codigoSup(x, i.selb) || {}).cod || '') : [];
      return nrm([i.selb, localImp(i), nomeImp(i), i.ip, c && c.obs, ...cods].join(' ')).includes(q);
    }).sort((a, b) => SR.ordem === 'selb' ? a.selb.localeCompare(b.selb, 'pt', { numeric: true })
      : SR.ordem === 'local' ? (localImp(a) || '~').localeCompare(localImp(b) || '~', 'pt') || a.selb.localeCompare(b.selb, 'pt', { numeric: true })
      : menorNivel(supDe(a.selb)) - menorNivel(supDe(b.selb)));
    $('#srN').textContent = `${lista.length} de ${imps.length}`;
    $('#srGrade').innerHTML = !imps.length ? vazioHtml('impressora', 'Nenhuma impressora com IP', 'Cadastre o IP das impressoras na aba SELBs.')
      : !lista.length ? vazioHtml('busca', 'Nenhuma impressora encontrada', '') : `<div class="sr-grade">${lista.map(cartaoSup).join('')}</div>`;
    $('#srGrade').querySelectorAll('.sr-card').forEach(c => {
      const ir = () => { location.hash = 'receb/impressoras~' + encodeURIComponent(c.dataset.imp); };
      c.addEventListener('click', ir); c.addEventListener('keydown', e => { if (e.key === 'Enter') ir(); });
    });
  };
  desenhar();
  $('#srQ').addEventListener('input', e => { SR.q = e.target.value; desenhar(); });
  el.querySelectorAll('input[name="srF"]').forEach(r => r.addEventListener('change', () => { SR.filtro = r.value; desenhar(); }));
  $('#srOrdem').addEventListener('change', e => { SR.ordem = e.target.value; desenhar(); });
  if ($('#srCat')) $('#srCat').addEventListener('change', e => { SR.cat = e.target.value; desenhar(); });
  $('#srLer').addEventListener('click', async e => { const b = e.currentTarget; b.disabled = true; b.textContent = 'Lendo…'; await lerSuprimentosAgora(); renderSuprimentosResumo(); });
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
  await Promise.all([atualizarMonitor(), carregarSelbsCad()]);
  const D = MON.dados;
  const rq = await api('api/monitor/quedas?dias=30').catch(() => null);
  const quedas = rq && rq.ok ? (await rq.json()).quedas : [];
  const ra = await api('api/monitor/alertas?dias=30').catch(() => null);
  const AL = ra && ra.ok ? await ra.json() : { alertas: [], webhook: false };
  if (!D) { el.innerHTML = abasReceb('impressoras') + '<div class="panel"><p class="err">Não foi possível carregar o monitoramento.</p></div>'; return; }
  const imps = [...D.impressoras].sort((a, b) => (a.online === false && !a.pausada ? 0 : 1) - (b.online === false && !b.pausada ? 0 : 1) || a.selb.localeCompare(b.selb, 'pt-BR', { numeric: true }));
  const ativas = imps.filter(i => !i.pausada);
  const fora = D.pausa ? 0 : ativas.filter(i => i.online === false).length;
  const d7 = ativas.filter(i => i.d7 != null), media7 = d7.length ? Math.round(d7.reduce((a, i) => a + i.d7, 0) / d7.length * 10) / 10 : null;
  el.innerHTML = abasReceb('impressoras') + `
    <div class="panel">
      <div class="head-row"><h2>${TX('impressoras.titulo')}</h2><div class="filters" style="margin:0">
        ${D.pausa ? `<span class="badge warn">pausado ${esc(ateTxt(D.pausa))}</span><button class="btn small" data-retomar="todos">Retomar</button>` : menuPausa('todos', 'Pausar monitoramento')}
        <button class="btn ghost small" id="impSupr" title="Lê agora tinta/toner e caixa de todas as impressoras (SNMP)">${IC('caixa')}Ler suprimentos</button>
        <button class="btn ghost small" id="impVerificar">${IC('raio')}Verificar agora</button></div></div>
      <div class="stats">
        ${statHtml(ativas.length - fora, 'online', 'check', 'ok')}
        ${statHtml(fora, 'fora do ar', 'alerta', fora ? 'bad' : '')}
        ${statHtml(imps.length - ativas.length, 'pausadas', 'relogio', '')}
        ${statHtml(pctTxt(media7), 'disponibilidade média em 7 dias', 'grafico', 'violeta')}
        ${statHtml(imps.filter(i => alertasSup(supDe(i.selb)).length).length, 'com suprimento baixo', 'caixa', imps.some(i => alertasSup(supDe(i.selb)).length) ? 'warn' : '')}
      </div>
      <p class="muted">Ping com o menor pacote possível a cada ${D.intervaloMin} min; histórico de ${D.dias} dias. ${D.rodada ? `Última verificação ${haQuanto(D.rodada)}.` : ''}
        Só entram SELBs com IP no cadastro (aba SELBs).</p>
      ${!imps.length ? vazioHtml('impressora', 'Nenhuma impressora com IP', 'Cadastre o IP das impressoras na aba SELBs para monitorar.') : `
      ${legendaStatus()}
      <div class="tablewrap"><table class="clickable"><thead><tr><th class="nosort">Impressora</th><th class="nosort">Situação</th><th class="nosort">Tinta / toner / caixa</th><th class="nosort">Últimas 24 h</th><th class="nosort">24 h</th><th class="nosort">7 dias</th><th class="nosort">Quedas (7 d)</th><th class="nosort"></th></tr></thead><tbody>
      ${imps.map(i => `<tr data-imp="${esc(i.selb)}">
        <td><b>${esc(i.selb)}</b> <span class="muted">${esc(nomeImp(i))}</span><br><small>${i.local ? esc(localImp(i)) + ' · ' : ''}<a class="ip-link" href="http://${esc(i.ip)}" target="_blank" rel="noopener">${esc(i.ip)}</a></small></td>
        <td>${i.pausada || D.pausa ? `<span class="badge">pausada ${esc(ateTxt(i.pausada || D.pausa))}</span>`
          : i.online === null ? '<span class="badge">aguardando</span>' : i.online ? `<span class="badge ok">online</span><br><small>${i.ms != null ? `~${i.ms} ms · ` : ''}${haQuanto(i.verificadoEm)}</small>`
          : `<span class="badge bad">fora do ar</span><br><small>${haQuanto(i.desde)}</small>`}</td>
        <td>${suprimentosMini(supDe(i.selb), i.selb)}</td>
        <td>${barra24h(i.faixas)}</td>
        <td class="t">${pctTxt(i.d24)}</td><td class="t">${pctTxt(i.d7)}</td><td>${i.quedas7 || 0}</td>
        <td class="acoes">${i.pausada ? `<button class="btn ghost small" data-retomar="${esc(i.selb)}">Retomar</button>` : menuPausa(i.selb)}</td></tr>`).join('')}
      </tbody></table></div>`}
    </div>
    <div class="panel">
      <div class="head-row"><h2>${TX('impressoras.alertas')}</h2><div class="filters" style="margin:0">
        ${AL.webhook ? '<span class="badge ok">envio por webhook ativo</span>' : '<span class="badge" title="Defina ALERTA_WEBHOOK na stack para receber os alertas no Teams, Google Chat, Discord ou ntfy">sem envio externo</span>'}
        ${AL.webhook ? `<button class="btn ghost small" id="impAlertaTeste">${IC('raio')}Enviar alerta de teste</button>` : ''}</div></div>
      <p class="muted">Gerado quando tinta/toner ou a vida útil da caixa de manutenção chega a ${LIMITE_SUP}% (e de novo ao chegar a 5%), e quando uma impressora cai ou volta.</p>
      ${!AL.alertas.length ? vazioHtml('check', 'Nenhum alerta nos últimos 30 dias', '') : `
      <div class="tablewrap"><table class="clickable"><thead><tr><th class="nosort">Quando</th><th class="nosort">Alerta</th><th class="nosort">Enviado</th></tr></thead><tbody>
      ${AL.alertas.slice(0, 200).map(a => `<tr data-imp="${esc(String(a.selb || '').split(', ')[0])}"><td class="t">${dataHora(a.quando)}</td><td>${esc(a.texto)}</td>
        <td>${!AL.webhook && !a.enviado ? '<span class="muted">—</span>' : a.enviado ? '<span class="badge ok">sim</span>' : '<span class="badge bad">falhou</span>'}</td></tr>`).join('')}
      </tbody></table></div>`}
    </div>
    <div class="panel">
      <div class="head-row"><h2>${TX('impressoras.quedas')}</h2></div>
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
  $('#impSupr').addEventListener('click', async e => { e.currentTarget.disabled = true; e.currentTarget.textContent = 'Lendo…'; await lerSuprimentosAgora(); renderImpressoras(); });
  $('#impAlertaTeste')?.addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true;
    const r = await api('api/monitor/alerta-teste', { method: 'POST' }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    alert(r && r.ok && j.enviado ? 'Alerta de teste enviado.' : `Não foi possível enviar: ${j.erro || (j.status ? 'HTTP ' + j.status : 'sem resposta do webhook')}`);
    b.disabled = false;
  });
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
        <b class="ld-title">${esc(selb)}</b><small>${i ? esc(nomeImp(i)) + (i.local ? ' · ' + esc(localImp(i)) : '') : ''}</small>
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
    <div class="panel"><div class="head-row"><h2>Tinta, toner e caixa de manutenção</h2><div class="filters" style="margin:0">
        <small class="muted">${supDe(selb) ? `lido ${haQuanto(supDe(selb).lidoEm)}${supDe(selb).modelo ? ' · ' + esc(supDe(selb).modelo) : ''}` : 'ainda não lido'}</small>
        <button class="btn ghost small" id="impSuprUm">${IC('caixa')}Ler agora</button></div></div>
      ${!supDe(selb) ? vazioHtml('caixa', 'Ainda sem leitura', `A leitura é automática a cada ${SUP.dados ? SUP.dados.horas : 6} h; use "Ler agora" ou "Testar leitura" no cadastro do SELB.`)
        : supDe(selb).ok ? suprimentosHtml(supDe(selb).itens, selb) : `<p class="err">${IC('alerta')} ${esc(supDe(selb).erro)}</p>`}
      <div id="impSupHist"></div></div>
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
  $('#impSuprUm').addEventListener('click', async e => { e.currentTarget.disabled = true; e.currentTarget.textContent = 'Lendo…'; await lerSuprimentosAgora(selb); renderImpressora(selb); });
  // histórico dos níveis (90 dias)
  api(`api/suprimentos/historico?selb=${encodeURIComponent(selb)}&dias=90`).then(x => x.ok ? x.json() : null).then(h => {
    const box = $('#impSupHist');
    if (box && h && h.pontos.length >= 2) { box.innerHTML = graficoSuprimentos(h.pontos); ligarGraficoSup(box); }
  }).catch(() => {});
}

// histórico dos níveis: uma linha por tinta/toner/caixa, nas cores reais, com legenda e cursor
const COR_LINHA = { preto: '#1f2430', azul: '#0891b2', magenta: '#db2777', amarelo: '#ca8a04', caixa: '#64748b' };
function graficoSuprimentos(pontos) {
  const W = 900, Hh = 220, m = { l: 40, r: 12, t: 12, b: 26 };
  const t0 = Date.parse(pontos[0].t), t1 = Math.max(Date.parse(pontos[pontos.length - 1].t), t0 + 3600000);
  const X = t => m.l + (t - t0) / (t1 - t0) * (W - m.l - m.r), Y = v => Hh - m.b - v / 100 * (Hh - m.t - m.b);
  const series = {};
  for (const p of pontos) for (const [item, pct] of p.itens) if (item !== 'outro' && pct != null) (series[item] = series[item] || []).push([Date.parse(p.t), pct]);
  const chaves = ['preto', 'azul', 'magenta', 'amarelo', 'caixa'].filter(k => series[k]);
  if (!chaves.length) return '';
  const grade = [0, 50, 100].map(v => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" class="g"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v}%</text>`).join('');
  const dias = Math.max(1, Math.round((t1 - t0) / 86400000));
  // período curto (< 2 dias): mostra a hora; senão, o dia
  const rot = t => { const d = new Date(t); return t1 - t0 < 2 * 86400000 ? hora(d.toISOString()) : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const marcas = [0, 0.5, 1].map(f => { const t = t0 + f * (t1 - t0); return `<text x="${X(t)}" y="${Hh - 6}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}">${rot(t)}</text>`; }).join('');
  const linhas = chaves.map(k => `<path d="${series[k].map(([t, v], j) => `${j ? 'L' : 'M'}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join('')}" class="linha" style="stroke:${COR_LINHA[k]}"${k === 'caixa' ? ' stroke-dasharray="5 4"' : ''}/>`).join('');
  return `<h3>Histórico dos níveis <small class="muted">(${dias} dia${dias > 1 ? 's' : ''})</small></h3>
    <div class="mon-legenda">${chaves.map(k => `<span><i style="background:${COR_LINHA[k]}"></i>${SUP_NOME[k]}${k === 'caixa' ? ' (% vida útil)' : ''}</span>`).join('')}</div>
    <div class="mon-lat" data-series='${JSON.stringify(Object.fromEntries(chaves.map(k => [k, series[k]])))}' data-t0="${t0}" data-t1="${t1}">
      <svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Histórico dos níveis de tinta, toner e caixa">${grade}${marcas}${linhas}<line class="cursor" y1="${m.t}" y2="${Hh - m.b}" x1="-10" x2="-10"/></svg>
      <div class="mon-dica" hidden></div></div>`;
}
function ligarGraficoSup(box) {
  const g = box.querySelector('.mon-lat');
  if (!g) return;
  const S = JSON.parse(g.dataset.series), t0 = +g.dataset.t0, t1 = +g.dataset.t1, svg = g.querySelector('svg'), cur = g.querySelector('.cursor'), dica = g.querySelector('.mon-dica');
  const W = 900, m = { l: 40, r: 12 };
  svg.addEventListener('mousemove', e => {
    const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * W, t = t0 + (x - m.l) / (W - m.l - m.r) * (t1 - t0);
    let perto = null;
    for (const pts of Object.values(S)) for (const p of pts) if (!perto || Math.abs(p[0] - t) < Math.abs(perto - t)) perto = p[0];
    const px = m.l + (perto - t0) / (t1 - t0) * (W - m.l - m.r);
    cur.setAttribute('x1', px); cur.setAttribute('x2', px);
    const d = new Date(perto);
    dica.hidden = false;
    dica.innerHTML = `<b>${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hora(d.toISOString())}</b><br>` +
      Object.entries(S).map(([k, pts]) => { const p = pts.find(q => q[0] === perto); return p ? `${SUP_NOME[k]}: ${p[1]}%` : ''; }).filter(Boolean).join('<br>');
    dica.style.left = `${px / W * 100}%`; dica.style.top = '30%';
  });
  svg.addEventListener('mouseleave', () => { dica.hidden = true; cur.setAttribute('x1', -10); cur.setAttribute('x2', -10); });
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

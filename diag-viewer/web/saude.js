'use strict';
/*
  Saúde do equipamento (06_saude.json gerado pelo diag-hardware.ps1)
  - analyzeSaude(): achados automáticos (grave / alerta / info)
  - renderSaude(): aba "Saúde" da coleta
  - snapshotColeta(): resumo gravado dentro do laudo de manutenção
*/

const arr = v => (Array.isArray(v) ? v : v == null ? [] : [v]);
const num = v => (v == null || v === '' || isNaN(+v) ? null : +v);
const NIVEL = { grave: { label: 'Grave', cls: 'bad' }, alerta: { label: 'Atenção', cls: 'warn' }, info: { label: 'Info', cls: '' } };
const EVENTOS_SAUDE = [
  ['telaAzul', 'Telas azuis (BugCheck)'],
  ['desligamentoInesperado', 'Desligamentos inesperados'],
  ['erroDisco', 'Erros de disco / sistema de arquivos'],
  ['erroHardware', 'Erros de hardware (WHEA)'],
  ['driverVideo', 'Falhas do driver de vídeo'],
  ['falhaAtualizacao', 'Falhas de instalação de atualização'],
  ['travamentoAplicativo', 'Aplicativos que pararam de responder'],
  ['servicoFalhou', 'Serviços que pararam inesperadamente'],
  ['limitacaoCpu', 'Processador limitado pelo firmware'],
];

const TESTE_TXT = { 'Relacao de confianca com o dominio': 'Relação de confiança com o domínio', 'Controlador de dominio': 'Controlador de domínio', 'Resolucao DNS': 'Resolução DNS' };

function parseInfoText(text) {
  const info = {};
  for (const line of (text || '').split(/\r?\n/)) {
    if (line.startsWith('---')) break;
    const m = line.match(/^([^:]+?)\s*:\s(.*)$/);
    if (m && !(m[1].trim() in info)) info[m[1].trim()] = m[2].trim();
  }
  return info;
}

function readSaudeFrom(files) {
  for (const [k, v] of files) {
    if (/(^|\/)06_saude\.json$/i.test(k)) {
      try { return JSON.parse(decodeText(v)); } catch { return null; }
    }
  }
  return null;
}

function analyzeSaude(s) {
  const out = [];
  if (!s) return out;
  const ref = (s.geradoEm && parseDate(s.geradoEm)) || new Date(); // data da coleta, não a de hoje
  const add = (nivel, texto) => out.push({ nivel, texto });

  for (const d of arr(s.discos)) {
    const nome = `${d.nome || 'Disco'} (${d.tipo || '?'}${d.gb ? ', ' + d.gb + ' GB' : ''})`;
    if (d.saude && !/healthy/i.test(d.saude)) add(/unhealthy/i.test(d.saude) ? 'grave' : 'alerta', `${nome}: estado de saúde informado pelo sistema "${d.saude}".`);
    const t = num(d.temperatura), lim = /hdd/i.test(d.tipo) ? 55 : 65;
    if (t != null && t >= lim) add('alerta', `${nome}: temperatura de ${t} °C (referência até ${lim} °C).`);
    const w = num(d.desgastePct);
    if (w != null && w >= 90) add('grave', `${nome}: desgaste de ${w}% da vida útil.`);
    else if (w != null && w >= 70) add('alerta', `${nome}: desgaste de ${w}% da vida útil.`);
    const er = (num(d.errosLeitura) || 0) + (num(d.errosEscrita) || 0);
    if (er > 0) add('alerta', `${nome}: ${er} erro(s) de leitura/escrita registrados pelo controlador.`);
  }
  for (const f of arr(s.smart)) if (f.falhaPrevista) add('grave', `SMART indica falha prevista do disco (${f.instancia || 'disco'}).`);

  for (const v of arr(s.volumes)) {
    const p = num(v.livrePct);
    if (p != null && p < 5) add('grave', `Unidade ${v.letra} com apenas ${v.livreGB} GB livres (${p}%).`);
    else if (p != null && p < 15) add('alerta', `Unidade ${v.letra} com ${v.livreGB} GB livres (${p}%).`);
  }

  const e = s.eventos || {};
  const ev = (k, nivel, frase) => { const x = e[k]; if (x && x.total > 0) add(nivel, `${x.total} ${frase} no período${x.ultimo ? `, último em ${fmt(parseDate(x.ultimo))}` : ''}.`); };
  ev('telaAzul', 'grave', 'tela(s) azul(is) (BugCheck)');
  ev('erroHardware', 'grave', 'erro(s) de hardware reportados pelo processador/barramento (WHEA)');
  ev('erroDisco', 'grave', 'erro(s) de disco ou de sistema de arquivos');
  ev('driverVideo', 'alerta', 'falha(s) do driver de vídeo (parou de responder e foi recuperado)');
  ev('desligamentoInesperado', 'alerta', 'desligamento(s) inesperado(s) (queda de energia, travamento ou botão)');
  const fa = e.falhaAplicativo;
  if (fa && fa.total >= 20) {
    const top = arr(fa.porAplicativo)[0];
    add('info', `${fa.total} falhas de aplicativos no período${top ? `; mais frequente: ${top.aplicativo} (${top.total})` : ''}.`);
  }
  if (arr(s.minidumps).length) add('alerta', `${arr(s.minidumps).length} arquivo(s) de despejo de memória (minidump) em C:\\Windows\\Minidump.`);

  const m = s.memoria;
  if (m && num(m.totalGB) != null && m.totalGB < 4) add('info', `Memória total de ${m.totalGB} GB, abaixo do recomendado para o Windows 10/11.`);
  const b = s.bateria;
  if (b && num(b.desgastePct) != null && b.desgastePct >= 40) add('alerta', `Bateria com ${b.desgastePct}% de desgaste em relação à capacidade de projeto.`);

  const av = s.antivirus;
  if (av && av.ativo === false) add('grave', `Antivírus (${av.produto}) desativado.`);
  else if (av && av.tempoReal === false) add('alerta', `Proteção em tempo real do antivírus desativada.`);
  if (av && av.assinatura) {
    const d = parseDate(av.assinatura);
    if (d && (ref - d) / 86400000 > 7) add('alerta', `Definições do antivírus com mais de 7 dias na data da coleta (última em ${fmt(d).slice(0, 10)}).`);
  }
  const si = s.sistema;
  if (si && si.ultimaAtualizacao) {
    const d = parseDate(si.ultimaAtualizacao);
    if (d && (ref - d) / 86400000 > 60) add('info', `Última atualização do Windows instalada em ${fmt(d).slice(0, 10)}, mais de 60 dias antes da coleta.`);
  }
  for (const r of arr(s.rede)) {
    if (/up/i.test(r.status) && /^(10|100) ?Mbps/i.test(r.velocidade || '')) add('info', `Placa de rede "${r.nome}" conectada a ${r.velocidade} (esperado 1 Gbps em rede cabeada).`);
  }
  // ---- dados do script de diagnóstico (versão 2)
  for (const x of arr(s.volumes)) if (x.verificacaoPendente) add('alerta', `Unidade ${x.letra} marcada para verificação de disco (chkdsk) no próximo boot.`);
  for (const d of arr(s.dispositivosProblema)) add('alerta', `Dispositivo "${d.nome}"${d.classe ? ` (${d.classe})` : ''}: código ${d.codigo}${d.descricao ? ' – ' + d.descricao.toLowerCase() : ''}.`);
  for (const g of arr(s.video)) if (g.codigoErro) add('alerta', `Placa de vídeo "${g.nome}" com código de erro ${g.codigoErro}.`);
  for (const sv of arr(s.servicos)) if (/auto/i.test(sv.inicio || '') && !/running/i.test(sv.estado || '') && sv.nome !== 'wuauserv')
    add('alerta', `Serviço "${sv.descricao || sv.nome}" configurado para iniciar automaticamente, mas está ${String(sv.estado || 'parado').toLowerCase() === 'stopped' ? 'parado' : sv.estado}.`);
  for (const t of arr(s.conectividade)) if (!t.ok) add(/confian/i.test(t.teste) ? 'grave' : 'alerta', `Teste de rede falhou: ${TESTE_TXT[t.teste] || t.teste}${t.alvo ? ` (${t.alvo})` : ''}.`);
  const tc = num(s.temperaturaCpu);
  if (tc != null && tc >= 85) add('alerta', `Temperatura do processador (zona térmica ACPI) em ${tc} °C.`);
  if (s.ativacao && s.ativacao.ativado === false) add('alerta', `Windows não ativado (${s.ativacao.status || 'status desconhecido'}).`);
  if (si && si.reinicioPendente) add('info', 'Reinício pendente para concluir atualizações.');
  if (si && num(si.horasLigado) != null && si.horasLigado > 24 * 14) add('info', `Ligado há ${Math.round(si.horasLigado / 24)} dias sem reiniciar.`);
  if (m && num(m.usoPct) != null && m.usoPct >= 90) add('alerta', `Memória em ${m.usoPct}% de uso no momento da coleta.`);
  if (s.cpu && num(s.cpu.cargaPct) != null && s.cpu.cargaPct >= 90) add('alerta', `Processador em ${s.cpu.cargaPct}% de uso no momento da coleta.`);
  if (av && arr(av.ameacas).length) add('alerta', `${arr(av.ameacas).length} ameaça(s) detectada(s) pelo antivírus no período.`);
  const fu = e.falhaAtualizacao;
  if (fu && fu.total >= 3) add('info', `${fu.total} falhas de instalação de atualizações do Windows no período.`);
  for (const pr of arr(s.impressoras)) if (/offline/i.test(pr.status || '')) add('info', `Impressora "${pr.nome}" está offline.`);

  achadosProfundos(s, add);

  const ordem = { grave: 0, alerta: 1, info: 2 };
  return out.sort((a, b) => ordem[a.nivel] - ordem[b.nivel]);
}

function achadosHtml(list, vazio = 'Nenhum problema identificado automaticamente nos dados coletados.') {
  if (!list.length) return `<p class="muted">${vazio}</p>`;
  return `<ul class="achados">${list.map(a => `<li><span class="badge ${NIVEL[a.nivel].cls}">${NIVEL[a.nivel].label}</span> ${esc(a.texto)}</li>`).join('')}</ul>`;
}

const saudeBadge = s => !s ? '—' : /healthy/i.test(s) ? '<span class="badge ok">Saudável</span>' : /unhealthy/i.test(s) ? `<span class="badge bad">${esc(s)}</span>` : `<span class="badge warn">${esc(s)}</span>`;
const v = (x, suf = '') => (x == null || x === '' ? '—' : esc(x) + suf);

function renderSaude() {
  const el = $('#tab-saude');
  if (!el) return;
  const s = state.saude;
  if (!s) {
    el.innerHTML = `<div class="panel"><h2>Saúde do equipamento</h2><p class="muted">Esta coleta não tem dados de saúde (06_saude.json). Ela foi feita com uma versão anterior do script. Rode de novo o diagnóstico (página Downloads).</p></div>`;
    return;
  }
  const e = s.eventos || {};
  el.innerHTML = `
  <div class="panel"><h2>Achados automáticos</h2>${achadosHtml(analyzeSaude(s))}</div>
  ${renderProfundo(s)}
  ${renderSensores(s)}

  <div class="panel"><h2>Hardware</h2>
    <div class="kv">
      <div>Processador</div><div>${v(s.cpu && s.cpu.nome)}${s.cpu ? ` · ${v(s.cpu.nucleos)} núcleos / ${v(s.cpu.threads)} threads · carga ${v(s.cpu.cargaPct, '%')}` : ''}</div>
      <div>Memória</div><div>${s.memoria ? `${v(s.memoria.totalGB, ' GB')} (livre ${v(s.memoria.livreGB, ' GB')}${s.memoria.usoPct != null ? ` · uso ${v(s.memoria.usoPct, '%')}` : ''}${s.memoria.slotsTotal ? ` · ${arr(s.memoria.modulos).length} de ${v(s.memoria.slotsTotal)} slots` : ''})` : '—'}</div>
      ${s.temperaturaCpu != null ? `<div>Temperatura (ACPI)</div><div>${v(s.temperaturaCpu, ' °C')}</div>` : ''}
      ${arr(s.monitores).length ? `<div>Monitores</div><div>${arr(s.monitores).map(x => `${v(x.fabricante)} ${v(x.modelo)} <small>${v(x.serial)}</small>`).join('<br>')}</div>` : ''}
    </div>
    ${arr(s.video).length ? `<h3>Vídeo</h3>${simpleTable(['Placa', 'Driver', 'Data do driver', 'Resolução', 'Status'], arr(s.video).map(g => [v(g.nome), v(g.driverVersao), g.driverData ? fmt(parseDate(g.driverData)).slice(0, 10) : '—', v(g.resolucao), g.codigoErro ? `<span class="badge warn">erro ${esc(g.codigoErro)}</span>` : v(g.status)]))}` : ''}
    ${s.memoria && arr(s.memoria.modulos).length ? '<h3>Módulos de memória</h3>' + simpleTable(['Slot', 'Capacidade', 'Frequência', 'Fabricante', 'Modelo'], arr(s.memoria.modulos).map(m => [v(m.slot), v(m.gb, ' GB'), v(m.mhz, ' MHz'), v(m.fabricante), v(m.modelo)])) : ''}
  </div>

  <div class="panel"><h2>Armazenamento</h2>
    ${arr(s.discos).length ? simpleTable(['Disco', 'Tipo', 'Capacidade', 'Saúde', 'Temperatura', 'Desgaste', 'Horas ligado', 'Erros L/E'],
      arr(s.discos).map(d => [`${v(d.nome)}<br><small>${v(d.serial)}</small>`, `${v(d.tipo)} · ${v(d.barramento)}`, v(d.gb, ' GB'), saudeBadge(d.saude), v(d.temperatura, ' °C'), v(d.desgastePct, '%'), v(d.horasLigado), `${v(d.errosLeitura)} / ${v(d.errosEscrita)}`])) : '<p class="muted">Sem dados de discos.</p>'}
    ${arr(s.smart).some(x => x.falhaPrevista) ? '<div class="note">SMART: falha prevista em pelo menos um disco.</div>' : ''}
    <h3>Unidades</h3>
    ${arr(s.volumes).length ? arr(s.volumes).map(x => `<div class="vol"><div class="vol-l"><b>${esc(x.letra)}</b> ${esc(x.rotulo || '')} <small>${esc(x.sistemaArquivos || '')}</small></div>
      <div class="vol-bar"><div style="width:${Math.max(0, Math.min(100, 100 - (num(x.livrePct) || 0)))}%" class="${(num(x.livrePct) || 0) < 15 ? 'low' : ''}"></div></div>
      <div class="vol-r">${v(x.livreGB, ' GB')} livres de ${v(x.totalGB, ' GB')}</div></div>`).join('') : '<p class="muted">Sem dados.</p>'}
  </div>

  <div class="panel"><h2>Sistema e proteção</h2>
    <div class="kv">
      <div>Sistema</div><div>${v(s.sistema && s.sistema.nome)} ${v(s.sistema && s.sistema.versao)} ${v(s.sistema && s.sistema.arquitetura)}</div>
      <div>Último boot</div><div>${s.sistema && s.sistema.ultimoBoot ? fmt(parseDate(s.sistema.ultimoBoot)) : '—'} · ligado há ${v(s.sistema && s.sistema.horasLigado, ' h')}</div>
      <div>Última atualização</div><div>${s.sistema && s.sistema.ultimaAtualizacao ? fmt(parseDate(s.sistema.ultimaAtualizacao)).slice(0, 10) : '—'} ${v(s.sistema && s.sistema.ultimaAtualizacaoId)}</div>
      <div>Inicialização rápida</div><div>${s.sistema && s.sistema.inicializacaoRapida != null ? (s.sistema.inicializacaoRapida ? 'Ativada' : 'Desativada') : '—'}</div>
      <div>Antivírus</div><div>${s.antivirus ? `${v(s.antivirus.produto)}${s.antivirus.ativo != null ? ` · ${s.antivirus.ativo ? 'ativo' : '<b class="bad-txt">desativado</b>'}` : ''}${s.antivirus.tempoReal != null ? ` · tempo real ${s.antivirus.tempoReal ? 'ligado' : 'desligado'}` : ''}${s.antivirus.assinatura ? ` · definições de ${fmt(parseDate(s.antivirus.assinatura)).slice(0, 10)}` : ''}` : '—'}</div>
      ${s.bateria ? `<div>Bateria</div><div>carga ${v(s.bateria.cargaPct, '%')} · desgaste ${v(s.bateria.desgastePct, '%')}</div>` : ''}
    </div>
    ${s.ativacao || (s.sistema && s.sistema.planoEnergia) ? `<div class="kv" style="margin-top:6px">
      ${s.ativacao ? `<div>Ativação</div><div>${s.ativacao.ativado ? '<span class="badge ok">Ativado</span>' : `<span class="badge warn">${v(s.ativacao.status)}</span>`} ${v(s.ativacao.canal)}</div>` : ''}
      ${s.sistema && s.sistema.reinicioPendente != null ? `<div>Reinício pendente</div><div>${s.sistema.reinicioPendente ? 'Sim' : 'Não'}</div>` : ''}
      ${s.sistema && s.sistema.planoEnergia ? `<div>Plano de energia</div><div>${v(s.sistema.planoEnergia)}</div>` : ''}
    </div>` : ''}
    ${arr(s.rede).length ? `<h3>Rede</h3>${simpleTable(['Adaptador', 'Status', 'Velocidade', 'IP', 'Gateway', 'DNS', 'MAC'], arr(s.rede).map(r => [`${v(r.nome)}<br><small>${v(r.descricao)}</small>`, v(r.status), v(r.velocidade), v(r.ip), v(r.gateway), v(r.dns), `<span class="mono">${v(r.mac)}</span>`]))}` : ''}
    ${arr(s.conectividade).length ? `<h3>Testes de conectividade</h3>${simpleTable(['Teste', 'Alvo', 'Resultado', 'Tempo'], arr(s.conectividade).map(t => [v(TESTE_TXT[t.teste] || t.teste), v(t.alvo), t.ok ? '<span class="badge ok">OK</span>' : '<span class="badge bad">Falhou</span>', t.ms != null ? v(t.ms, ' ms') : '—']))}` : ''}
  </div>

  ${arr(s.dispositivosProblema).length || arr(s.servicos).length || arr(s.impressoras).length ? `<div class="panel"><h2>Dispositivos, serviços e impressoras</h2>
    ${arr(s.dispositivosProblema).length ? `<h3>Dispositivos com problema</h3>${simpleTable(['Dispositivo', 'Classe', 'Código', 'Descrição'], arr(s.dispositivosProblema).map(d => [`${v(d.nome)}<br><small class="mono">${v(d.id)}</small>`, v(d.classe), v(d.codigo), v(d.descricao)]))}` : (s.dispositivosProblema ? '<p class="muted">Nenhum dispositivo com problema no Gerenciador de Dispositivos.</p>' : '')}
    ${arr(s.servicos).length ? `<h3>Serviços</h3>${simpleTable(['Serviço', 'Estado', 'Início'], arr(s.servicos).map(x => [`${v(x.descricao)} <small>${v(x.nome)}</small>`, /running/i.test(x.estado) ? '<span class="badge ok">Em execução</span>' : `<span class="badge ${/auto/i.test(x.inicio) && x.nome !== 'wuauserv' ? 'warn' : ''}">${v(x.estado)}</span>`, v(x.inicio)]))}` : ''}
    ${arr(s.impressoras).length ? `<h3>Impressoras</h3>${simpleTable(['Impressora', 'Driver', 'Porta', 'Status'], arr(s.impressoras).map(x => [`${v(x.nome)}${x.padrao ? ' <span class="badge">padrão</span>' : ''}`, v(x.driver), v(x.porta), v(x.status)]))}` : ''}
  </div>` : ''}

  ${s.processos || arr(s.inicializacao).length ? `<div class="panel"><h2>Desempenho e inicialização</h2>
    ${s.processos ? `<div class="grid2"><div><h3>Mais memória</h3>${simpleTable(['Processo', 'MB'], arr(s.processos.memoria).map(x => [v(x.nome), v(x.mb)]))}</div>
      <div><h3>Mais tempo de CPU</h3>${simpleTable(['Processo', 'Segundos'], arr(s.processos.cpu).map(x => [v(x.nome), v(x.segundosCpu)]))}</div></div>
      <p class="muted">${v(s.processos.total)} processos em execução na hora da coleta.</p>` : ''}
    ${arr(s.inicializacao).length ? `<details><summary>Programas na inicialização (${arr(s.inicializacao).length})</summary>${simpleTable(['Nome', 'Comando', 'Local'], arr(s.inicializacao).map(x => [v(x.nome), `<span class="mono">${v(x.comando)}</span>`, v(x.local)]))}</details>` : ''}
    ${s.antivirus && arr(s.antivirus.ameacas).length ? `<h3>Ameaças detectadas</h3>${simpleTable(['Data', 'Recurso', 'Ação'], arr(s.antivirus.ameacas).map(x => [x.data ? fmt(parseDate(x.data)) : '—', `<span class="mono">${v(x.recurso)}</span>`, x.acaoOk ? 'Resolvida' : 'Pendente']))}` : ''}
  </div>` : ''}

  ${renderDetalhes(s)}

  <div class="panel"><h2>Eventos críticos no período da coleta</h2>
    ${simpleTable(['Categoria', 'Total', 'Primeiro', 'Último'], EVENTOS_SAUDE.map(([k, l]) => {
      const x = e[k] || {};
      return [esc(l), x.total ? `<b>${x.total}</b>` : '0', x.primeiro ? fmt(parseDate(x.primeiro)) : '—', x.ultimo ? fmt(parseDate(x.ultimo)) : '—'];
    }))}
    ${EVENTOS_SAUDE.filter(([k]) => e[k] && arr(e[k].recentes).length).map(([k, l]) => `<details><summary>${esc(l)}: ${arr(e[k].recentes).length} mais recentes</summary>
      ${simpleTable(['Data/hora', 'ID', 'Origem', 'Mensagem'], arr(e[k].recentes).map(r => [fmt(parseDate(r.hora)), v(r.id), v(r.origem), v(r.mensagem)]), true)}</details>`).join('')}
    ${e.falhaAplicativo && arr(e.falhaAplicativo.porAplicativo).length ? `<h3>Aplicativos com falha (${e.falhaAplicativo.total})</h3>${simpleTable(['Aplicativo', 'Falhas', 'Última'], arr(e.falhaAplicativo.porAplicativo).map(a => [v(a.aplicativo), v(a.total), a.ultimo ? fmt(parseDate(a.ultimo)) : '—']))}` : ''}
    ${arr(s.minidumps).length ? `<h3>Minidumps</h3>${simpleTable(['Arquivo', 'Data', 'Tamanho'], arr(s.minidumps).map(d => [v(d.arquivo), d.data ? fmt(parseDate(d.data)) : '—', v(d.kb, ' KB')]))}` : ''}
  </div>`;
}

// Resumo da coleta gravado no laudo (fica estável mesmo se a coleta mudar)
function snapshotColeta({ id, info, saude, zipHash, recebidoEm }) {
  const s = saude || {};
  const e = s.eventos || {};
  return {
    coletaId: id || '', recebidoEm: recebidoEm || '', pacoteSha256: zipHash || '',
    horaColeta: info['Hora da coleta'] || '', coletadoPor: info['Coletado por'] || '',
    computador: info['Computador'] || '', patrimonio: info['Patrimonio'] || '',
    fabricanteModelo: info['Fabricante / Modelo'] || '', serial: info['Serial (BIOS)'] || '',
    sistema: info['Sistema'] || '', instalacaoSO: info['Instalacao do SO'] || '',
    cpu: s.cpu ? s.cpu.nome : '', memoriaGB: s.memoria ? s.memoria.totalGB : null,
    modulos: s.memoria ? arr(s.memoria.modulos).map(m => `${m.gb} GB ${m.mhz || ''} MHz`.trim()) : [],
    discos: arr(s.discos).map(d => ({ nome: d.nome, tipo: d.tipo, gb: d.gb, saude: d.saude, temperatura: d.temperatura, desgastePct: d.desgastePct, horasLigado: d.horasLigado })),
    volumes: arr(s.volumes).map(x => ({ letra: x.letra, totalGB: x.totalGB, livreGB: x.livreGB, livrePct: x.livrePct })),
    eventos: Object.fromEntries(EVENTOS_SAUDE.map(([k]) => [k, e[k] ? e[k].total || 0 : null])),
    falhasAplicativos: e.falhaAplicativo ? e.falhaAplicativo.total : null,
    antivirus: s.antivirus ? `${s.antivirus.produto || ''}${s.antivirus.ativo === false ? ' (desativado)' : ''}` : '',
    ultimaAtualizacao: s.sistema ? s.sistema.ultimaAtualizacao || '' : '',
    video: arr(s.video).map(g => g.nome).filter(Boolean),
    dispositivosProblema: arr(s.dispositivosProblema).map(d => `${d.nome} (código ${d.codigo})`),
    conectividade: arr(s.conectividade).map(t => ({ teste: t.teste, ok: !!t.ok })),
    ativacao: s.ativacao ? (s.ativacao.ativado ? 'Ativado' : s.ativacao.status || '') : '',
    tipoColeta: s.tipo || (info['Tipo de coleta'] ? 'diagnostico' : 'remocao'),
    testesAuto: testesAutomaticos(s),
    profundoEm: s.profundo ? s.profundo.inicio || '' : '',
    temSaude: !!saude,
    achados: analyzeSaude(saude),
  };
}

// ------------------------------------------------------------------ testes profundos e dados detalhados (diagnostico v2)
const SMART_CRITICOS = [5, 187, 197, 198];
const SISTEMA_TXT = { Healthy: 'Íntegra', Repairable: 'Corrompida (reparável)', NonRepairable: 'Corrompida (não reparável)' };
const VOLUME_TXT = { NoErrorsFound: 'Sem erros', ScanErrorsFoundAndFixedOnline: 'Erros no sistema de arquivos encontrados e corrigidos automaticamente', ErrorsFoundNotFixed: 'Erros no sistema de arquivos encontrados e não corrigidos (verificação somente leitura)', ScanNeeded: 'Verificação completa necessária', SpotFixNeeded: 'Correção pontual necessária', FullRepairNeeded: 'Reparo completo necessário' };

// Lista padronizada dos testes automáticos (usada na aba Saúde e no laudo)
function testesAutomaticos(s) {
  const P = s && s.profundo && s.profundo.testes;
  if (!P) return [];
  const out = [];
  const add = (nome, falha, obs, alerta) => out.push({ nome, resultado: falha ? 'falha' : alerta ? 'alerta' : 'ok', obs });
  if (P.sistema) {
    const dOk = P.sistema.dism === 'Healthy', sOk = /^sem viola/i.test(P.sistema.sfc || '');
    add('Integridade do Windows (DISM + SFC)', !dOk && /repar/i.test(P.sistema.dism) || /viola..es de integridade/i.test(P.sistema.sfc || ''),
      `DISM: ${SISTEMA_TXT[P.sistema.dism] || P.sistema.dism}; SFC: ${(P.sistema.sfc || '').replace('Violacoes', 'Violações').replace('violacoes', 'violações')}`, !(dOk && sOk));
  }
  if (P.disco) for (const u of arr(P.disco.unidades)) add(`Verificação da unidade ${u.unidade} (chkdsk)`, !u.ok && /repair|reparo|NotFixed|^Erro/i.test(u.resultado), (VOLUME_TXT[u.resultado] || u.resultado) + (u.arquivo ? ` – ver ${u.arquivo}` : ''), !u.ok);
  if (P.superficie) for (const d of arr(P.superficie.discos)) {
    const lido = d.gb ? Math.round(100 * (d.lidoGB || 0) / d.gb) : null;
    add(`Superfície do disco ${d.disco} (${d.modelo || ''})`, d.areasComErro > 0 || !!d.erro,
      d.erro ? `Não foi possível ler: ${d.erro}` : `${d.lidoGB} de ${d.gb} GB lidos${lido != null && lido < 99 ? ` (${lido}%)` : ''}; média ${d.mediaMBs} MB/s, mínima ${d.minMBs} MB/s; ${d.blocosLentos} bloco(s) lento(s); ${d.areasComErro} área(s) com erro${d.locaisErro ? ` em ${d.locaisErro.replace(/[;\s]+$/, '')}` : ''}`,
      d.blocosLentos > 20);
  }
  if (P.desempenho) {
    const w = P.desempenho;
    add('Desempenho (WinSAT)', false, w.processador != null ? `Processador ${w.processador} · memória ${w.memoria} · disco ${w.disco} · vídeo ${w.graficos} (escala até 9,9)` : `Não concluído (código ${w.codigo})`, w.processador == null || (w.disco != null && w.disco < 6));
  }
  if (P.benchmark) {
    const b = P.benchmark, d = b.disco || {};
    add('Benchmark (processador, memória e disco)', b.errosCalculo > 0,
      `Processador: ${v0(b.cpuMono)} ciclos/s com 1 thread e ${v0(b.cpuMulti)} com ${v0(b.threads)} (${v0(b.escala)}×); memória: ${v0(b.memoriaMBs)} MB/s; ` +
      (d.erro ? `disco ${d.unidade || ''}: ${d.erro}` : `disco ${d.unidade} escrita ${d.escritaMBs} MB/s, leitura ${d.leituraMBs} MB/s, 4K aleatório ${d.leitura4kIops} IOPS`) +
      (b.errosCalculo > 0 ? `; ${b.errosCalculo} erro(s) de cálculo` : ''),
      !!d.erro || (d.leituraMBs != null && d.leituraMBs < 60) || (d.escritaMBs != null && d.escritaMBs < 30));
  }
  if (P.memoria) add('Memória RAM (padrões gravados e conferidos)', P.memoria.erros > 0, `${P.memoria.mbTestados} MB testados, ${P.memoria.passadas} passada(s) em ${P.memoria.minutos} min, ${P.memoria.erros} erro(s)`, P.memoria.passadas < 2);
  if (P.estresse) {
    const e = P.estresse;
    add('Estresse do processador', e.errosCalculo > 0 || e.errosWhea > 0 || !!e.abortado,
      `${e.abortado ? e.abortado.replace('Interrompido:', 'Interrompido por temperatura:') + '; ' : ''}${e.minutos} min com ${e.threads} threads; uso médio ${e.usoMedioPct}%; desempenho médio ${e.desempenhoMedioPct}% (mín. ${e.desempenhoMinPct}%)${e.tempMax != null ? `; temperatura máx. ${e.tempMax} °C` : ''}; ${e.errosCalculo} erro(s) de cálculo; ${e.eventosLimitacao} aviso(s) de limitação`,
      (e.tempMax != null && e.tempMax >= 90) || e.eventosLimitacao > 0 || (e.desempenhoMinPct != null && e.desempenhoMinPct < 60));
  }
  if (P.rede) for (const a of arr(P.rede.alvos)) add(`Rede prolongada – ${a.nome} (${a.alvo})`, a.perdaPct > 5,
    `${a.enviados} pings, perda ${a.perdaPct}%, média ${a.mediaMs} ms, máx. ${a.maxMs} ms, variação ${a.jitterMs} ms`, a.perdaPct > 1 || (a.nome === 'Gateway' && a.mediaMs > 20));
  if (P.antivirus) add(`Antivírus – verificação ${P.antivirus.tipo === 'Completa' ? 'completa' : 'rápida'}`, arr(P.antivirus.ameacas).length > 0,
    P.antivirus.erro ? `Não executou: ${P.antivirus.erro}` : `${arr(P.antivirus.ameacas).length} ameaça(s) em ${P.antivirus.minutos} min`, !!P.antivirus.erro);
  if (P.energia) add('Relatório de energia (powercfg)', false, `${v0(P.energia.erros)} erro(s), ${v0(P.energia.avisos)} aviso(s) – ver energia.html`, P.energia.erros > 0);
  if (s.sensores && arr(s.sensores.itens).length) {
    const an = analisarSensores(s);
    // os problemas entram nos achados um a um (achadosProfundos); aqui fica só o resumo
    out.push({ nome: 'Sensores durante os testes (temperatura, tensão, ventoinhas)', resultado: an.some(a => a.nivel === 'grave') ? 'falha' : an.length ? 'alerta' : 'ok', obs: resumoSensores(s), sensores: true });
  }
  return out;
}
const v0 = x => (x == null ? '—' : x);
const RES_BADGE = { ok: '<span class="badge ok">OK</span>', alerta: '<span class="badge warn">Atenção</span>', falha: '<span class="badge bad">Falha</span>' };

function achadosProfundos(s, add) {
  for (const a of analisarSensores(s)) add(a.nivel, a.texto);
  for (const t of testesAutomaticos(s)) if (t.resultado !== 'ok' && !t.sensores) add(t.resultado === 'falha' ? 'grave' : 'alerta', `${t.nome}: ${t.obs}.`);
  for (const sa of arr(s.smartAtributos)) for (const at of arr(sa.atributos)) {
    if (SMART_CRITICOS.includes(at.id) && at.bruto > 0) add('grave', `SMART – ${at.nome}: ${at.bruto} (disco ${sa.instancia ? sa.instancia.split('\\').pop() : ''}).`);
    if (at.id === 199 && at.bruto > 0) add('alerta', `SMART – ${at.bruto} erro(s) CRC: verifique o cabo SATA e o conector.`);
  }
  for (const tm of arr(s.testeMemoriaWindows)) if (tm.comErros) add('grave', `Teste de memória do Windows encontrou erros (${fmt(parseDate(tm.hora))}).`);
  const it = s.inicializacaoTempo;
  if (it && it.mediaSeg > 120) add('alerta', `Inicialização lenta: média de ${it.mediaSeg} s em ${it.boots} inicialização(ões).`);
  else if (it && it.mediaSeg > 60) add('info', `Inicialização com média de ${it.mediaSeg} s.`);
  if (s.confiabilidade && s.confiabilidade.indice < 5) add('alerta', `Índice de estabilidade do Windows em ${s.confiabilidade.indice} de 10.`);
  if (s.wifi && s.wifi.sinalPct != null && s.wifi.sinalPct < 50) add('alerta', `Sinal do Wi-Fi fraco (${s.wifi.sinalPct}%).`);
  if (s.drivers && arr(s.drivers.naoAssinados).length) add('info', `${arr(s.drivers.naoAssinados).length} driver(s) sem assinatura digital.`);
  const seg = s.seguranca;
  if (seg && seg.tpm && seg.tpm.presente === false) add('info', 'TPM não encontrado (requisito do Windows 11).');
  if (seg && /uefi/i.test(seg.firmware || '') && seg.secureBoot === false) add('info', 'Inicialização segura (Secure Boot) desativada.');
  const e = s.eventos || {};
  if (e.limitacaoCpu && e.limitacaoCpu.total > 0) add('alerta', `${e.limitacaoCpu.total} aviso(s) de processador limitado pelo firmware (superaquecimento ou energia).`);
  if (e.travamentoAplicativo && e.travamentoAplicativo.total >= 10) add('info', `${e.travamentoAplicativo.total} travamento(s) de aplicativos (parou de responder) no período.`);
  if (e.servicoFalhou && e.servicoFalhou.total >= 5) add('info', `${e.servicoFalhou.total} parada(s) inesperada(s) de serviços no período.`);
}

function renderProfundo(s) {
  const p = s.profundo;
  if (!p) return '';
  const T = testesAutomaticos(s);
  const P = p.testes || {};
  return `<div class="panel"><h2>Testes profundos <small class="muted">${esc(p.inicio || '')} · ${v0(p.minutosTotal)} min</small></h2>
    ${T.length ? simpleTable(['Teste', 'Resultado', 'Detalhes'], T.map(t => [esc(t.nome), RES_BADGE[t.resultado], esc(t.obs)])) : '<p class="muted">Nenhum resultado.</p>'}
    ${P.estresse ? `<p class="muted">Estresse: temperatura inicial ${v(P.estresse.tempInicial, ' °C')}, frequência média ${v(P.estresse.mhzMedio, ' MHz')}, desempenho inicial ${v(P.estresse.desempenhoInicialPct, '%')}. A temperatura vem do monitor de sensores (processador, ou zona térmica ACPI quando o LibreHardwareMonitor não está na pasta do script).</p>` : ''}
    ${P.logs ? `<p class="muted">Logs copiados: ${arr(P.logs.arquivos).map(esc).join(', ')}.</p>` : ''}
  </div>`;
}

function renderDetalhes(s) {
  const parts = [];
  const sm = arr(s.smartAtributos).filter(x => arr(x.atributos).length);
  if (sm.length) parts.push(`<h3>Atributos SMART</h3>${sm.map(x => `<details ${arr(x.atributos).some(a => SMART_CRITICOS.includes(a.id) && a.bruto > 0) ? 'open' : ''}><summary>${esc((x.instancia || '').split('\\').slice(-2).join(' '))}</summary>
    ${simpleTable(['ID', 'Atributo', 'Valor', 'Pior', 'Bruto'], arr(x.atributos).map(a => [v(a.id), (SMART_CRITICOS.includes(a.id) || a.id === 199) && a.bruto > 0 ? `<b class="bad-txt">${esc(a.nome)}</b>` : esc(a.nome), v(a.valor), v(a.pior), v(a.bruto)]))}</details>`).join('')}`);
  const it = s.inicializacaoTempo;
  const kv = [];
  if (it) kv.push(['Tempo de inicialização', `média ${v(it.mediaSeg, ' s')} · máx. ${v(it.maxSeg, ' s')} · última ${v(it.ultimoSeg, ' s')} (${v(it.boots)} inicializações)`]);
  if (s.eventos && s.eventos.reinicios) kv.push(['Inicializações no período', v(s.eventos.reinicios.total)]);
  if (s.confiabilidade) kv.push(['Índice de estabilidade', `${v(s.confiabilidade.indice)} de 10`]);
  const seg = s.seguranca;
  if (seg) {
    kv.push(['Firmware / Secure Boot', `${v(seg.firmware)} · Secure Boot ${seg.secureBoot == null ? '—' : seg.secureBoot ? 'ativado' : 'desativado'}`]);
    if (seg.tpm) kv.push(['TPM', seg.tpm.presente ? `presente · versão ${v(seg.tpm.versao)}${seg.tpm.ativo === false ? ' · desativado' : ''}` : 'não encontrado']);
    if (arr(seg.bitlocker).length) kv.push(['BitLocker', arr(seg.bitlocker).map(b => `${esc(b.unidade)} ${/on/i.test(b.protecao) ? 'protegido' : 'sem proteção'} (${esc(b.criptografadoPct)}%)`).join(' · ')]);
  }
  if (s.memoriaVirtual) kv.push(['Memória virtual', `${v(s.memoriaVirtual.totalMB, ' MB')} · uso ${v(s.memoriaVirtual.usoMB, ' MB')} · pico ${v(s.memoriaVirtual.picoMB, ' MB')}`]);
  if (s.wifi) kv.push(['Wi-Fi', `${v(s.wifi.ssid)} · sinal ${v(s.wifi.sinalPct, '%')} · ${v(s.wifi.radio)} · canal ${v(s.wifi.canal)} · ${v(s.wifi.recepcaoMbps, ' Mbps')}`]);
  if (s.drivers) kv.push(['Drivers', `${v(s.drivers.total)} instalados · ${arr(s.drivers.naoAssinados).length} sem assinatura (lista em 09_drivers.csv)`]);
  if (kv.length) parts.unshift(`<div class="kv">${kv.map(([a, b]) => `<div>${a}</div><div>${b}</div>`).join('')}</div>`);
  if (it && arr(it.atrasos).length) parts.push(`<h3>O que atrasa a inicialização</h3>${simpleTable(['Item', 'Vezes', 'Atraso médio'], arr(it.atrasos).map(a => [v(a.nome), v(a.vezes), v(a.mediaAtrasoSeg, ' s')]))}`);
  if (arr(s.testeMemoriaWindows).length) parts.push(`<h3>Teste de memória do Windows (últimos)</h3>${simpleTable(['Data', 'Resultado'], arr(s.testeMemoriaWindows).map(t => [fmt(parseDate(t.hora)), t.comErros ? `<b class="bad-txt">${v(t.mensagem)}</b>` : v(t.mensagem)]))}`);
  if (s.atualizacoes) {
    const f = arr(s.atualizacoes.falhas);
    parts.push(`<details ${f.length ? 'open' : ''}><summary>Atualizações do Windows: ${v(s.atualizacoes.total)} no histórico, ${f.length} falha(s) recente(s)</summary>
      ${simpleTable(['Data', 'Atualização', 'Resultado', 'Código'], (f.length ? f : arr(s.atualizacoes.recentes)).map(u => [u.data ? fmt(parseDate(u.data)) : '—', v(u.titulo), u.resultado === 'Falhou' ? `<b class="bad-txt">Falhou</b>` : v(u.resultado), `<span class="mono">${v(u.codigo)}</span>`]))}</details>`);
  }
  if (s.drivers && arr(s.drivers.naoAssinados).length) parts.push(`<details><summary>Drivers sem assinatura (${arr(s.drivers.naoAssinados).length})</summary>${simpleTable(['Dispositivo', 'Versão', 'INF'], arr(s.drivers.naoAssinados).map(d => [v(d.dispositivo), v(d.versao), v(d.inf)]))}</details>`);
  return parts.length ? `<div class="panel"><h2>Saúde detalhada</h2>${parts.join('')}</div>` : '';
}

// ------------------------------------------------------------------ sensores (10_sensores.csv + resumo em 06_saude.json)
const SENSOR_TIPO = { temperatura: 'Temperatura', tensao: 'Tensão', ventoinha: 'Ventoinha', potencia: 'Potência', corrente: 'Corrente', controle: 'Controle', carga: 'Carga', frequencia: 'Frequência' };
const FASE_TXT = { ocioso: 'repouso', benchmark: 'benchmark', estresse: 'estresse', memoria: 'memória', desempenho: 'WinSAT', sistema: 'DISM/SFC', disco: 'chkdsk', superficie: 'superfície', rede: 'rede', antivirus: 'antivírus', energia: 'energia', logs: 'logs', fim: 'fim' };
const TOL_TENSAO = 5; // % – tolerância ATX das linhas +12V, +5V e +3.3V

// linha da fonte pelo nome do sensor; standby (5VSB, 3VSB) fica de fora
function tensaoNominal(n) {
  if (/SB|standby/i.test(n)) return null;
  // "(?![a-z])": "Core #5 VID" não é a linha de 5 V
  if (/(^|[^\d.#])12\s*V(?![a-z])/i.test(n)) return 12;
  if (/3[.,]3\s*V(?![a-z])|3V3/i.test(n)) return 3.3;
  if (/(^|[^\d.#])5\s*V(?![a-z])/i.test(n)) return 5;
  return null;
}
function desvioTensao(x) {
  const nom = /^(Cpu|Gpu)/i.test(x.hwTipo || '') ? null : tensaoNominal(x.nome || '');
  return nom && num(x.min) != null && num(x.max) != null ? Math.max(Math.abs(x.min - nom), Math.abs(x.max - nom)) / nom * 100 : 0;
}

function analisarSensores(s) {
  const out = [], S = s && s.sensores;
  if (!S) return out;
  const add = (nivel, texto) => out.push({ nivel, texto });
  const pico = {}; // maior temperatura por processador / placa de vídeo
  for (const x of arr(S.itens)) {
    const max = num(x.max), min = num(x.min);
    // limites de alarme do NVMe não são leituras (coletas antigas ainda trazem)
    if (max == null || /warning|critical/i.test(x.nome || '')) continue;
    if (x.tipo === 'tensao' && desvioTensao(x) > TOL_TENSAO)
      add('alerta', `Tensão ${x.nome} (${x.hw}) fora de ±${TOL_TENSAO}%: ${min} a ${max} V para ${tensaoNominal(x.nome)} V nominais. A leitura é do sensor da placa-mãe; confirme com multímetro antes de condenar a fonte.`);
    if (x.tipo === 'temperatura' && /^(Cpu|Gpu)/i.test(x.hwTipo || '') && (!pico[x.hw] || max > pico[x.hw].max)) pico[x.hw] = x;
    if (x.tipo === 'temperatura' && /^Storage/i.test(x.hwTipo || '') && max >= 70) add('alerta', `${x.hw}: temperatura chegou a ${max} °C durante os testes.`);
    // placas de vídeo param a ventoinha em repouso: só vale para quem estava girando no início
    if (x.tipo === 'ventoinha' && num(x.inicial) > 0 && min === 0 && !/^Gpu/i.test(x.hwTipo || ''))
      add('alerta', `Ventoinha ${x.nome} (${x.hw}) parou durante o monitoramento (girava a ${x.inicial} RPM).`);
  }
  for (const [hw, x] of Object.entries(pico)) {
    const quando = x.faseMax && x.faseMax !== 'ocioso' ? ` durante ${FASE_TXT[x.faseMax] || x.faseMax}` : '';
    if (x.max >= 95) add('grave', `${hw}: temperatura chegou a ${x.max} °C${quando} (em repouso: ${x.inicial} °C). Verifique cooler, pasta térmica e fluxo de ar.`);
    else if (x.max >= 85) add('alerta', `${hw}: temperatura chegou a ${x.max} °C${quando} (em repouso: ${x.inicial} °C).`);
  }
  return out;
}

function resumoSensores(s) {
  const it = arr(s.sensores && s.sensores.itens), p = [], quente = {};
  for (const x of it) if (x.tipo === 'temperatura' && num(x.max) != null && !(quente[x.hw] >= x.max)) quente[x.hw] = x.max;
  for (const [hw, m] of Object.entries(quente)) p.push(`${hw} máx. ${m} °C`);
  for (const x of it) if (x.tipo === 'tensao' && tensaoNominal(x.nome || '')) p.push(`${x.nome} ${x.min} a ${x.max} V`);
  const f = it.filter(x => x.tipo === 'ventoinha' && x.max > 0);
  if (f.length) p.push(`${f.length} ventoinha(s): ${f.map(x => `${Math.round(x.min)} a ${Math.round(x.max)} RPM`).join(', ')}`);
  return p.join('; ') || 'Nenhum sensor de temperatura, tensão ou ventoinha disponível neste PC';
}

function renderSensores(s) {
  const S = s.sensores;
  if (!S || !arr(S.itens).length) return '';
  const ordem = Object.keys(SENSOR_TIPO);
  const itens = arr(S.itens).slice().sort((a, b) => ordem.indexOf(a.tipo) - ordem.indexOf(b.tipo) || String(a.hw).localeCompare(String(b.hw)));
  const un = x => (x.unidade === 'C' ? ' °C' : x.unidade ? ' ' + x.unidade : '');
  const semPlaca = !/LibreHardwareMonitor/i.test(S.fonte || '') && !itens.some(x => x.tipo === 'tensao' || x.tipo === 'ventoinha');
  const varios = S.amostras > 1;
  return `<div class="panel"><h2>Sensores <small class="muted">${esc(S.fonte || '')} · ${v0(S.amostras)} amostra(s)${varios ? ` a cada ${v0(S.intervaloSeg)} s` : ''}</small></h2>
    ${S.aviso ? `<div class="note">${esc(S.aviso)}</div>` : ''}
    ${graficoSensores()}
    ${simpleTable(varios ? ['Componente', 'Sensor', 'Tipo', 'Inicial', 'Mínimo', 'Média', 'Máximo', 'Pico em'] : ['Componente', 'Sensor', 'Tipo', 'Valor'], itens.map(x => {
      const ruim = x.tipo === 'tensao' && desvioTensao(x) > TOL_TENSAO;
      const c = val => (ruim ? `<b class="bad-txt">${v(val, un(x))}</b>` : v(val, un(x)));
      const base = [v(x.hw), v(x.nome) + (x.tipo === 'tensao' && tensaoNominal(x.nome || '') ? ` <small class="muted">nominal ${tensaoNominal(x.nome)} V</small>` : ''), SENSOR_TIPO[x.tipo] || v(x.tipo)];
      return varios ? [...base, v(x.inicial, un(x)), c(x.min), v(x.media, un(x)), c(x.max), esc(FASE_TXT[x.faseMax] || x.faseMax || '—')] : [...base, c(x.inicial)];
    }))}
    ${semPlaca ? '<p class="muted">Tensões da fonte (+12V, +5V, +3.3V) e rotação das ventoinhas não foram lidas: o Windows não informa esses sensores. Coloque o LibreHardwareMonitor na pasta <span class="mono">sensores</span> ao lado do script (<span class="mono">baixar-sensores.ps1</span>) e rode de novo.</p>' : ''}
    <p class="muted">Série completa em <span class="mono">10_sensores.csv</span> (uma linha por sensor a cada amostra, com o teste em execução).</p>
  </div>`;
}

// Temperaturas ao longo dos testes (SVG), a partir do 10_sensores.csv da coleta aberta
function graficoSensores() {
  const bytes = typeof findFile === 'function' ? findFile('10_sensores.csv') : null;
  if (!bytes) return '';
  const horas = [], fases = [], series = new Map();
  for (const l of decodeText(bytes).split(/\r?\n/).slice(1)) {
    const c = l.split(';');
    if (c.length < 7) continue;
    if (horas[horas.length - 1] !== c[0]) { horas.push(c[0]); fases.push(c[1]); }
    if (c[4] !== 'temperatura' || isNaN(+c[6]) || /warning|critical/i.test(c[5])) continue;
    const k = `${c[2]} · ${c[5]}`;
    if (!series.has(k)) series.set(k, []);
    series.get(k).push([horas.length - 1, +c[6]]);
  }
  const top = [...series].map(([k, pts]) => ({ k, pts, max: Math.max(...pts.map(p => p[1])) })).sort((a, b) => b.max - a.max).slice(0, 6);
  if (horas.length < 3 || !top.length) return '';
  const W = 800, H = 230, L = 38, R = 8, T = 18, B = 22, n = horas.length - 1;
  const todos = top.flatMap(t => t.pts.map(p => p[1]));
  const y0 = Math.floor(Math.min(...todos) / 10) * 10, y1 = Math.max(y0 + 10, Math.ceil(Math.max(...todos) / 10) * 10);
  const X = i => L + (W - L - R) * i / n, Y = t => T + (H - T - B) * (1 - (t - y0) / (y1 - y0));
  const cores = ['#d62728', '#1f77b4', '#2ca02c', '#ff7f0e', '#9467bd', '#8c564b'];
  let faixas = '';
  for (let i = 0, ini = 0, par = 0; i <= n; i++) {
    if (i === n || fases[i + 1] !== fases[ini]) {
      const x = X(ini), w = Math.max(1, X(Math.min(n, i + 1)) - x);
      faixas += `${par++ % 2 ? `<rect x="${x.toFixed(1)}" y="${T}" width="${w.toFixed(1)}" height="${H - T - B}" fill="currentColor" opacity=".06"/>` : ''}
        ${w > 40 ? `<text x="${(x + 3).toFixed(1)}" y="${T - 5}" font-size="10" fill="currentColor" opacity=".7">${esc(FASE_TXT[fases[ini]] || fases[ini])}</text>` : ''}`;
      ini = i + 1;
    }
  }
  let grade = '';
  for (let t = y0; t <= y1; t += (y1 - y0) > 50 ? 20 : 10)
    grade += `<line x1="${L}" x2="${W - R}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" stroke="currentColor" opacity=".15"/><text x="${L - 5}" y="${(Y(t) + 3).toFixed(1)}" font-size="10" text-anchor="end" fill="currentColor">${t}°</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Temperaturas durante os testes" style="width:100%;max-width:900px;height:auto">
      ${faixas}${grade}
      ${top.map((t, i) => `<polyline fill="none" stroke="${cores[i]}" stroke-width="1.6" points="${t.pts.map(p => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ')}"/>`).join('')}
      <text x="${L}" y="${H - 6}" font-size="10" fill="currentColor">${esc(horas[0].slice(11))}</text>
      <text x="${W - R}" y="${H - 6}" font-size="10" text-anchor="end" fill="currentColor">${esc(horas[n].slice(11))}</text>
    </svg>
    <p class="muted" style="margin:2px 0 10px">${top.map((t, i) => `<span style="color:${cores[i]}">■</span> ${esc(t.k)} (máx. ${t.max} °C)`).join(' &nbsp; ')}</p>`;
}

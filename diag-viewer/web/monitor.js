'use strict';
/*
  Monitoramento das impressoras (SELBs com IP cadastrado).
  O servidor faz o ping a cada MONITOR_MIN minutos (padrão 5); aqui só mostramos o resultado:
  - tela inicial: painel vermelho com as impressoras fora do ar (ou uma linha verde se está tudo bem);
  - menu lateral: contador vermelho em "Recebimentos";
  - aba SELBs: bolinha de situação ao lado do IP (renderSelbs usa MON.porIp).
  A tela consulta o servidor a cada minuto. Depende de app.js (api, esc, IC).
*/
const MON = { dados: null, porIp: new Map(), timer: null };

const haQuanto = iso => {
  if (!iso) return '';
  const min = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `há ${h} h${min % 60 ? ' ' + (min % 60) + ' min' : ''}`;
  return `há ${Math.floor(h / 24)} dias`;
};
const nomeImp = i => [i.marca, i.modelo].filter(Boolean).join(' ') || ({ impressora: 'Impressora', multifuncional: 'Multifuncional', scanner: 'Scanner' }[i.tipo] || 'Equipamento');

// bolinha de situação (usada também na aba SELBs)
function situacaoHtml(ip) {
  const i = MON.porIp.get(ip);
  if (!i || i.online === null) return `<span class="mon-bola" title="Ainda não verificada"></span>`;
  return i.online
    ? `<span class="mon-bola on" title="Online${i.ms != null ? ` · ${i.ms} ms` : ''} · verificada ${haQuanto(i.verificadoEm)}${i.via && i.via !== 'ping' ? ` (responde na ${i.via}, não ao ping)` : ''}"></span>`
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

function desenharMonitor() {
  const box = document.getElementById('impStatus'), badge = document.getElementById('sideImp');
  const D = MON.dados, imps = D ? D.impressoras : [];
  const fora = imps.filter(i => i.online === false).sort((a, b) => String(a.desde).localeCompare(String(b.desde)));
  const on = imps.filter(i => i.online === true).length;
  if (badge) { badge.hidden = !fora.length; badge.textContent = fora.length; badge.title = `${fora.length} impressora(s) fora do ar`; }
  if (!box) return;
  if (!D || !imps.length) { box.hidden = true; return; }
  box.hidden = false;
  const rodape = `Ping a cada ${D.intervaloMin} min${D.rodada ? ` · última verificação ${haQuanto(D.rodada)}` : ' · primeira verificação em andamento'}${D.ping === 'indisponivel' ? ' · sem ping no servidor: verificando pelas portas da impressora' : ''}`;
  const botao = `<button class="btn ghost small" id="monVerificar">${IC('raio')}Verificar agora</button>`;
  if (!fora.length) {
    box.className = 'panel imp-status ok';
    box.innerHTML = `<div class="imp-linha"><span class="imp-ic ok">${IC('impressora')}</span>
      <div><b>${on === imps.length ? `Todas as ${imps.length} impressoras estão online` : `${on} de ${imps.length} impressoras online`}</b><br><small>${rodape}</small></div>
      <div class="imp-acoes">${botao}<a class="btn ghost small" href="#receb/selbs">Ver SELBs</a></div></div>`;
  } else {
    box.className = 'panel imp-status alerta';
    box.innerHTML = `<div class="imp-linha"><span class="imp-ic bad">${IC('alerta')}</span>
      <div><b>${fora.length === 1 ? '1 impressora fora do ar' : `${fora.length} impressoras fora do ar`}</b><br><small>${on} online de ${imps.length} · ${rodape}</small></div>
      <div class="imp-acoes">${botao}<a class="btn ghost small" href="#receb/selbs">Ver SELBs</a></div></div>
      <div class="imp-lista">${fora.map(i => `<div class="imp-item"><span class="mon-bola off"></span>
        <div><b>${esc(i.selb)}</b> <span class="muted">${esc(nomeImp(i))}</span><br><small>${i.local ? esc(i.local) + ' · ' : ''}fora do ar ${haQuanto(i.desde)}</small></div>
        <a class="ip-link" href="http://${esc(i.ip)}" target="_blank" rel="noopener" title="Abrir o painel da impressora">${IC('monitor')}${esc(i.ip)}</a></div>`).join('')}</div>`;
  }
  const b = document.getElementById('monVerificar');
  if (b) b.addEventListener('click', async () => {
    b.disabled = true; b.innerHTML = `${IC('relogio')}Verificando…`;
    await atualizarMonitor(true);
  });
}

function iniciarMonitor() {
  if (location.protocol === 'file:') return;
  atualizarMonitor();
  clearInterval(MON.timer);
  MON.timer = setInterval(() => { if (!document.hidden) atualizarMonitor(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) atualizarMonitor(); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciarMonitor); else iniciarMonitor();

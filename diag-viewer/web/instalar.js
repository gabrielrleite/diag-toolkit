'use strict';
// ================================================================== instalar como app (celular e computador)
// A Central diag é um PWA: manifest.webmanifest + service worker (sw.js). Instalada, abre como app (tela cheia,
// ícone na tela inicial) e a parte das impressoras funciona sem conexão (offline.js).
// Os navegadores só instalam como app (e só abrem sem servidor) em HTTPS ou localhost.
const INST = { prompt: null };
const ehApp = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ehIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const ehAndroid = () => /android/i.test(navigator.userAgent);
const ehCelular = () => ehIOS() || ehAndroid() || matchMedia('(max-width: 700px)').matches;
const lerFlag = k => { try { return localStorage.getItem(k); } catch { return null; } };
const gravarFlag = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sem storage */ } };

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); INST.prompt = e; atualizarInstalar(); });
window.addEventListener('appinstalled', () => { INST.prompt = null; gravarFlag('appInstalado', '1'); atualizarInstalar(); });

function atualizarInstalar() {
  const b = document.getElementById('btnInstalar');
  if (b) b.hidden = ehApp() || location.protocol === 'file:';
  // no celular, um aviso (uma vez, dispensável) no topo do conteúdo
  const ja = document.getElementById('instAviso');
  const mostrar = ehCelular() && !ehApp() && location.protocol !== 'file:' && !lerFlag('instalarDispensado') && !lerFlag('appInstalado');
  if (!mostrar) { if (ja) ja.remove(); return; }
  if (ja) return;
  const main = document.querySelector('main');
  if (!main) return;
  const d = document.createElement('div');
  d.id = 'instAviso'; d.className = 'inst-aviso noprint';
  d.innerHTML = `<img src="icons/icon-192.png" alt="" width="40" height="40">
    <div><b>Instale a Central diag no celular</b><br><small>Abre como app, e impressoras, SELBs e suprimentos funcionam mesmo sem conexão.</small></div>
    <div class="inst-acoes"><button type="button" class="btn small" id="instSim">Instalar</button><button type="button" class="btn ghost small" id="instNao">Agora não</button></div>`;
  main.prepend(d);
  d.querySelector('#instSim').onclick = () => instalarApp();
  d.querySelector('#instNao').onclick = () => { gravarFlag('instalarDispensado', '1'); d.remove(); };
}

async function instalarApp() {
  if (INST.prompt) {
    const p = INST.prompt; INST.prompt = null;
    p.prompt();
    const r = await p.userChoice.catch(() => null);
    if (r && r.outcome === 'accepted') gravarFlag('appInstalado', '1');
    atualizarInstalar();
    return;
  }
  ajudaInstalar();
}

// passo a passo conforme o aparelho (quando o navegador não oferece o botão de instalar direto)
function ajudaInstalar() {
  const endereco = location.origin + location.pathname.replace(/index\.html$/, '');
  const seguro = window.isSecureContext;
  const passos = ehIOS()
    ? ['Abra este endereço no <b>Safari</b> (no iPhone, só o Safari instala).', 'Toque em <b>Compartilhar</b> (quadrado com a seta para cima).', 'Toque em <b>Adicionar à Tela de Início</b> e depois em <b>Adicionar</b>.']
    : ehAndroid()
      ? ['Abra este endereço no <b>Chrome</b>.', 'Toque no menu <b>⋮</b> (canto superior direito).', 'Toque em <b>Instalar app</b> (ou <b>Adicionar à tela inicial</b> → <b>Instalar</b>).']
      : ['No <b>Chrome</b> ou <b>Edge</b>: clique no ícone de instalar na barra de endereço (monitor com seta), ou menu <b>⋮</b> → <b>Instalar Central diag</b>.', 'No celular: abra o endereço abaixo e siga o passo a passo que aparece lá.'];
  const d = document.createElement('dialog');
  d.className = 'dlg dlg-largo';
  d.innerHTML = `<h2>Instalar a Central diag</h2>
    <p>Instalada, ela abre como um app (ícone na tela inicial, tela cheia). <b>Impressoras, SELBs e Suprimentos</b> funcionam mesmo sem conexão com o servidor: o que você alterar fica guardado e é enviado quando a conexão voltar.</p>
    <ol class="inst-passos">${passos.map(x => `<li>${x}</li>`).join('')}</ol>
    <label>Endereço para abrir no celular <span class="inst-end"><input id="instEnd" value="${esc(endereco)}" readonly><button type="button" class="btn ghost small" id="instCopiar">Copiar</button></span></label>
    ${seguro ? '' : `<div class="inst-alerta"><b>Atenção: este endereço é http (sem cadeado).</b> Nele o navegador só cria um atalho: o app precisa do servidor para abrir e o modo offline funciona só com a página já aberta.
      Para instalar de verdade, a Central precisa ser acessada por <b>HTTPS</b>.
      ${ehIOS() ? '' : `<br>Alternativa no <b>Android</b> (Chrome): abra <code>chrome://flags</code>, procure <b>Insecure origins treated as secure</b>, adicione <code>${esc(location.origin)}</code>, ative (<b>Enabled</b>) e toque em <b>Relaunch</b>. Depois volte aqui e instale.`}</div>`}
    <div class="dlg-actions"><button type="button" class="btn" id="instOk">Entendi</button></div>`;
  document.body.appendChild(d);
  d.addEventListener('close', () => d.remove());
  d.querySelector('#instOk').onclick = () => d.close();
  d.querySelector('#instCopiar').onclick = async e => {
    const i = d.querySelector('#instEnd');
    try { await navigator.clipboard.writeText(i.value); } catch { i.select(); document.execCommand && document.execCommand('copy'); }
    e.target.textContent = 'Copiado';
  };
  d.showModal();
}

document.addEventListener('DOMContentLoaded', () => {
  const b = document.getElementById('btnInstalar');
  if (b) b.addEventListener('click', instalarApp);
  atualizarInstalar();
});
if (document.readyState !== 'loading') { const b = document.getElementById('btnInstalar'); if (b) b.addEventListener('click', instalarApp); atualizarInstalar(); }

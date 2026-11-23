'use strict';
/*
  Tema claro / escuro / automático (segue o sistema).
  Carregado no <head> para aplicar o tema antes de desenhar a página (sem "piscar").
  Botões com o atributo data-tema-btn alternam: Automático -> Claro -> Escuro.
  A escolha fica no navegador (localStorage). Na impressão usa sempre o claro.
*/
(() => {
  const CHAVE = 'diagTema', html = document.documentElement;
  const ROTULO = { auto: 'Automático (segue o sistema)', light: 'Claro', dark: 'Escuro' };
  const svg = d => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICONE = {
    auto: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/>'),
    light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>'),
    dark: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
  };
  const PROXIMO = { auto: 'light', light: 'dark', dark: 'auto' };
  let tema = 'auto';
  try { tema = localStorage.getItem(CHAVE) || 'auto'; } catch { /* sem storage: automático */ }
  if (!ROTULO[tema]) tema = 'auto';
  const aplicar = t => { if (t === 'auto') html.removeAttribute('data-theme'); else html.setAttribute('data-theme', t); };
  aplicar(tema);

  const pintar = () => document.querySelectorAll('[data-tema-btn]').forEach(b => {
    b.innerHTML = ICONE[tema];
    b.title = `Tema: ${ROTULO[tema]}. Clique para trocar.`;
    b.setAttribute('aria-label', b.title);
  });
  document.addEventListener('DOMContentLoaded', () => {
    pintar();
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-tema-btn]');
      if (!btn) return;
      tema = PROXIMO[tema];
      try { localStorage.setItem(CHAVE, tema); } catch { /* só nesta página */ }
      trocar(btn);
    });
  });
  // transição: o novo tema "se espalha" em círculo a partir do botão (View Transitions API).
  // Sem suporte (ou com "reduzir movimento"), as cores mudam suavemente por CSS.
  function trocar(btn) {
    const mudar = () => { aplicar(tema); pintar(); };
    const reduzir = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!document.startViewTransition || reduzir) {
      if (!reduzir) html.classList.add('tema-trocando');
      mudar();
      setTimeout(() => html.classList.remove('tema-trocando'), 450);
      return;
    }
    const r = btn.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const raio = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const vt = document.startViewTransition(mudar);
    vt.ready.then(() => html.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${raio}px at ${x}px ${y}px)`] },
      { duration: 520, easing: 'cubic-bezier(.4, 0, .2, 1)', pseudoElement: '::view-transition-new(root)' },
    )).catch(() => {});
  }

  // impressão sempre clara
  window.addEventListener('beforeprint', () => html.setAttribute('data-theme', 'light'));
  window.addEventListener('afterprint', () => aplicar(tema));
})();

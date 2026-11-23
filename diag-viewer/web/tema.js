'use strict';
/*
  Tema claro / escuro / automático (segue o sistema).
  Carregado no <head> para aplicar o tema antes de desenhar a página (sem "piscar").
  Botões com o atributo data-tema-btn alternam: Automático -> Claro -> Escuro.
  A escolha fica no navegador (localStorage). Na impressão usa sempre o claro.
*/
(() => {
  const CHAVE = 'diagTema', html = document.documentElement;
  const ROTULO = { auto: '◐ Automático', light: '☀ Claro', dark: '☾ Escuro' };
  const PROXIMO = { auto: 'light', light: 'dark', dark: 'auto' };
  let tema = 'auto';
  try { tema = localStorage.getItem(CHAVE) || 'auto'; } catch { /* sem storage: automático */ }
  if (!ROTULO[tema]) tema = 'auto';
  const aplicar = t => { if (t === 'auto') html.removeAttribute('data-theme'); else html.setAttribute('data-theme', t); };
  aplicar(tema);

  const pintar = () => document.querySelectorAll('[data-tema-btn]').forEach(b => {
    b.textContent = ROTULO[tema];
    b.title = `Tema: ${ROTULO[tema].slice(2)}. Clique para trocar.`;
    b.setAttribute('aria-label', b.title);
  });
  document.addEventListener('DOMContentLoaded', () => {
    pintar();
    document.addEventListener('click', e => {
      if (!e.target.closest('[data-tema-btn]')) return;
      tema = PROXIMO[tema];
      try { localStorage.setItem(CHAVE, tema); } catch { /* só nesta página */ }
      aplicar(tema); pintar();
    });
  });
  // impressão sempre clara
  window.addEventListener('beforeprint', () => html.setAttribute('data-theme', 'light'));
  window.addEventListener('afterprint', () => aplicar(tema));
})();

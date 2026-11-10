(function () {
  let tok = '', pendente = null;
  try { tok = sessionStorage.getItem('diagReadToken') || ''; } catch (e) { /* sem storage */ }
  const box = document.getElementById('tokBox'), inp = document.getElementById('tok'), msg = document.getElementById('msg');
  const err = t => { msg.textContent = t; msg.hidden = !t; };

  async function baixar(tipo) {
    err('');
    const url = '../api/coleta/pacote.zip' + (tipo === 'diagnostico' ? '?tipo=diagnostico' : '');
    const nome = tipo === 'diagnostico' ? 'diag-diagnostico.zip' : 'diag-remocao.zip';
    try {
      const r = await fetch(url, { headers: tok ? { 'X-Token': tok } : {}, cache: 'no-store' });
      if (r.status === 401) {
        pendente = tipo; box.hidden = false; inp.focus();
        err(tok ? 'Token recusado.' : 'Informe o token de leitura do servidor.');
        return;
      }
      if (!r.ok) { err('Não foi possível gerar o pacote (' + r.status + ').'); return; }
      const obj = URL.createObjectURL(await r.blob());
      const a = document.createElement('a'); a.href = obj; a.download = nome;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(obj), 5000);
      box.hidden = true; pendente = null;
    } catch (e) { err('Servidor indisponível. Abra esta página pelo endereço do servidor.'); }
  }
  document.querySelectorAll('[data-pacote]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); baixar(b.dataset.pacote); }));
  const ok = () => { tok = inp.value.trim(); try { sessionStorage.setItem('diagReadToken', tok); } catch (e) {} baixar(pendente || 'diagnostico'); };
  document.getElementById('tokOk').addEventListener('click', ok);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
})();

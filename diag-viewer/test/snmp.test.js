'use strict';
// node diag-viewer/test/snmp.test.js — cliente SNMP (snmp.js) contra um agente SNMP mínimo, sem rede externa
const assert = require('assert'), dgram = require('dgram');
const snmp = require('../snmp.js'), { decodificar, oid, int, tlv, seq } = snmp._ber;

// agente: responde GetNext (v1/v2c) e GetBulk (v2c) a partir de uma tabela ordenada
// maxVbs: descarta respostas com mais valores (simula rede que perde UDP fragmentado); tooBig: responde erro 1
// mudo: nunca responde; pedidos: conta os pedidos recebidos
function agente(tabela, { comunidade = 'public', soV1 = false, maxVbs = 0, tooBig = 0, mudo = false } = {}) {
  const ordem = o => o.split('.').map(Number);
  const cmp = (a, b) => { const x = ordem(a), y = ordem(b); for (let k = 0; k < Math.min(x.length, y.length); k++) if (x[k] !== y[k]) return x[k] - y[k]; return x.length - y.length; };
  const t = [...tabela].sort((a, b) => cmp(a[0], b[0]));
  const prox = o => t.find(([x]) => cmp(x, o) > 0);
  const valor = ([, tipo, v]) => tipo === 's' ? tlv(0x04, Buffer.from(v)) : int(v);
  const sock = dgram.createSocket('udp4');
  sock.on('message', (buf, rinfo) => {
    // versão e comunidade: 1º e 2º campos da SEQUENCE (o tamanho pode ocupar 1 ou mais bytes)
    const tam = p => (buf[p + 1] & 0x80 ? { ini: p + 2 + (buf[p + 1] & 0x7f), n: buf.readUIntBE(p + 2, buf[p + 1] & 0x7f) } : { ini: p + 2, n: buf[p + 1] });
    let versao, com, req;
    try {
      const raiz = tam(0), v = tam(raiz.ini), c = tam(v.ini + v.n);
      versao = buf[v.ini]; com = buf.subarray(c.ini, c.ini + c.n).toString(); req = decodificar(buf);
    } catch { return; }
    sock.pedidos = (sock.pedidos || 0) + 1;
    if (mudo || com !== comunidade || (soV1 && versao !== 0)) return; // comunidade errada / versão não suportada: silêncio
    const vbs = [];
    if (req.tipo === 0xa1) for (const vb of req.vbs) { const n = prox(vb.oid); vbs.push(n ? seq(oid(n[0]), valor(n)) : seq(oid(vb.oid), Buffer.from([0x82, 0]))); }
    if (req.tipo === 0xa5) {
      const atuais = req.vbs.map(vb => vb.oid), maxRep = Math.min(req.indice, 50);
      for (let r = 0; r < maxRep; r++) atuais.forEach((o, k) => { const n = o && prox(o); atuais[k] = n ? n[0] : null; vbs.push(n ? seq(oid(n[0]), valor(n)) : seq(oid(o || '1.3'), Buffer.from([0x82, 0]))); });
    }
    if (maxVbs && vbs.length > maxVbs) return;
    const grande = tooBig && vbs.length > tooBig;
    const resp = seq(int(versao), tlv(0x04, Buffer.from(com)), tlv(0xa2, Buffer.concat([int(req.id), int(grande ? 1 : 0), int(0), seq(...(grande ? [] : vbs))])));
    sock.send(resp, rinfo.port, rinfo.address);
  });
  return new Promise(ok => sock.bind(0, '127.0.0.1', () => ok(sock)));
}

const B = '1.3.6.1.2.1.43.11.1.1';
const brother = [
  ['1.3.6.1.2.1.1.1.0', 's', 'Brother NC-8300w'], ['1.3.6.1.2.1.25.3.2.1.3.1', 's', 'Brother HL-L5100DN series'], ['1.3.6.1.2.1.43.5.1.1.17.1', 's', 'E78ABC'],
  [`${B}.3.1.1`, 'i', 1], [`${B}.4.1.1`, 'i', 3], [`${B}.5.1.1`, 'i', 21], [`${B}.6.1.1`, 's', 'Black Toner Cartridge'], [`${B}.8.1.1`, 'i', 100], [`${B}.9.1.1`, 'i', 12],
  [`${B}.3.1.2`, 'i', 0], [`${B}.4.1.2`, 'i', 3], [`${B}.5.1.2`, 'i', 9], [`${B}.6.1.2`, 's', 'Drum Unit'], [`${B}.8.1.2`, 'i', 30000], [`${B}.9.1.2`, 'i', 21000],
  [`${B}.3.1.3`, 'i', 0], [`${B}.4.1.3`, 'i', 4], [`${B}.5.1.3`, 'i', 8], [`${B}.6.1.3`, 's', 'Maintenance Box'], [`${B}.8.1.3`, 'i', 100], [`${B}.9.1.3`, 'i', 92],
  ['1.3.6.1.2.1.43.12.1.1.4.1.1', 's', 'black'], ['1.3.6.1.2.1.99.1', 'i', 7],
];

(async () => {
  // v2c (GetBulk)
  const a1 = await agente(brother);
  const r = await snmp.lerSuprimentos('127.0.0.1', 'public', { porta: a1.address().port, timeout: 500 });
  assert.strictEqual(r.versao, 'v2c');
  assert.strictEqual(r.modelo, 'Brother HL-L5100DN series');
  assert.strictEqual(r.serie, 'E78ABC');
  const por = Object.fromEntries(r.itens.map(i => [i.desc, i]));
  assert.deepStrictEqual([por['Black Toner Cartridge'].item, por['Black Toner Cartridge'].pct, por['Black Toner Cartridge'].estado], ['preto', 12, 'baixo']);
  assert.strictEqual(snmp.LIMITE_BAIXO, 25);
  assert.deepStrictEqual([por['Drum Unit'].item, por['Drum Unit'].pct], ['outro', 70]);
  // caixa de manutenção lida como vida útil: 92% = quase nova
  assert.deepStrictEqual([por['Maintenance Box'].item, por['Maintenance Box'].pct, por['Maintenance Box'].estado, por['Maintenance Box'].receptaculo], ['caixa', 92, 'ok', true]);
  // comunidade errada: sem resposta
  await assert.rejects(snmp.lerSuprimentos('127.0.0.1', 'errada', { porta: a1.address().port, timeout: 200, repeticoes: 0 }), /sem resposta/);
  a1.close();
  // agente só v1: cai para GetNext
  const a2 = await agente(brother, { soV1: true });
  const r2 = await snmp.lerSuprimentos('127.0.0.1', 'public', { porta: a2.address().port, timeout: 200, repeticoes: 0 });
  assert.strictEqual(r2.versao, 'v1');
  assert.strictEqual(r2.itens.length, 3);
  a2.close();
  // rede que descarta respostas grandes: reduz o tamanho e continua em v2c, com os mesmos dados
  for (const o of [{ maxVbs: 9 }, { tooBig: 5 }]) {
    const a = await agente(brother, o);
    const rr = await snmp.lerSuprimentos('127.0.0.1', 'public', { porta: a.address().port, timeout: 150, repeticoes: 0 });
    assert.strictEqual(rr.versao, 'v2c', JSON.stringify(o));
    assert.strictEqual(rr.itens.length, 3, JSON.stringify(o));
    assert.strictEqual(rr.modelo, 'Brother HL-L5100DN series');
    a.close();
  }
  // nunca responde: erro marcado como "nenhuma resposta" (para o diagnóstico), poucos pedidos
  const a3 = await agente(brother, { mudo: true });
  const e3 = await snmp.lerSuprimentos('127.0.0.1', 'public', { porta: a3.address().port, timeout: 100, repeticoes: 0 }).catch(e => e);
  assert.match(e3.message, /sem resposta/); assert.strictEqual(e3.nenhumaResposta, true);
  assert.ok(a3.pedidos <= 3, 'pedidos: ' + a3.pedidos);
  a3.close();
  // sonda: responde (v2c / só v1) ou não
  const a4 = await agente(brother, { soV1: true });
  assert.deepStrictEqual(await snmp.sondar('127.0.0.1', 'public', { porta: a4.address().port, timeout: 150, repeticoes: 0 }), { versao: 'v1', sysDescr: 'Brother NC-8300w' });
  assert.strictEqual(await snmp.sondar('127.0.0.1', 'outra', { porta: a4.address().port, timeout: 100, repeticoes: 0 }), null);
  a4.close();
  // classificação por nome/cor
  assert.strictEqual(snmp.classificar('Toner Cyan', '', 3, 3), 'azul');
  assert.strictEqual(snmp.classificar('Cartucho de tinta', 'yellow', 3, 6), 'amarelo');
  assert.strictEqual(snmp.classificar('Waste Toner Bottle', '', 4, 4), 'caixa');
  assert.strictEqual(snmp.classificar('Fuser Unit', '', 3, 15), 'outro');
  for (const nome of ['Used Toner Bottle', 'Ink Collector Unit', 'Ink Absorber', 'Caixa de manutenção', 'Waste Ink Pad']) assert.strictEqual(snmp.classificar(nome, '', 3, 1), 'caixa', nome);
  // código do cartucho a partir do nome
  assert.strictEqual(snmp.codigoDe('Black Toner Cartridge TN-3472'), 'TN-3472');
  assert.strictEqual(snmp.codigoDe('Black Cartridge HP 26A CF226A'), 'CF226A');
  assert.strictEqual(snmp.codigoDe('Black Ink T544120'), 'T544120');
  assert.strictEqual(snmp.codigoDe('Print Cartridge Black SP C252HA'), 'C252HA');
  assert.strictEqual(snmp.codigoDe('Black Toner Cartridge'), '');
  assert.strictEqual(snmp.codigoDe('Maintenance Box C9345'), 'C9345');
  console.log('snmp: ok');
})().catch(e => { console.error(e); process.exit(1); });

'use strict';
// node diag-viewer/test/snmp.test.js — cliente SNMP (snmp.js) contra um agente SNMP mínimo, sem rede externa
const assert = require('assert'), dgram = require('dgram');
const snmp = require('../snmp.js'), { decodificar, oid, int, tlv, seq } = snmp._ber;

// agente: responde GetNext (v1/v2c) e GetBulk (v2c) a partir de uma tabela ordenada
function agente(tabela, { comunidade = 'public', soV1 = false } = {}) {
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
    if (com !== comunidade || (soV1 && versao !== 0)) return; // comunidade errada / versão não suportada: silêncio
    const vbs = [];
    if (req.tipo === 0xa1) for (const vb of req.vbs) { const n = prox(vb.oid); vbs.push(n ? seq(oid(n[0]), valor(n)) : seq(oid(vb.oid), Buffer.from([0x82, 0]))); }
    if (req.tipo === 0xa5) {
      const atuais = req.vbs.map(vb => vb.oid), maxRep = Math.min(req.vbs.length ? 10 : 0, 10);
      for (let r = 0; r < maxRep; r++) atuais.forEach((o, k) => { const n = o && prox(o); atuais[k] = n ? n[0] : null; vbs.push(n ? seq(oid(n[0]), valor(n)) : seq(oid(o || '1.3'), Buffer.from([0x82, 0]))); });
    }
    const resp = seq(int(versao), tlv(0x04, Buffer.from(com)), tlv(0xa2, Buffer.concat([int(req.id), int(0), int(0), seq(...vbs)])));
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
  assert.deepStrictEqual([por['Drum Unit'].item, por['Drum Unit'].pct], ['outro', 70]);
  assert.deepStrictEqual([por['Maintenance Box'].item, por['Maintenance Box'].pct, por['Maintenance Box'].estado, por['Maintenance Box'].receptaculo], ['caixa', 92, 'cheia', true]);
  // comunidade errada: sem resposta
  await assert.rejects(snmp.lerSuprimentos('127.0.0.1', 'errada', { porta: a1.address().port, timeout: 200, repeticoes: 0 }), /sem resposta/);
  a1.close();
  // agente só v1: cai para GetNext
  const a2 = await agente(brother, { soV1: true });
  const r2 = await snmp.lerSuprimentos('127.0.0.1', 'public', { porta: a2.address().port, timeout: 200, repeticoes: 0 });
  assert.strictEqual(r2.versao, 'v1');
  assert.strictEqual(r2.itens.length, 3);
  a2.close();
  // classificação por nome/cor
  assert.strictEqual(snmp.classificar('Toner Cyan', '', 3, 3), 'azul');
  assert.strictEqual(snmp.classificar('Cartucho de tinta', 'yellow', 3, 6), 'amarelo');
  assert.strictEqual(snmp.classificar('Waste Toner Bottle', '', 4, 4), 'caixa');
  assert.strictEqual(snmp.classificar('Fuser Unit', '', 3, 15), 'outro');
  console.log('snmp: ok');
})().catch(e => { console.error(e); process.exit(1); });

'use strict';
// node diag-viewer/test/sensores.test.js — confere as regras de sensores de web/saude.js
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const ctx = vm.createContext({ console, esc: x => String(x), fmt: x => String(x), parseDate: () => null });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/saude.js'), 'utf8') + '\nthis.T = { tensaoNominal, analisarSensores, testesAutomaticos };', ctx);
const { tensaoNominal, analisarSensores, testesAutomaticos } = ctx.T;

assert.strictEqual(tensaoNominal('+12V'), 12);
assert.strictEqual(tensaoNominal('+3.3V'), 3.3);
assert.strictEqual(tensaoNominal('+5V'), 5);
assert.strictEqual(tensaoNominal('5VSB'), null);
assert.strictEqual(tensaoNominal('Vcore'), null);
assert.strictEqual(tensaoNominal('Voltage #12'), null);

const it = (hw, hwTipo, tipo, nome, inicial, min, max, faseMax = 'estresse') => ({ hw, hwTipo, tipo, nome, inicial, min, max, faseMax });
const s = { sensores: { itens: [
  it('NCT6798D', 'SuperIO', 'tensao', '+12V', 12.0, 11.2, 12.1),      // -6,7%: alerta
  it('NCT6798D', 'SuperIO', 'tensao', '+5V', 5.0, 4.95, 5.05),        // ok
  it('Ryzen 5', 'Cpu', 'temperatura', 'Core (Tctl/Tdie)', 45, 44, 97), // grave
  it('RTX 3070', 'GpuNvidia', 'temperatura', 'GPU Core', 40, 40, 70),  // ok
  it('NCT6798D', 'SuperIO', 'ventoinha', 'Fan #1', 900, 0, 1500),      // parou: alerta
  it('RTX 3070', 'GpuNvidia', 'ventoinha', 'GPU Fan', 0, 0, 1800),     // 0 RPM em repouso é normal
] } };
const a = analisarSensores(s);
assert.strictEqual(a.map(x => x.nivel).sort().join(), 'alerta,alerta,grave');
assert.ok(a.some(x => /\+12V/.test(x.texto)) && a.some(x => /97 °C/.test(x.texto)) && a.some(x => /Fan #1/.test(x.texto)));
assert.strictEqual(analisarSensores({}).length, 0);

s.profundo = { testes: { benchmark: { cpuMono: 50, cpuMulti: 500, threads: 12, escala: 10, errosCalculo: 0, memoriaMBs: 9000, disco: { unidade: 'C:', escritaMBs: 20, leituraMBs: 40, leitura4kIops: 90 } } } };
const t = testesAutomaticos(s);
assert.strictEqual(t.find(x => /Benchmark/.test(x.nome)).resultado, 'alerta'); // disco lento
assert.strictEqual(t.find(x => x.sensores).resultado, 'falha');
console.log('ok');
assert.strictEqual(tensaoNominal('Core #5 VID'), null);
assert.strictEqual(tensaoNominal('+12V Rail'), 12);
assert.strictEqual(analisarSensores({ sensores: { itens: [it('Ryzen 5', 'Cpu', 'tensao', '+5V', 1.5, 1.5, 1.5)] } }).length, 0);
console.log('ok 2');

'use strict';
// node diag-viewer/test/recebimentos.test.js — confere web/receb-ocr.js (grade, homografia, CPF, datas)
const assert = require('assert');
const O = require('../web/receb-ocr.js');

// CPF
assert.ok(O.cpfValido('52998224725'));
assert.ok(!O.cpfValido('52998224724'));
assert.ok(!O.cpfValido('11111111111'));
assert.deepStrictEqual(O.limparCpf('529 982 247-25'), { valor: '529.982.247-25', ok: true, digitos: '52998224725' });
assert.strictEqual(O.limparCpf('S29.982.Z47-2S').ok, true);          // letras confundidas pelo OCR
assert.strictEqual(O.limparCpf('529.982.247').ok, false);

// datas
assert.strictEqual(O.limparData('12/11/2026').valor, '12/11/2026');
assert.strictEqual(O.limparData('3/1/26').valor, '03/01/2026');
assert.strictEqual(O.limparData('121126').iso, '2026-11-12');
assert.strictEqual(O.limparData('12/11', 2025).iso, '2025-11-12');
assert.strictEqual(O.limparData('31/02/2026').ok, false);
assert.strictEqual(O.limparTexto(' | maria  da silva_ '), 'maria da silva');

// homografia: ida e volta
const H = O.homografia([[0, 0], [100, 0], [100, 50], [0, 50]], [[10, 20], [210, 35], [190, 140], [5, 120]]);
const [x, y] = O.aplicar(H, 100, 50);
assert.ok(Math.abs(x - 190) < 1e-6 && Math.abs(y - 140) < 1e-6);

// grade sintética: 6 linhas x 5 colunas, um pouco girada, com uma célula "escrita"
const W = 900, Hh = 600, g = new Uint8Array(W * Hh).fill(225);
const cols = [100, 180, 260, 520, 640, 800], rows = [100, 160, 220, 280, 340, 400, 460];
const rot = (px, py) => [px + (py - 100) * 0.03, py - (px - 100) * 0.03];
const ponto = (px, py) => { const [a, b] = rot(px, py).map(Math.round); for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) if (a + dx >= 0 && a + dx < W && b + dy >= 0 && b + dy < Hh) g[(b + dy) * W + a + dx] = 30; };
for (const r of rows) for (let px = cols[0]; px <= cols[5]; px++) ponto(px, r);
for (const c of cols) for (let py = rows[0]; py <= rows[6]; py++) ponto(c, py);
for (let k = 0; k < 40; k++) for (let t = 0; t < 30; t++) ponto(280 + k * 5 + (t % 3), 235 + (t * 0.7 | 0));  // "texto" na linha 2, coluna 3
const img = { g, w: W, h: Hh };
const cantos = O.detectarCantos(img);
assert.ok(cantos, 'achou a grade');
const esperado = [rot(100, 100), rot(800, 100), rot(800, 460), rot(100, 460)];
cantos.forEach((c, i) => assert.ok(Math.hypot(c[0] - esperado[i][0], c[1] - esperado[i][1]) < 8, `canto ${i}: ${c} vs ${esperado[i]}`));
const R = O.retificar(img, cantos, 0);
const G = O.analisarGrade(R);
assert.strictEqual(G.cols.length - 1, 5, 'colunas: ' + G.cols);
assert.strictEqual(G.rows.length - 1, 6, 'linhas: ' + G.rows);
const cheias = [];
for (let r = 0; r < 6; r++) for (let c = 0; c < 5; c++) if (O.temConteudo(O.tinta(G, R, O.celula(G, r, c)))) cheias.push(`${r},${c}`);
assert.deepStrictEqual(cheias, ['2,2']);
console.log('recebimentos: ok');

// correção pela lista de valores já cadastrados
const locais = ['SALA 204 BLOCO B', 'ALMOXARIFADO', 'RECEPÇÃO'];
assert.strictEqual(O.sugerir('ALMOXARIFAD0', locais).valor, 'ALMOXARIFADO');
assert.strictEqual(O.sugerir('RECEPCAO', locais).valor, 'RECEPÇÃO');
assert.strictEqual(O.sugerir('SALA 2O4 BL0CO B', locais).valor, 'SALA 204 BLOCO B');
assert.strictEqual(O.sugerir('DIRETORIA', locais), null);
assert.ok(O.similaridade('abc', 'ABC') === 1 && O.similaridade('', 'x') === 0);
console.log('recebimentos (sugestões): ok');

// vários SELBs na mesma entrega
assert.deepStrictEqual(O.separarSelbs('A123, A124'), ['A123', 'A124']);
assert.deepStrictEqual(O.separarSelbs('A123; a124 + B77'), ['A123', 'a124', 'B77']);
assert.deepStrictEqual(O.separarSelbs('A123 e A124'), ['A123', 'A124']);
assert.deepStrictEqual(O.separarSelbs('A123 A124'), ['A123', 'A124']);
assert.deepStrictEqual(O.separarSelbs('B7 7'), ['B7 7']);                 // espaço dentro de um SELB
assert.deepStrictEqual(O.separarSelbs('A123, a123'), ['A123']);            // sem repetidos
assert.deepStrictEqual(O.separarSelbs(''), []);
assert.ok(O.temSelb('A123, B77', 'b-77') && !O.temSelb('A123, B77', 'B7'));
assert.strictEqual(O.juntarSelbs(['A1', 'B2']), 'A1, B2');
console.log('recebimentos (vários SELBs): ok');

// leitura de datas com barra perdida ou dígito trocado
assert.strictEqual(O.limparData('1111/2026').iso, '2026-11-11');
assert.strictEqual(O.limparData('1802/2026').iso, '2026-02-18');
assert.strictEqual(O.limparData('25/68/26').iso, '2026-08-25');
assert.ok(O.limparData('25/68/26').corrigida);
assert.strictEqual(O.limparData('14/09/202', 2026).iso, '2026-09-14');
assert.strictEqual(O.limparData('99/99/9999').ok, false);
// SELB: ". " separa; formato aprendido corrige letra/dígito
assert.deepStrictEqual(O.separarSelbs('B1 686. D4535'), ['B1 686', 'D4535']);
const fmt = O.formatoSelb(['A1234', 'B2345', 'C3456', 'D4567', 'F5678', 'XX1']);
assert.deepStrictEqual(fmt, { letras: 1, digitos: 4 });
assert.strictEqual(O.ajustarAoFormato('A2A17', fmt), 'A2417');
assert.strictEqual(O.ajustarAoFormato('AG691', fmt), 'A6691');
assert.strictEqual(O.ajustarAoFormato('8123', fmt), '8123');          // tamanho diferente: não mexe
assert.strictEqual(O.formatoSelb(['A1', 'B22']), null);                // poucos exemplos
console.log('recebimentos (datas e formato de SELB): ok');

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseNotice, parseStatement, forMonth, futureTotal, candidates, statementTextRows} from './dist/ledger.mjs';

test('alerta omisso mantém parcelas pendentes', () => {
  assert.deepEqual(parseNotice('Compra de R$ 180,00 em Mercado'), {
    name:'Mercado', cents:18000, count:null, part:1
  });
  assert.equal(parseNotice('Compra de R$ 180,00 em Mercado em 6x').count,6);
});

test('alerta identifica Itaú e preserva o estabelecimento antes da data', () => {
  assert.deepEqual(parseNotice('Itaú: Compra aprovada no valor de R$ 120,90 na loja Exemplo em 24/11/2026 em 3 vezes.'), {
    name:'Exemplo', cents:12090, count:3, part:1, bank:'Itaú', date:'2026-11-24'
  });
});

test('fatura digitalizada aceita espaços na data e no valor e preserva o sinal', () => {
  const [entry] = parseStatement(['04 / 11 Loja 02/03 R$ − 15, 90'], '2026-11', 'CAIXA');
  assert.equal(entry.cents, -1590);
  assert.equal(entry.part, 2);
});

test('fatura CAIXA separa duas compras na mesma altura e ignora cidade e valor em dólar', () => {
  const item = (str, x, width) => ({str, width, transform:[1, 0, 0, 1, x, 100]});
  const items = [
    item('02/11', 35, 15), item('Mercado 02/04', 55, 50), item('São Paulo', 151, 35),
    item('12,00', 220, 18), item('160,00D', 259, 28),
    item('03/11', 311, 15), item('Estorno Exemplo', 331, 50), item('45,90C', 537, 29)
  ];
  const entries = parseStatement(statementTextRows(items, 595, 'CAIXA'), '2026-11', 'CAIXA');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(({name, cents, part}) => [name, cents, part]), [
    ['Mercado', 16000, 2], ['Estorno Exemplo', -4590, 1]
  ]);
});

test('fatura reconhece a parcela atual e projeta apenas as seguintes', () => {
  const [entry] = parseStatement(['21/12 Mercado 03/06 30,00','22/12 Pagamento da fatura -180,00'],'2026-01','Itaú');
  assert.equal(entry.date,'2025-12-21');
  assert.deepEqual(forMonth(entry,'2026-01'),{part:3,cents:3000});
  assert.equal(forMonth(entry,'2025-12'),null);
  assert.equal(futureTotal(entry,'2026-01'),9000);
  assert.equal(forMonth(entry,'2026-05'),null);
});

test('parcela da fatura pode corresponder ao valor total do alerta', () => {
  const notice = {...parseNotice('Compra de R$ 180,00 em Mercado'),date:'2026-01-21',bank:'CAIXA',month:'2026-01'};
  const [entry] = parseStatement(['21/01 Mercado 01/06 30,00'],'2026-02','CAIXA');
  assert.deepEqual(candidates([notice],entry),[notice]);
  assert.deepEqual(candidates([{...notice,bank:'Itaú'}],entry),[]);
});

test('distribui os centavos sem alterar o total', () => {
  const entry = {month:'2026-01',count:3,part:1,cents:10000};
  assert.equal(forMonth(entry,'2026-01').cents,3334);
  assert.equal(futureTotal(entry,'2026-01'),6666);
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseNotice, parseStatement, forMonth, futureTotal, candidates} from './dist/ledger.mjs';

test('alerta omisso mantém parcelas pendentes', () => {
  assert.deepEqual(parseNotice('Compra de R$ 180,00 em Mercado'), {
    name:'Mercado', cents:18000, count:null, part:1
  });
  assert.equal(parseNotice('Compra de R$ 180,00 em Mercado em 6x').count,6);
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

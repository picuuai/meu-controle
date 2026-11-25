import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseNotice, parseStatement, forMonth, futureTotal, candidates, statementTextRows} from './dist/ledger.mjs';
import {identifyStatementRows, importStatementRows, installmentCount, applyStatementForecast,
  statementDueDate, statementReferenceMonth} from './dist/ledger.mjs';
import {suggestCategory} from './dist/dashboard.mjs';

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

test('lote preserva compras idênticas e ignora as mesmas linhas ao reimportar', () => {
  const rows = identifyStatementRows(parseStatement(['04/11 Mercado 15,90', '04/11 Mercado 15,90'], '2026-11', 'CAIXA'));
  let id = 0;
  const allocate = () => String(++id);
  const first = importStatementRows([], [rows[1]], allocate, 1);
  const second = importStatementRows(first.entries, rows, allocate, 2);
  assert.equal(second.added, 1);
  assert.equal(second.duplicates, 1);
  assert.deepEqual([...second.alreadyRecorded], [rows[1]]);
  const repeated = importStatementRows(second.entries, rows, allocate, 3);
  assert.deepEqual(repeated.entries, second.entries);
  assert.equal(repeated.duplicates, 2);
  const legacy = {...first.entries[0], statementKey: undefined};
  const visible = importStatementRows([legacy], rows, allocate, 4);
  assert.deepEqual([...visible.alreadyRecorded], [rows[0]]);
  const selected = importStatementRows([legacy], rows, allocate, 4, new Set([rows[1]]));
  assert.equal(selected.added, 1);
});

test('lote concilia uma compra confirmada e deixa conflitos para revisão', () => {
  const notice = {id:'alert', name:'Loja', cents:9000, bank:'Itaú', date:'2026-10-05', month:'2026-10', part:1, count:null, category:'Compras'};
  const rows = identifyStatementRows(parseStatement(['05/10 Loja 02/03 30,00'], '2026-11', 'Itaú'));
  const result = importStatementRows([notice], rows, () => 'novo', 1);
  assert.equal(result.updated, 1);
  assert.equal(result.entries[0].id, notice.id);
  assert.equal(result.entries[0].category, notice.category);
  assert.equal(forMonth(result.entries[0], '2026-12').cents, 3000);
  const ambiguous = importStatementRows([notice, {...notice, id:'outro'}], rows, () => 'novo', 1);
  assert.equal(ambiguous.pending.length, 1);
  assert.equal(ambiguous.entries.length, 2);
});

test('parcela listada na próxima fatura fica no mês seguinte e só é gravada se ainda não estiver projetada', () => {
  const parsed = parseStatement([
    '05/12 Loja 01/03 30,00',
    'Compras parceladas - próximas faturas',
    '05/12 Loja 02/03 30,00',
    '08/12 Outra loja 01/02 20,00',
    'Próxima fatura 50,00'
  ], '2026-12', 'Itaú');
  assert.deepEqual(parsed.map(({month, part}) => [month, part]), [['2026-12',1],['2027-01',2],['2027-01',1]]);
  const rows = identifyStatementRows(parsed);
  let id = 0;
  const result = importStatementRows([], rows, () => String(++id), 1, new Set(rows));
  assert.equal(result.added, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.entries.filter(entry => forMonth(entry,'2026-12')).length,1);
  assert.equal(result.entries.reduce((total, entry) => total + (forMonth(entry,'2027-01')?.cents || 0),0),5000);
});

test('Itaú inclui o IOF sem data e projeta os valores da seção que bate com os subtotais', () => {
  const controls = {};
  const parsed = parseStatement([
    '08/11 Loja 01/03 40,00',
    '08/11 Loja 02/03 40,00',
    '08/11 Loja 03/03 40,00',
    'Repasse de IOF em R$ 0,85',
    'Compras parceladas - próximas faturas',
    '10/11 Outra loja 01/02 20,00',
    'Pr ó xima fatura 20,00',
    'Total para pr ó ximas faturas 40,00'
  ], '2026-11', 'Itaú', controls);
  const rows = applyStatementForecast(parsed,'2026-11',controls);
  assert.equal(rows.filter(row => row.billOnly).length, 3);
  assert.equal(rows.find(row => row.dateIsReference).cents, 85);
  assert.equal(rows.reduce((sum,row) => sum + (forMonth(row,'2026-11')?.cents || 0),0),12085);
  assert.equal(rows.reduce((sum,row) => sum + futureTotal(row,'2026-11'),0),4000);
  assert.equal(applyStatementForecast(parsed,'2026-11',{...controls,futureCents:5000}),parsed);
});

test('reconhece vencimento em linha separada e confirma a parcela prevista sem duplicá-la', () => {
  const item = (str, x, y) => ({str, transform:[1,0,0,1,x,y]});
  assert.equal(statementDueDate([item('VENCIMENTO',475,800),item('02/12/2026',485,780)]), '2026-12-02');
  const [actual] = identifyStatementRows(parseStatement(['05/11 Loja 02/03 30,00'], '2026-12', 'Itaú'));
  const projected = {...actual, id:'previsto', projection:true, updatedAt:1};
  const result = importStatementRows([projected],[actual],()=>'novo',2,new Set([actual]));
  assert.equal(result.updated,1);
  assert.equal(result.entries.length,1);
  assert.equal(result.entries[0].projection,false);
});

test('Itaú usa o mês de emissão mesmo com vencimento no mês seguinte', () => {
  const item = (str, x, y) => ({str, transform:[1,0,0,1,x,y]});
  const items = [item('Vencimento: 01/12/2026',233,668), item('Emiss',244,661),
    item('o: 23/11/2026',261,661), item('Próx. Fechamento: 25/12/2026',226,653)];
  const due = statementDueDate(items);
  assert.equal(due,'2026-12-01');
  assert.equal(statementReferenceMonth(items,'Itaú','2026-12',due),'2026-11');
  assert.equal(statementReferenceMonth([], 'Itaú', '2026-11', due), '2026-11');
});

test('cabeçalho de próximas faturas pode começar em uma página e continuar na seguinte', () => {
  const item = (str, x, y, width = 20) => ({str, width, transform:[1,0,0,1,x,y]});
  const section = {};
  statementTextRows([item('Compras parceladas - próximas faturas',351,390)],595,'Itaú',section);
  const lines = statementTextRows([
    item('05/11',143,700), item('Loja 02/03',170,700), item('30,00',309,700),
    item('Próxima fatura',143,690), item('30,00',309,690)
  ],595,'Itaú',section);
  assert.equal(parseStatement(lines,'2026-11','Itaú')[0].month,'2026-12');
  assert.equal(section.nextBill,false);
});

test('CAIXA mantém a parcela do demonstrativo no mês da fatura', () => {
  const [entry] = parseStatement(['04/11 Mercado 02 DE 04 15,90D','05/11 OBRIGADO PELO PAGAMENTO 40,00C'], '2026-11', 'CAIXA');
  assert.deepEqual([entry.name, entry.month, entry.part, entry.count], ['Mercado','2026-11',2,4]);
});

test('previsão impressa da CAIXA é referência e não cria lançamento', () => {
  const controls = {};
  const rows = parseStatement([
    'Saldo previsto próxima fatura: R$2.307,69 (Contempla as despesas)',
    '04/11 Mercado 02 DE 04 15,90D'
  ], '2026-11', 'CAIXA', controls);
  assert.equal(controls.nextCents, 230769);
  assert.equal(rows.length, 1);
  assert.equal(forMonth(rows[0], '2026-12').cents, 1590);
  assert.equal(futureTotal(rows[0], '2026-12'), 1590);
});

test('sugestão usa categoria anterior e contempla nomes comuns no PDF', () => {
  assert.equal(suggestCategory('SUPERMERCADOS EXEMPLO'), 'Supermercado');
  assert.equal(suggestCategory('IFD*iFoodOSASCO'), 'Alimentação');
  assert.equal(suggestCategory('mercado exemplo', [{name:'MERCADO EXEMPLO', category:'Outros'}]), 'Outros');
});

test('compra sem parcela no PDF é à vista e mantém a chave dos lançamentos antigos', () => {
  const [row] = parseStatement(['04/11 Mercado 15,90D'], '2026-11', 'CAIXA');
  assert.equal(row.count, 1);
  assert.equal(installmentCount({...row, count:null}), 1);
  assert.equal(installmentCount({...row, count:null, name:'Mercado 02 DE 04'}), null);
  assert.equal(installmentCount({source:'alert', name:'Mercado', count:null}), null);
  assert.equal(identifyStatementRows([row])[0].statementKey, identifyStatementRows([{...row, count:null}])[0].statementKey);
});

test('parcela incompleta mantém o número lido e o valor do mês sem projetar parcelas', () => {
  const rows = parseStatement([
    '04/11 Mercado 03 DE 15,90D',
    '05/11 Outra loja 02 D E 04 20,00D',
    '06/11 Exemplo 05/03 25,00D'
  ], '2026-11', 'CAIXA');
  assert.deepEqual(rows.map(row => [row.part, installmentCount(row)]), [[3,null],[2,4],[5,null]]);
  assert.deepEqual(forMonth(rows[0], '2026-11'), {part:3,cents:1590});
  assert.equal(forMonth(rows[0], '2026-12'), null);
  assert.equal(futureTotal(rows[0], '2026-11'), 0);
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

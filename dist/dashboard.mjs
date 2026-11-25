import {forMonth} from './ledger.mjs';

export const uncategorized = 'Sem categoria';
export const categories = ['Alimentação', 'Supermercado', 'Transporte', 'Moradia e contas',
  'Saúde', 'Educação', 'Lazer', 'Compras', 'Assinaturas', 'Viagens', 'Tarifas e juros', 'Outros'];

const rules = [
  ['Supermercado', /\b(supermercado|hipermercado|atacadao|carrefour|assai)\b/],
  ['Alimentação', /\b(ifood|restaurante|lanchonete|padaria|pizzaria|hamburgueria)\b/],
  ['Transporte', /\b(uber|posto|combustivel|estacionamento|pedagio|gasolina)\b/],
  ['Moradia e contas', /\b(energia|condominio|aluguel|saneamento|internet)\b/],
  ['Saúde', /\b(farmacia|drogaria|clinica|dentista|laboratorio)\b/],
  ['Educação', /\b(escola|faculdade|universidade|curso)\b/],
  ['Lazer', /\b(cinema|teatro|show|parque)\b/],
  ['Assinaturas', /\b(netflix|spotify|disney|deezer)\b/],
  ['Viagens', /\b(hotel|pousada|latam|passagem|airbnb)\b/],
  ['Tarifas e juros', /\b(anuidade|tarifa|juros|iof)\b/]
];

export function suggestCategory(name) {
  const normalized = name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  return rules.find(([, pattern]) => pattern.test(normalized))?.[0] || '';
}

export function categoryOf(entry) {
  return categories.includes(entry.category) ? entry.category : uncategorized;
}

export function groupCharges(rows, group) {
  const totals = new Map();
  for (const {entry, bill} of rows) {
    const label = group(entry);
    totals.set(label, (totals.get(label) || 0) + bill.cents);
  }
  return [...totals].sort((a, b) => b[1] - a[1]);
}

export function monthlyCharges(entries, month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const base = year * 12 + monthNumber - 1;
  return Array.from({length: 6}, (_, index) => {
    const number = base - 5 + index;
    const year = Math.floor(number / 12);
    const month = String(number % 12 + 1).padStart(2, '0');
    const key = year + '-' + month;
    return [month + '/' + year, entries.reduce((sum, entry) => sum + (forMonth(entry, key)?.cents || 0), 0)];
  });
}

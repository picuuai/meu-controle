import {forMonth} from './ledger.mjs';

export const uncategorized = 'Sem categoria';
export const categories = ['Alimentação', 'Supermercado', 'Transporte', 'Moradia e contas',
  'Saúde', 'Educação', 'Lazer', 'Compras', 'Assinaturas', 'Viagens', 'Tarifas e juros', 'Outros'];

const rules = [
  ['Supermercado', /^sup\b|\b(supermercados?|hipermercados?|atacadao|carrefour|assai|horti\s*fruti|acougue)\b/],
  ['Alimentação', /ifood|\b(restaurantes?|lanchonetes?|padarias?|pizzas?|pizzaria|hamburgueria|churrascaria|cafeteria|sorveteria|subway)\b/],
  ['Transporte', /\b(uber|posto|rodoposto|combustivel|estacionamento|parking|pedagio|gasolina|autolubrificante)\b/],
  ['Moradia e contas', /\b(energia|condominio|aluguel|saneamento|internet)\b/],
  ['Saúde', /\b(farmacias?|pharmacia|drogarias?|drogasil|clinica|dentista|laboratorio)\b|\braia\d*/],
  ['Educação', /\b(escola|faculdade|universidade|curso)\b/],
  ['Lazer', /\b(cinema|teatro|show|parque)\b/],
  ['Assinaturas', /netflix|spotify|prime\s*video|google\s*one|\b(disney|deezer)\b/],
  ['Viagens', /\b(hotel|pousada|latam|passagem|airbnb)\b/],
  ['Tarifas e juros', /\b(anuidade|tarifa|juros|iof)\b/],
  ['Compras', /\b(sapataria|calcados|moda|aliexpress|mercado\s*livre)\b/]
];

const normalizeName = name => name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export function suggestCategory(name, previous = []) {
  const normalized = normalizeName(name);
  const match = previous.findLast(entry => !entry.deleted && categories.includes(entry.category) &&
    normalizeName(entry.name) === normalized);
  if (match) return match.category;
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

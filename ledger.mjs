export function parseNotice(text) {
  const price = text.match(/R\s*\$\s*([\d.]+,\d{2})/i);
  const installments = text.match(/\b(\d{1,3})\s*(?:x\b|parcelas?\b|vezes\b)/i);
  const count = Number(installments?.[1]) || null;
  const merchant = /\b(?:estabelecimento\s*[:\-]?|em|na loja)\s+(?!\d|R\s*\$)([^.\n;]+?)(?=\s+(?:em|de|no dia|no cart[aã]o)\s+(?:\d|R\s*\$)|[.;\n]|$)/i;
  const name = text.match(merchant)?.[1]?.trim();
  const bank = /\bita[uú]\b/i.test(text) ? 'Itaú' : /\bcaixa\b/i.test(text) ? 'CAIXA' : undefined;
  const date = text.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  const dateValue = date && date[3] + '-' + date[2] + '-' + date[1];
  return {name: name || 'Compra do cartão', cents: price ? toCents(price[1]) : null,
    count: count <= 120 ? count : null, part: 1, ...(bank && {bank}), ...(dateValue && {date: dateValue})};
}

const toCents = value => Math.round(Number(value.replaceAll('.', '').replace(',', '.')) * 100);

export function parseStatement(lines, month, bank) {
  return lines.flatMap(line => {
    const row = line.match(/^\s*(\d{2})\s*\/\s*(\d{2})(?:\s*\/\s*(\d{4}|\d{2}))?\s+(.+?)\s+(?:R\s*\$\s*)?([-−]?\s*[\d.]+,\s*\d{2})\s*$/);
    if (!row) return [];
    const [,day, dateMonth, year, description, value] = row;
    if (/pagamento (?:de|da|efetuado)|saldo anterior|total da fatura/i.test(description)) return [];
    const marker = description.match(/(?:\b(?:parc(?:ela)?\.?)\s*)?(\d{1,3})\s*\/\s*(\d{1,3})\s*$/i);
    const part = Number(marker?.[1]) || 1;
    const count = Number(marker?.[2]) || null;
    if (count && (part > count || count > 120)) return [];
    const inferredYear = Number(month.slice(0,4)) - Number(dateMonth > month.slice(5));
    const date = (year?.length === 2 ? '20' + year : year || inferredYear) + '-' + dateMonth + '-' + day;
    const parsed = new Date(date + 'T00:00Z');
    if (Number.isNaN(+parsed) || parsed.toISOString().slice(0,10) !== date) return [];
    const name = (marker ? description.slice(0, marker.index) : description).trim();
    const cents = toCents(value.replaceAll(/\s/g, '').replace('−', '-'));
    return name ? [{name, date, bank, month, cents, count, part, source:'pdf', statementValue:true}] : [];
  });
}

export function charge(entry, part) {
  if (entry.statementValue) return entry.cents;
  const count = entry.count || 1;
  const base = Math.trunc(entry.cents / count);
  return base + (part <= Math.abs(entry.cents % count) ? Math.sign(entry.cents) : 0);
}

const monthNumber = month => Number(month.slice(0,4)) * 12 + Number(month.slice(5)) - 1;

export function forMonth(entry, month) {
  const part = entry.part + monthNumber(month) - monthNumber(entry.month);
  if (part < (entry.statementValue ? entry.part : 1) || part > (entry.count || 1)) return null;
  return {part, cents:charge(entry,part)};
}

export function futureTotal(entry, month) {
  if (!entry.count) return 0;
  const first = Math.max(entry.statementValue ? entry.part : 1, entry.part + monthNumber(month) - monthNumber(entry.month) + 1);
  let cents = 0;
  for (let part = first; part <= entry.count; part++) cents += charge(entry, part);
  return cents;
}

const normalized = value => value.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/[^a-z0-9]/g,'');

export function candidates(entries, incoming) {
  const name = normalized(incoming.name);
  if (!name || name === 'compradocartao') return [];
  return entries.filter(entry => {
    if (entry.bank !== incoming.bank || entry.date !== incoming.date || normalized(entry.name) !== name) return false;
    const existing = forMonth(entry, incoming.month);
    return existing?.cents === incoming.cents ||
      (incoming.count && !entry.count && Math.abs(entry.cents - incoming.count * incoming.cents) <= incoming.count);
  });
}

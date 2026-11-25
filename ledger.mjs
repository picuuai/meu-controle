export function parseNotice(text) {
  const price = text.match(/R\s*\$\s*([\d.]+,\d{2})/i);
  const installments = text.match(/\b(\d{1,3})\s*(?:x\b|parcelas?\b|vezes\b)/i);
  const count = Number(installments?.[1]) || null;
  const merchant = /\b(?:estabelecimento\s*[:\-]?|em|na loja)\s+(?!\d|R\s*\$)([^.\n;]+?)(?=\s+(?:em|de|no dia|no cart[aã]o)\s+(?:\d|R\s*\$)|[.;\n]|$)/i;
  const name = text.match(merchant)?.[1]?.trim();
  const bank = /\bita[uú](?!\p{L})/iu.test(text) ? 'Itaú' : /\bcaixa\b/i.test(text) ? 'CAIXA' : undefined;
  const date = text.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  const dateValue = date && date[3] + '-' + date[2] + '-' + date[1];
  return {name: name || 'Compra do cartão', cents: price ? toCents(price[1]) : null,
    count: count <= 120 ? count : null, part: 1, ...(bank && {bank}), ...(dateValue && {date: dateValue})};
}

const toCents = value => Math.round(Number(value.replaceAll('.', '').replace(',', '.')) * 100);

export function statementTextRows(items, pageWidth, bank) {
  const rows = [];
  for (const item of items) {
    if (!item.str?.trim()) continue;
    const [, , , , x, y] = item.transform;
    const row = rows.find(candidate => Math.abs(y - candidate.y) < 2);
    const word = {x, end: x + item.width, text: item.str.trim()};
    if (row) row.words.push(word);
    else rows.push({y, words: [word]});
  }
  rows.sort((a, b) => b.y - a.y);
  const layout = bank === 'Itaú' ? {split: .57, dates: [.22, .59], totals: [.56, .93]}
    : bank === 'CAIXA' ? {split: .5, dates: [.06, .52], totals: [.49, .95], cities: [.25, .715]} : null;
  if (!layout) return rows.map(row => row.words.sort((a, b) => a.x - b.x).map(word => word.text).join(' '));

  const lines = [];
  for (const {words} of rows) {
    words.sort((a, b) => a.x - b.x);
    for (const column of [0, 1]) {
      const region = words.filter(word => Number(word.x / pageWidth >= layout.split) === column);
      const dateIndex = region.findIndex(word =>
        /^\d{2}\s*\/\s*\d{2}(?!\d)/.test(word.text) && Math.abs(word.x / pageWidth - layout.dates[column]) < .028);
      if (dateIndex < 0) continue;
      const amountIndex = region.findLastIndex(word =>
        /[\d.]+,\s*\d{2}\s*[CD]?$/i.test(word.text) && Math.abs(word.end / pageWidth - layout.totals[column]) < .035);
      if (amountIndex < dateIndex) continue;
      const suffix = region[amountIndex + 1];
      const end = bank === 'CAIXA' && suffix && /^[CD]$/i.test(suffix.text) ? amountIndex + 2 : amountIndex + 1;
      const description = region.slice(dateIndex, amountIndex).filter(word =>
        !layout.cities || word.x / pageWidth < layout.cities[column]);
      const amount = region.slice(amountIndex, end);
      lines.push([...description, ...amount].map(word => word.text).join(' '));
    }
  }
  return lines;
}

export function parseStatement(lines, month, bank) {
  return lines.flatMap(line => {
    const row = line.match(/^\s*(\d{2})\s*\/\s*(\d{2})(?:\s*\/\s*(\d{4}|\d{2}))?(?:\s+|(?=[\p{L}*]))(.+?)\s+(?:R\s*\$\s*)?([-−]?\s*[\d.]+,\s*\d{2})\s*([CD])?\s*$/iu);
    if (!row) return [];
    const [,day, dateMonth, year, description, value, direction] = row;
    if (/pagto\.?|pagamento (?:de|da|efetuado)|saldo anterior|total da fatura/i.test(description)) return [];
    const marker = description.match(/(?:\b(?:parc(?:ela)?\.?)\s*)?(\d{1,3})\s*\/\s*(\d{1,3})\s*$/i);
    const part = Number(marker?.[1]) || 1;
    const count = Number(marker?.[2]) || null;
    if (count && (part > count || count > 120)) return [];
    const inferredYear = Number(month.slice(0,4)) - Number(dateMonth > month.slice(5));
    const date = (year?.length === 2 ? '20' + year : year || inferredYear) + '-' + dateMonth + '-' + day;
    const parsed = new Date(date + 'T00:00Z');
    if (Number.isNaN(+parsed) || parsed.toISOString().slice(0,10) !== date) return [];
    const name = (marker ? description.slice(0, marker.index) : description).trim();
    const amount = toCents(value.replaceAll(/\s/g, '').replace('−', '-'));
    const cents = direction?.toUpperCase() === 'C' ? -Math.abs(amount) : amount;
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

export function identifyStatementRows(rows) {
  const occurrences = new Map();
  return rows.map(row => {
    const signature = JSON.stringify([row.bank, row.month, row.date, normalized(row.name), row.cents, row.part, row.count]);
    const occurrence = (occurrences.get(signature) || 0) + 1;
    occurrences.set(signature, occurrence);
    return {...row, statementKey: signature + ':' + occurrence};
  });
}

export function importStatementRows(entries, rows, createId, now) {
  const saved = new Map(entries.map(entry => [entry.id, entry]));
  const knownKeys = new Set(entries.map(entry => entry.statementKey).filter(Boolean));
  const used = new Set();
  const pending = [];
  let added = 0;
  let updated = 0;
  let duplicates = 0;
  for (const row of rows) {
    if (knownKeys.has(row.statementKey)) {
      duplicates++;
      continue;
    }
    const signature = row.statementKey.slice(0, row.statementKey.lastIndexOf(':') + 1);
    const matches = candidates(entries, row).filter(entry =>
      !used.has(entry.id) && !entry.statementKey?.startsWith(signature));
    if (matches.length > 1) {
      pending.push(row);
      continue;
    }
    const existing = matches[0];
    if (!existing) {
      const id = createId();
      saved.set(id, {...row, id, updatedAt: now});
      added++;
      continue;
    }
    used.add(existing.id);
    const bill = forMonth(existing, row.month);
    if ((existing.statementValue && !row.count) ||
        (row.count && existing.count === row.count && bill?.part === row.part && bill.cents === row.cents)) {
      duplicates++;
      continue;
    }
    if (existing.statementValue && existing.count) {
      pending.push(row);
      continue;
    }
    if (!row.count) {
      duplicates++;
      continue;
    }
    saved.set(existing.id, {...existing, ...row, category: existing.category || row.category,
      updatedAt: Math.max(now, (existing.updatedAt || 0) + 1)});
    updated++;
  }
  return {entries: [...saved.values()], added, updated, duplicates, pending};
}

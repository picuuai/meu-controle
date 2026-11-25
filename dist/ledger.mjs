export function parseNotice(text, receivedDate = new Date().toLocaleDateString('sv-SE')) {
  const caixaPurchase = text.match(/\bCAIXA\s*:\s*Compra\s+aprovada\s+em\s+(.+?)[,\s]+R\s*\$\s*([\d.]+,\d{2})(?:\s+em\s+(\d{1,3})\s*(?:x\b|vezes\b|parcelas?\b))?\s*,?\s*(\d{2})\/(\d{2})(?:\/(\d{4}))?(?:\s+(?:às|as)\s+(\d{2}:\d{2}))?/iu);
  if (caixaPurchase) {
    const [, name, amount, installments, day, month, year, time] = caixaPurchase;
    const count = Number(installments) || null;
    return {name:name.trim(), cents:toCents(amount), count:count <= 120 ? count : null, part:1, bank:'CAIXA',
      ...noticeDate(day, month, year, receivedDate), ...(time && {time})};
  }
  const compact = text.trim().match(/^(?:29194\s*[:\n]\s*)?(.+?)\s+compra\s+(\d{3,9})\s+(\d{2})\/(\d{2})\/(\d{4})$/iu);
  if (compact) {
    const [, name, amount, day, month, year] = compact;
    return {name:name.trim(), cents:Number(amount), count:null, part:1, bank:'CAIXA',
      ...noticeDate(day, month, year, receivedDate)};
  }
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

function noticeDate(day, month, year, receivedDate) {
  const receivedYear = Number(receivedDate.slice(0, 4));
  const inferredYear = receivedYear - Number(month + '-' + day > receivedDate.slice(5));
  const date = (year || inferredYear) + '-' + month + '-' + day;
  const parsed = new Date(date + 'T00:00Z');
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === date ? {date} : {};
}

const toCents = value => Math.round(Number(value.replaceAll('.', '').replace(',', '.')) * 100);
const forecastHeading = /^compras\s+parceladas\b(?:\s*[-–—]\s*pr|.*\bpr[oó]ximas faturas\b)/i;
const forecastEnd = /^(?:pr[oó]xima fatura|demais faturas|total para pr[oó]ximas faturas)\b/i;
const statementTax = /^repasse\s+de\s+iof\s+em\s+r\$\s+([\d.]+,\d{2})$/i;

function forecastControl(text) {
  const compact = text.normalize('NFD').replace(/\p{Diacritic}|\s/gu, '').toLowerCase();
  const amount = compact.match(/([\d.]+,\d{2})$/);
  if (!amount) return null;
  if (compact.startsWith('proximafatura')) return ['nextCents', toCents(amount[1])];
  if (compact.startsWith('totalparaproximasfaturas')) return ['futureCents', toCents(amount[1])];
  return null;
}

function caixaForecastControl(text) {
  const match = text.match(/\bsaldo\s+previsto\s+pr[oó]xima\s+fatura\s*:\s*R\s*\$\s*([\d.]+,\d{2})/i);
  return match ? ['nextCents', toCents(match[1])] : null;
}

function statementDate(items, labelPattern) {
  const format = /\b(\d{2})\s*\/\s*(\d{2})\s*\/\s*(\d{4})\b/;
  const dates = new Map();
  const add = match => {
    if (!match) return;
    const date = match[3] + '-' + match[2] + '-' + match[1];
    const parsed = new Date(date + 'T00:00Z');
    if (Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === date) {
      dates.set(date, (dates.get(date) || 0) + 1);
    }
  };
  for (const item of items) {
    const label = item.str?.trim() || '';
    if (!labelPattern.test(label)) continue;
    const inline = label.match(format);
    if (inline) {
      add(inline);
      continue;
    }
    const x = item.transform[4];
    const y = item.transform[5];
    const adjacent = items.filter(other => other !== item && other.transform[4] >= x &&
      other.transform[4] <= x + 96 && Math.abs(other.transform[5] - y) < 1)
      .map(other => other.str?.match(format)?.[0]).filter(Boolean);
    if (new Set(adjacent).size === 1) {
      add(adjacent[0].match(format));
      continue;
    }
    const nearby = items.filter(other => other !== item && /^\s*\d/.test(other.str || '') &&
      other.transform[4] >= x - 4 && other.transform[4] <= x + 96 &&
      other.transform[5] <= y + 2 && other.transform[5] >= y - 24);
    const matches = new Set(nearby.map(other => other.str.match(format)?.[0]).filter(Boolean));
    if (matches.size === 1) add([...matches][0].match(format));
  }
  const ordered = [...dates].sort((a, b) => b[1] - a[1]);
  return ordered.length && ordered[0][1] !== ordered[1]?.[1] ? ordered[0][0] : null;
}

export function statementDueDate(items) {
  return statementDate(items, /^vencimento\s*:?($|\s*\d)/i);
}

export function statementReferenceMonth(items, bank, selectedMonth, dueDate) {
  if (bank !== 'Itaú') return dueDate?.slice(0, 7) || selectedMonth;
  const closing = statementDate(items, /^(?:data (?:do |de ))?fechamento\s*:?($|\s*\d)/i) ||
    statementDate(items, /^emiss(?:[aã]o\s*:?|$)/i);
  return closing && (!dueDate || closing <= dueDate) ? closing.slice(0, 7) : selectedMonth;
}

export function statementTextRows(items, pageWidth, bank, section = {}) {
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
  const forecast = [Boolean(section.nextBill), false];
  for (const {words} of rows) {
    words.sort((a, b) => a.x - b.x);
    for (const column of [0, 1]) {
      const region = words.filter(word => Number(word.x / pageWidth >= layout.split) === column);
      const label = region.map(word => word.text).join(' ');
      const control = bank === 'Itaú' ? forecastControl(label) : caixaForecastControl(label);
      if (control) {
        forecast[column] = false;
        lines.push(label);
        continue;
      }
      if (forecastHeading.test(label)) forecast[column] = true;
      else if (forecastEnd.test(label)) forecast[column] = false;
      if (bank === 'Itaú' && statementTax.test(label)) {
        lines.push(label);
        continue;
      }
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
      const text = [...description, ...amount].map(word => word.text).join(' ');
      lines.push(forecast[column] ? {text, nextBill: true} : text);
    }
  }
  section.nextBill = forecast.some(Boolean);
  return lines;
}

export function parseStatement(lines, month, bank, controls = {}) {
  let forecast = false;
  return lines.flatMap(line => {
    const text = typeof line === 'string' ? line : line.text;
    if (forecastHeading.test(text)) { forecast = true; return []; }
    const control = bank === 'Itaú' ? forecastControl(text) : bank === 'CAIXA' && caixaForecastControl(text);
    if (control) {
      controls[control[0]] = control[1];
      forecast = false;
      return [];
    }
    if (forecastEnd.test(text)) { forecast = false; return []; }
    const tax = bank === 'Itaú' && text.match(statementTax);
    if (tax) return [{name:'Repasse de IOF', date:month + '-01', dateIsReference:true, bank, month,
      cents:toCents(tax[1]), count:1, part:1, source:'pdf', statementValue:true}];
    const nextBill = forecast || line.nextBill === true;
    const row = text.match(/^\s*(\d{2})\s*\/\s*(\d{2})(?:\s*\/\s*(\d{4}|\d{2}))?(?:\s+|(?=[\p{L}*]))(.+?)\s+(?:R\s*\$\s*)?([-−]?\s*[\d.]+,\s*\d{2})\s*([CD])?\s*$/iu);
    if (!row) return [];
    const [,day, dateMonth, year, description, value, direction] = row;
    if (/pagto\b|pagamento (?:de|da|efetuado|via conta)|obrigado pelo pagamento|saldo anterior|total da fatura/i.test(description)) return [];
    const marker = description.match(installmentMarker);
    const partial = marker || description.match(incompleteInstallment);
    const part = Number(partial?.[1]) || 1;
    const total = Number(marker?.[2]) || null;
    const count = total && part <= total && total <= 120 ? total : null;
    const installmentPending = Boolean(partial && !count);
    if (nextBill && !count && !installmentPending) return [];
    const inferredYear = Number(month.slice(0,4)) - Number(dateMonth > month.slice(5));
    const date = (year?.length === 2 ? '20' + year : year || inferredYear) + '-' + dateMonth + '-' + day;
    const parsed = new Date(date + 'T00:00Z');
    if (Number.isNaN(+parsed) || parsed.toISOString().slice(0,10) !== date) return [];
    const name = (partial ? description.slice(0, partial.index) : description).trim();
    const amount = toCents(value.replaceAll(/\s/g, '').replace('−', '-'));
    const cents = direction?.toUpperCase() === 'C' ? -Math.abs(amount) : amount;
    const billingMonth = nextBill ? monthAfter(month) : month;
    return name ? [{name, date, bank, month:billingMonth, cents, count: installmentPending ? null : count || 1,
      part, source:'pdf', statementValue:true, ...(installmentPending && {installmentPending:true}),
      ...(nextBill && {projection:true})}] : [];
  });
}

export function charge(entry, part) {
  if (entry.statementValue) return entry.cents;
  const count = entry.count || 1;
  const base = Math.trunc(entry.cents / count);
  return base + (part <= Math.abs(entry.cents % count) ? Math.sign(entry.cents) : 0);
}

const monthNumber = month => Number(month.slice(0,4)) * 12 + Number(month.slice(5)) - 1;
const installmentMarker = /(?:\b(?:parc(?:ela)?\.?)\s*)?(\d{1,3})(?:\s*\/\s*|\s+d\s*e\s+)(\d{1,3})\s*$/i;
const incompleteInstallment = /\b(\d{1,3})(?:\s*\/|\s+d(?:\s*e)?)\s*$/i;

export function installmentCount(entry) {
  if (entry.count) return entry.count;
  return entry.source === 'pdf' && !entry.installmentPending &&
    !installmentMarker.test(entry.name) && !incompleteInstallment.test(entry.name) ? 1 : null;
}

export function monthAfter(month) {
  const number = monthNumber(month) + 1;
  return Math.floor(number / 12) + '-' + String(number % 12 + 1).padStart(2, '0');
}

export function forMonth(entry, month) {
  if (entry.billOnly && month !== entry.month) return null;
  if (!entry.count) return entry.month === month ? {part:entry.part, cents:entry.cents} : null;
  const part = entry.part + monthNumber(month) - monthNumber(entry.month);
  if (part < (entry.statementValue ? entry.part : 1) || part > (entry.count || 1)) return null;
  return {part, cents:charge(entry,part)};
}

export function futureTotal(entry, month) {
  if (entry.billOnly) return entry.month > month ? entry.cents : 0;
  if (!entry.count) return 0;
  const first = Math.max(entry.statementValue ? entry.part : 1, entry.part + monthNumber(month) - monthNumber(entry.month) + 1);
  let cents = 0;
  for (let part = first; part <= entry.count; part++) cents += charge(entry, part);
  return cents;
}

export function applyStatementForecast(rows, month, controls) {
  const projected = rows.filter(row => row.projection);
  if (!projected.length || projected.some(row => !row.count)) return rows;
  const nextCents = projected.reduce((total, row) => total + row.cents, 0);
  const futureCents = projected.reduce((total, row) => total + futureTotal(row, month), 0);
  if (nextCents !== controls.nextCents || futureCents !== controls.futureCents) return rows;
  return rows.map(row => !row.projection && row.count > 1 ? {...row, billOnly:true} : row);
}

const normalized = value => value.replace(installmentMarker, '').replace(incompleteInstallment, '').normalize('NFD')
  .replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/[^a-z0-9]/g,'');

export function candidates(entries, incoming) {
  const name = normalized(incoming.name);
  if (!name || name === 'compradocartao') return [];
  return entries.filter(entry => {
    if (entry.deleted || entry.bank !== incoming.bank || entry.date !== incoming.date || normalized(entry.name) !== name) return false;
    const existing = forMonth(entry, incoming.month);
    return existing?.cents === incoming.cents ||
      (incoming.count && !entry.count && Math.abs(entry.cents - incoming.count * incoming.cents) <= incoming.count);
  });
}

export function identifyStatementRows(rows) {
  const occurrences = new Map();
  return rows.map(row => {
    const signature = JSON.stringify([row.bank, row.month, row.date, normalized(row.name), row.cents, row.part,
      row.count === 1 ? null : row.count]);
    const occurrence = (occurrences.get(signature) || 0) + 1;
    occurrences.set(signature, occurrence);
    return {...row, statementKey: signature + ':' + occurrence};
  });
}

export function importStatementRows(entries, rows, createId, now, selected) {
  const preview = selected === undefined;
  selected ??= new Set(rows);
  const saved = new Map(entries.map(entry => [entry.id, entry]));
  const knownKeys = new Map(entries.filter(entry => entry.statementKey).map(entry => [entry.statementKey, entry]));
  const usedByMonth = new Map();
  const pending = [];
  let added = 0;
  let updated = 0;
  const alreadyRecorded = new Set();
  const ordered = [...rows].sort((a, b) => Number(Boolean(a.projection)) - Number(Boolean(b.projection)));
  for (const row of ordered) {
    const {categoryReviewed, ...transaction} = row;
    const known = knownKeys.get(row.statementKey);
    if (known) {
      const confirmed = known.projection && !row.projection;
      const forecastUpdated = row.billOnly && !known.billOnly;
      if (selected.has(row) && (confirmed || forecastUpdated)) {
        saved.set(known.id, {...known, ...(confirmed && {projection:false}),
          ...(forecastUpdated && {billOnly:true}), updatedAt:Math.max(now, (known.updatedAt || 0) + 1)});
        updated++;
      } else if (selected.has(row)) alreadyRecorded.add(row);
      continue;
    }
    if (!usedByMonth.has(row.month)) usedByMonth.set(row.month, new Set());
    const used = usedByMonth.get(row.month);
    const signature = row.statementKey.slice(0, row.statementKey.lastIndexOf(':') + 1);
    const source = row.projection && !preview ? [...saved.values()] : entries;
    const matches = candidates(source, row).filter(entry =>
      !used.has(entry.id) && !entry.statementKey?.startsWith(signature));
    if (matches.length > 1) {
      if (selected.has(row)) pending.push(row);
      continue;
    }
    const existing = matches[0];
    if (existing) used.add(existing.id);
    if (!selected.has(row)) continue;
    if (!existing) {
      const id = createId();
      saved.set(id, {...transaction, id, updatedAt: now});
      added++;
      continue;
    }
    const bill = forMonth(existing, row.month);
    if (row.billOnly && !existing.billOnly && existing.statementValue && existing.month === row.month &&
        bill?.part === row.part && bill.cents === row.cents) {
      saved.set(existing.id, {...existing, billOnly:true, updatedAt:Math.max(now, (existing.updatedAt || 0) + 1)});
      updated++;
      continue;
    }
    if ((row.count === 1 && bill?.cents === row.cents) ||
        (existing.statementValue && !row.count) ||
        (row.count && existing.count === row.count && bill?.part === row.part && bill.cents === row.cents)) {
      alreadyRecorded.add(row);
      continue;
    }
    if (existing.statementValue && existing.count) {
      pending.push(row);
      continue;
    }
    if (!row.count) {
      alreadyRecorded.add(row);
      continue;
    }
    saved.set(existing.id, {...existing, ...transaction, category: categoryReviewed ? row.category : existing.category || row.category,
      updatedAt: Math.max(now, (existing.updatedAt || 0) + 1)});
    updated++;
  }
  return {entries: [...saved.values()], added, updated, duplicates: alreadyRecorded.size, alreadyRecorded, pending};
}

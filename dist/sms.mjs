import {parseNotice} from './ledger.mjs?v=21';

const approved = /\bCAIXA\s*:\s*compra\s+aprovada\s+em\s+/giu;

export function parseSmsText(text, receivedDate) {
  const starts = [...text.matchAll(approved)].map(match => match.index);
  const messages = starts.length
    ? starts.map((start, index) => text.slice(start, starts[index + 1]))
    : text.trim().split(/\r?\n/);
  return messages.flatMap(message => {
    const row = parseNotice(message, receivedDate);
    return row.bank === 'CAIXA' && row.name !== 'Compra do cartão' && row.date &&
      Number.isSafeInteger(row.cents) && row.cents > 0 ? [row] : [];
  });
}

export function parseSmsBackup(text, receivedDate) {
  if (/<!\s*DOCTYPE/i.test(text)) throw new Error('Arquivo XML com definição externa.');
  const backup = new DOMParser().parseFromString(text, 'application/xml');
  if (backup.querySelector('parsererror') || backup.documentElement?.localName !== 'smses') {
    throw new Error('Formato de backup SMS inválido.');
  }
  return [...backup.documentElement.children].flatMap(item => {
    if (item.localName !== 'sms') return [];
    if (!/^(?:tel:)?29194$/i.test(item.getAttribute('address')?.trim() || '')) return [];
    if (item.hasAttribute('type') && item.getAttribute('type') !== '1') return [];
    const timestamp = Number(item.getAttribute('date'));
    const sent = new Date(timestamp);
    const date = timestamp > 0 && Number.isFinite(+sent) ? sent.toLocaleDateString('sv-SE') : receivedDate;
    return parseSmsText(item.getAttribute('body') || '', date);
  });
}

export function smsKey(row) {
  return JSON.stringify([row.bank, row.date, row.time || '', row.cents, row.name.trim().toLocaleLowerCase('pt-BR')]);
}

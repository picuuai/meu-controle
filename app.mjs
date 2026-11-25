import {parseNotice, parseStatement, forMonth, futureTotal, candidates} from './ledger.mjs';
import {mergeEntries, syncEntries} from './sync.mjs';

const $ = id => document.getElementById(id);
const money = new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
const brl = cents => money.format(cents/100);
const localDate = new Date().toLocaleDateString('sv-SE');
const form = $('form');
const fields = form.elements;
const storageKey = 'meu-controle-ledger';
const readEntries = () => JSON.parse(localStorage.getItem(storageKey) || '[]');
let entries = readEntries();
let queue = [];
let editing;
let receiptUrl;

function render() {
  const month = $('month').value;
  const selected = entries.filter(entry => !$('filter').value || entry.bank === $('filter').value);
  const visible = selected.map(entry => ({entry, bill:forMonth(entry,month)})).filter(row => row.bill);
  visible.sort((a,b) => b.entry.date.localeCompare(a.entry.date));
  $('total').textContent = brl(visible.reduce((sum,row) => sum + row.bill.cents,0));
  $('future').textContent = brl(selected.reduce((sum,entry) => sum + futureTotal(entry,month),0));
  $('pending').textContent = visible.filter(({entry}) => !entry.count).length;
  $('entries').replaceChildren();
  if (!visible.length) $('entries').textContent = 'Nenhum lançamento neste mês.';
  for (const {entry,bill} of visible) {
    const button = document.createElement('button');
    button.className = 'entry';
    const detail = document.createElement('span');
    detail.textContent = entry.name;
    const subtitle = document.createElement('small');
    subtitle.textContent = [entry.bank, entry.date.split('-').reverse().join('/'), entry.count ? bill.part + '/' + entry.count : 'Parcelamento pendente'].join(' · ');
    detail.append(subtitle);
    const value = document.createElement('b');
    value.textContent = brl(bill.cents);
    button.append(detail,value);
    button.onclick = () => edit(entry);
    $('entries').append(button);
  }
}

function review() {
  $('review').replaceChildren();
  for (const item of queue) {
    const button = document.createElement('button');
    button.className = 'entry';
    button.textContent = item.name + ' · ' + (item.cents == null ? 'Valor pendente' : brl(item.cents));
    button.onclick = () => edit(item);
    $('review').append(button);
  }
}

function edit(entry) {
  editing = entry;
  fields.name.value = entry.name || '';
  fields.bank.value = entry.bank || $('bank').value;
  fields.date.value = entry.date || localDate;
  fields.month.value = entry.month || $('month').value;
  fields.amount.value = entry.cents == null ? '' : (entry.cents/100).toFixed(2);
  fields.count.value = entry.count ?? '';
  fields.part.value = entry.part || 1;
  fields.part.setCustomValidity('');
  $('amount-label').textContent = entry.statementValue ? 'Valor da parcela (R$)' : 'Valor total da compra (R$)';
  updateMatch();
  $('editor').showModal();
}

function draft() {
  return {...editing,name:fields.name.value.trim(),bank:fields.bank.value,date:fields.date.value,month:fields.month.value,
    cents:Math.round(Number(fields.amount.value)*100),count:Number(fields.count.value)||null,part:Number(fields.part.value)};
}
function updateMatch() {
  $('match').replaceChildren();
  if (editing.source !== 'pdf' || editing.id) return;
  const matches = candidates(entries,draft());
  if (!matches.length) return;
  const label = document.createElement('label');
  label.textContent = 'Compra correspondente';
  const select = document.createElement('select');
  select.id = 'merge';
  select.append(new Option('Salvar como outra compra',''));
  for (const match of matches) select.append(new Option(match.name + ' · ' + brl(match.cents),match.id));
  if (matches.length === 1) select.value = matches[0].id;
  label.append(select);
  $('match').append(label);
}

form.oninput = event => {
  fields.part.setCustomValidity('');
  if (event.target.id !== 'merge') updateMatch();
};
form.onsubmit = event => {
  event.preventDefault();
  const entry = draft();
  if (entry.part > (entry.count || 1)) {
    fields.part.setCustomValidity('A parcela deve estar entre 1 e o total informado.');
    fields.part.reportValidity();
    return;
  }
  const current = readEntries();
  const target = $('merge')?.value;
  const existing = target && current.find(row => row.id === target);
  entry.id = entry.id || (existing ? existing.id : crypto.randomUUID());
  const previous = current.find(row => row.id === entry.id);
  entry.updatedAt = Math.max(Date.now(), (previous?.updatedAt || 0) + 1);
  // Preserve the start of an already confirmed installment series.
  const saved = existing?.count && existing.statementValue && existing.part < entry.part && existing.count === entry.count && existing.cents === entry.cents
    ? existing : entry;
  const next = [...current.filter(row => row.id !== entry.id),saved];
  try {localStorage.setItem(storageKey,JSON.stringify(next));}
  catch { $('match').textContent = 'Falha ao salvar no aparelho. Tente novamente.'; return; }
  entries = next;
  if (editing.nativeKey) window.AndroidAlerts?.acknowledge(editing.nativeKey);
  queue = queue.filter(row => row !== editing);
  $('editor').close();
  $('month').value = entry.month;
  render();
  review();
};

let syncToken = '';
$('sync-form').onsubmit = async event => {
  event.preventDefault();
  const field = $('sync-token');
  const status = $('sync-status');
  syncToken = field.value.trim() || syncToken;
  if (!syncToken) {
    status.textContent = 'Informe o token do GitHub.';
    field.focus();
    return;
  }
  field.value = '';
  $('sync-button').disabled = true;
  status.textContent = 'Sincronizando…';
  try {
    const synced = await syncEntries(syncToken, readEntries);
    const current = readEntries();
    const next = mergeEntries(synced, current);
    localStorage.setItem(storageKey, JSON.stringify(next));
    entries = next;
    render();
    status.textContent = next.length === synced.length &&
      next.every((entry, index) => entry === synced[index])
      ? 'Lançamentos sincronizados.'
      : 'Há alterações locais mais recentes. Sincronize novamente para enviá-las.';
  } catch (error) {
    status.textContent = error instanceof TypeError
      ? 'Sem conexão com o GitHub. Tente novamente.'
      : error.message;
  } finally {
    $('sync-button').disabled = false;
  }
};

$('month').value = localDate.slice(0,7);
$('month').onchange = () => {$('month').value ||= localDate.slice(0,7); render();};
$('filter').onchange = render;
$('add').onclick = () => edit({});
$('close').onclick = () => $('editor').close();
$('read').onclick = () => {
  const text = $('notice').value.trim();
  if (text) edit({...parseNotice(text),source:'alert'});
  else $('notice').focus();
};

$('theme').value = localStorage.getItem('meu-controle-theme') || 'system';
function theme() {
  if ($('theme').value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = $('theme').value;
}
$('theme').onchange = () => {localStorage.setItem('meu-controle-theme',$('theme').value); theme();};
theme();

$('pdf').onchange = async () => {
  const file = $('pdf').files[0];
  if (!file) return;
  const {value:month} = $('month');
  const {value:bank} = $('bank');
  $('pdf').disabled = true;
  $('status').textContent = 'Lendo a fatura…';
  let documentTask;
  try {
    const pdfjs = await import('./pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs',import.meta.url).href;
    documentTask = pdfjs.getDocument({data:await file.arrayBuffer(),isEvalSupported:false});
    documentTask.onPassword = (resolve, reason) => {
      const password = prompt(reason === 2 ? 'Senha incorreta. Informe a senha do PDF.' : 'Informe a senha do PDF.');
      if (password) resolve(password);
      else documentTask.destroy();
    };
    const pdf = await documentTask.promise;
    const lines = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const {items} = await page.getTextContent();
      const rows = [];
      for (const item of items) {
        if (!item.str?.trim()) continue;
        const [, , , , x, y] = item.transform;
        const row = rows.find(candidate => Math.abs(y-candidate.y) < 2);
        if (row) row.items.push({x,text:item.str.trim()});
        else rows.push({y,items:[{x,text:item.str.trim()}]});
      }
      lines.push(...rows.sort((a,b)=>b.y-a.y).map(row=>row.items.sort((a,b)=>a.x-b.x).map(item=>item.text).join(' ')));
    }
    const parsed = parseStatement(lines,month,bank);
    queue = [...queue.filter(entry => entry.source !== 'pdf'),...parsed];
    review();
    $('status').textContent = parsed.length ? parsed.length + ' lançamentos encontrados. Revise antes de salvar.' : 'Nenhuma compra reconhecida. Confira se a fatura tem texto selecionável.';
  } catch {
    $('status').textContent = 'Não foi possível ler o PDF. Confira o arquivo e a senha.';
  } finally {
    await documentTask?.destroy().catch(()=>{});
    $('pdf').disabled = false;
    $('pdf').value = '';
  }
};

$('photo').onchange = () => {
  const file = $('photo').files[0];
  if (!file) return;
  if (receiptUrl) URL.revokeObjectURL(receiptUrl);
  receiptUrl = URL.createObjectURL(file);
  const image = new Image();
  image.src = receiptUrl;
  image.alt = 'Prévia do comprovante';
  const button = document.createElement('button');
  button.textContent = 'Digitar a compra do comprovante';
  button.onclick = () => edit({});
  $('receipt').className = 'receipt';
  $('receipt').replaceChildren(image,button);
  $('photo').value = '';
};

if (window.AndroidAlerts) {
  $('native').hidden = false;
  $('native').onclick = () => window.AndroidAlerts.openSettings();
  const refresh = () => {
    const alerts = JSON.parse(window.AndroidAlerts.pending());
    queue = [...queue.filter(row => !row.nativeKey), ...alerts.filter(alert => !entries.some(entry => entry.nativeKey === alert.key)).map(alert => ({
      ...parseNotice(alert.text), bank:alert.bank, date:alert.date, month:alert.date.slice(0,7), nativeKey:alert.key, source:'alert'
    }))];
    review();
  };
  window.addEventListener('focus',refresh);
  setInterval(refresh,2500);
  refresh();
} else if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.warn);
}
render();

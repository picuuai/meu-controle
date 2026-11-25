import {parseNotice, parseStatement, forMonth, futureTotal, candidates, statementTextRows,
  identifyStatementRows, importStatementRows, installmentCount} from './ledger.mjs?v=13';
import {mergeEntries, syncEntries} from './sync.mjs?v=13';
import {categories, categoryOf, groupCharges, monthlyCharges, suggestCategory, uncategorized} from './dashboard.mjs';

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
const selectedPdf = new Set();
let statementRows = [];
let editing;
let initialCategory;
let lastDeletion;

for (const category of categories) fields.category.add(new Option(category, category));
for (const category of [...categories, uncategorized]) $('category-filter').add(new Option(category, category));

function paymentLabel(entry, part = entry.part) {
  const count = installmentCount(entry);
  if (!count) return 'Parcelamento pendente';
  return count === 1 ? 'À vista' : part + '/' + count;
}

function drawBars(id, series) {
  const chart = $(id);
  chart.replaceChildren();
  const max = Math.max(0, ...series.map(([, cents]) => Math.abs(cents)));
  if (!max && !series.length) {
    const item = document.createElement('li');
    item.textContent = 'Sem lançamentos neste recorte.';
    chart.append(item);
    return;
  }
  for (const [label, cents] of series) {
    const item = document.createElement('li');
    const caption = document.createElement('div');
    const name = document.createElement('span');
    const amount = document.createElement('strong');
    name.textContent = label;
    amount.textContent = brl(cents);
    caption.append(name, amount);
    const track = document.createElement('div');
    track.className = 'chart-track';
    track.setAttribute('aria-hidden', 'true');
    const bar = document.createElement('span');
    bar.className = cents < 0 ? 'credit-bar' : '';
    bar.style.width = (max ? Math.abs(cents) / max * 100 : 0) + '%';
    track.append(bar);
    item.append(caption, track);
    chart.append(item);
  }
}

function render() {
  const month = $('month').value;
  const card = $('filter').value;
  const category = $('category-filter').value;
  const selected = entries.filter(entry =>
    !entry.deleted && (!card || entry.bank === card) && (!category || categoryOf(entry) === category));
  const visible = selected.map(entry => ({entry, bill:forMonth(entry,month)})).filter(row => row.bill);
  visible.sort((a,b) => b.entry.date.localeCompare(a.entry.date));
  $('total').textContent = brl(visible.reduce((sum,row) => sum + row.bill.cents,0));
  $('future').textContent = brl(selected.reduce((sum,entry) => sum + futureTotal(entry,month),0));
  $('pending').textContent = visible.filter(({entry}) => !installmentCount(entry)).length;
  drawBars('category-chart', groupCharges(visible, categoryOf));
  drawBars('card-chart', groupCharges(visible, entry => entry.bank));
  drawBars('monthly-chart', monthlyCharges(selected, month));
  const query = $('search').value.trim().toLocaleLowerCase('pt-BR');
  const results = visible.filter(({entry}) => entry.name.toLocaleLowerCase('pt-BR').includes(query));
  $('entries').replaceChildren();
  if (!results.length) $('entries').textContent = 'Nenhum lançamento encontrado.';
  for (const {entry,bill} of results) {
    const button = document.createElement('button');
    button.className = 'entry';
    const detail = document.createElement('span');
    detail.textContent = entry.name;
    const subtitle = document.createElement('small');
    subtitle.textContent = [categoryOf(entry), entry.bank, entry.date.split('-').reverse().join('/'), paymentLabel(entry, bill.part)].join(' · ');
    detail.append(subtitle);
    const value = document.createElement('b');
    value.textContent = brl(bill.cents);
    button.append(detail,value);
    button.onclick = () => edit(entry);
    $('entries').append(button);
  }
}

function review(refreshPdf = true) {
  $('review').replaceChildren();
  for (const item of queue.filter(item => item.source !== 'pdf')) {
    const button = document.createElement('button');
    button.className = 'entry';
    button.textContent = item.name + ' · ' + (item.cents == null ? 'Valor pendente' : brl(item.cents));
    button.onclick = () => edit(item);
    $('review').append(button);
  }
  if (!refreshPdf) return;
  $('pdf-rows').replaceChildren();
  const pdfRows = queue.filter(item => item.source === 'pdf').sort((a, b) => a.month.localeCompare(b.month));
  $('pdf-review').hidden = !pdfRows.length;
  const selectionChanged = () => {
    const total = pdfRows.filter(item => selectedPdf.has(item)).length;
    $('select-pdf-all').checked = total === pdfRows.length && total > 0;
    $('select-pdf-all').indeterminate = total > 0 && total < pdfRows.length;
    $('save-pdf').disabled = !total;
    $('save-pdf').textContent = total ? 'Lançar selecionados (' + total + ')' : 'Lançar selecionados';
  };
  $('select-pdf-all').onchange = event => {
    for (const item of pdfRows) {
      if (event.target.checked) selectedPdf.add(item);
      else selectedPdf.delete(item);
    }
    review();
  };
  let billingMonth;
  for (const item of pdfRows) {
    if (billingMonth !== item.month) {
      billingMonth = item.month;
      const heading = document.createElement('h3');
      heading.className = 'pdf-billing-month';
      heading.textContent = (item.projection ? 'Próxima fatura' : 'Fatura do mês') + ' · ' + billingMonth.split('-').reverse().join('/');
      $('pdf-rows').append(heading);
    }
    const button = document.createElement('button');
    button.className = 'entry';
    button.textContent = item.date.split('-').reverse().join('/') + ' · ' + item.name + ' · ' + brl(item.cents) + ' · ' + paymentLabel(item);
    button.onclick = () => edit(item);
    const row = document.createElement('div');
    row.className = 'pdf-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedPdf.has(item);
    checkbox.setAttribute('aria-label', 'Selecionar ' + item.name + ' ' + brl(item.cents));
    checkbox.onchange = () => {
      if (checkbox.checked) selectedPdf.add(item);
      else selectedPdf.delete(item);
      selectionChanged();
    };
    row.append(checkbox, button);
    $('pdf-rows').append(row);
  }
  selectionChanged();
}

$('save-pdf').onclick = () => {
  const rows = queue.filter(item => selectedPdf.has(item));
  if (!rows.length) return;
  const result = importStatementRows(readEntries(), statementRows, () => crypto.randomUUID(), Date.now(), selectedPdf);
  try {localStorage.setItem(storageKey, JSON.stringify(result.entries));}
  catch { $('status').textContent = 'Falha ao salvar no aparelho. A seleção foi preservada.'; return; }
  entries = result.entries;
  const pending = new Set(result.pending);
  queue = queue.filter(item => !selectedPdf.has(item) || pending.has(item));
  selectedPdf.clear();
  $('month').value = rows.find(row => !row.projection)?.month || rows[0].month;
  $('filter').value = rows[0].bank;
  $('category-filter').value = '';
  $('search').value = '';
  render();
  review();
  $('status').textContent = [
    result.added + ' novos lançamentos',
    result.updated ? result.updated + ' compras conciliadas' : '',
    result.duplicates ? result.duplicates + ' já registrados' : '',
    result.pending.length ? result.pending.length + ' precisam de revisão individual' : ''
  ].filter(Boolean).join(' · ') + '.';
};

function edit(entry) {
  editing = entry;
  $('delete-entry').hidden = !entry.id;
  fields.name.value = entry.name || '';
  fields.bank.value = entry.bank || $('bank').value;
  fields.date.value = entry.date || localDate;
  fields.month.value = entry.month || $('month').value;
  fields.amount.value = entry.cents == null ? '' : (entry.cents/100).toFixed(2);
  fields.count.value = installmentCount(entry) ?? (entry.source === 'alert' || entry.id ? '' : 1);
  fields.part.value = entry.part || 1;
  initialCategory = entry.id ? entry.category || '' : suggestCategory(entry.name || '');
  fields.category.value = initialCategory;
  fields.part.setCustomValidity('');
  $('amount-label').textContent = entry.statementValue ? 'Valor da parcela (R$)' : 'Valor total da compra (R$)';
  updateMatch();
  $('editor').showModal();
}

function draft() {
  return {...editing,name:fields.name.value.trim(),bank:fields.bank.value,category:fields.category.value,date:fields.date.value,month:fields.month.value,
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
  if (existing?.category && entry.category === initialCategory) entry.category = existing.category;
  if (previous?.deleted) {
    $('match').textContent = 'Este lançamento foi excluído. Feche a edição para atualizar a lista.';
    return;
  }
  // Preserve the start of an already confirmed installment series.
  const saved = existing?.count && existing.statementValue && existing.part < entry.part && existing.count === entry.count && existing.cents === entry.cents
    ? {...existing, category:entry.category, updatedAt:entry.updatedAt} : entry;
  const next = [...current.filter(row => row.id !== entry.id),saved];
  try {localStorage.setItem(storageKey,JSON.stringify(next));}
  catch { $('match').textContent = 'Falha ao salvar no aparelho. Tente novamente.'; return; }
  entries = next;
  if (editing.nativeKey) window.AndroidAlerts?.acknowledge(editing.nativeKey);
  queue = queue.filter(row => row !== editing);
  selectedPdf.delete(editing);
  $('editor').close();
  $('month').value = entry.month;
  render();
  review();
};

$('delete-entry').onclick = () => {
  if (!editing?.id || !confirm('Excluir este lançamento e suas parcelas vinculadas?')) return;
  const current = readEntries();
  const entry = current.find(row => row.id === editing.id && !row.deleted);
  if (!entry) {
    $('match').textContent = 'Este lançamento já foi excluído.';
    return;
  }
  const removed = {id: entry.id, deleted: true, updatedAt: Math.max(Date.now(), (entry.updatedAt || 0) + 1)};
  const next = current.map(row => row.id === entry.id ? removed : row);
  try {localStorage.setItem(storageKey, JSON.stringify(next));}
  catch { $('match').textContent = 'Falha ao excluir no aparelho.'; return; }
  lastDeletion = {entry, updatedAt: removed.updatedAt};
  entries = next;
  $('editor').close();
  $('entry-status').textContent = 'Lançamento excluído.';
  $('undo-delete').hidden = false;
  render();
};

$('undo-delete').onclick = () => {
  if (!lastDeletion) return;
  const {entry, updatedAt} = lastDeletion;
  const current = readEntries();
  if (!current.some(row => row.id === entry.id && row.deleted && row.updatedAt === updatedAt)) {
    $('entry-status').textContent = 'O lançamento já foi alterado em outra sessão.';
    $('undo-delete').hidden = true;
    return;
  }
  const restored = {...entry, updatedAt: Math.max(Date.now(), updatedAt + 1)};
  const next = current.map(row => row.id === entry.id ? restored : row);
  try {localStorage.setItem(storageKey, JSON.stringify(next));}
  catch { $('entry-status').textContent = 'Falha ao desfazer a exclusão.'; return; }
  entries = next;
  lastDeletion = undefined;
  $('entry-status').textContent = 'Lançamento restaurado.';
  $('undo-delete').hidden = true;
  render();
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
$('category-filter').onchange = render;
$('search').oninput = render;
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

const pdfInput = $('pdf');
const dropZone = $('pdf-drop');
const pickPdf = $('pick-pdf');
pickPdf.onclick = () => pdfInput.click();
pdfInput.onchange = () => importPdf(pdfInput.files);
dropZone.ondragover = event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = pickPdf.disabled ? 'none' : 'copy';
  dropZone.classList.toggle('dragging', !pickPdf.disabled);
};
dropZone.ondragleave = event => {
  if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('dragging');
};
dropZone.ondrop = event => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
  importPdf(event.dataTransfer.files);
};

async function importPdf(files) {
  if (!files.length || pickPdf.disabled) return;
  const status = $('status');
  const [file] = files;
  if (files.length !== 1 || !/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    status.textContent = 'Selecione um único arquivo PDF da fatura.';
    pdfInput.value = '';
    return;
  }
  const {value:month} = $('month');
  const {value:bank} = $('bank');
  pickPdf.disabled = true;
  status.textContent = 'Lendo ' + file.name + '…';
  let documentTask;
  let ocr;
  let canceled = false;
  try {
    const pdfjs = await import('./pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs',import.meta.url).href;
    documentTask = pdfjs.getDocument({data:await file.arrayBuffer(),isEvalSupported:false});
    documentTask.onPassword = (resolve, reason) => {
      const password = prompt(reason === 2 ? 'Senha incorreta. Informe a senha do PDF.' : 'Informe a senha do PDF.');
      if (password) resolve(password);
      else {
        canceled = true;
        documentTask.destroy().catch(() => {});
      }
    };
    const pdf = await documentTask.promise;
    const parsed = [];
    const imagePages = [];
    const textPages = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const {items} = await page.getTextContent();
      if (!items.some(item => item.str?.trim())) {
        imagePages.push(page);
        continue;
      }
      textPages.push(page);
      const width = page.getViewport({scale: 1}).width;
      const lines = statementTextRows(items, width, bank);
      parsed.push(...parseStatement(lines,month,bank));
    }
    // Some scans have a text layer whose words do not align with the printed rows.
    const pagesToRecognize = parsed.length ? imagePages : [...imagePages, ...textPages];
    if (pagesToRecognize.length) {
      const {createPdfOcr} = await import('./ocr.mjs?v=8');
      for (const page of pagesToRecognize.sort((a,b) => a.pageNumber - b.pageNumber)) {
        status.textContent = 'Reconhecendo o texto da página ' + page.pageNumber + ' de ' + pdf.numPages + '…';
        ocr ||= await createPdfOcr();
        parsed.push(...parseStatement(await ocr.read(page, bank), month, bank));
      }
    }
    const imported = identifyStatementRows(parsed).map(row => ({...row, category: suggestCategory(row.name)}));
    statementRows = imported;
    const {alreadyRecorded} = importStatementRows(readEntries(), imported, () => Symbol(), 0);
    const remaining = imported.filter(row => !alreadyRecorded.has(row));
    selectedPdf.clear();
    for (const row of remaining) selectedPdf.add(row);
    queue = [...queue.filter(entry => entry.source !== 'pdf'),...remaining];
    review();
    if (!imported.length) {
      status.textContent = 'Nenhum lançamento reconhecido no PDF. Confira se o arquivo contém a lista de compras e se o texto está legível.';
    } else if (!remaining.length) {
      status.textContent = 'Todos os ' + imported.length + ' lançamentos reconhecidos nesta fatura já estão registrados.';
    } else {
      const skipped = alreadyRecorded.size ? ' ' + alreadyRecorded.size + ' já registrados foram ocultados.' : '';
      status.textContent = remaining.length + ' para lançar ou revisar em ' + file.name + '.' + skipped +
        (ocr ? ' Confira os dados reconhecidos.' : '') + ' Depois, toque em Lançar selecionados.';
    }
  } catch (error) {
    console.warn('Falha ao importar fatura', error.name);
    status.textContent = canceled ? 'Importação cancelada.' : error.name === 'InvalidPDFException'
      ? 'O arquivo não é um PDF válido.'
      : 'Não foi possível abrir o PDF. Confira se o arquivo abre normalmente e tente novamente.';
  } finally {
    await ocr?.close().catch(() => {});
    await documentTask?.destroy().catch(()=>{});
    pickPdf.disabled = false;
    pdfInput.value = '';
  }
}

if (window.AndroidAlerts) {
  $('native').hidden = false;
  $('native').onclick = () => window.AndroidAlerts.openSettings();
  const refresh = () => {
    const enabled = window.AndroidAlerts.enabled?.();
    $('native-status').textContent = enabled
      ? 'Acesso às notificações ativado. Novos alertas de compra aparecem abaixo para revisão.'
      : 'Autorize Meu Controle nas configurações do Android para receber alertas.';
    const alerts = JSON.parse(window.AndroidAlerts.pending());
    queue = [...queue.filter(row => !row.nativeKey), ...alerts.filter(alert => !entries.some(entry => entry.nativeKey === alert.key)).map(alert => ({
      ...parseNotice(alert.text), bank:alert.bank, date:alert.date, month:alert.date.slice(0,7), nativeKey:alert.key, source:'alert'
    }))];
    review(false);
  };
  window.addEventListener('focus',refresh);
  setInterval(refresh,2500);
  refresh();
} else {
  const install = $('install-app');
  let installPrompt;
  install.hidden = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = undefined;
    install.hidden = true;
  });
  install.onclick = async () => {
    if (!installPrompt) {
      $('install-help').showModal();
      return;
    }
    const prompt = installPrompt;
    installPrompt = undefined;
    install.disabled = true;
    try {
      const {outcome} = await prompt.prompt();
      if (outcome === 'accepted') install.hidden = true;
    } catch {
      $('install-help').showModal();
    } finally {
      install.disabled = false;
    }
  };
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.warn);
}
render();

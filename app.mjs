import {parseNotice, parseStatement, forMonth, futureTotal, candidates, statementTextRows,
  identifyStatementRows, importStatementRows, installmentCount, applyStatementForecast, statementDueDate,
  statementReferenceMonth, monthAfter} from './ledger.mjs?v=22';
import {mergeEntries, mergeClosedBills, syncEntries} from './sync.mjs?v=14';
import {categories, categoryOf, groupCharges, monthlyCharges, suggestCategory, uncategorized} from './dashboard.mjs?v=21';
import {parseSmsText, parseSmsBackup, smsKey} from './sms.mjs?v=24';
import {createPairing, readPairing} from './pairing.mjs?v=24';

const $ = id => document.getElementById(id);
const money = new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
const brl = cents => money.format(cents/100);
const localDate = new Date().toLocaleDateString('sv-SE');
const form = $('form');
const fields = form.elements;
const storageKey = 'meu-controle-ledger';
const readEntries = () => JSON.parse(localStorage.getItem(storageKey) || '[]');
const cardStorageKey = 'meu-controle-active-cards';
const billStatusStorageKey = 'meu-controle-closed-bills';
const defaultCards = ['Itaú', 'CAIXA'];
const cardKey = name => name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('pt-BR');
function readCards() {
  try {
    const saved = JSON.parse(localStorage.getItem(cardStorageKey));
    if (Array.isArray(saved) && saved.every(card => typeof card === 'string' && card.trim())) return saved;
  } catch { /* Use the starting cards if the saved list cannot be read. */ }
  return [...defaultCards];
}
let entries = readEntries();
let activeCards = readCards();
function readClosedBills() {
  try {
    const value = JSON.parse(localStorage.getItem(billStatusStorageKey) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
let closedBills = readClosedBills();
const billStatusKey = (bank, month) => bank + '|' + month;
let readingPdf = false;
let queue = [];
const selectedPdf = new Set();
let statementRows = [];
let editing;
let initialCategory;
let lastDeletion;
let entryPage = 1;
const entriesPerPage = 20;
const views = {painel:'Painel', lancamentos:'Lançamentos', faturas:'Faturas', alertas:'Alertas', configuracoes:'Configurações'};
const periodFormat = new Intl.DateTimeFormat('pt-BR', {month:'long', year:'numeric'});

for (const category of categories) fields.category.add(new Option(category, category));
for (const category of [...categories, uncategorized]) $('category-filter').add(new Option(category, category));

function setCardOptions(select, cards, value, emptyLabel) {
  select.replaceChildren();
  if (emptyLabel) select.append(new Option(emptyLabel, ''));
  for (const card of cards) select.add(new Option(card, card));
  if (cards.includes(value) || emptyLabel) select.value = cards.includes(value) ? value : '';
}

function historicCards() {
  return [...new Set(entries.filter(entry => !entry.deleted && entry.bank).map(entry => entry.bank))];
}

function renderCardSettings() {
  const list = $('managed-cards');
  list.replaceChildren();
  if (!activeCards.length) {
    const empty = document.createElement('li');
    empty.textContent = 'Nenhum cartão cadastrado.';
    list.append(empty);
  }
  for (const name of activeCards) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger-action';
    remove.textContent = 'Remover';
    remove.setAttribute('aria-label', 'Remover cartão ' + name);
    remove.onclick = () => saveCards(readCards().filter(card => card !== name), 'Cartão removido da lista ativa.');
    row.append(label, remove);
    list.append(row);
  }
  setCardOptions($('bank'), activeCards, $('bank').value);
  const noCards = !activeCards.length;
  $('bank').disabled = noCards;
  $('pick-pdf').disabled = noCards || readingPdf;
  $('no-active-cards').hidden = !noCards;
}

function saveCards(cards, message) {
  try {localStorage.setItem(cardStorageKey, JSON.stringify(cards));}
  catch {
    $('card-status').textContent = 'Não foi possível salvar os cartões neste aparelho.';
    return false;
  }
  activeCards = cards;
  renderCardSettings();
  resetEntryPage();
  $('card-status').textContent = message;
  return true;
}

$('card-form').onsubmit = event => {
  event.preventDefault();
  const field = $('card-name');
  const name = field.value.trim().replace(/\s+/g, ' ');
  if (!name) {
    $('card-status').textContent = 'Informe o nome do cartão.';
    return;
  }
  const cards = readCards();
  const key = cardKey(name);
  if (cards.some(card => cardKey(card) === key)) {
    $('card-status').textContent = 'Esse cartão já está cadastrado.';
    return;
  }
  const canonical = [...defaultCards, ...historicCards()].find(card => cardKey(card) === key) || name;
  if (saveCards([...cards, canonical], 'Cartão cadastrado.')) field.value = '';
};

window.addEventListener('storage', event => {
  if (event.key !== cardStorageKey && event.key !== storageKey && event.key !== billStatusStorageKey) return;
  activeCards = readCards();
  entries = readEntries();
  closedBills = readClosedBills();
  renderCardSettings();
  render();
});

function showView() {
  const requested = location.hash.slice(1);
  const view = Object.hasOwn(views, requested) ? requested : 'painel';
  for (const section of document.querySelectorAll('[data-view]')) section.hidden = section.dataset.view !== view;
  for (const link of document.querySelectorAll('[data-view-link]')) {
    if (link.dataset.viewLink === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  $('app-filters').hidden = view === 'alertas' || view === 'configuracoes';
  $('app-card-filter').hidden = $('app-category-filter').hidden = view === 'faturas';
  document.title = view === 'painel' ? 'Meu Controle' : views[view] + ' · Meu Controle';
}

window.addEventListener('hashchange', () => {
  showView();
  window.scrollTo(0, 0);
});

function openEntries(filter, value) {
  $(filter).value = value;
  $('search').value = '';
  $('entry-state').value = '';
  entryPage = 1;
  render();
  location.hash = 'lancamentos';
}

function paymentLabel(entry, part = entry.part) {
  const count = installmentCount(entry);
  if (!count) return part > 1 ? 'Parcela ' + part + ' · total pendente' : 'Parcelamento pendente';
  return count === 1 ? 'À vista' : part + '/' + count;
}

function drawBars(id, series, filter) {
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
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'chart-filter';
    name.onclick = () => openEntries(filter, label);
    const amount = document.createElement('strong');
    name.textContent = label;
    amount.textContent = brl(cents);
    caption.append(name, amount);
    const track = document.createElement('div');
    track.className = 'chart-track';
    track.setAttribute('aria-hidden', 'true');
    const bar = document.createElement('span');
    bar.className = cents < 0 ? 'credit-bar' : 'debit-bar';
    bar.style.width = (max ? Math.abs(cents) / max * 100 : 0) + '%';
    track.append(bar);
    item.append(caption, track);
    chart.append(item);
  }
}

function drawTrend(series, month) {
  const chart = $('monthly-chart');
  chart.replaceChildren();
  const highest = Math.max(0, ...series.map(([, cents]) => cents));
  const lowest = Math.max(0, ...series.map(([, cents]) => -cents));
  const range = highest + lowest || 1;
  const baseline = lowest / range * 100;
  for (const [label, cents] of series) {
    const [number, year] = label.split('/');
    const period = year + '-' + number;
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'trend-month';
    button.setAttribute('aria-pressed', String(period === month));
    button.title = label + ' · ' + brl(cents);
    button.setAttribute('aria-label', button.title);
    button.onclick = () => {
      $('month').value = period;
      resetEntryPage();
      $('monthly-chart').querySelector('[aria-pressed="true"]')?.focus();
    };
    const track = document.createElement('span');
    track.className = 'trend-track';
    track.style.setProperty('--baseline', baseline + '%');
    track.setAttribute('aria-hidden', 'true');
    const bar = document.createElement('span');
    bar.className = 'trend-bar' + (cents < 0 ? ' credit-bar' : '');
    bar.style.bottom = (cents < 0 ? baseline + cents / range * 100 : baseline) + '%';
    bar.style.height = Math.abs(cents) / range * 100 + '%';
    track.append(bar);
    const caption = document.createElement('span');
    caption.textContent = number + '/' + year.slice(-2);
    button.append(track, caption);
    item.append(button);
    chart.append(item);
  }
}

function renderBills(month) {
  const bills = $('bill-cards');
  bills.replaceChildren();
  const cards = [...new Set([...activeCards, ...historicCards()])];
  for (const bank of cards) {
    const charges = entries.filter(entry => !entry.deleted && entry.bank === bank)
      .map(entry => forMonth(entry, month)).filter(Boolean);
    const card = document.createElement('section');
    card.className = 'bill-card';
    const heading = document.createElement('h2');
    heading.textContent = bank;
    const value = document.createElement('strong');
    value.textContent = brl(charges.reduce((total, charge) => total + charge.cents, 0));
    const count = document.createElement('small');
    count.textContent = charges.length === 1 ? '1 lançamento no mês' : charges.length + ' lançamentos no mês';
    const closed = Boolean(closedBills[billStatusKey(bank, month)]?.closed);
    const state = document.createElement('p');
    state.className = 'bill-state' + (closed ? ' is-closed' : '');
    state.textContent = closed ? 'Fatura fechada' : 'Fatura em aberto';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = closed ? 'Reabrir fatura' : 'Marcar como fechada';
    toggle.setAttribute('aria-label', (closed ? 'Reabrir' : 'Fechar') + ' fatura ' + bank + ' de ' + month);
    toggle.onclick = () => setBillClosed(bank, month, !closed);
    const action = document.createElement('button');
    action.type = 'button';
    action.textContent = 'Ver lançamentos';
    action.setAttribute('aria-label', 'Ver lançamentos do cartão ' + bank);
    action.onclick = () => {
      $('category-filter').value = '';
      openEntries('filter', bank);
    };
    card.append(heading, value, count, state, toggle, action);
    bills.append(card);
  }
}

function setBillClosed(bank, month, closed) {
  const key = billStatusKey(bank, month);
  const now = Date.now();
  const next = {...closedBills, [key]: {bank, month, closed, updatedAt:now}};
  try {localStorage.setItem(billStatusStorageKey, JSON.stringify(next));}
  catch {
    $('bill-status').textContent = 'Não foi possível salvar o fechamento neste aparelho.';
    return;
  }
  closedBills = next;
  if (closed) {
    const nextMonth = monthAfter(month);
    $('month').value = nextMonth;
    $('bill-status').textContent = 'Fatura ' + bank + ' fechada. Exibindo ' + nextMonth.split('-').reverse().join('/') + '.';
    render();
    return;
  }
  $('bill-status').textContent = 'Fatura reaberta.';
  renderBills(month);
}

function resetEntryPage() {
  entryPage = 1;
  render();
}

function render() {
  const month = $('month').value;
  setCardOptions($('filter'), [...new Set([...activeCards, ...historicCards()])], $('filter').value, 'Todos');
  const card = $('filter').value;
  const category = $('category-filter').value;
  const selected = entries.filter(entry =>
    !entry.deleted && (!card || entry.bank === card) && (!category || categoryOf(entry) === category));
  const visible = selected.map(entry => ({entry, bill:forMonth(entry,month),
    forecast: Boolean(entry.projection) || entry.month < month})).filter(row => row.bill);
  visible.sort((a,b) => b.entry.date.localeCompare(a.entry.date) ||
    (b.entry.time || '').localeCompare(a.entry.time || '') ||
    (b.entry.updatedAt || 0) - (a.entry.updatedAt || 0));
  $('dashboard-period').textContent = periodFormat.format(new Date(month + '-15T12:00'));
  $('shortcut-entry-count').textContent = visible.length === 1 ? '1 lançamento no mês' : visible.length + ' lançamentos no mês';
  $('total').textContent = brl(visible.reduce((sum,row) => sum + row.bill.cents,0));
  const projected = visible.filter(row => row.forecast);
  $('total-caption').textContent = !projected.length ? 'Total da fatura registrada'
    : projected.length === visible.length ? 'Total previsto no mês' : 'Total registrado e previsto';
  const nextMonth = monthAfter(month);
  const nextTotal = selected.reduce((sum, entry) => sum + (forMonth(entry, nextMonth)?.cents || 0), 0);
  const laterTotal = selected.reduce((sum,entry) => sum + futureTotal(entry, nextMonth),0);
  $('next-month-caption').textContent = 'Próxima fatura · ' + nextMonth.split('-').reverse().join('/');
  $('future').textContent = brl(nextTotal);
  $('later-total').textContent = 'Após a próxima: ' + brl(laterTotal);
  $('pending').textContent = visible.filter(({entry}) => !installmentCount(entry)).length;
  drawBars('category-chart', groupCharges(visible, categoryOf), 'category-filter');
  drawBars('card-chart', groupCharges(visible, entry => entry.bank), 'filter');
  drawTrend(monthlyCharges(selected, month), month);
  renderBills(month);
  const query = $('search').value.trim().toLocaleLowerCase('pt-BR');
  const state = $('entry-state').value;
  const results = visible.filter(({entry}) => entry.name.toLocaleLowerCase('pt-BR').includes(query) &&
    (!state || (Boolean(installmentCount(entry)) === (state === 'confirmed'))));
  const pages = Math.max(1, Math.ceil(results.length / entriesPerPage));
  entryPage = Math.min(entryPage, pages);
  const start = (entryPage - 1) * entriesPerPage;
  const pageRows = results.slice(start, start + entriesPerPage);
  $('entry-page-status').textContent = results.length
    ? 'Mostrando ' + (start + 1) + ' a ' + (start + pageRows.length) + ' de ' + results.length
    : '';
  $('entry-pagination').hidden = pages <= 1;
  $('entry-previous').disabled = entryPage <= 1;
  $('entry-next').disabled = entryPage >= pages;
  $('entries').replaceChildren();
  $('pending-entries').replaceChildren();
  $('pending-section').hidden = !pageRows.some(({entry}) => !installmentCount(entry));
  if (!results.length) $('entries').textContent = 'Nenhum lançamento encontrado.';
  for (const {entry,bill,forecast} of pageRows) {
    const card = document.createElement('div');
    card.className = 'entry-card';
    const header = document.createElement('div');
    header.className = 'entry-card-header';
    const detail = document.createElement('span');
    detail.textContent = entry.name;
    const subtitle = document.createElement('small');
    subtitle.textContent = [categoryOf(entry), entry.bank, [entry.date.split('-').reverse().join('/'), entry.time].filter(Boolean).join(' '),
      paymentLabel(entry, bill.part), forecast ? 'Previsto' : ''].filter(Boolean).join(' · ');
    detail.append(subtitle);
    const value = document.createElement('b');
    value.textContent = brl(bill.cents);
    const actions = document.createElement('div');
    actions.className = 'entry-card-actions';
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.textContent = 'Editar';
    editButton.setAttribute('aria-label', 'Editar ' + entry.name);
    editButton.onclick = () => edit(entry);
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'danger-action';
    deleteButton.textContent = 'Excluir';
    deleteButton.setAttribute('aria-label', 'Excluir ' + entry.name);
    deleteButton.onclick = () => deleteEntry(entry);
    actions.append(editButton, deleteButton);
    const controls = document.createElement('div');
    controls.className = 'entry-card-controls';
    controls.append(value, actions);
    header.append(detail, controls);
    card.append(header);
    $(installmentCount(entry) ? 'entries' : 'pending-entries').append(card);
  }
}

function review(refreshPdf = true) {
  $('review').replaceChildren();
  const alerts = queue.filter(item => item.source !== 'pdf');
  $('nav-alert-count').textContent = alerts.length;
  $('nav-alert-count').hidden = !alerts.length;
  $('shortcut-alert-count').textContent = alerts.length ?
    (alerts.length === 1 ? '1 aviso para revisar' : alerts.length + ' avisos para revisar') : 'Revisar avisos bancários e SMS';
  if (!alerts.length) $('review').textContent = 'Nenhum alerta aguardando revisão.';
  for (const item of alerts) {
    const button = document.createElement('button');
    button.className = 'entry';
    button.textContent = item.name + ' · ' + (item.cents == null ? 'Valor pendente' : brl(item.cents)) +
      (item.date ? ' · ' + item.date.split('-').reverse().join('/') : '') + ' · ' + paymentLabel(item) +
      (item.confirmationPending ? ' · Confirmar compra' : '');
    button.onclick = () => edit(item);
    $('review').append(button);
  }
  if (!refreshPdf) return;
  $('pdf-rows').replaceChildren();
  const pdfRows = queue.filter(item => item.source === 'pdf').sort((a, b) =>
    b.month.localeCompare(a.month) || b.date.localeCompare(a.date) ||
    Number(Boolean(installmentCount(a))) - Number(Boolean(installmentCount(b))));
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
  let previousPending;
  for (const item of pdfRows) {
    if (billingMonth !== item.month) {
      billingMonth = item.month;
      previousPending = undefined;
      const heading = document.createElement('h3');
      heading.className = 'pdf-billing-month';
      heading.textContent = (item.projection ? 'Próxima fatura' : 'Fatura do mês') + ' · ' + billingMonth.split('-').reverse().join('/');
      $('pdf-rows').append(heading);
    }
    const isPending = !installmentCount(item);
    if (previousPending !== isPending) {
      previousPending = isPending;
      const heading = document.createElement('h4');
      heading.className = 'pdf-billing-month';
      heading.textContent = isPending ? 'Parcelamento a confirmar' : 'Parcelamento definido';
      $('pdf-rows').append(heading);
    }
    const button = document.createElement('button');
    button.className = 'entry pdf-item-summary';
    const updateLabel = () => {
      button.textContent = item.date.split('-').reverse().join('/') + ' · ' + item.name + ' · ' + brl(item.cents) + ' · ' + paymentLabel(item);
    };
    updateLabel();
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
    const header = document.createElement('div');
    header.className = 'pdf-row-header';
    header.append(checkbox, button);
    const fields = document.createElement('div');
    fields.className = 'pdf-row-fields';
    const category = document.createElement('select');
    category.append(new Option(uncategorized, ''));
    for (const value of categories) category.add(new Option(value, value));
    category.value = item.category || '';
    category.onchange = () => {
      item.category = category.value;
      item.categoryReviewed = true;
    };
    const part = document.createElement('input');
    const count = document.createElement('input');
    for (const input of [part, count]) {
      input.type = 'number';
      input.min = '1';
      input.max = '120';
      input.step = '1';
      input.inputMode = 'numeric';
    }
    part.required = true;
    part.value = item.part;
    count.value = installmentCount(item) ?? '';
    count.placeholder = 'Pendente';
    const updateInstallments = () => {
      const confirmed = Boolean(installmentCount(item));
      part.setCustomValidity(count.value && part.valueAsNumber > count.valueAsNumber
        ? 'A parcela atual deve ser menor ou igual ao total.' : '');
      if (!part.validity.valid || !count.validity.valid) return;
      item.part = part.valueAsNumber;
      item.count = count.value ? count.valueAsNumber : null;
      item.installmentPending = !item.count;
      updateLabel();
      if (!confirmed && item.count) {
        selectedPdf.add(item);
        checkbox.checked = true;
        selectionChanged();
      }
    };
    part.oninput = count.oninput = updateInstallments;
    for (const [labelText, field] of [['Categoria', category], ['Parcela', part], ['Total de parcelas', count]]) {
      const label = document.createElement('label');
      label.append(labelText, field);
      fields.append(label);
    }
    row.append(header, fields);
    $('pdf-rows').append(row);
  }
  selectionChanged();
}

$('save-pdf').onclick = () => {
  const rows = queue.filter(item => selectedPdf.has(item));
  if (!rows.length) return;
  if (rows.some(row => !activeCards.includes(row.bank))) {
    $('status').textContent = 'Cadastre novamente o cartão de origem em Gerenciar cartões para concluir esta importação.';
    return;
  }
  for (const row of $('pdf-rows').querySelectorAll('.pdf-row')) {
    if (!row.querySelector('input[type=checkbox]').checked) continue;
    for (const input of row.querySelectorAll('input[type=number]')) {
      if (!input.reportValidity()) return;
    }
  }
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
  resetEntryPage();
  review();
  $('status').textContent = [
    result.added + ' novos lançamentos',
    result.updated ? result.updated + ' compras conciliadas' : '',
    result.duplicates ? result.duplicates + ' já registrados' : '',
    result.pending.length ? result.pending.length + ' precisam de revisão individual' : ''
  ].filter(Boolean).join(' · ') + '.';
};

function edit(entry) {
  if (!entry.id && !activeCards.length) {
    location.hash = 'configuracoes';
    $('card-status').textContent = 'Cadastre um cartão para lançar compras.';
    return;
  }
  editing = entry;
  fields.name.value = entry.name || '';
  const cards = entry.id && entry.bank && !activeCards.includes(entry.bank) ? [...activeCards, entry.bank] : activeCards;
  const requestedCard = entry.bank || $('bank').value;
  setCardOptions(fields.bank, cards, requestedCard, cards.includes(requestedCard) ? '' : 'Escolher cartão');
  fields.date.value = entry.date || localDate;
  $('entry-date-label').textContent = entry.dateIsReference ? 'Data de referência' : 'Data da compra';
  fields.month.value = entry.month || $('month').value;
  fields.amount.value = entry.cents == null ? '' : (entry.cents/100).toFixed(2);
  fields.count.value = installmentCount(entry) ?? (entry.source || entry.id ? '' : 1);
  fields.part.value = entry.part || 1;
  initialCategory = entry.id ? entry.category || '' : suggestCategory(entry.name || '');
  fields.category.value = initialCategory;
  fields.part.setCustomValidity('');
  $('amount-label').textContent = entry.statementValue ? 'Valor da parcela (R$)' : 'Valor total da compra (R$)';
  updateMatch();
  $('editor').showModal();
}

function draft() {
  const count = Number(fields.count.value) || null;
  return {...editing,name:fields.name.value.trim(),bank:fields.bank.value,category:fields.category.value,date:fields.date.value,month:fields.month.value,
    cents:Math.round(Number(fields.amount.value)*100),count,part:Number(fields.part.value),
    ...(editing.source === 'pdf' && !count && {installmentPending:true})};
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
  if (event.target === fields.count && fields.count.value === '1') fields.part.value = '1';
  fields.part.setCustomValidity('');
  if (event.target.id !== 'merge') updateMatch();
};

$('set-one-payment').onclick = () => {
  fields.count.value = '1';
  fields.part.value = '1';
  fields.part.setCustomValidity('');
  updateMatch();
};
form.onsubmit = event => {
  event.preventDefault();
  const entry = draft();
  if (entry.count && entry.part > entry.count) {
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

function deleteEntry(selected) {
  if (!confirm('Excluir este lançamento e suas parcelas vinculadas?')) return;
  const current = readEntries();
  const entry = current.find(row => row.id === selected.id && !row.deleted);
  if (!entry) {
    $('entry-status').textContent = 'Este lançamento já foi excluído.';
    return;
  }
  const removed = {id: entry.id, deleted: true, updatedAt: Math.max(Date.now(), (entry.updatedAt || 0) + 1)};
  const next = current.map(row => row.id === entry.id ? removed : row);
  try {localStorage.setItem(storageKey, JSON.stringify(next));}
  catch { $('entry-status').textContent = 'Falha ao excluir no aparelho.'; return; }
  lastDeletion = {entry, updatedAt: removed.updatedAt};
  entries = next;
  $('entry-status').textContent = 'Lançamento excluído.';
  $('undo-delete').hidden = false;
  render();
}

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
let scannedPairing;
let pairingTimer;
$('pair-create').hidden = Boolean(window.AndroidAlerts);
$('pair-create').onclick = async () => {
  const status = $('pair-status');
  const input = $('sync-token');
  const token = input.value.trim() || syncToken;
  if (!token) {
    status.textContent = 'Informe o token do GitHub antes de gerar o QR.';
    input.focus();
    return;
  }
  $('pair-create').disabled = true;
  try {
    const {code, pin} = await createPairing(token);
    const qr = window.qrcode(0, 'M');
    qr.addData(code);
    qr.make();
    $('pair-qr').src = qr.createDataURL(4, 16);
    $('pair-code').textContent = pin.match(/.{4}/g).join(' ');
    $('pair-qr-dialog').showModal();
    clearTimeout(pairingTimer);
    pairingTimer = setTimeout(() => $('pair-qr-dialog').close(), 4 * 60 * 1000);
    status.textContent = '';
  } catch {
    status.textContent = 'Não foi possível gerar o QR de pareamento.';
  } finally {
    $('pair-create').disabled = false;
  }
};
$('pair-qr-dialog').onclose = () => {
  clearTimeout(pairingTimer);
  $('pair-qr').removeAttribute('src');
  $('pair-code').textContent = '';
};
$('pair-pin-close').onclick = () => $('pair-pin-dialog').close();
$('pair-pin-dialog').onclose = () => {
  scannedPairing = undefined;
  $('pair-pin').value = '';
  $('pair-pin-status').textContent = '';
};
$('pair-pin-form').onsubmit = async event => {
  event.preventDefault();
  const button = $('pair-pin-form').querySelector('button[type=submit]');
  button.disabled = true;
  try {
    syncToken = await readPairing(scannedPairing, $('pair-pin').value.replace(/\s/g, ''));
    $('pair-pin-dialog').close();
    $('sync-token').value = '';
    $('sync-form').requestSubmit();
  } catch (error) {
    $('pair-pin-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
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
    const synced = await syncEntries(syncToken, readEntries, readClosedBills);
    const current = readEntries();
    const next = mergeEntries(synced.entries, current);
    const nextClosedBills = mergeClosedBills(synced.closedBills, readClosedBills());
    localStorage.setItem(storageKey, JSON.stringify(next));
    localStorage.setItem(billStatusStorageKey, JSON.stringify(nextClosedBills));
    entries = next;
    closedBills = nextClosedBills;
    render();
    status.textContent = next.length === synced.entries.length &&
      next.every((entry, index) => entry === synced.entries[index]) &&
      JSON.stringify(nextClosedBills) === JSON.stringify(synced.closedBills)
      ? 'Lançamentos e fechamentos sincronizados.'
      : 'Há alterações locais mais recentes. Sincronize novamente para enviá-las.';
  } catch (error) {
    status.textContent = error instanceof TypeError
      ? 'Sem conexão com o GitHub. Tente novamente.'
      : error.message;
  } finally {
    $('sync-button').disabled = false;
  }
};

const lastEntryMonth = entries.filter(entry => !entry.deleted && /^\d{4}-\d{2}$/.test(entry.month))
  .reduce((latest, entry) => entry.month > latest ? entry.month : latest, '');
const lastClosedBill = Object.values(closedBills).filter(bill => bill.closed)
  .reduce((latest, bill) => bill.month > latest ? bill.month : latest, '');
const focusMonth = [lastEntryMonth, lastClosedBill].filter(Boolean).sort().at(-1) || localDate.slice(0,7);
$('month').value = lastClosedBill === focusMonth ? monthAfter(focusMonth) : focusMonth;
$('month').onchange = () => {$('month').value ||= localDate.slice(0,7); resetEntryPage();};
$('filter').onchange = resetEntryPage;
$('category-filter').onchange = resetEntryPage;
$('entry-state').onchange = resetEntryPage;
$('search').oninput = resetEntryPage;
$('add').onclick = () => edit({});
$('add-entry').onclick = () => edit({});
for (const [id, change] of [['entry-previous', -1], ['entry-next', 1]]) {
  $(id).onclick = () => {
    entryPage += change;
    render();
    $('entry-page-status').scrollIntoView({block:'start'});
  };
}
$('close').onclick = () => $('editor').close();

function queueSms(rows) {
  const status = $('sms-status');
  if (!rows.length) {
    status.textContent = 'Nenhum SMS de compra da CAIXA reconhecido.';
    return;
  }
  const prior = readEntries();
  const seen = new Set([...prior, ...queue].filter(row =>
    !row.deleted && row.source === 'alert' && row.bank === 'CAIXA' && row.date && Number.isSafeInteger(row.cents))
    .map(smsKey));
  let added = 0;
  for (const row of rows) {
    const key = smsKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push({...row, count:row.count || 1, part:row.part || 1, month:row.date.slice(0, 7),
      category:suggestCategory(row.name, prior), confirmationPending:true, source:'alert'});
    added++;
  }
  const skipped = rows.length - added;
  status.textContent = added + ' SMS adicionados à revisão.' + (skipped ? ' ' + skipped + ' já estavam na fila ou gravados.' : '');
  review(false);
}

$('read').onclick = () => {
  const text = $('notice').value.trim();
  if (!text) { $('notice').focus(); return; }
  const messages = parseSmsText(text, localDate);
  if (messages.length > 1) {
    queueSms(messages);
    $('notice').value = '';
    return;
  }
  edit({...parseNotice(text, localDate),source:'alert'});
};

$('sms-file').onchange = async () => {
  const field = $('sms-file');
  const file = field.files[0];
  if (!file) return;
  try {
    if (file.size > 25_000_000 || !/\.(xml|txt)$/i.test(file.name)) {
      $('sms-status').textContent = 'Escolha um backup SMS em XML ou um arquivo TXT até 25 MB.';
      return;
    }
    const content = await file.text();
    queueSms(/\.xml$/i.test(file.name) ? parseSmsBackup(content, localDate) : parseSmsText(content, localDate));
  } catch {
    $('sms-status').textContent = 'Não foi possível abrir o arquivo de histórico SMS.';
  } finally {
    field.value = '';
  }
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
const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
document.addEventListener('dragenter', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dropZone.classList.add('dragging');
});
document.addEventListener('dragover', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = pickPdf.disabled ? 'none' : 'copy';
  dropZone.classList.toggle('dragging', !pickPdf.disabled);
});
document.addEventListener('dragleave', event => {
  if (hasFiles(event) && !event.relatedTarget) dropZone.classList.remove('dragging');
});
document.addEventListener('drop', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dropZone.classList.remove('dragging');
  importPdf(event.dataTransfer.files);
});

async function importPdf(files) {
  if (!files?.length || pickPdf.disabled) return;
  const status = $('status');
  $('pdf-bank-forecast').hidden = true;
  const [file] = files;
  if (files.length !== 1 || !/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    status.textContent = 'Selecione um único arquivo PDF da fatura.';
    pdfInput.value = '';
    return;
  }
  let {value:month} = $('month');
  const {value:bank} = $('bank');
  readingPdf = true;
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
    const controls = {};
    const section = {};
    let dueDate;
    const imagePages = [];
    const textPages = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const {items} = await page.getTextContent();
      if (pageNo === 1) {
        dueDate = statementDueDate(items);
        month = statementReferenceMonth(items, bank, month, dueDate);
      }
      if (!items.some(item => item.str?.trim())) {
        imagePages.push(page);
        continue;
      }
      textPages.push(page);
      const width = page.getViewport({scale: 1}).width;
      const lines = statementTextRows(items, width, bank, section);
      parsed.push(...parseStatement(lines, month, bank, controls));
    }
    // Some scans have a text layer whose words do not align with the printed rows.
    const pagesToRecognize = parsed.length ? imagePages : [...imagePages, ...textPages];
    if (pagesToRecognize.length) {
      const {createPdfOcr} = await import('./ocr.mjs?v=8');
      for (const page of pagesToRecognize.sort((a,b) => a.pageNumber - b.pageNumber)) {
        status.textContent = 'Reconhecendo o texto da página ' + page.pageNumber + ' de ' + pdf.numPages + '…';
        ocr ||= await createPdfOcr();
        parsed.push(...parseStatement(await ocr.read(page, bank), month, bank, controls));
      }
    }
    const previous = readEntries();
    const imported = identifyStatementRows(applyStatementForecast(parsed, month, controls))
      .map(row => ({...row, category: suggestCategory(row.name, previous)}));
    statementRows = imported;
    const {alreadyRecorded} = importStatementRows(previous, imported, () => Symbol(), 0);
    if (Number.isSafeInteger(controls.nextCents)) {
      $('pdf-bank-forecast').textContent = 'Previsão do banco no PDF para ' +
        monthAfter(month).split('-').reverse().join('/') + ': ' + brl(controls.nextCents) + '.';
      $('pdf-bank-forecast').hidden = false;
    }
    const remaining = imported.filter(row => !alreadyRecorded.has(row));
    selectedPdf.clear();
    for (const row of remaining) {
      if (installmentCount(row)) selectedPdf.add(row);
    }
    queue = [...queue.filter(entry => entry.source !== 'pdf'),...remaining];
    review();
    if (!imported.length) {
      status.textContent = 'Nenhum lançamento reconhecido no PDF. Confira se o arquivo contém a lista de compras e se o texto está legível.';
    } else if (!remaining.length) {
      status.textContent = 'Todos os ' + imported.length + ' lançamentos reconhecidos nesta fatura já estão registrados.';
    } else {
      const skipped = alreadyRecorded.size ? ' ' + alreadyRecorded.size + ' já registrados foram ocultados.' : '';
      const due = dueDate ? ' · Vencimento ' + dueDate.split('-').reverse().join('/') : '';
      const reference = ' Fatura de ' + month.split('-').reverse().join('/') + due + '.';
      status.textContent = remaining.length + ' para lançar ou revisar em ' + file.name + '.' + reference + skipped +
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
    readingPdf = false;
    pickPdf.disabled = !activeCards.length;
    pdfInput.value = '';
  }
}

if (window.AndroidAlerts) {
  $('android-builds').hidden = true;
  $('native').hidden = false;
  $('native').onclick = () => window.AndroidAlerts.openSettings();
  if (window.AndroidAlerts.scanPairing) {
    $('pair-scan').hidden = false;
    $('pair-scan').onclick = () => window.AndroidAlerts.scanPairing();
  }
  if (window.AndroidAlerts.installedVersion) {
    $('android-update').hidden = false;
    $('android-version').textContent = 'Versão Android ' + window.AndroidAlerts.installedVersion();
    let updateUrl;
    const checkUpdate = async (silent = false) => {
      const status = $('update-status');
      if (!silent) status.textContent = 'Verificando…';
      $('check-update').disabled = true;
      try {
        const response = await fetch('https://api.github.com/repos/picuuai/meu-controle/releases/latest', {cache:'no-store'});
        if (!response.ok) throw new Error();
        const release = await response.json();
        const version = Number(release.tag_name?.match(/^android-(\d+)$/)?.[1]);
        const asset = release.assets?.find(item => item.name === 'meu-controle-android.apk');
        if (!Number.isSafeInteger(version) || !asset) throw new Error();
        updateUrl = version > window.AndroidAlerts.installedVersion() ? asset.browser_download_url : undefined;
        $('get-update').hidden = !updateUrl;
        if (updateUrl) status.textContent = 'Nova versão do Android disponível.';
        else if (!silent) status.textContent = 'O APK está atualizado.';
      } catch {
        if (!silent) status.textContent = 'Não foi possível verificar a versão agora.';
      } finally {
        $('check-update').disabled = false;
      }
    };
    $('check-update').onclick = () => checkUpdate();
    $('get-update').onclick = () => window.AndroidAlerts.downloadUpdate(updateUrl);
    checkUpdate(true);
  }
  const refresh = () => {
    const enabled = window.AndroidAlerts.enabled?.();
    const connected = enabled && (window.AndroidAlerts.connected?.() ?? true);
    $('native').textContent = enabled ? 'Gerenciar acesso às notificações' : 'Ativar acesso às notificações';
    $('native-status').textContent = connected
      ? 'Acesso ativado. Alertas dos bancos e avisos de compra do SMS 29194 aparecem para revisão.'
      : enabled ? 'Acesso concedido. Aguardando conexão do Android.'
        : 'Acesso desativado. Autorize o Meu Controle nas configurações do Android.';
    const shared = [];
    for (let index = 0; index < 50; index++) {
      const message = window.AndroidAlerts.takeSharedMessage?.();
      if (!message) break;
      shared.push(...parseSmsText(message, localDate));
    }
    if (shared.length) {
      queueSms(shared);
      location.hash = 'alertas';
    }
    if (!$('editor').open && !$('pair-pin-dialog').open) {
      const code = window.AndroidAlerts.takePairingCode?.();
      if (code) {
        scannedPairing = code;
        location.hash = 'configuracoes';
        $('sync-form').closest('details').open = true;
        $('pair-pin-dialog').showModal();
      }
    }
    const alerts = JSON.parse(window.AndroidAlerts.pending());
    queue = [...queue.filter(row => !row.nativeKey), ...alerts.filter(alert => !entries.some(entry => entry.nativeKey === alert.key)).map(alert => {
      const parsed = parseNotice(alert.text, alert.date);
      const date = parsed.date || alert.date;
      return {...parsed, bank:alert.bank, date, month:date.slice(0,7), nativeKey:alert.key, source:'alert'};
    })];
    review(false);
  };
  window.addEventListener('focus',refresh);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
  $('native-sms-help').hidden = false;
  setInterval(refresh,2500);
  refresh();
} else {
  const install = $('install-app');
  let installPrompt;
  install.hidden = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  install.textContent = 'Instalar versão web';
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
showView();
renderCardSettings();
render();
review();

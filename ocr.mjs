import Tesseract from './ocr/tesseract.mjs';

function caixaRows(tsv, width) {
  const columns = [[], []];
  for (const line of tsv.split('\n')) {
    const [level,,,,,, left, top, size, height,, value] = line.split('\t');
    if (level !== '5' || !value?.trim()) continue;
    const center = +left + +size / 2;
    const column = center < width / 2 ? 0 : 1;
    columns[column].push({x: center / width, y: +top + +height / 2, height: +height, value});
  }
  const result = [];
  for (const [column, words] of columns.entries()) {
    const offset = column / 2;
    for (const word of words) {
      if (word.x < offset + .015 || word.x > offset + .115) continue;
      const date = word.value.match(/^(\d{2})[/.|]?(\d{2})$/);
      if (!date || +date[1] < 1 || +date[1] > 31 || +date[2] < 1 || +date[2] > 12) continue;
      const row = words.filter(other => Math.abs(other.y - word.y) < word.height * .8).sort((a, b) => a.x - b.x);
      const amounts = row.filter(other => other.x > offset + .37);
      const amount = amounts.map(other => other.value).join('').match(/^([-−]?[\d.]+,\d{2})([CDO0€])?$/i);
      const description = row.filter(other => other.x > word.x && other.x > offset + .06 && other.x < offset + .25)
        .map(other => other.value).join(' ');
      if (!amount || !/\p{L}/u.test(description)) continue;
      const value = /[C€]/i.test(amount[2] || '') ? '-' + amount[1].replace(/^[-−]/, '') : amount[1];
      result.push([word.y, date[1] + '/' + date[2] + ' ' + description + ' ' + value]);
    }
  }
  return result.sort((a, b) => a[0] - b[0]).map(([, line]) => line);
}

export async function createPdfOcr() {
  const path = name => new URL('./ocr/' + name, import.meta.url).href;
  const worker = await Tesseract.createWorker('por', 1, {
    workerPath: path('worker.min.js'),
    corePath: path('tesseract-core-lstm.wasm.js'),
    langPath: path(''),
    workerBlobURL: false
  });
  try {
    await worker.setParameters({tessedit_pageseg_mode: Tesseract.PSM.AUTO});
  } catch (error) {
    await worker.terminate();
    throw error;
  }
  return {
    async read(page, bank) {
      const base = page.getViewport({scale: 1});
      const viewport = page.getViewport({scale: Math.min(3.2, 2300 / base.width, 3400 / base.height)});
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        await page.render({canvasContext: canvas.getContext('2d'), viewport}).promise;
        const readColumns = bank === 'CAIXA' && page.pageNumber > 1;
        const {data} = await worker.recognize(canvas, {}, {text: true, tsv: readColumns});
        const text = data.text.split(/\r?\n/).filter(line => line.trim());
        const columns = readColumns ? caixaRows(data.tsv, canvas.width) : [];
        return columns.length ? columns : text;
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    },
    close: () => worker.terminate()
  };
}

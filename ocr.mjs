import Tesseract from './ocr/tesseract.mjs';

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
    async read(page) {
      const base = page.getViewport({scale: 1});
      const viewport = page.getViewport({scale: Math.min(3.2, 2300 / base.width, 3400 / base.height)});
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        await page.render({canvasContext: canvas.getContext('2d'), viewport}).promise;
        const {data} = await worker.recognize(canvas);
        return data.text.split(/\r?\n/).filter(line => line.trim());
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    },
    close: () => worker.terminate()
  };
}

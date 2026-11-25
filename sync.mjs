const repository = 'picuuai/meu-controle_dados';
const api = 'https://api.github.com/repos/' + repository;
const file = api + '/contents/meu-controle/lancamentos.json';

export function mergeEntries(...lists) {
  const entries = new Map();
  for (const list of lists) {
    for (const entry of list) {
      const previous = entries.get(entry.id);
      const updated = entry.updatedAt || 0;
      const previousUpdate = previous?.updatedAt || 0;
      if (!previous || updated > previousUpdate) entries.set(entry.id, entry);
      else if (updated === previousUpdate && JSON.stringify(entry) !== JSON.stringify(previous)) {
        throw new Error('O mesmo lançamento tem duas versões com a mesma data de edição. A sincronização foi interrompida.');
      }
    }
  }
  return [...entries.values()];
}

export async function syncEntries(token, readLocal) {
  const request = (url, options = {}) => fetch(url, {
    ...options,
    cache: 'no-store',
    redirect: 'error',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    }
  });
  const repo = await request(api);
  if (!repo.ok) throw new Error('Sem acesso ao repositório de dados. Confira o token e suas permissões.');
  if (!(await repo.json()).private) throw new Error('O repositório de dados precisa estar privado.');

  const response = await request(file);
  let sha;
  let remote = [];
  if (response.ok) {
    const stored = await response.json();
    sha = stored.sha;
    if (!sha || stored.encoding !== 'base64') throw new Error('Formato do arquivo remoto incompatível.');
    const bytes = Uint8Array.from(atob(stored.content), character => character.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (data.version !== 1 || !Array.isArray(data.entries) ||
        data.entries.some(entry => !entry || typeof entry.id !== 'string' || typeof entry.date !== 'string' ||
          typeof entry.name !== 'string' || typeof entry.month !== 'string' || !Number.isSafeInteger(entry.cents))) {
      throw new Error('Arquivo remoto inválido. Os lançamentos locais foram preservados.');
    }
    remote = data.entries;
  } else if (response.status !== 404) {
    throw new Error('Não foi possível ler os lançamentos no GitHub.');
  }

  const entries = mergeEntries(remote, readLocal());
  if (JSON.stringify(entries) === JSON.stringify(remote)) return entries;

  const bytes = new TextEncoder().encode(JSON.stringify({version: 1, entries}));
  if (bytes.length > 750_000) throw new Error('O arquivo de lançamentos ultrapassou o tamanho suportado.');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const saved = await request(file, {
    method: 'PUT',
    body: JSON.stringify({message: 'Sincronizar lançamentos', content: btoa(binary), sha})
  });
  if (saved.status === 409 || saved.status === 422) {
    throw new Error('Não foi possível gravar esta versão. Tente sincronizar novamente.');
  }
  if (!saved.ok) throw new Error('Não foi possível gravar no GitHub. Confira a permissão Contents: Read and write.');
  return entries;
}

const format = 'MC1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const lifetime = 4 * 60 * 1000;

const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));

async function pairingKey(pin, salt, usage) {
  const input = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2', salt, iterations:600000, hash:'SHA-256'},
    input, {name:'AES-GCM', length:256}, false, [usage]);
}

export async function createPairing(token) {
  if (!token || token.length > 255) throw new Error('Informe um token do GitHub válido.');
  const values = crypto.getRandomValues(new Uint32Array(2));
  const pin = [...values].map(value => String(value % 1_000_000).padStart(6, '0')).join('');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const expires = Date.now() + lifetime;
  const key = await pairingKey(pin, salt, 'encrypt');
  const encrypted = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData:encoder.encode(String(expires))},
    key, encoder.encode(token));
  return {pin, code:[format, expires, encode(salt), encode(iv), encode(new Uint8Array(encrypted))].join('.')};
}

export async function readPairing(code, pin) {
  if (!/^\d{12}$/.test(pin)) throw new Error('Informe os 12 dígitos que aparecem abaixo do QR.');
  const [type, expiresText, salt, iv, encrypted, extra] = code.split('.');
  const expires = Number(expiresText);
  if (type !== format || extra || !/^[0-9]+$/.test(expiresText || '') ||
      ![salt, iv, encrypted].every(value => /^[\w-]+$/.test(value || '')) || !Number.isSafeInteger(expires)) {
    throw new Error('QR de pareamento inválido.');
  }
  if (Date.now() > expires || expires - Date.now() > lifetime + 15000) throw new Error('QR expirado. Gere outro no computador.');
  try {
    const key = await pairingKey(pin, decode(salt), 'decrypt');
    const token = decoder.decode(await crypto.subtle.decrypt({name:'AES-GCM', iv:decode(iv),
      additionalData:encoder.encode(expiresText)}, key, decode(encrypted)));
    if (!token || token.length > 255) throw new Error();
    return token;
  } catch {
    throw new Error('Código incorreto. Confira os 12 dígitos exibidos no computador.');
  }
}

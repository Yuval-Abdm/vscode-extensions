// Décodage des fichiers : UTF-8 si valide (BOM retiré), sinon Windows-1252 (fichiers historiques Latin-1).
const utf8 = new TextDecoder('utf-8', { fatal: true });
const windows1252 = new TextDecoder('windows-1252');

export function decode(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    return windows1252.decode(bytes);
  }
}

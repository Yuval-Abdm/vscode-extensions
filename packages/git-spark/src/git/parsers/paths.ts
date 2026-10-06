// Chemins affichés par git : entre guillemets, avec échappements C et octets en octal, quand ils contiennent des
// caractères spéciaux (guillemet, antislash, tabulation, saut de ligne…).

const ESCAPES: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

export function unquotePath(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  const body = text.slice(1, -1);
  const parts: Buffer[] = [];
  let last = 0;
  for (const match of body.matchAll(/\\([0-7]{3}|.)/gs)) {
    parts.push(Buffer.from(body.slice(last, match.index), 'utf8'));
    const escape = match[1];
    parts.push(/^[0-7]{3}$/.test(escape) ? Buffer.from([parseInt(escape, 8)]) : Buffer.from(ESCAPES[escape] ?? escape, 'utf8'));
    last = match.index + match[0].length;
  }
  parts.push(Buffer.from(body.slice(last), 'utf8'));
  return Buffer.concat(parts).toString('utf8');
}

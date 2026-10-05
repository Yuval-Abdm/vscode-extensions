// Garanties du formateur (§5.5) sur tous les fichiers des fixtures : jetons non blancs inchangés, PHP toujours
// valide, formater deux fois = formater une fois.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_FORMAT, formatText } from '../src/server/format/format.ts';
import { parse } from './helpers.ts';

const root = path.join(import.meta.dirname, 'fixtures');
const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.php')).sort();

describe('formateur sur les fixtures', () => {
  for (const options of [DEFAULT_FORMAT, { ...DEFAULT_FORMAT, braces: 'keep' as const, alignArrows: true, alignAssignments: true }]) {
    it(`${files.length} fichiers, accolades ${options.braces}`, async () => {
      for (const file of files) {
        const text = readFileSync(path.join(root, file), 'utf8');
        const tree = await parse(text);
        const out = formatText(tree, text, options);
        assert.equal(out.replace(/\s+/g, ''), text.replace(/\s+/g, ''), `${file} : jetons modifiés`);
        if (!tree.rootNode.hasError) assert.ok(!(await parse(out)).rootNode.hasError, `${file} : PHP invalide après formatage`);
        assert.equal(formatText(await parse(out), out, options), out, `${file} : non idempotent`);
      }
    });
  }

  it('template HTML : le HTML ne bouge pas', async () => {
    const text = readFileSync(path.join(root, 'mixed-html/liste.php'), 'utf8');
    const out = formatText(await parse(text), text, DEFAULT_FORMAT);
    const html = (s: string) => s.split('\n').filter((l) => /^\s*<(?!\?)/.test(l) && !l.includes('<?'));
    assert.deepEqual(html(out), html(text));
    assert.match(out, /<h1><\?= \$titre \?><\/h1>/);
    assert.match(out, /\n {28}echo '<b>' \. number_format\(\$client\['solde'\], 2\) \. '<\/b>';\n/);
  });
});

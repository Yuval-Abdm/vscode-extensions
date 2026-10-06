// Vérifie la cohérence des traductions des deux extensions :
// - chaque texte passé à vscode.l10n.t(...) a sa traduction dans l10n/bundle.l10n.fr.json, sans clé en trop ;
// - mêmes paramètres {0}, {1}… en anglais et en français ;
// - chaque %clé% de package.json existe dans package.nls.json et package.nls.fr.json.
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert');

const PACKAGES = ['changed-files-explorer', 'ftp-sftp-deploy', 'php-forge', 'git-spark'];
const root = path.join(__dirname, '..', 'packages');

/** Clés l10n du code (.js et .ts, sous-dossiers compris) : vscode.l10n.t('…'), l10n.t('…') et t('…'). */
function keysInCode(dir) {
  const keys = new Set();
  const call = /(?:(?:vscode\.)?l10n\.t|(?<![\w.])t)\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  for (const file of fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(js|ts)$/.test(f))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of src.matchAll(call)) keys.add(eval(m[1])); // littéral JS → chaîne
  }
  return keys;
}

const params = (s) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join(',');

for (const pkg of PACKAGES) {
  const dir = path.join(root, pkg);
  describe(`l10n ${pkg}`, () => {
    it('chaque texte du code est traduit en français, sans clé en trop', () => {
      const code = keysInCode(path.join(dir, 'src'));
      const bundle = JSON.parse(fs.readFileSync(path.join(dir, 'l10n/bundle.l10n.fr.json'), 'utf8'));
      const missing = [...code].filter((k) => !(k in bundle));
      const extra = Object.keys(bundle).filter((k) => !code.has(k));
      assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] });
      for (const [en, fr] of Object.entries(bundle)) assert.strictEqual(params(fr), params(en), `paramètres différents : « ${en} » / « ${fr} »`);
    });

    it('package.json : chaque %clé% existe en anglais et en français', () => {
      const manifest = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
      const used = new Set([...manifest.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]));
      const en = JSON.parse(fs.readFileSync(path.join(dir, 'package.nls.json'), 'utf8'));
      const fr = JSON.parse(fs.readFileSync(path.join(dir, 'package.nls.fr.json'), 'utf8'));
      assert.deepStrictEqual([...used].filter((k) => !(k in en)), [], 'clés absentes de package.nls.json');
      assert.deepStrictEqual(Object.keys(en).sort(), Object.keys(fr).sort(), 'package.nls.json et package.nls.fr.json diffèrent');
      assert.deepStrictEqual(Object.keys(en).filter((k) => !used.has(k)), [], 'clés inutilisées');
    });
  });
}

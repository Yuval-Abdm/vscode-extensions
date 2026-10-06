// Branches proposées par le sélecteur de la vue Commit : branches locales, puis branches distantes sans branche
// locale du même nom (les extraire crée la branche locale qui les suit).
import type { RefInfo } from '../../git/commands.ts';

export type BranchChoice = { kind: 'local'; name: string; current: boolean } | { kind: 'remote'; name: string; remoteBranch: string };

export function branchChoices(refs: RefInfo[], current: string | undefined): BranchChoice[] {
  const locals = refs.filter((ref) => ref.kind === 'branch').map((ref) => ref.name);
  const known = new Set(locals);
  const choices: BranchChoice[] = locals.map((name) => ({ kind: 'local', name, current: name === current }));
  // Branche courante en tête, comme dans VS Code.
  choices.sort((a, b) => Number(b.kind === 'local' && b.current) - Number(a.kind === 'local' && a.current));
  for (const ref of refs) {
    if (ref.kind !== 'remote') continue;
    // « origin/feature/x » → « feature/x »
    const name = ref.name.slice(ref.name.indexOf('/') + 1);
    if (known.has(name)) continue;
    known.add(name);
    choices.push({ kind: 'remote', name, remoteBranch: ref.name });
  }
  return choices;
}

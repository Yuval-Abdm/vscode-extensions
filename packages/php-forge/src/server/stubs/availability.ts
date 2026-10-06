// Disponibilité d'un symbole natif selon la version de PHP (since, until, removed des stubs).
import type { PhpSymbol } from '../../shared/types.ts';

/** -1, 0 ou 1 ; les composants absents valent 0 (« 8 » = « 8.0 »). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

export function isAvailable(symbol: PhpSymbol, version?: string): boolean {
  if (!version) return true;
  if (symbol.since && compareVersions(symbol.since, version) > 0) return false;
  if (symbol.until && compareVersions(version, symbol.until) > 0) return false;
  if (symbol.removed && compareVersions(version, symbol.removed) >= 0) return false;
  return true;
}

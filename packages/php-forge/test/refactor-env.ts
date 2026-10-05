// Environnement de recherche de références sur un projet en mémoire (fichiers sous /p).
import { IncludeGraph } from '../src/server/includes/graph.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import type { RefEnv, SourceFile } from '../src/server/refactor/references.ts';
import { TypeResolver } from '../src/server/types/expand.ts';
import { extract, parse } from './helpers.ts';
import { uriOf } from './project.ts';

export async function refEnv(files: Record<string, string>, stubs = '<?php function call_user_func(callable $c, mixed ...$a) {} function usort(array &$a, callable $c) {} function function_exists(string $f) {}') {
  const index = new SymbolIndex();
  const sources = new Map<string, SourceFile>();
  for (const [rel, text] of Object.entries(files)) {
    const uri = uriOf(rel);
    const symbols = await extract(text, uri);
    index.set(symbols);
    sources.set(uri, { uri, text, tree: await parse(text), symbols });
  }
  const stubIndex = new SymbolIndex();
  stubIndex.set(await extract(stubs, 'phpstub:/standard/standard.php'));
  const lookup = new Lookup(index, stubIndex);
  const env: RefEnv = {
    lookup,
    resolver: new TypeResolver(lookup, '8.3'),
    graph: new IncludeGraph(index, { roots: ['/p'], readFile: () => undefined }),
    files: () => [...index.files()],
    source: (uri) => {
      const file = sources.get(uri);
      return file && { file, release: () => undefined };
    },
  };
  return { env, file: (rel: string) => sources.get(uriOf(rel))!, uriOf };
}

/** « rel:ligne:colonne » d'une liste d'emplacements, triée. */
export function where(locations: { uri: string; range: { start: { line: number; character: number } } }[]): string[] {
  return locations.map((l) => `${l.uri.slice(l.uri.indexOf('/p/') + 3)}:${l.range.start.line}:${l.range.start.character}`).sort();
}

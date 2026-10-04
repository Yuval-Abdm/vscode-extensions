// Types sérialisables partagés : résumés de fichiers (index, cache disque, workers) et échanges client / serveur.

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'trait'
  | 'enum'
  | 'function'
  | 'method'
  | 'property'
  | 'constant'
  | 'classConstant'
  | 'enumCase';

export interface PhpSymbol {
  kind: SymbolKind;
  /** Nom court (propriétés sans « $ ») */
  name: string;
  /** Nom complet sans « \ » initial, pour les classes, fonctions et constantes globales */
  fqn?: string;
  range: Range;
  selectionRange: Range;
  /** Signature lisible : « public static function make(array $a = []): static » */
  signature?: string;
  doc?: string;
  modifiers?: string[];
  /** Parents (classe) ou interfaces parentes (interface), en noms complets */
  extends?: string[];
  implements?: string[];
  /** Traits utilisés */
  uses?: string[];
  deprecated?: boolean;
  /** Première version de PHP qui fournit le symbole (stubs) */
  since?: string;
  /** Dernière version de PHP qui le fournit (stubs, attribut PhpStormStubsElementAvailable) */
  until?: string;
  /** Première version de PHP qui ne le fournit plus (@removed) */
  removed?: string;
  children?: PhpSymbol[];
}

export type IncludeKind = 'include' | 'include_once' | 'require' | 'require_once';

export interface IncludeRef {
  kind: IncludeKind;
  range: Range;
  /** Texte de l'expression du chemin (évaluée au jalon 0.3) */
  expression: string;
}

/** Portée de noms : namespace et imports `use`. Clés en minuscules pour classes et fonctions, exactes pour les constantes. */
export interface NameScope {
  range: Range;
  namespace: string;
  uses: {
    class: Record<string, string>;
    function: Record<string, string>;
    constant: Record<string, string>;
  };
}

export interface FileSymbols {
  uri: string;
  symbols: PhpSymbol[];
  includes: IncludeRef[];
  /** Portées dans l'ordre du fichier ; la première couvre tout le fichier */
  scopes: NameScope[];
  syntaxError: boolean;
}

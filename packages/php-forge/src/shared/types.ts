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

export type ScalarName =
  | 'int'
  | 'float'
  | 'string'
  | 'bool'
  | 'true'
  | 'false'
  | 'null'
  | 'void'
  | 'never'
  | 'resource'
  | 'callable'
  | 'iterable'
  | 'object'
  | 'array-key'
  | 'scalar'
  | 'numeric';

/**
 * Type PHP sérialisable. Les classes sont en noms complets ; `self`, `static` et `parent` sont relatifs à la
 * classe qui déclare le membre ; `ref` est un type différé, résolu à la demande avec l'index.
 */
export type TypeExpr =
  | { kind: 'mixed' }
  | { kind: 'scalar'; name: ScalarName }
  | { kind: 'class'; fqn: string; args?: TypeExpr[] }
  | { kind: 'classString'; fqn?: string; template?: string }
  | { kind: 'self' }
  | { kind: 'static' }
  | { kind: 'parent' }
  | { kind: 'array'; key?: TypeExpr; value?: TypeExpr; shape?: Record<string, TypeExpr>; list?: boolean }
  | { kind: 'union'; types: TypeExpr[] }
  | { kind: 'intersection'; types: TypeExpr[] }
  | { kind: 'template'; name: string }
  | { kind: 'closure'; returns?: TypeExpr }
  | { kind: 'ref'; ref: TypeRef };

/** Ce dont dépend un type différé : retour de fonction ou de méthode, membre, constante, élément, clé. */
export type TypeRef =
  | { of: 'function'; names: string[]; args?: TypeExpr[] }
  | { of: 'method'; name: string; on: TypeExpr; args?: TypeExpr[] }
  | { of: 'property'; name: string; on: TypeExpr }
  | { of: 'classConstant'; name: string; on: TypeExpr }
  | { of: 'constant'; names: string[] }
  | { of: 'element'; on: TypeExpr }
  | { of: 'key'; on: TypeExpr }
  | { of: 'offset'; key?: string; on: TypeExpr };

export interface PhpParam {
  name: string;
  type?: TypeExpr;
  defaultValue?: string;
  variadic?: boolean;
  byRef?: boolean;
  doc?: string;
}

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
  /** Paramètres (fonctions et méthodes) */
  params?: PhpParam[];
  /** Type déclaré ou phpdoc : retour (fonctions, méthodes) ou valeur (propriétés, constantes) */
  type?: TypeExpr;
  /** Type déduit du code quand rien n'est déclaré (retours, valeur par défaut, affectations $this->x) */
  inferred?: TypeExpr;
  /** Noms des templates (@template) */
  templates?: string[];
  /** Arguments génériques des parents (@extends / @implements / @use Parent<T>), par nom complet en minuscules */
  parentArgs?: Record<string, TypeExpr[]>;
  /** Classes dont les membres sont accessibles (@mixin) */
  mixins?: string[];
  /** Membre déclaré par @property ou @method */
  virtual?: boolean;
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

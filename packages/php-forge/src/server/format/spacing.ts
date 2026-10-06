// Espaces entre deux jetons d'une même ligne (PSR-12) : opérateurs binaires et affectations entourés d'un espace,
// virgule suivie d'un espace, rien après une ouverture ni avant une fermeture, rien autour de -> et ::, un espace
// entre un mot-clé de contrôle et sa parenthèse, cast suivi d'un espace. Ailleurs : un espace s'il y en avait,
// aucun sinon (le formateur ne colle ni ne sépare ce qu'il ne connaît pas).
import type { Token } from './tokens.ts';

const OPENERS = new Set(['(', '[']);
const CLOSERS = new Set([')', ']']);
const NO_SPACE_AROUND = new Set(['->', '?->', '::']);
const CONTROL = new Set(['if', 'elseif', 'while', 'for', 'foreach', 'switch', 'catch', 'match', 'fn', 'function', 'use']);
const FUNCTION_LIKE = new Set(['array', 'list', 'isset', 'empty', 'unset', 'eval', 'exit', 'die', 'declare']);
const BINARY_PARENTS = new Set(['binary_expression', 'assignment_expression', 'augmented_assignment_expression', 'reference_assignment_expression']);
const EQUALS_PARENTS = new Set(['simple_parameter', 'property_promotion_parameter', 'const_element', 'property_element', 'static_variable_declaration', 'enum_case']);
const UNARY_PARENTS = new Set(['unary_op_expression', 'error_suppression_expression']);
const BLOCK_BRACES = new Set(['compound_statement', 'declaration_list', 'enum_declaration_list', 'switch_block', 'match_block', 'use_list']);
const COLON_TIGHT = new Set(['case_statement', 'default_statement', 'colon_block', 'argument', 'method_declaration', 'function_definition', 'anonymous_function', 'arrow_function', 'named_label_statement', 'enum_declaration']);

const isWord = (t: Token) => /^[a-z_]+$/i.test(t.type) && !t.node.isNamed;
const parentType = (t: Token) => t.node.parent?.type ?? '';

/** Opérateur binaire (ou affectation) : le jeton est l'opérateur de son parent. */
function isBinaryOperator(t: Token): boolean {
  const parent = t.node.parent;
  if (!parent) return false;
  if (t.type === '=>') return true;
  if (BINARY_PARENTS.has(parent.type)) return !t.node.isNamed && parent.childForFieldName('left')?.id !== t.node.id && parent.childForFieldName('right')?.id !== t.node.id;
  if (t.type === '=' && EQUALS_PARENTS.has(parent.type)) return true;
  if ((t.type === '?' || t.type === ':') && parent.type === 'conditional_expression') return true;
  return false;
}

/** Espace voulu entre `left` et `right` sur la même ligne ; `current` : espace actuel. */
export function spacing(left: Token, right: Token, current: string): string {
  const keep = current.length ? ' ' : '';
  // Après un commentaire `// …` qui finit sur `?>` : ses espaces de fin lui appartiennent, rien n'est ajouté
  if (left.type === 'comment') return current;
  // Balises PHP : `<?= $x ?>`, `<?php echo 1; ?>`
  if (left.type === 'php_tag') return ' ';
  if (right.type === 'php_end_tag') return ' ';
  if (right.type === ',' || right.type === ';') return '';
  if (left.type === ',') return ' ';
  if (left.type === ';') return CLOSERS.has(right.type) ? '' : ' ';
  if (OPENERS.has(left.type) || CLOSERS.has(right.type)) return '';
  if (NO_SPACE_AROUND.has(left.type) || NO_SPACE_AROUND.has(right.type)) return '';
  // `?:` reste collé
  if (left.type === '?' && right.type === ':' && parentType(left) === 'conditional_expression') return '';
  if (right.type === ':' && COLON_TIGHT.has(parentType(right))) return '';
  if (left.type === ':' && COLON_TIGHT.has(parentType(left))) return parentType(left) === 'colon_block' ? keep : ' ';
  if (isBinaryOperator(left) || isBinaryOperator(right)) return ' ';
  if (right.type === '(') {
    if (parentType(right) === 'cast_expression') return keep;
    if (isWord(left)) {
      const word = left.type.toLowerCase();
      return CONTROL.has(word) ? ' ' : FUNCTION_LIKE.has(word) ? '' : keep;
    }
    if (parentType(right) === 'arguments' || parentType(right) === 'formal_parameters') return '';
    return keep;
  }
  // Cast : `(int) $x`
  if (left.type === ')' && parentType(left) === 'cast_expression') return ' ';
  const first = (t: Token) => t.node.parent?.firstChild?.id === t.node.id;
  // `- -$b`, `- --$b`, `+ +$b` : collés, ils deviendraient `--$b` (décrément) ; l'espace reste
  if ((left.type === '-' || left.type === '+') && right.type.startsWith(left.type) && parentType(left) === 'unary_op_expression') return keep;
  if (UNARY_PARENTS.has(parentType(left)) && !left.node.isNamed && first(left)) return '';
  // `++$i` (préfixe) collé à sa variable, `$i++` (suffixe) aussi ; `return ++$i` garde son espace
  if ((left.type === '++' || left.type === '--') && parentType(left) === 'update_expression' && first(left)) return '';
  if ((right.type === '++' || right.type === '--') && parentType(right) === 'update_expression' && !first(right)) return '';
  if (left.type === '&' && parentType(left) === 'reference_assignment_expression') return '';
  if (left.type === '...' || left.type === '&' && parentType(left) === 'reference_modifier' || left.type === '?' && parentType(left) === 'optional_type') return '';
  if (parentType(left) === 'declare_directive' || parentType(right) === 'declare_directive') return keep;
  if (right.type === '{' && BLOCK_BRACES.has(parentType(right))) return ' ';
  // `{ return 1; }` : un espace à l'intérieur des accolades d'un bloc sur une ligne, rien dans `{}`
  if (left.type === '{' && BLOCK_BRACES.has(parentType(left))) return right.type === '}' ? '' : ' ';
  if (right.type === '}' && BLOCK_BRACES.has(parentType(right))) return ' ';
  if (right.type === 'use' && parentType(right) === 'anonymous_function_use_clause') return ' ';
  if (left.type === '}' && /^(else|elseif|catch|finally|while)$/i.test(right.type)) return ' ';
  return keep;
}

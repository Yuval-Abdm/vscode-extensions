# Changelog

## 0.5.0 — preview

- Rename and Find All References across the project: variables (also across includes and `global`), parameters (with named arguments), functions, classes, methods, properties, constants and namespaces; `'Class::method'` strings and callables (`[$obj, 'm']`, `[Foo::class, 'm']`) when certain. Native and library symbols cannot be renamed.
- "N references" / "N implementations" CodeLens (`phpForge.codeLens.references`, `phpForge.codeLens.implementations`).
- Auto-import: accepting a class, function or constant from another namespace adds the sorted `use` (`phpForge.completion.autoImport`).
- Suggested imports on unknown names ("Import Lib\User", "Import all missing classes"); for code without namespaces, "Add include 'includes/fonctions.php'" written in the file's own style (`ROOT_PATH.'/…'`, `__DIR__ . '/…'`, relative).
- Organize use statements (sort, group, remove unused), also on save with `phpForge.organizeUsesOnSave`.
- Code generation: getters and setters, constructor (property promotion from PHP 8.0), missing methods of interfaces and abstract classes, PHPDoc skeleton, `@var` for a variable.
- Quick fixes: declare an undefined variable, replace a deprecated or removed function by its documented replacement.
- Fewer false positives on legacy code: properties written as `$this->x[] = …`, `+=`, `++` or `$this->$name = …`, members used inside traits, `method_exists` / `property_exists` guards, `$a ?: $b ?: $c`, `$s{0}` before PHP 7.4.

## 0.4.0 — preview

- Diagnostics: undefined functions, classes and constants; methods and properties that do not exist on a known type (never on untyped code, classes with `__call` / `__get`, `@mixin` or an unknown parent); argument count of the project's functions and methods; unused `use` and unreachable code (grayed out).
- PHP version: functions removed in, added after or deprecated for `phpForge.phpVersion` (`mysql_query` in 7.x, `str_contains` before 8.0, `each` since 7.2); deprecated syntax with safe quick fixes (`$s{0}`, `(real)`, nested ternaries, `${var}` in strings, implicitly nullable parameters, PHP 4 constructors).
- Functions and classes declared twice in an include chain, files included twice without `_once`.
- Every file of the project is analyzed in the background and listed in the Problems view (`phpForge.diagnostics.scope`); library folders (`phpForge.libraryPaths`, folders with their own `composer.json`) are never diagnosed.
- Level per rule (`phpForge.diagnostics.rules`), `// @php-forge-ignore <code>` and `/** @php-forge-ignore-file <code> */` with "Ignore on this line / in this file" quick fixes.
- Baseline: "Create Baseline" hides the existing problems of a legacy project (`.vscode/php-forge-baseline.json`), only new ones are shown; count in the status bar.

## 0.3.0 — preview

- Include engine for projects without autoload: include paths are evaluated (`ROOT_PATH.'/…'`, `$_SERVER['DOCUMENT_ROOT']`, `__DIR__`, `dirname(__FILE__)`, constants, server paths from `phpForge.serverRoot` or `.vscode/deploy.json`), and every file is analyzed in the context of each file that includes it.
- Undefined variables with the strict rule: a variable is reported as soon as one caller does not define it, with the list of faulty callers (`$title is not defined when included from lp_3/index.php:3 (defined in 2 other callers)`); variables defined in only one branch are reported as information.
- `extract($_POST)`, by-reference parameters (`preg_match`, `bind_result`), `isset` / `empty` / `??` guards, `global`, `static`, closures are understood; dynamic code stops the warnings instead of guessing.
- Unresolved includes (with a `/** @include path */` hint), functions, classes and constants declared in a file that is not included.
- Variables coming from included files and callers: type (a `$pdo` created in `connexion_DB.php` is a `PDO` in the pages), origin on hover, go to definition, completion.
- "Included by N files" CodeLens, Include Tree view in the Explorer, go to definition from an include.
- Settings: `phpForge.documentRoot`, `phpForge.serverRoot`, `phpForge.includes.maxContexts`, `phpForge.externalGlobals`.

## 0.2.0 — preview

- Type inference: declared types and phpdoc (generics, array shapes, templates, `@property`, `@method`, `@mixin`), types inferred from code (return values, properties assigned in constructors, constants), variable flow with narrowing (`instanceof`, `is_*`, null checks, `assert`).
- Completion: variables, members by type (visibility respected), static members, functions / classes / constants filtered by PHP version and enabled extensions, keywords, include paths, known array keys, phpdoc tags; documentation on demand.
- Signature help and inlay hints (parameter names; variable and return types optional).
- Typed go to definition (closest override), go to implementation, document highlights, folding, smart selection, semantic highlighting.
- Hover shows variable types and php.net links.
- Missing `;` detected on the right line (instead of an "unexpected" error on the next one), with an "Add `;`" quick fix.
- PHP tags in HTML: a value alone in `<?php $x ?>` / `<?$x?>` is never printed (warning, fixes: `<?=` or `<?php echo`); short open tag `<?` flagged (fix: `<?php`).
- SQL in strings highlighted across the whole query: concatenations (`'SELECT …'.$id.' GROUP BY …'`, even when the next part starts on another line), `$sql .= ' AND …'` and query function arguments (`rp_query`, `->query`, `mysqli_query`…).
- SQL queries that mix PHP quotes (`'UPDATE …'.$d." = '"…`) are flagged, with a quick fix that converts the whole query to the quotes needing the fewest escapes (usually double quotes, so SQL `'` stay as is); quotes that only wrap a value (`"'"`) are allowed.
- Hovering a line with an error or warning shows the problem, the proposed fix and an "Apply" link that fixes it in one click (the hover then closes; the same problem reported on several parts of a line is shown once).
- PHP version (`phpForge.phpVersion`, detected from `composer.json` or the `php` executable) shown in the status bar; `phpForge.stubs` selects PHP extensions.

## 0.1.0 — preview

- PHP language server (tree-sitter-php): whole-workspace indexing in the background, worker threads, disk cache.
- Document outline, workspace symbol search (Ctrl+T), go to definition, hover (signature, phpdoc, PHP versions).
- Native PHP functions, classes and constants (JetBrains phpstorm-stubs).
- Live syntax errors.
- Latin-1 / Windows-1252 files supported.

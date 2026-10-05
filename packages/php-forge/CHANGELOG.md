# Changelog

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

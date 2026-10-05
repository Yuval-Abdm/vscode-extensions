# Changelog

## 0.9.0 — preview

- **PHP Impact** view (Explorer): the PHP files changed in Git or not saved yet, each with the pages that load it through includes (the scripts nobody includes) — what to check before deploying. Files reached through a dynamic include path are marked as possibly incomplete.
- **Deploy changed files** (view title bar, with the FTP SFTP Deploy extension): uploads every changed file with the workspace's deploy profile, after offering to save unsaved files, warning when a file has errors (`phpForge.deploy.checkErrors`) and confirming the server and the files to send; files in merge conflict are never sent.

## 0.8.0 — preview

- Security: request data (`$_GET`, `$_POST`, `$_REQUEST`, `$_COOKIE`, `$_FILES` names, client-controlled `$_SERVER` keys, `extract($_POST)` — also in a file included after it —, `php://input`) is followed through variables, string building and the project's functions to SQL queries (`security-sql-injection`), HTML output (`security-xss`), shell commands (`security-command-injection`), includes (`security-file-inclusion`), `unserialize` (`security-unsafe-unserialize`), `header('Location: …')` (`security-open-redirect`) and file writes (`security-path-traversal`). The message shows the path: `$_POST['id'] (line 12) → $id → $sql (line 20) → mysqli_query (line 21)`.
- Escaping is checked per sink: casts and `intval`, `filter_var`, `htmlspecialchars` / `htmlentities` (HTML), `mysqli_real_escape_string` / `addslashes` inside quotes (SQL), prepared statements, `escapeshellarg`, `basename`; `in_array(…, true)` on a literal list, `is_numeric`, `ctype_digit` and early exits narrow a value. Your own escaping functions: `phpForge.security.sanitizers`; everything can be turned off with `phpForge.security.enabled`.
- PHP version migration: set `phpForge.migration.targetVersion` (e.g. `8.2`) to see everything that breaks or becomes deprecated between `phpForge.phpVersion` and the target — removed and deprecated functions (`mysql_*`, `each`, `create_function`, `ereg`, `utf8_encode`…), syntax (`$s{0}`, `(real)`, `${var}`, PHP 4 constructors, nested ternaries, implicitly nullable parameters), number / string comparisons (8.0) and dynamic properties (8.2). Quick fixes: `while (list($k, $v) = each($a))` → `foreach`, `create_function` → closure, and the existing syntax fixes.
- **Migration report** command: every `migration-*` problem of the workspace, by rule and by file, in a Markdown document.

## 0.7.0 — preview

- SQL schema from the project's `.sql` files (`CREATE TABLE`, `ALTER TABLE … ADD`; `phpForge.sql.schema`, default `sql/**/*.sql`, `migrations/**/*.sql`, `database/**/*.sql`) or from the database: **Refresh SQL schema** reads `INFORMATION_SCHEMA` of a MySQL / MariaDB database (`phpForge.sql.connection`, read-only session, password kept in VS Code secret storage) into `.vscode/php-forge-schema.json`.
- In SQL queries (also concatenated, built with `.=`, or marked with `/** @sql */`): completion of tables, of columns according to the `FROM` aliases, and of SQL functions; hover of a column (type, NULL, default); Go to Definition to the `CREATE TABLE`.
- Diagnostics: `sql-syntax` (comma before `FROM` / `WHERE`, `WHERE AND`, unclosed parenthesis or quote), `sql-unknown-column` (tables whose columns are all known), `sql-unknown-table` (with the database schema only).
- `$row = mysqli_fetch_assoc($res)`, `$res->fetch_assoc()`, `$stmt->fetch(PDO::FETCH_ASSOC)` and `fetchAll()` are typed by the columns of the `SELECT`: `$row['…']` completion, and `extract($row)` defines one variable per column.
- New rule `mixed-quotes`: string concatenations that mix `'…'` and `"…"` outside SQL, with a quick fix (parts that only hold `"\n"`, quotes or parentheses are tolerated).
- The rest of a concatenated query (`' WHERE …'`, `' ORDER BY …'`) is colored as soon as the file opens (TextMate injection).

## 0.6.0 — preview

- Formatter: Format Document, Format Selection, format on type (`;`, `}`) and on save (`editor.formatOnSave`). PSR-12 indentation, spacing and braces; only whitespace between tokens is rewritten, so strings, heredocs, comments and HTML are never changed.
- Mixed HTML / PHP files: only `<?php … ?>` blocks are formatted, indented from the line of their `<?php` tag; `<?= … ?>` is only normalized to `<?= $x ?>`.
- Settings: `phpForge.format.enable`, `phpForge.format.braces` (`psr12` / `keep`), `phpForge.format.alignArrows`, `phpForge.format.alignAssignments`, `phpForge.format.trailingCommas`, `phpForge.format.lineLength`; indentation size comes from the editor.
- A file with a syntax error is left as is.

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

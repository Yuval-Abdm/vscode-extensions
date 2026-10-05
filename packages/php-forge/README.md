# PHP Forge

**Free PHP language server for VS Code — built for real-world projects, from modern Composer apps to legacy code held together by `include`.**

> Preview (0.9). PHP Forge is being built milestone by milestone towards 1.0: see the roadmap below.

## Features

- **Completion** that knows your types: variables in scope, object members (visibility respected), static members and enum cases, functions / classes / constants filtered by your PHP version, keywords, `include` paths, known array keys, phpdoc tags — with documentation on demand.
- **Type inference**: declared types and phpdoc (generics, `array{…}` shapes, `@template`, `@property`, `@method`, `@mixin`), types inferred from code when nothing is declared (return values, properties assigned in constructors, constants), variable flow with narrowing (`instanceof`, `is_*`, null checks, `assert`).
- **Signature help** and **inlay hints** (parameter names; inferred variable and return types optional).
- **Go to Definition** (closest override for redefined methods), **Go to Implementation**, **highlight occurrences**, **folding**, **smart selection**, **semantic highlighting**.
- **Hover**: variable types, signature, namespace, phpdoc, PHP version availability, deprecation, php.net links.
- **Whole-project index** in the background (worker threads), cached on disk: a 19,000-file project is indexed in about 6 s.
- **Outline / breadcrumbs**, **workspace symbol search** (Ctrl+T) and **live syntax errors** (a forgotten `;` is pointed out on its own line, with an "Add `;`" quick fix). In HTML, `<?php $x ?>` without `echo` and short `<?` tags are flagged, with quick fixes.
- **SQL in PHP strings**: highlighting of the whole query (every part of a concatenation, `$sql .= …` additions, query function arguments, strings marked `/** @sql */`); completion of tables, of columns according to the `FROM` aliases and of SQL functions; column hover (type, NULL, default); Go to Definition to the `CREATE TABLE`; checks for SQL syntax slips, unknown columns and unknown tables, from the project's `.sql` files or the real database (see **SQL schema** below). `$row = mysqli_fetch_assoc($res)` and PDO `fetch()` rows know the columns of the `SELECT`.
- **Mixed quotes**: SQL queries and other string concatenations that mix `'…'` and `"…"` parts are flagged, with a quick fix.
- **Security**: request data followed to SQL queries, HTML output, shell commands, includes, `unserialize`, redirects and file writes — also through `extract($_POST)` in an including file and through your own functions — with the propagation path in the message.
- **PHP version migration**: set `phpForge.migration.targetVersion` to list what breaks between your PHP version and the target, with safe quick fixes and a **Migration report**.
- **Diagnostics** for the whole project, in the background: undefined functions, classes, constants, methods and properties (only on known types), argument count, unused `use`, unreachable code, APIs removed or added after your PHP version, deprecated syntax, functions declared twice in an include chain. Level per rule, `// @php-forge-ignore`, and a **baseline** to hide the existing problems of a legacy project.
- **Problems on hover**: hover a line with an error or warning to see the problem, the proposed fix and an **Apply** link.
- **Native PHP functions and classes** from JetBrains phpstorm-stubs, for the PHP version of your project (shown in the status bar).
- **Legacy-friendly**: Latin-1 / Windows-1252 files, PHP mixed with HTML, untyped code, functions declared inside `if (!function_exists(…))`.

### Includes (projects without autoload)

PHP Forge follows `include` / `require` like PHP does, from every page that nobody includes. In a file included by several pages, a variable is reported as soon as **one** of them does not define it, with the faulty pages:

> `$title is not defined when included from lp_3/index.php:3 (defined in 2 other callers)`

Variables created in included files keep their type and origin (hover, completion, go to definition). The **Include Tree** view (Explorer) and the "Included by N files" CodeLens show who includes what. Include paths written with server paths are mapped with `phpForge.serverRoot` or the `remotePath` of `.vscode/deploy.json`; a dynamic include can be documented with `/** @include path/to/file.php */` on the line above.

The **PHP Impact** view (Explorer) lists the PHP files you changed (Git changes and unsaved files) and, for each one, the pages that load it through includes — the pages to check before going live. With [FTP SFTP Deploy](https://marketplace.visualstudio.com/items?itemName=yuval-abdm.ftp-sftp-deploy) installed, **Deploy changed files** in its title bar uploads every changed file; it first offers to save unsaved ones, warns when a file has errors (`phpForge.deploy.checkErrors`), never sends files in merge conflict, and asks for confirmation with the server and the files that will be sent.

### Diagnostics

| Code | Default | What |
|---|---|---|
| `syntax-error`, `missing-semicolon` | error | Syntax errors (a forgotten `;` on its own line) |
| `undefined-variable` / `maybe-undefined-variable` | warning / information | Strict rule across includes, per caller |
| `undefined-function`, `undefined-class`, `undefined-constant` | error | Symbol found nowhere (workspace or PHP for your version) |
| `undefined-method`, `undefined-property` | warning | On a known type only (never on untyped code, `__call` / `__get`, `@mixin`) |
| `argument-count` | error | Too many / too few arguments to the project's functions and methods |
| `unused-use`, `unreachable-code` | hint (grayed out) | Dead code |
| `removed-api`, `deprecated-api`, `deprecated-syntax` | error / warning / warning | Depends on `phpForge.phpVersion` |
| `symbol-not-included`, `duplicate-declaration`, `unresolved-include` | warning / error / information | Include chains |

- Change a level or turn a rule off with `phpForge.diagnostics.rules`, e.g. `{ "unused-use": "off", "undefined-variable": "error" }`.
- Ignore one line with `// @php-forge-ignore <code>` (on the line or the line above), a whole file with `/** @php-forge-ignore-file <code> */` — both offered as quick fixes.
- **Baseline**: run **PHP Forge: Create Baseline** on a legacy project — existing problems are stored in `.vscode/php-forge-baseline.json` and hidden, only new ones are shown (count in the status bar).
- Library folders (`phpForge.libraryPaths`, and folders with their own `composer.json`) are indexed but never diagnosed; add third-party code copied into the project there (e.g. `"**/artichow/**"`).

### Refactoring and imports

- **Rename** (F2) and **Find All References** across the project: variables (also across includes, `global` and `$GLOBALS['x']`), parameters (with named arguments), functions, classes (`use`, types, phpdoc), methods, properties, constants and namespaces. `'Class::method'` strings and callables (`[$obj, 'm']`, `[Foo::class, 'm']`) are included when certain; a method called on an untyped object only counts when no other class declares the same name. Native PHP and library symbols cannot be renamed.
- **"N references" / "N implementations" CodeLens** above classes, functions, methods and interfaces.
- **Auto-import**: accepting a class, function or constant from another namespace adds the `use`, sorted.
- **Suggested imports** on unknown names ("Import Lib\User", "Import all missing classes"); for code without namespaces, **"Add include 'includes/fonctions.php'"** written in the file's own style (`ROOT_PATH.'/…'`, `__DIR__ . '/…'`, `$_SERVER['DOCUMENT_ROOT']`, relative).
- **Organize use statements** (sort, group, remove unused), also on save with `phpForge.organizeUsesOnSave`.
- **Code generation**: getters and setters, constructor (property promotion from PHP 8.0), missing methods of interfaces and abstract classes, PHPDoc skeleton, `@var` for a variable.
- **Quick fixes**: declare an undefined variable, replace a deprecated or removed function by its documented replacement.

### Formatting

- **Format Document**, **Format Selection**, **format on type** (`;`, `}`) and **on save** (`editor.formatOnSave`): PSR-12 indentation, spacing and braces. Only the whitespace between tokens is rewritten — strings, heredocs, comments and HTML are never changed, and formatting twice gives the same result.
- **Mixed HTML / PHP**: only `<?php … ?>` blocks are formatted, indented from the line of their `<?php` tag; `<?= … ?>` is only normalized to `<?= $x ?>`. The line break after `?>` is never touched.
- Options: braces (`psr12` or `keep`), alignment of `=>` and `=`, trailing commas in multi-line arrays, indicative line length. A file with a syntax error is left as is.

### SQL schema

PHP Forge reads the tables of the project's `.sql` files (`phpForge.sql.schema`: `CREATE TABLE`, `ALTER TABLE … ADD`). To use the real database instead, set `phpForge.sql.connection` (`host`, `port`, `user`, `database`) and run **PHP Forge: Refresh SQL schema**: the password is asked once and kept in VS Code secret storage, only `INFORMATION_SCHEMA` is read (in a read-only session from MySQL 5.6 / MariaDB 10.0), and the result is written to `.vscode/php-forge-schema.json` of the chosen workspace folder — each folder of a multi-root workspace has its own schema (add it to `.gitignore` if the schema is private). The database schema is the reference: unknown tables are reported only when it is loaded, and old `.sql` dumps can report columns that were added since — refresh it.

Completion in strings: VS Code does not suggest inside strings by default; press `Ctrl+Space`, or set `"editor.quickSuggestions": { "strings": "on" }` for `[php]`.

## Roadmap to 1.0

| Version | Content |
|---|---|
| 0.2 ✓ | Type inference, completion, signature help, inlay hints, go to implementation |
| 0.3 ✓ | Include engine: variables, functions and classes followed across `include` / `require` |
| 0.4 ✓ | Diagnostics (undefined variables per caller, unknown symbols, PHP version), baseline |
| 0.5 ✓ | Rename, references, auto-import and suggested imports (`use` and `include`), code generation |
| 0.6 ✓ | Formatter (PSR-12, mixed HTML/PHP) |
| 0.7 ✓ | SQL in PHP strings: schema from `.sql` files or the database, completion, hover, checks |
| 0.8 ✓ | Security (taint analysis) and PHP version migration |
| 0.9 ✓ | FTP SFTP Deploy integration: impacted pages, deploy in one click |

## Settings

| Setting | Default | Description |
|---|---|---|
| `phpForge.exclude` | `["**/node_modules/**", "**/.git/**"]` | Globs of files and folders that are neither indexed nor analyzed |
| `phpForge.maxFileSize` | `2000000` | Files larger than this (bytes) are ignored |
| `phpForge.phpVersion` | `""` (auto) | PHP version of the project; legacy projects without `composer.json` should set it (e.g. `"7.3"`) |
| `phpForge.stubs` | common extensions | PHP extensions whose native symbols are known |
| `phpForge.inlayHints.parameterNames` | `true` | Parameter names before literal arguments |
| `phpForge.inlayHints.variableTypes` | `false` | Inferred type of assigned variables |
| `phpForge.inlayHints.returnTypes` | `false` | Inferred return type of untyped functions |
| `phpForge.documentRoot` | `""` | Web root for `$_SERVER['DOCUMENT_ROOT']` in include paths (absolute or relative to the workspace) |
| `phpForge.serverRoot` | `""` | Path of the site on the server, to map includes written with server paths (default: `remotePath` of `.vscode/deploy.json`) |
| `phpForge.includes.maxContexts` | `64` | Include contexts analyzed per file before the analysis becomes approximate |
| `phpForge.externalGlobals` | `[]` | Variables defined outside the analyzed code (e.g. `auto_prepend_file`) |
| `phpForge.diagnostics.scope` | `"workspace"` | `workspace`: every file analyzed in the background; `openFiles`: open files only |
| `phpForge.diagnostics.rules` | `{}` | Level per diagnostic code (`error`, `warning`, `information`, `hint`, `off`) |
| `phpForge.libraryPaths` | `["**/vendor/**", "**/PHPExcel/**", "**/Google/Api/**"]` | Library folders: indexed, never diagnosed |
| `phpForge.codeLens.references` | `true` | "N references" above classes, functions and methods |
| `phpForge.codeLens.implementations` | `true` | "N implementations" above interfaces, abstract classes and their methods |
| `phpForge.completion.autoImport` | `true` | Add the `use` statement when a name from another namespace is accepted in completion |
| `phpForge.organizeUsesOnSave` | `false` | Sort `use` statements and remove unused ones on save |
| `phpForge.format.enable` | `true` | Format PHP files (document, selection, on type, on save) |
| `phpForge.format.braces` | `"psr12"` | `psr12`: class and function braces on their own line, control structures on the same line; `keep`: unchanged |
| `phpForge.format.alignArrows` | `false` | Align the `=>` of consecutive array elements |
| `phpForge.format.alignAssignments` | `false` | Align the `=` of consecutive assignments |
| `phpForge.format.trailingCommas` | `false` | Trailing comma in multi-line arrays |
| `phpForge.format.lineLength` | `120` | Indicative line length (alignment is skipped beyond it) |
| `phpForge.sql.schema` | `["sql/**/*.sql", "migrations/**/*.sql", "database/**/*.sql"]` | `.sql` files that describe the database, relative to each workspace folder |
| `phpForge.sql.connection` | `{}` | MySQL / MariaDB database read by **Refresh SQL schema** (`host`, `port`, `user`, `database`; password in secret storage) |
| `phpForge.security.enabled` | `true` | Follow request data to SQL, HTML output, commands, includes, `unserialize`, redirects and file writes |
| `phpForge.security.sanitizers` | `[]` | Your own escaping functions (`rp_clean`, `Html::escape`), safe for every sink |
| `phpForge.migration.targetVersion` | `""` | PHP version you are migrating to; `migration-*` diagnostics and **Migration report** |
| `phpForge.deploy.checkErrors` | `true` | Warn before **Deploy changed files** when a file to deploy has errors |
| `phpForge.trace.server` | `off` | Language server trace |

## Commands

- **PHP Forge: Restart Language Server**
- **PHP Forge: Reindex Workspace**
- **PHP Forge: Show Output**
- **PHP Forge: Show Include Tree**
- **PHP Forge: Create Baseline / Update Baseline / Clear Baseline**
- **PHP Forge: Refresh SQL schema**
- **PHP Forge: Migration report**
- **PHP Forge: Show impact of changed files** / **Deploy changed files**

## Using it with Intelephense or PHP Tools

Completions and diagnostics would be duplicated: PHP Forge offers to open those extensions so you can disable them for the workspace.

## License

[MIT](LICENSE). Bundles [JetBrains phpstorm-stubs](https://github.com/JetBrains/phpstorm-stubs) (Apache 2.0): see [NOTICE](NOTICE).

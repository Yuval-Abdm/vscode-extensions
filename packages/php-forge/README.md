# PHP Forge

**Free PHP language server for VS Code — built for real-world projects, from modern Composer apps to legacy code held together by `include`.**

> Preview (0.2). PHP Forge is being built milestone by milestone towards 1.0: see the roadmap below.

## Features

- **Completion** that knows your types: variables in scope, object members (visibility respected), static members and enum cases, functions / classes / constants filtered by your PHP version, keywords, `include` paths, known array keys, phpdoc tags — with documentation on demand.
- **Type inference**: declared types and phpdoc (generics, `array{…}` shapes, `@template`, `@property`, `@method`, `@mixin`), types inferred from code when nothing is declared (return values, properties assigned in constructors, constants), variable flow with narrowing (`instanceof`, `is_*`, null checks, `assert`).
- **Signature help** and **inlay hints** (parameter names; inferred variable and return types optional).
- **Go to Definition** (closest override for redefined methods), **Go to Implementation**, **highlight occurrences**, **folding**, **smart selection**, **semantic highlighting**.
- **Hover**: variable types, signature, namespace, phpdoc, PHP version availability, deprecation, php.net links.
- **Whole-project index** in the background (worker threads), cached on disk: a 19,000-file project is indexed in about 6 s.
- **Outline / breadcrumbs**, **workspace symbol search** (Ctrl+T) and **live syntax errors** (a forgotten `;` is pointed out on its own line, with an "Add `;`" quick fix). In HTML, `<?php $x ?>` without `echo` and short `<?` tags are flagged, with quick fixes.
- **Native PHP functions and classes** from JetBrains phpstorm-stubs, for the PHP version of your project (shown in the status bar).
- **Legacy-friendly**: Latin-1 / Windows-1252 files, PHP mixed with HTML, untyped code, functions declared inside `if (!function_exists(…))`.

## Roadmap to 1.0

| Version | Content |
|---|---|
| 0.2 ✓ | Type inference, completion, signature help, inlay hints, go to implementation |
| 0.3 | Include engine: variables, functions and classes followed across `include` / `require` |
| 0.4 | Diagnostics (undefined variables per caller, unknown symbols, PHP version), baseline |
| 0.5 | Rename, references, auto-import and suggested imports (`use` and `include`), code generation |
| 0.6 | Formatter (PSR-12, mixed HTML/PHP) |
| 0.7 | SQL in PHP strings: highlighting, schema-aware completion and checks |
| 0.8 | Security (taint analysis) and PHP version migration |
| 0.9 | FTP SFTP Deploy integration: impacted pages, deploy in one click |

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
| `phpForge.trace.server` | `off` | Language server trace |

## Commands

- **PHP Forge: Restart Language Server**
- **PHP Forge: Reindex Workspace**
- **PHP Forge: Show Output**

## Using it with Intelephense or PHP Tools

Completions and diagnostics would be duplicated: PHP Forge offers to open those extensions so you can disable them for the workspace.

## License

[MIT](LICENSE). Bundles [JetBrains phpstorm-stubs](https://github.com/JetBrains/phpstorm-stubs) (Apache 2.0): see [NOTICE](NOTICE).

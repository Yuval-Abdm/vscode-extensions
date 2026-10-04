# PHP Forge

**Free PHP language server for VS Code — built for real-world projects, from modern Composer apps to legacy code held together by `include`.**

> Preview (0.1). PHP Forge is being built milestone by milestone towards 1.0: see the roadmap below.

## Features in 0.1

- **Whole-project index** in the background (worker threads), cached on disk: reopening a 3,000-file project is near-instant.
- **Go to Definition** for classes, interfaces, traits, enums, functions, constants (`define()` and `const`), methods, properties and class constants — following `use` imports, `self`, `static`, `parent`, `$this` and inheritance (parents, traits, interfaces).
- **Hover**: signature, namespace, phpdoc, PHP version availability and deprecation.
- **Outline / breadcrumbs** and **workspace symbol search** (Ctrl+T) with fuzzy matching.
- **Live syntax errors**.
- **Native PHP functions and classes** from JetBrains phpstorm-stubs.
- **Legacy-friendly**: Latin-1 / Windows-1252 files, PHP mixed with HTML, functions declared inside `if (!function_exists(…))`.

## Roadmap to 1.0

| Version | Content |
|---|---|
| 0.2 | Type inference, completion, signature help, inlay hints, go to implementation |
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
| `phpForge.trace.server` | `off` | Language server trace |

## Commands

- **PHP Forge: Restart Language Server**
- **PHP Forge: Reindex Workspace**
- **PHP Forge: Show Output**

## Using it with Intelephense or PHP Tools

Completions and diagnostics would be duplicated: PHP Forge offers to open those extensions so you can disable them for the workspace.

## License

[MIT](LICENSE). Bundles [JetBrains phpstorm-stubs](https://github.com/JetBrains/phpstorm-stubs) (Apache 2.0): see [NOTICE](NOTICE).

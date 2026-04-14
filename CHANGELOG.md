# Changelog

## 1.0.0

Initial public release on the VS Code Marketplace.

### Features

- Syntax highlighting for Vortex `.vs` files: tags, built-in functions, `$variables` with `:modifiers`, HTML markup, strings, and `<!-- comments -->`.
- Go-to-definition for user-defined `<funcName>` calls and `#include` paths.
- Hover documentation showing function signatures (parameters, defaults, modifiers) and built-in function synopses sourced from the official Vortex manual.
- Outline view, workspace symbols, and find-all-references for function definitions.
- Semantic highlighting — user-defined function calls take the theme's `function` color; built-ins keep keyword coloring.
- Snippets for common scaffolding: `vxscript`, `vxa`, `vxif`, `vxloop`, `vxsql`, `vxexport`, `ifdef`, `ifndef`, `include`.
- Commands: **Vortex: Preprocess .vsrc with ifdef** and **Vortex: Open Online Documentation**.

### Vortex-src (ifdef) mode

- Disabled by default. Enable via the `vortex.enableVortexSrc` setting.
- Adds highlighting for `#ifdef`, `#ifndef`, `#if`, `#else`, `#endif`, `#define`, `#include`, `#for`/`#endfor`, `#htmlesc`, `## line comments`, and `(#)MACRO(#)` references.
- Allows optional whitespace between `#` and the directive name (e.g. `#  include` for indented preprocessor blocks).
- Associates `.vsrc` files with the Vortex-src language when enabled.

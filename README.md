# Vortex Language Support

VS Code extension for [Thunderstone Vortex](https://docs.thunderstone.com/site/vortexman/) web-script files (`.vs`).

Vortex is the server-side scripting language behind Thunderstone's Webinator, Texis, and related products.

## Features

- **Syntax highlighting** — Vortex tags, built-in functions, `$variables` (including `:modifiers`), HTML markup, strings, and `<!-- comments -->`.
- **Go-to-definition** — Jump to any `<a name=funcName>` declaration across the workspace. Also resolves `#include` paths.
- **Hover documentation** — See function signatures, parameters with defaults, and the file/line where each function is defined. Built-in functions show a synopsis from the official docs.
- **Outline & workspace symbols** — Browse functions in the current file or search across the entire workspace.
- **Find all references** — Locate every call site for a function.
- **Semantic highlighting** — User-defined function calls get the theme's `function` color; built-ins keep keyword coloring.
- **Snippets** — Quick scaffolding for common patterns: `vxscript`, `vxa`, `vxif`, `vxloop`, `vxsql`, `vxexport`, and more.

## Vortex-src (ifdef preprocessing)

Thunderstone projects often use an `ifdef` preprocessor on `.vsrc` source files before deployment. This mode adds highlighting for `#ifdef`, `#ifndef`, `#if`, `#else`, `#endif`, `#define`, `#include`, `#for`/`#endfor`, `#htmlesc`, `## line comments`, and `(#)MACRO(#)` references.

Since most users won't have the ifdef preprocessor, this mode is **disabled by default**. To enable it:

1. Open **Settings** and search for `vortex.enableVortexSrc`.
2. Check the box to enable.
3. Reload the window.

Once enabled, `.vsrc` files are recognized as Vortex-src, and the **Vortex: Preprocess .vsrc with ifdef** command becomes available in the command palette and editor context menu.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `vortex.enableVortexSrc` | `false` | Enable the Vortex-src (ifdef) language mode for `.vsrc` files. |
| `vortex.ifdefPath` | `""` | Path to the `ifdef` script. If empty, the extension searches up from the workspace root. |
| `vortex.ifdefDefines` | `""` | Comma-separated `DEFINED=` macros (e.g. `APPLIANCE,FOO=bar`). |
| `vortex.ifdefExtraArgs` | `[]` | Extra `-v key=value` arguments forwarded to awk. |
| `vortex.useGitignore` | `true` | Use `git ls-files` for file discovery, honoring `.gitignore`. |
| `vortex.indexExclude` | `{**/node_modules/**,...}` | Fallback exclude glob for non-git workspaces. |

## Links

- [Vortex documentation](https://docs.thunderstone.com/site/vortexman/)
- [Issue tracker](https://github.com/Thunderstone-Software/vortex-vscode/issues)

## License

MIT — Copyright Thunderstone Software LLC.

# Vortex Language Support

VS Code support for [Thunderstone](https://docs.thunderstone.com/) Vortex web-script files
(`.vs`) and the `ifdef`-preprocessed source files (`.src`) used by Webinator and related
projects.

## Features

- **Syntax highlighting** for Vortex tags, built-in functions, `$variables` (with `:modifier`
  support), HTML markup, single/double quoted strings, and `<!-- comments -->`.
- **`.src` highlighting** layered on top of Vortex: `#ifdef` / `#ifndef` / `#if` / `#else` /
  `#endif` / `#define` / `#include` / `#for` / `#endfor` / `#htmlesc`, `## line comments`,
  and `(#)MACRO(#)` references.
- **Snippets** for common scaffolding (`vxscript`, `vxa`, `vxif`, `vxloop`, `vxsql`,
  `vxexport`, `ifdef`, `ifndef`, `include`).
- **Bracket matching, comment toggling, and folding** on `#if`/`#endif` regions.
- **Command: `Vortex: Preprocess .src with ifdef`** — runs the repo's `ifdef` awk script
  on the active `.src` file and opens the expanded output in a side editor.
- **Command: `Vortex: Open Online Documentation`**.

## Settings

| Setting | Description |
|---|---|
| `vortex.ifdefPath` | Path to the `ifdef` script. If empty, the extension walks up from the workspace root looking for a file named `ifdef`. |
| `vortex.ifdefDefines` | Comma-separated `DEFINED=` macros (e.g. `APPLIANCE,FOO=bar`). |
| `vortex.ifdefExtraArgs` | Extra `-v key=value` arguments forwarded to awk. |

## Installing locally

From this directory:

```sh
npm install -g @vscode/vsce      # one time
vsce package                     # produces vortex-language-0.1.0.vsix
code --install-extension vortex-language-0.1.0.vsix
```

Or, for live development, copy/symlink this directory into `~/.vscode/extensions/`
and reload the VS Code window.

## Navigation

- **Go-to-definition** (F12) on a `<funcName>` call jumps to its `<a name=funcName>`
  declaration. Works across files; if the function is defined in multiple files,
  VS Code shows the picker with the current file listed first.
- **Go-to-definition** on the path inside `#include "foo.src"` opens the included file.
- **Hover** on a `<funcName>` call shows its signature, including parameter names,
  default values, and modifiers (`public`/`private`/`export`), plus the file and
  line where it's defined.
- **Outline view** (`Cmd-Shift-O` / `Ctrl-Shift-O`) lists every `<a name=...>`
  function in the current file with its parameter list.
- **Workspace symbols** (`Cmd-T` / `Ctrl-T`) finds any function across the workspace.
- **Find all references** (`Shift-F12`) on a `<funcName>` lists every call site
  in the workspace.

## Roadmap

- Diagnostics from `texis -syntax`.
- Setting to disable `.src` / ifdef support (most users won't have ifdef).
- Marketplace publication.

## License

Copyright Thunderstone Software LLC.

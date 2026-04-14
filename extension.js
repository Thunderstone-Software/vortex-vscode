// Vortex Language Support — extension entry point.
//
// Provides:
//   - Workspace index of <a name=...> function definitions across .vs/.vsrc files.
//   - Go-to-definition for user functions and #include "..." paths.
//   - Hover docs showing function signatures (parameters with default values).
//   - Document symbols (Outline view) for the current file.
//   - Command: "Vortex: Preprocess .vsrc with ifdef".

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

let output;
let srcEnabled = false;
function log(msg) {
  if (output) output.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

const DOCS_BASE = 'https://docs.thunderstone.com/site/vortexman/';
/** @type {Object<string, {names:string[], url:string, summary:string}>} */
let builtinDocs = {};

function loadBuiltinDocs(extensionPath) {
  try {
    const file = path.join(extensionPath, 'builtins.json');
    builtinDocs = JSON.parse(fs.readFileSync(file, 'utf8'));
    log(`loaded ${Object.keys(builtinDocs).length} builtin doc entries`);
  } catch (e) {
    log(`could not load builtins.json: ${e.message}`);
    builtinDocs = {};
  }
}

// ---------------------------------------------------------------------------
// ifdef preprocessing command
// ---------------------------------------------------------------------------

function findIfdef(startDir) {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'ifdef');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function preprocessSrc() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('Vortex: no active editor.');
    return;
  }
  const doc = editor.document;
  if (doc.languageId !== 'vortex-src') {
    vscode.window.showWarningMessage('Vortex: active file is not a .vsrc file.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('vortex');
  let ifdefPath = cfg.get('ifdefPath');
  if (!ifdefPath) {
    const wsFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const startDir = wsFolder ? wsFolder.uri.fsPath : path.dirname(doc.uri.fsPath);
    ifdefPath = findIfdef(startDir) || findIfdef(path.dirname(doc.uri.fsPath));
  }
  if (!ifdefPath || !fs.existsSync(ifdefPath)) {
    vscode.window.showErrorMessage('Vortex: ifdef script not found. Set `vortex.ifdefPath` in settings.');
    return;
  }

  const defines = cfg.get('ifdefDefines') || '';
  const extra = cfg.get('ifdefExtraArgs') || [];
  const srcDir = path.dirname(ifdefPath);

  const args = ['-f', ifdefPath, '-v', `SrcDir=${srcDir}`];
  for (const a of extra) args.push('-v', a);
  args.push(doc.uri.fsPath);

  const env = Object.assign({}, process.env);
  if (defines) env.DEFINED = defines;

  cp.execFile('awk', args, { env, maxBuffer: 32 * 1024 * 1024 }, async (err, stdout, stderr) => {
    if (err) {
      vscode.window.showErrorMessage(`Vortex ifdef failed: ${err.message}\n${stderr}`);
      return;
    }
    const out = await vscode.workspace.openTextDocument({
      content: stdout,
      language: 'vortex'
    });
    await vscode.window.showTextDocument(out, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    if (stderr) {
      vscode.window.showWarningMessage(`ifdef stderr: ${stderr.split('\n')[0]}`);
    }
  });
}

function openDocs() {
  vscode.env.openExternal(vscode.Uri.parse('https://docs.thunderstone.com/site/vortexman/texis_web_script.html'));
}

// ---------------------------------------------------------------------------
// Function-definition indexer
// ---------------------------------------------------------------------------
//
// Each entry in the index is:
//   {
//     name: 'init',
//     uri: vscode.Uri,                  // file containing the definition
//     range: vscode.Range,              // full <a ...> opening tag
//     nameRange: vscode.Range,          // just the function name
//     params: [{ name, default }],     // default is the raw token incl. quotes, or undefined
//     modifiers: ['export', ...],       // public/private/export, lowercased
//     headerText: '<a name=init ...>'  // verbatim opening tag, for hover display
//   }

const FUNC_RE = /<a\b([^>]*)>/gi;
const RESERVED_MODIFIERS = new Set(['public', 'private', 'export']);
const FILE_GLOB_VS = '**/*.vs';
const FILE_GLOB_SRC = '**/*.{vs,vsrc}';
const DEFAULT_EXCLUDE =
  '{**/node_modules/**,**/.git/**,**/build/**,**/build-*/**,**/dist/**,**/usr/local/**,**/out/**}';
const MAX_FILE_BYTES = 1024 * 1024;   // skip files larger than 1 MB
const INDEX_CONCURRENCY = 8;

// The index is partitioned into "scopes". A scope is a directory tree that
// should be navigated as an independent unit. By default everything in a
// workspace folder belongs to one scope keyed by that folder's path. Files
// living under a directory whose basename matches `vortex.scopeRoots` (e.g.
// `build`, `build-*`, `dist`) belong to a separate scope keyed by that
// directory's path. This lets the user open a generated copy of the source
// tree and have go-to-definition / find-references resolve within that copy
// rather than against the main source.
//
// scopes: scopeKey -> { byName: Map<name, defs[]>, byFile: Map<uriString, defs[]>,
//                       loaded: boolean, loading: Promise|null }
const scopes = new Map();

function newScope() {
  return { byName: new Map(), byFile: new Map(), loaded: false, loading: null };
}

function getScope(key) {
  let s = scopes.get(key);
  if (!s) { s = newScope(); scopes.set(key, s); }
  return s;
}

// Cache: workspace-root -> ignore predicate (loaded once per workspace folder).
const vortexIgnoreCache = new Map();
function getVortexIgnore(wsRoot) {
  if (!vortexIgnoreCache.has(wsRoot)) {
    vortexIgnoreCache.set(wsRoot, loadVortexIgnore(wsRoot));
  }
  return vortexIgnoreCache.get(wsRoot);
}

// Cache: full path -> boolean (is this directory ignored by git or .vortexignore?).
const dirIgnoredCache = new Map();
function isDirIgnored(wsRoot, dir) {
  const key = wsRoot + '\0' + dir;
  if (dirIgnoredCache.has(key)) return dirIgnoredCache.get(key);
  let ignored = false;

  // .vortexignore first (cheap, in-memory).
  const vIgnore = getVortexIgnore(wsRoot);
  if (vIgnore) {
    let rel = path.relative(wsRoot, dir).split(path.sep).join('/');
    if (rel && vIgnore(rel)) ignored = true;
  }

  // Fall back to git check-ignore (synchronous; cached so cost is one-time
  // per ancestor directory). Wrapped in try/catch because git may be absent.
  if (!ignored) {
    try {
      cp.execFileSync(
        'git',
        ['-C', wsRoot, 'check-ignore', '-q', '--', dir],
        { stdio: 'ignore' }
      );
      ignored = true;
    } catch { /* exit 1 = not ignored, exit 128 = no git; both mean "not ignored" */ }
  }

  dirIgnoredCache.set(key, ignored);
  return ignored;
}

/**
 * Compute the scope key for a file URI. The rule:
 *
 *   - If any ancestor directory of the file (up to but not including the
 *     workspace folder) is excluded by .gitignore or .vortexignore, the
 *     **topmost** such ancestor is the scope root. This treats each
 *     gitignored sub-tree (build/, dist/, generated copies, etc.) as its
 *     own navigable unit without hard-coding directory names.
 *   - Otherwise the workspace folder root is the scope.
 */
function scopeKeyForUri(uri) {
  const fsPath = uri.fsPath;
  const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!wsFolder) return path.dirname(fsPath);
  const wsRoot = wsFolder.uri.fsPath;

  // Walk from the workspace root downward toward the file, remembering the
  // first ignored directory we encounter — that's the topmost ignored
  // ancestor and therefore the scope root.
  const rel = path.relative(wsRoot, fsPath);
  if (!rel || rel.startsWith('..')) return wsRoot;
  const parts = rel.split(path.sep);
  parts.pop(); // drop the filename
  let cur = wsRoot;
  for (const seg of parts) {
    cur = path.join(cur, seg);
    if (isDirIgnored(wsRoot, cur)) return cur;
  }
  return wsRoot;
}

function scopeForDoc(doc) {
  return getScope(scopeKeyForUri(doc.uri));
}

/**
 * Build a sorted array of newline offsets so offset->position is O(log n)
 * instead of O(offset). Called once per file.
 */
function buildLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetToPosition(lineStarts, offset) {
  // Binary search for the greatest line start <= offset.
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return new vscode.Position(lo, offset - lineStarts[lo]);
}

function tokenizeAttributes(attrs) {
  const tokens = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
  let m;
  while ((m = re.exec(attrs)) !== null) {
    tokens.push({ key: m[1], value: m[2], keyIndex: m.index });
  }
  return tokens;
}

function stripQuotes(s) {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

const NAME_ATTR_RE = /\bname\s*=/i;

function parseFile(uri, text) {
  const defs = [];
  let lineStarts = null; // built lazily — most files won't need it
  let match;
  FUNC_RE.lastIndex = 0;
  while ((match = FUNC_RE.exec(text)) !== null) {
    const attrText = match[1];
    // Fast reject: most <a ...> matches are plain HTML anchors (<a href=...>)
    // and never contain a `name=` attribute. Skipping these before tokenizing
    // is a huge win on HTML-heavy Vortex files.
    if (!NAME_ATTR_RE.test(attrText)) continue;
    const tokens = tokenizeAttributes(attrText);
    const nameTok = tokens.find(t => t.key.toLowerCase() === 'name');
    if (!nameTok || !nameTok.value) continue;

    const name = stripQuotes(nameTok.value);
    // Function names follow the same rules as variables: letters, digits,
    // underscores, dots, and (when quoted) spaces. Reject obviously invalid
    // values but stay permissive about the character set.
    if (!name || !/^[A-Za-z0-9_. ]+$/.test(name)) continue;

    const modifiers = [];
    const params = [];
    for (const t of tokens) {
      const k = t.key.toLowerCase();
      if (k === 'name') continue;
      if (RESERVED_MODIFIERS.has(k)) {
        modifiers.push(k);
        continue;
      }
      params.push({ name: t.key, default: t.value });
    }

    if (!lineStarts) lineStarts = buildLineStarts(text);
    const tagStart = match.index;
    const tagEnd = match.index + match[0].length;
    const range = new vscode.Range(
      offsetToPosition(lineStarts, tagStart),
      offsetToPosition(lineStarts, tagEnd)
    );

    // Locate the name's offset inside the matched tag for nameRange.
    const nameOffsetInTag = match[0].indexOf(name, match[0].toLowerCase().indexOf('name'));
    const nameStart = nameOffsetInTag >= 0 ? tagStart + nameOffsetInTag : tagStart;
    const nameRange = new vscode.Range(
      offsetToPosition(lineStarts, nameStart),
      offsetToPosition(lineStarts, nameStart + name.length)
    );

    defs.push({
      name,
      uri,
      range,
      nameRange,
      params,
      modifiers,
      headerText: match[0]
    });
  }
  return defs;
}

function removeFileFromIndex(uriString) {
  // Renames/deletes are rare; iterate scopes (typically <5) instead of
  // maintaining a reverse file->scope map.
  for (const scope of scopes.values()) {
    const old = scope.byFile.get(uriString);
    if (!old) continue;
    for (const def of old) {
      const arr = scope.byName.get(def.name);
      if (!arr) continue;
      const filtered = arr.filter(d => d.uri.toString() !== uriString);
      if (filtered.length === 0) scope.byName.delete(def.name);
      else scope.byName.set(def.name, filtered);
    }
    scope.byFile.delete(uriString);
  }
}

function addDefsToIndex(uri, defs) {
  const scope = getScope(scopeKeyForUri(uri));
  scope.byFile.set(uri.toString(), defs);
  for (const def of defs) {
    const arr = scope.byName.get(def.name) || [];
    arr.push(def);
    scope.byName.set(def.name, arr);
  }
}

async function indexFile(uri) {
  // Use plain Node fs rather than vscode.workspace.fs: the latter routes
  // through the remote-FS RPC layer, which adds tens of milliseconds per
  // call. Since the extension host runs on the same machine as the files,
  // Node fs hits local disk directly.
  try {
    const fsPath = uri.fsPath;
    const stat = await fsp.stat(fsPath);
    if (stat.size > MAX_FILE_BYTES) return;
    const text = await fsp.readFile(fsPath, 'utf8');
    removeFileFromIndex(uri.toString());
    addDefsToIndex(uri, parseFile(uri, text));
  } catch (e) {
    // Ignore unreadable files.
  }
}

function indexDocument(doc) {
  if (doc.languageId !== 'vortex' && !(srcEnabled && doc.languageId === 'vortex-src')) return;
  if (doc.uri.scheme !== 'file') return;
  removeFileFromIndex(doc.uri.toString());
  addDefsToIndex(doc.uri, parseFile(doc.uri, doc.getText()));
}

/**
 * List candidate files for one workspace folder. Prefer `git ls-files` so we
 * naturally honor .gitignore (and skip generated build/dist trees). Fall back
 * to vscode.workspace.findFiles + the exclude glob for non-git folders.
 */
function listFilesViaGit(folderPath) {
  return new Promise(resolve => {
    cp.execFile(
      'git',
      ['-C', folderPath, 'ls-files', '-z',
       '--cached', '--others', '--exclude-standard',
       '--', '*.vs', ...(srcEnabled ? ['*.vsrc'] : [])],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const rels = stdout.split('\0').filter(Boolean);
        resolve(rels.map(r => vscode.Uri.file(path.join(folderPath, r))));
      }
    );
  });
}

/**
 * Read .vortexignore at the workspace folder root and return a predicate that
 * decides whether a relative POSIX path should be excluded. Format is a
 * minimal subset of .gitignore:
 *
 *   - One pattern per line. Blank lines and `#` comments are skipped.
 *   - A leading `/` anchors the pattern at the workspace root.
 *   - A trailing `/` matches any path inside that directory.
 *   - Otherwise the pattern is a literal path-segment substring match.
 */
function loadVortexIgnore(folderPath) {
  const file = path.join(folderPath, '.vortexignore');
  let content;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch { return null; }

  const rules = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const anchored = line.startsWith('/');
    const pat = anchored ? line.slice(1) : line;
    const isDir = pat.endsWith('/');
    const body = isDir ? pat.slice(0, -1) : pat;
    rules.push({ anchored, isDir, body });
  }
  if (rules.length === 0) return null;

  return function isExcluded(rel) {
    for (const r of rules) {
      if (r.anchored) {
        if (rel === r.body || rel.startsWith(r.body + '/')) return true;
      } else if (r.isDir) {
        if (rel.startsWith(r.body + '/') || rel.includes('/' + r.body + '/')) return true;
      } else if (rel === r.body || rel.endsWith('/' + r.body)) {
        return true;
      }
    }
    return false;
  };
}

async function listCandidateFiles() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) return [];

  const cfg = vscode.workspace.getConfiguration('vortex');
  const useGit = cfg.get('useGitignore') !== false;
  const exclude = cfg.get('indexExclude') || DEFAULT_EXCLUDE;

  const all = [];
  for (const folder of folders) {
    let uris = null;
    if (useGit) uris = await listFilesViaGit(folder.uri.fsPath);
    if (!uris) {
      const pattern = new vscode.RelativePattern(folder, srcEnabled ? FILE_GLOB_SRC : FILE_GLOB_VS);
      uris = await vscode.workspace.findFiles(pattern, exclude);
    }
    const isExcluded = loadVortexIgnore(folder.uri.fsPath);
    if (isExcluded) {
      const base = folder.uri.fsPath + path.sep;
      const before = uris.length;
      uris = uris.filter(u => {
        const rel = u.fsPath.startsWith(base) ? u.fsPath.slice(base.length) : u.fsPath;
        return !isExcluded(rel.split(path.sep).join('/'));
      });
      log(`.vortexignore dropped ${before - uris.length} of ${before} files in ${folder.name}`);
    }
    all.push(...uris);
  }
  return all;
}

async function runIndexWorkers(uris) {
  let next = 0;
  async function worker() {
    while (next < uris.length) {
      const i = next++;
      await indexFile(uris[i]);
    }
  }
  const workers = [];
  for (let i = 0; i < INDEX_CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
}

async function buildInitialIndex() {
  const t0 = Date.now();

  // Mark each workspace-folder scope as loaded *before* starting the scan.
  // Otherwise a provider call that races the initial index would see
  // loaded=false, kick off its own walkDirForVortexFiles (which ignores
  // .vortexignore and git), and step on the running scan. Pre-marking
  // means providers fast-path into the (initially empty) index and any
  // unanswered queries resolve naturally as defs are added.
  for (const folder of vscode.workspace.workspaceFolders || []) {
    getScope(folder.uri.fsPath).loaded = true;
  }

  const uris = await listCandidateFiles();
  log(`candidate files: ${uris.length}`);

  await runIndexWorkers(uris);

  const totalNames = new Set();
  let totalFiles = 0;
  for (const s of scopes.values()) {
    for (const k of s.byName.keys()) totalNames.add(k);
    totalFiles += s.byFile.size;
  }
  const ms = Date.now() - t0;
  log(`indexed ${totalNames.size} unique function names from ${totalFiles} files across ${scopes.size} scope(s) (${ms}ms)`);
}

/**
 * Recursively walk a directory collecting .vs/.vsrc files. Used for lazy
 * loading of non-default scopes (e.g. generated build or dist trees) where
 * git ls-files won't help because the directory is gitignored.
 */
async function walkDirForVortexFiles(rootDir, out) {
  let entries;
  try { entries = await fsp.readdir(rootDir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(rootDir, e.name);
    if (e.isDirectory()) {
      await walkDirForVortexFiles(full, out);
    } else if (e.isFile() && (e.name.endsWith('.vs') || (srcEnabled && e.name.endsWith('.vsrc')))) {
      out.push(vscode.Uri.file(full));
    }
  }
}

/**
 * Ensure the scope at `scopeKey` is fully indexed. If it's a non-default
 * scope (e.g. build-*) that hasn't been scanned, walk it now. Returns the
 * scope object once it's ready.
 */
async function ensureScopeIndexed(scopeKey) {
  const scope = getScope(scopeKey);
  if (scope.loaded) return scope;
  if (scope.loading) return scope.loading.then(() => scope);

  scope.loading = (async () => {
    const t0 = Date.now();
    const uris = [];
    await walkDirForVortexFiles(scopeKey, uris);
    log(`lazy-loading scope ${scopeKey}: ${uris.length} files`);
    await runIndexWorkers(uris);
    scope.loaded = true;
    scope.loading = null;
    log(`scope ${scopeKey} loaded in ${Date.now() - t0}ms`);
  })();
  return scope.loading.then(() => scope);
}

// ---------------------------------------------------------------------------
// Helpers used by providers
// ---------------------------------------------------------------------------

const BUILTIN_TAGS = new Set([
  'a','if','else','elseif','switch','case','default','loop','while','sql','db',
  'user','pass','readln','write','exec','capture','timport','break','continue',
  'return','verb','timeout','export','putmsg','entryfunc','exitfunc','uses',
  'schedule','cookies','stack','tracesql','sqlcache','trap','addtrailingslash',
  'pragma','script','sum','fmt','strfmt','fmtcp','fmtinfo','mm','sb','apicp',
  'apiinfo','sqlcp','pagelinks','flush','header','rex','split','sandr','strstr',
  'strstri','substr','strcmp','strcmpi','strncmp','strnicmp','strlen','strrev',
  'upper','lower','strfold','strfoldcmp','sort','uniq','uniqcount','count',
  'strtonum','rand','randpick','srand','exit','fetch','submit','urlinfo',
  'urltext','urllinks','urlcp','urlutil','nslookup','nsinfo','options',
  'radiobutton','checkbox','doctype','cal','calrule','calendar','caldate',
  'clist','slist','wordlist','wordcount','wordoccurrencecounts','createdb',
  'adminsql','loguser','userstats','resetstats','abstract','rmcommon',
  'pwencrypt','encrypt','decrypt','readvars','varinfo','getvar','setvar',
  'push','pop','slice','vxcp','vxinfo','hash','geo2code','code2geo','pdfxml',
  'xtree','profiler','read','send','spew','sleep','sysinfo','syscp','sysutil',
  'stat','watchpath','getpid','procexists','kill','loadavg'
]);

// Directives that take a Vortex function name as their value, e.g.
//   <entryfunc=initvars>
//   <exitfunc=onExit>
// Cursor on the value should resolve to the named user function.
const FUNC_REF_DIRECTIVES = ['entryfunc', 'exitfunc'];
const FUNC_REF_VALUE_RE = new RegExp(
  `<(?:${FUNC_REF_DIRECTIVES.join('|')})\\s*=\\s*$`,
  'i'
);

/**
 * If the cursor is on something that names a Vortex tag/function — either a
 * direct call (`<funcName ...>`) or the value of a function-name directive
 * like `<entryfunc=funcName>` — return `{ name, range }`. Otherwise null.
 */
function getTagNameAt(document, position) {
  // Match either a quoted name (so cursors inside `"function name"` work) or
  // a plain identifier with optional dots.
  const wordRange = document.getWordRangeAtPosition(
    position, /"[^"]*"|'[^']*'|[A-Za-z_][A-Za-z0-9_.]*/
  );
  if (!wordRange) return null;
  const raw = document.getText(wordRange);
  const name = stripQuotes(raw);
  const lineBefore = document.lineAt(wordRange.start.line).text.slice(0, wordRange.start.character);
  if (/<\/?\s*$/.test(lineBefore)) return { name, range: wordRange };
  if (FUNC_REF_VALUE_RE.test(lineBefore)) return { name, range: wordRange };
  // The function name inside its own definition: `<a name=funcName>`,
  // `<a name="funcName">`, `<a name='funcName'>`. Without this, Find
  // References from the declaration returns nothing.
  if (/<a\s+name\s*=\s*["']?$/i.test(lineBefore)) return { name, range: wordRange };
  return null;
}

function getIncludePathAt(document, position) {
  const line = document.lineAt(position.line).text;
  const m = /^(\s*#\s*include\s+)(["<])([^">]+)([">])/.exec(line);
  if (!m) return null;
  const pathStart = m[1].length + 1;
  const pathEnd = pathStart + m[3].length;
  if (position.character < pathStart || position.character > pathEnd) return null;
  return {
    path: m[3],
    range: new vscode.Range(position.line, pathStart, position.line, pathEnd)
  };
}

function resolveIncludePath(fromUri, includePath) {
  // Try sibling first, then walk up the workspace folder for known dirs.
  const baseDir = path.dirname(fromUri.fsPath);
  const tryPaths = [path.resolve(baseDir, includePath)];
  const wsFolder = vscode.workspace.getWorkspaceFolder(fromUri);
  if (wsFolder) {
    tryPaths.push(path.resolve(wsFolder.uri.fsPath, includePath));
    tryPaths.push(path.resolve(wsFolder.uri.fsPath, 'html', includePath));
  }
  for (const p of tryPaths) {
    if (fs.existsSync(p)) return vscode.Uri.file(p);
  }
  return null;
}

function sortDefsForCurrentDoc(defs, currentUri) {
  const cur = currentUri.toString();
  return defs.slice().sort((a, b) => {
    const aSame = a.uri.toString() === cur ? 0 : 1;
    const bSame = b.uri.toString() === cur ? 0 : 1;
    return aSame - bSame;
  });
}

function formatSignature(def) {
  const params = def.params.map(p => p.default ? `${p.name}=${p.default}` : p.name);
  const mods = def.modifiers.length ? ' ' + def.modifiers.join(' ') : '';
  return `<${def.name}${mods}${params.length ? ' ' + params.join(' ') : ''}>`;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const definitionProvider = {
  async provideDefinition(document, position) {
    const inc = getIncludePathAt(document, position);
    if (inc) {
      const target = resolveIncludePath(document.uri, inc.path);
      if (target) return new vscode.Location(target, new vscode.Position(0, 0));
      return null;
    }
    const tag = getTagNameAt(document, position);
    if (!tag) return null;
    if (BUILTIN_TAGS.has(tag.name.toLowerCase())) return null;
    const scope = await ensureScopeIndexed(scopeKeyForUri(document.uri));
    const defs = scope.byName.get(tag.name);
    if (!defs || defs.length === 0) return null;
    return sortDefsForCurrentDoc(defs, document.uri).map(
      d => new vscode.Location(d.uri, d.nameRange)
    );
  }
};

const hoverProvider = {
  async provideHover(document, position) {
    const tag = getTagNameAt(document, position);
    if (!tag) return null;

    // Built-in: look up the static docs scraped from the manual.
    const lc = tag.name.toLowerCase();
    if (builtinDocs[lc] || BUILTIN_TAGS.has(lc)) {
      const entry = builtinDocs[lc];
      if (!entry) return null;
      const md = new vscode.MarkdownString();
      md.isTrusted = true;
      const title = entry.names.length > 1
        ? entry.names.map(n => `\`<${n}>\``).join(', ')
        : `\`<${entry.names[0]}>\``;
      md.appendMarkdown(`**${title}** — ${entry.summary}\n\n`);
      if (entry.synopsis) md.appendCodeblock(entry.synopsis, 'vortex');
      md.appendMarkdown(`\n[Open documentation](${DOCS_BASE}${entry.url})`);
      return new vscode.Hover(md, tag.range);
    }

    const scope = await ensureScopeIndexed(scopeKeyForUri(document.uri));
    const defs = scope.byName.get(tag.name);
    if (!defs || defs.length === 0) return null;

    const sorted = sortDefsForCurrentDoc(defs, document.uri);
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendCodeblock(formatSignature(sorted[0]), 'vortex');

    for (const d of sorted) {
      const wsFolder = vscode.workspace.getWorkspaceFolder(d.uri);
      const rel = wsFolder
        ? path.relative(wsFolder.uri.fsPath, d.uri.fsPath)
        : d.uri.fsPath;
      md.appendMarkdown(`\n_Defined in_ \`${rel}:${d.range.start.line + 1}\``);
      if (sorted.length > 1) md.appendMarkdown('  \n');
    }
    return new vscode.Hover(md, tag.range);
  }
};

const documentSymbolProvider = {
  provideDocumentSymbols(document) {
    const scope = scopeForDoc(document);
    const defs = scope.byFile.get(document.uri.toString()) || [];
    return defs.map(d => {
      const detail = d.params.length
        ? '(' + d.params.map(p => p.name).join(', ') + ')'
        : '';
      return new vscode.DocumentSymbol(
        d.name,
        detail,
        vscode.SymbolKind.Function,
        d.range,
        d.nameRange
      );
    });
  }
};

// Semantic tokens let us color user-function calls differently from plain HTML.
// The TextMate grammar can't do this because it has no workspace knowledge:
// `<article>` (literal HTML output) and `<myfunc>` (a Vortex call) look
// identical to the grammar. With semantic tokens we look up each <word> tag
// in the live function index and emit a `function` token for the matches.
// Names not in the index fall through to the grammar's coloring.
const semanticTokenLegend = new vscode.SemanticTokensLegend(['function'], []);

const SEMANTIC_RE =
  /<\/?([A-Za-z_][A-Za-z0-9_]*)\b|<(?:entryfunc|exitfunc)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\b/gi;

const semanticTokensProvider = {
  async provideDocumentSemanticTokens(document) {
    const scope = await ensureScopeIndexed(scopeKeyForUri(document.uri));
    const builder = new vscode.SemanticTokensBuilder(semanticTokenLegend);
    const text = document.getText();
    SEMANTIC_RE.lastIndex = 0;
    let m;
    while ((m = SEMANTIC_RE.exec(text)) !== null) {
      const name = m[1] || m[2];
      // Skip built-ins — the grammar already colors them as keywords, and
      // overriding with `function` would make them indistinguishable from
      // user calls.
      if (BUILTIN_TAGS.has(name.toLowerCase())) continue;
      if (!scope.byName.has(name)) continue;
      const captureOffset = m[0].lastIndexOf(name);
      const startOffset = m.index + captureOffset;
      const pos = document.positionAt(startOffset);
      builder.push(pos.line, pos.character, name.length, 0 /* function */, 0);
    }
    return builder.build();
  }
};

const referenceProvider = {
  async provideReferences(document, position, context) {
    const tag = getTagNameAt(document, position);
    if (!tag) return null;
    // Built-ins appear everywhere; refusing to enumerate them keeps the
    // results panel useful.
    if (BUILTIN_TAGS.has(tag.name.toLowerCase())) return null;

    const name = tag.name;
    // Function names are [A-Za-z_][A-Za-z0-9_]* so no regex escaping needed,
    // but be defensive in case the indexer ever loosens that.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match either a direct call (`<funcName` followed by space, attr, or `>`)
    // or use as the value of a function-name directive (`<entryfunc=funcName`).
    const dirAlt = FUNC_REF_DIRECTIVES.join('|');
    const callRe = new RegExp(
      `<(?:${dirAlt})\\s*=\\s*(${escaped})\\b|<(${escaped})\\b`,
      'gi'
    );

    // Scan every already-indexed file in the same scope as the document.
    // (Cross-scope references would be misleading: a build-*/ tree is meant
    // to be navigated independently of the main source.)
    const scope = await ensureScopeIndexed(scopeKeyForUri(document.uri));
    const uris = Array.from(scope.byFile.keys()).map(s => vscode.Uri.parse(s));
    const locations = [];

    await Promise.all(uris.map(async uriString => {
      const uri = vscode.Uri.parse(uriString);
      let text;
      try { text = await fsp.readFile(uri.fsPath, 'utf8'); }
      catch { return; }
      // Cheap substring guard: name must appear after either `<` or `=`
      // somewhere in the file. Skip the regex run otherwise.
      if (text.indexOf(name) < 0) return;

      let lineStarts = null;
      callRe.lastIndex = 0;
      let m;
      while ((m = callRe.exec(text)) !== null) {
        if (!lineStarts) lineStarts = buildLineStarts(text);
        // Group 1 is the directive form, group 2 is the direct call. Whichever
        // matched, locate the captured name's offset within the full match.
        const captured = m[1] != null ? m[1] : m[2];
        const captureOffset = m[0].lastIndexOf(captured);
        const nameStart = m.index + captureOffset;
        const start = offsetToPosition(lineStarts, nameStart);
        const end = offsetToPosition(lineStarts, nameStart + captured.length);
        locations.push(new vscode.Location(uri, new vscode.Range(start, end)));
      }
    }));

    if (context.includeDeclaration) {
      const defs = scope.byName.get(name) || [];
      for (const d of defs) {
        locations.push(new vscode.Location(d.uri, d.nameRange));
      }
    }
    return locations;
  }
};

const workspaceSymbolProvider = {
  provideWorkspaceSymbols(query) {
    // Search across every loaded scope. Lazy scopes that haven't been
    // visited yet won't appear here — that matches user expectation
    // (Cmd-T should not pay to scan generated copies that haven't been
    // opened).
    const q = query.toLowerCase();
    const out = [];
    for (const scope of scopes.values()) {
      for (const [name, defs] of scope.byName) {
        if (q && !name.toLowerCase().includes(q)) continue;
        for (const d of defs) {
          out.push(new vscode.SymbolInformation(
            d.name,
            vscode.SymbolKind.Function,
            '',
            new vscode.Location(d.uri, d.nameRange)
          ));
        }
      }
    }
    return out;
  }
};

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function activate(context) {
  output = vscode.window.createOutputChannel('Vortex');
  context.subscriptions.push(output);
  log(`activating vortex-language ${context.extension.packageJSON.version}`);
  loadBuiltinDocs(context.extensionPath);

  srcEnabled = vscode.workspace.getConfiguration('vortex').get('enableVortexSrc', false);
  log(`vortex-src enabled: ${srcEnabled}`);

  const selector = [
    { language: 'vortex', scheme: 'file' },
    ...(srcEnabled ? [{ language: 'vortex-src', scheme: 'file' }] : [])
  ];

  // When vortex-src is enabled, claim .vsrc files as vortex-src (since we
  // don't declare file extensions statically in package.json).
  if (srcEnabled) {
    const claimSrcDoc = doc => {
      if (doc.uri.scheme !== 'file') return;
      if (doc.languageId === 'vortex-src') return;
      const ext = path.extname(doc.uri.fsPath);
      if (ext === '.vsrc') {
        vscode.languages.setTextDocumentLanguage(doc, 'vortex-src');
      }
    };
    // Claim files opened from now on.
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(claimSrcDoc)
    );
    // Claim files that were already open before the extension activated
    // (e.g. tabs restored from a previous session).
    for (const doc of vscode.workspace.textDocuments) {
      claimSrcDoc(doc);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('vortex.preprocessSrc', preprocessSrc),
    vscode.commands.registerCommand('vortex.openDocs', openDocs),
    vscode.languages.registerDefinitionProvider(selector, definitionProvider),
    vscode.languages.registerHoverProvider(selector, hoverProvider),
    vscode.languages.registerDocumentSymbolProvider(selector, documentSymbolProvider),
    vscode.languages.registerReferenceProvider(selector, referenceProvider),
    vscode.languages.registerDocumentSemanticTokensProvider(
      selector, semanticTokensProvider, semanticTokenLegend
    ),
    vscode.languages.registerWorkspaceSymbolProvider(workspaceSymbolProvider)
  );

  // Keep the index fresh. We deliberately do NOT hook onDidOpenTextDocument:
  // it fires for every internal open (output panels, git buffers, peeks, etc.)
  // and the initial scan already covers on-disk state.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => indexDocument(doc)),
    vscode.workspace.onDidDeleteFiles(e => {
      for (const uri of e.files) removeFileFromIndex(uri.toString());
    }),
    vscode.workspace.onDidRenameFiles(async e => {
      for (const { oldUri, newUri } of e.files) {
        removeFileFromIndex(oldUri.toString());
        await indexFile(newUri);
      }
    }),
    vscode.workspace.onDidCreateFiles(async e => {
      for (const uri of e.files) await indexFile(uri);
    })
  );

  // Initial scan in the background — don't block activation.
  buildInitialIndex().catch(err => {
    log(`initial index failed: ${err && err.stack || err}`);
  });
}

function deactivate() {}

module.exports = { activate, deactivate };

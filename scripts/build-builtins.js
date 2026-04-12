#!/usr/bin/env node
//
// Regenerate builtins.json from the live Vortex manual.
// Run from the extension directory:
//
//   node scripts/build-builtins.js
//
// Output: builtins.json — a flat name -> { names, url, summary, synopsis }
// map covering both built-in functions and statements. The extension loads
// it at activation. Re-run when the manual changes.

const fs = require('fs');
const path = require('path');

const BASE = 'https://docs.thunderstone.com/site/vortexman/';
const INDEX_PAGES = [
  'builtin_functions.html',
  'vortex_statements.html',
  'vortex_directives.html'
];
const OUT_PATH = path.join(__dirname, '..', 'builtins.json');
const FETCH_CONCURRENCY = 4;

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.text();
}

/**
 * Extract top-level <li> entries inside <nav class="ManTOC">. Each entry
 * looks like:
 *
 *   <li> <a href="rex_split.html"><tt>rex</tt>, <tt>split</tt> - regular ...</a>
 *
 * Sub-pages appear in nested <ul> blocks; we skip those.
 */
function parseTocPage(html) {
  const tocStart = html.indexOf('<nav class="ManTOC">');
  const tocEnd = html.indexOf('</nav>', tocStart);
  if (tocStart < 0 || tocEnd < 0) throw new Error('could not find ManTOC');
  const toc = html.slice(tocStart, tocEnd);

  // Walk the TOC tracking <ul> depth so nested lists (sub-pages) are skipped.
  let depth = 0;
  let top = '';
  for (let i = 0; i < toc.length; ) {
    if (toc.startsWith('<ul', i)) {
      depth++;
      i = toc.indexOf('>', i) + 1;
      continue;
    }
    if (toc.startsWith('</ul>', i)) {
      depth--;
      i += 5;
      continue;
    }
    if (depth === 1) top += toc[i];
    i++;
  }

  const entries = [];
  const entryRe = /<li>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis;
  let m;
  while ((m = entryRe.exec(top)) !== null) {
    const url = m[1];
    const inner = m[2];

    // Function/statement names appear inside <tt>...</tt>.
    const names = [];
    const ttRe = /<tt>([^<]+)<\/tt>/g;
    let t;
    while ((t = ttRe.exec(inner)) !== null) names.push(t[1].trim().toLowerCase());
    if (names.length === 0) continue; // e.g. "Variable assignment" — no tag name

    const text = decodeHtml(inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')).trim();
    const dashIdx = text.indexOf(' - ');
    const summary = dashIdx >= 0 ? text.slice(dashIdx + 3).trim() : text;

    entries.push({ names, url, summary });
  }
  return entries;
}

/**
 * Pull the SYNOPSIS block out of a detail page. The block lives between
 *   SYNOPSIS<br><span style="font-family: courier"><pre><tt> ... </tt></pre></span>
 * and the next section header (DESCRIPTION/DIAGNOSTICS/etc.).
 */
function extractSynopsis(html) {
  const m = /SYNOPSIS\s*<br\s*\/?>\s*<span[^>]*>\s*<pre>([\s\S]*?)<\/pre>\s*<\/span>/i.exec(html);
  if (!m) return null;
  return decodeHtml(m[1].replace(/<[^>]+>/g, '')).trim();
}

function decodeHtml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#92;/g, '\\')
    .replace(/&nbsp;/g, ' ');
}

async function withConcurrency(items, n, worker) {
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      try { await worker(items[i], i); }
      catch (e) { console.warn(`  ${items[i].url}: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: n }, run));
}

async function main() {
  // Pass 1: scrape both index pages.
  const entries = [];
  for (const page of INDEX_PAGES) {
    console.log(`fetching index ${page}`);
    const html = await fetchText(BASE + page);
    const found = parseTocPage(html);
    console.log(`  ${found.length} entries`);
    entries.push(...found);
  }

  // Dedupe by primary name (first <tt>) — statements and functions don't
  // overlap in practice, but be safe.
  const seenUrls = new Set();
  const unique = entries.filter(e => {
    if (seenUrls.has(e.url)) return false;
    seenUrls.add(e.url);
    return true;
  });

  // Pass 2: fetch each detail page for the synopsis.
  console.log(`fetching ${unique.length} detail pages...`);
  await withConcurrency(unique, FETCH_CONCURRENCY, async entry => {
    const html = await fetchText(BASE + entry.url);
    entry.synopsis = extractSynopsis(html);
  });

  // Flatten to a name -> entry map (multi-name pages like fmt/strfmt get
  // one entry per name, all sharing the same payload).
  const out = {};
  for (const entry of unique) {
    for (const name of entry.names) {
      if (out[name]) continue;
      out[name] = {
        names: entry.names,
        url: entry.url,
        summary: entry.summary,
        synopsis: entry.synopsis || null
      };
    }
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  const withSynopsis = Object.values(out).filter(e => e.synopsis).length;
  console.log(`wrote ${OUT_PATH}: ${Object.keys(out).length} entries, ${withSynopsis} with synopsis`);
}

main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// Walk every recipe markdown and apply Title Case to the H1 title.
// Rules:
//   - First word of the title is always capitalised.
//   - First word inside a parenthesised clause is always capitalised
//     (so "Pâte à Choux (Choux Pastry)" stays that way, not
//     "Pâte à Choux (choux Pastry)").
//   - Small connectives stay lowercase mid-title: a / an / and / of /
//     to / in / on / with / for / etc., plus common foreign articles
//     and prepositions ("de", "du", "la", "à", "aux", etc.).
//   - Apostrophe-prefixed articles ("d'amande", "l'oignon") keep the
//     article lowercase and capitalise the word after the apostrophe.
//   - Hyphenated words split and each part title-cased.
//   - All-caps acronyms (BBQ, BIR) preserved.
//   - Diacritics handled via toLocale{Upper,Lower}Case.
//
// Writes changes back in place; re-runs are idempotent.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['.git', 'docs', 'node_modules', 'scripts', 'wip', 'resources', 'documentation', 'TODO', 'editorial']);
const SKIP_FILES = new Set(['README.md', 'RECIPE_TEMPLATE.md', 'LICENSE', 'new.md', 'AUTHORING.md', 'CHANGELOG.md']);

const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'en', 'for', 'from',
  'in', 'into', 'nor', 'of', 'on', 'onto', 'or', 'over', 'per', 'so',
  'than', 'the', 'to', 'up', 'upon', 'via', 'vs', 'when', 'with',
  // Foreign particles common in dish names.
  'de', 'del', 'des', 'di', 'du', 'da', 'das', 'der', 'die',
  'el', 'la', 'las', 'le', 'les', 'lo', 'los', 'il',
  'al', 'au', 'aux', 'um', 'à',
]);

const FORCED_CASING = { bir: 'BIR', bbq: 'BBQ' };

function toPosix(p) { return p.split(sep).join(posix.sep); }

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      if (entry.startsWith('.')) continue;
      walk(full, files);
    } else if (entry.endsWith('.md') && !SKIP_FILES.has(entry) && !entry.startsWith('TODO')) {
      files.push(full);
    }
  }
  return files;
}

function capitaliseWord(w) {
  if (!w) return w;
  const lower = w.toLowerCase();
  if (FORCED_CASING[lower] !== undefined) return FORCED_CASING[lower];
  if (/^\p{Lu}{2,}$/u.test(w)) return w;
  // Apostrophe-prefix article: single letter + apostrophe + rest.
  const apos = w.match(/^(\p{L})['’](.+)$/u);
  if (apos) {
    return apos[1].toLocaleLowerCase() + "'" + capitaliseWord(apos[2]);
  }
  if (w.includes('-')) {
    return w.split('-').map(capitaliseWord).join('-');
  }
  return w.charAt(0).toLocaleUpperCase() + w.slice(1).toLocaleLowerCase();
}

function titleCaseClause(input, forceFirst) {
  let firstSeen = false;
  return input.split(/(\s+)/).map((tok) => {
    if (/^\s+$/.test(tok) || !tok) return tok;
    const lower = tok.toLocaleLowerCase();
    if (!firstSeen && forceFirst) {
      firstSeen = true;
      return capitaliseWord(tok);
    }
    firstSeen = true;
    if (SMALL_WORDS.has(lower)) return lower;
    return capitaliseWord(tok);
  }).join('');
}

// Splits on parentheses and treats each clause independently.
// The very first clause AND the first word of any parenthesised clause
// get force-capitalised even if they happen to be a small-word.
function titleCase(title) {
  const parts = title.split(/(\(|\))/);
  let out = '';
  let mainStarted = false;
  let nextClauseStart = false;
  for (const part of parts) {
    if (part === '(') {
      out += '(';
      nextClauseStart = true;
      continue;
    }
    if (part === ')') {
      out += ')';
      nextClauseStart = false;
      continue;
    }
    if (!part) continue;
    const forceFirst = !mainStarted || nextClauseStart;
    out += titleCaseClause(part, forceFirst);
    if (part.trim()) mainStarted = true;
    nextClauseStart = false;
  }
  return out;
}

const files = walk(REPO_ROOT);
let changed = 0;
let unchanged = 0;
const diffs = [];

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const m = raw.match(/^(#\s+)(.+?)(\s*)$/m);
  if (!m) continue;
  const original = m[2];
  const cased = titleCase(original);
  if (cased === original) { unchanged++; continue; }
  const updated = raw.replace(/^(#\s+)(.+?)(\s*)$/m, `$1${cased}$3`);
  writeFileSync(file, updated, 'utf8');
  diffs.push({ file: toPosix(relative(REPO_ROOT, file)), from: original, to: cased });
  changed++;
}

console.log(`Scanned ${files.length} recipes. Updated ${changed}, unchanged ${unchanged}.`);
if (diffs.length) {
  console.log('');
  console.log('Changes:');
  for (const d of diffs) {
    console.log(`  ${d.file}`);
    console.log(`     "${d.from}" -> "${d.to}"`);
  }
}

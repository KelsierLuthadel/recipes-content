// Scan every modified .md file (per git status) under recipes-content
// for common edit defects. Reports findings grouped by issue type so a
// human can review the actual lines. Read-only - never writes.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

function modifiedFiles() {
  const out = execSync('git status --short', { cwd: ROOT }).toString();
  return out.split('\n')
    .map(l => l.match(/^\s*M\s+(.+\.md)$/))
    .filter(Boolean)
    .map(m => m[1].trim());
}

const EQUIPMENT_SUB_RE = /^###\s+(equipment|tools|kit|gear)\b/i;

const issues = {
  unbalanced_parens: [],
  empty_bullet: [],
  leftover_qualifier: [],   // about/additional/approximately still at start
  double_paren: [],         // "(x) (y)" two paren groups touching
  orphan_open: [],          // "(" with no matching ")"
  doubled_words: [],        // "and and", "the the"
  trailing_dash: [],        // line ends in " - " (stray separator)
  zest_unstripped: [],      // line still starts with "Zest"
  weird_whitespace: [],     // "  " double space, leading/trailing space artefacts
};

function pushIssue(bucket, file, lineNum, body) {
  issues[bucket].push({ file, line: lineNum, body });
}

for (const f of modifiedFiles()) {
  const full = path.join(ROOT, f);
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/);
  let inIng = false;
  let inEquipment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+ingredients\b/i.test(line)) { inIng = true; inEquipment = false; continue; }
    if (inIng && /^##\s/.test(line)) { inIng = false; inEquipment = false; continue; }
    if (!inIng) continue;
    if (/^###\s/.test(line)) { inEquipment = EQUIPMENT_SUB_RE.test(line); continue; }
    if (inEquipment) continue;

    const m = line.match(/^(\s*-\s*)(.*)$/);
    if (!m) continue;
    const body = m[2];
    const bare = body.trim();
    const lineNum = i + 1;

    if (!bare) { pushIssue('empty_bullet', f, lineNum, line); continue; }

    // unbalanced parens
    let depth = 0;
    let unbalanced = false;
    for (const ch of body) {
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth < 0) { unbalanced = true; break; } }
    }
    if (depth !== 0 || unbalanced) pushIssue('unbalanced_parens', f, lineNum, body);

    // leftover qualifier word (about / additional / approximately not in parens)
    // Check both at start AND mid-string (but not inside parens)
    // Strip parens first then test
    const bodyNoParens = body.replace(/\([^)]*\)/g, '');
    if (/\b(about|additional|approximately)\s+\S/i.test(bodyNoParens) && /^(.*?)\b(about|additional|approximately)\s+/i.test(bodyNoParens)) {
      // Distinguish: at start of line is what my script handles
      // After qty: matches "<num> <unit>? about/additional X"
      pushIssue('leftover_qualifier', f, lineNum, body);
    }

    // two adjacent paren groups: ") ("
    if (/\)\s*\(/.test(body)) pushIssue('double_paren', f, lineNum, body);

    // orphan open paren - already caught by unbalanced check but flag specifically
    if ((body.match(/\(/g) || []).length > (body.match(/\)/g) || []).length) {
      pushIssue('orphan_open', f, lineNum, body);
    }

    // doubled adjacent words
    const dup = body.match(/\b(\w+)\s+\1\b/i);
    if (dup && !['that','can','had','one','two','three','four','five'].includes(dup[1].toLowerCase())) {
      pushIssue('doubled_words', f, lineNum, body);
    }

    // trailing dash (line ends with " - " or "-")
    if (/\s-\s*$/.test(bare)) pushIssue('trailing_dash', f, lineNum, body);

    // Zest still at start
    if (/^Zest\s+/i.test(bare)) pushIssue('zest_unstripped', f, lineNum, body);

    // weird whitespace: multiple consecutive spaces in body
    if (/\s{2,}/.test(body)) pushIssue('weird_whitespace', f, lineNum, body);
  }
}

const labels = {
  unbalanced_parens: 'Unbalanced parentheses',
  empty_bullet: 'Empty bullet (- with nothing)',
  leftover_qualifier: 'about/additional/approximately not stripped',
  double_paren: 'Two paren groups touching: ) (',
  orphan_open: 'Open paren without close',
  doubled_words: 'Adjacent duplicated word',
  trailing_dash: 'Line ends in " - " (stray separator)',
  zest_unstripped: 'Line still starts with "Zest"',
  weird_whitespace: 'Double space inside body',
};

for (const [key, label] of Object.entries(labels)) {
  const list = issues[key];
  console.log(`\n=== ${label} (${list.length}) ===`);
  for (const r of list.slice(0, 15)) {
    console.log(`  ${r.file}:${r.line}`);
    console.log(`    ${r.body}`);
  }
  if (list.length > 15) console.log(`  ... and ${list.length - 15} more`);
}

const total = Object.values(issues).reduce((s, l) => s + l.length, 0);
console.log(`\nTotal issues flagged: ${total}`);

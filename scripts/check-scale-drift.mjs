// Compare every modified .md file's ingredient quantities against
// HEAD. Reports any numeric token (number + optional unit) that
// appeared in HEAD's ingredient block but is missing from the
// current version, or vice versa. Flags potential scale changes
// caused by edits.
//
// Tolerates legitimate transformations:
//   - "N x M unit X" -> "(N*M) unit X" (multiplier rule)
//   - Per-line reordering (compares multisets, not positions)
//
// Read-only - never writes.

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

function headContent(file) {
  try {
    return execSync(`git show HEAD:"${file.replace(/\\/g, '/')}"`, { cwd: ROOT }).toString();
  } catch {
    return null;
  }
}

const EQUIPMENT_SUB_RE = /^###\s+(equipment|tools|kit|gear)\b/i;

// Extract the ingredient block as a single string of bullet bodies
// (one per line, ### sub-headings excluded, equipment subs excluded).
function ingredientBlock(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inIng = false;
  let inEquipment = false;
  for (const line of lines) {
    if (/^##\s+ingredients\b/i.test(line)) { inIng = true; inEquipment = false; continue; }
    if (inIng && /^##\s/.test(line)) { inIng = false; inEquipment = false; continue; }
    if (!inIng) continue;
    if (/^###\s/.test(line)) { inEquipment = EQUIPMENT_SUB_RE.test(line); continue; }
    if (inEquipment) continue;
    const m = line.match(/^\s*-\s*(.*)$/);
    if (m) out.push(m[1]);
  }
  return out;
}

// Extract a multiset of "number<unit?>" tokens from a block of text.
// Unicode fractions get normalised to their numeric value.
const UNICODE_FRACS = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1/3, '⅔': 2/3, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875 };

// Normalise units to a canonical key with a scale factor so
// "1 litre" and "1000 ml" collapse to the same bucket.
const UNIT_NORM = {
  g: ['g', 1], gram: ['g', 1], grams: ['g', 1],
  kg: ['g', 1000], kilogram: ['g', 1000], kilograms: ['g', 1000],
  ml: ['ml', 1], millilitre: ['ml', 1], milliliter: ['ml', 1], millilitres: ['ml', 1], milliliters: ['ml', 1],
  l: ['ml', 1000], litre: ['ml', 1000], liter: ['ml', 1000], litres: ['ml', 1000], liters: ['ml', 1000],
  oz: ['oz', 1], ounce: ['oz', 1], ounces: ['oz', 1],
  lb: ['lb', 1], lbs: ['lb', 1], pound: ['lb', 1], pounds: ['lb', 1],
  tbsp: ['tbsp', 1], tablespoon: ['tbsp', 1], tablespoons: ['tbsp', 1],
  tsp: ['tsp', 1], teaspoon: ['tsp', 1], teaspoons: ['tsp', 1],
  cup: ['cup', 1], cups: ['cup', 1],
  pinch: ['pinch', 1], pinches: ['pinch', 1],
  dash: ['dash', 1], dashes: ['dash', 1],
  cm: ['cm', 1], mm: ['cm', 0.1], inch: ['inch', 1], inches: ['inch', 1],
};
const REAL_UNITS = new Set(Object.keys(UNIT_NORM));

// Collapse "N x M" multipliers ahead of extraction, so HEAD's
// "2 x 100 gram balls" reduces to "200 gram balls" and matches
// the post-multiplier-rule form in the current file.
function collapseMultipliers(text) {
  return text.replace(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/gi,
    (_, a, b) => String(parseFloat(a) * parseFloat(b)));
}

// Drop everything inside parens before extraction. Parenthetical
// content is annotation (substitutes, weight estimates, prep notes)
// and removing or rewording it isn't a true scale change.
function stripParens(text) {
  return text.replace(/\([^()]*\)/g, ' ');
}

function extractQtyTokens(rawText) {
  const text = stripParens(collapseMultipliers(rawText));
  const tokens = [];
  const re = /(\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?(?:\s*[½¼¾⅓⅔⅛⅜⅝⅞])?|[½¼¾⅓⅔⅛⅜⅝⅞]|\d+\/\d+)\s*([a-zA-Z]+)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // Normalise to a numeric value (use mid-point for ranges)
    let n = NaN;
    const numStr = m[1];
    if (numStr.includes('/')) {
      const [a, b] = numStr.split('/').map(Number);
      n = a / b;
    } else if (UNICODE_FRACS[numStr]) {
      n = UNICODE_FRACS[numStr];
    } else {
      const rangeMatch = numStr.match(/^(\d+(?:[.,]\d+)?)\s*[-–]\s*(\d+(?:[.,]\d+)?)/);
      if (rangeMatch) {
        n = (parseFloat(rangeMatch[1].replace(',', '.')) + parseFloat(rangeMatch[2].replace(',', '.'))) / 2;
      } else {
        const intFrac = numStr.match(/^(\d+)\s*([½¼¾⅓⅔⅛⅜⅝⅞])$/);
        if (intFrac) n = parseInt(intFrac[1], 10) + UNICODE_FRACS[intFrac[2]];
        else n = parseFloat(numStr.replace(',', '.'));
      }
    }
    if (!Number.isFinite(n)) continue;
    const candidateUnit = (m[2] || '').toLowerCase();
    let unit = '';
    let scaled = n;
    if (UNIT_NORM[candidateUnit]) {
      const [canon, factor] = UNIT_NORM[candidateUnit];
      unit = canon;
      scaled = n * factor;
    }
    tokens.push({ raw: m[0].trim(), value: scaled, unit });
  }
  return tokens;
}

// Sum tokens by unit so "200 g" + "300 g" reduces to a single 500g
// entry. Tokens without a unit get counted under "" key. Ranges have
// already been collapsed to mid-points.
function sumByUnit(tokens) {
  const totals = new Map();
  for (const t of tokens) {
    const k = t.unit;
    totals.set(k, (totals.get(k) || 0) + t.value);
  }
  return totals;
}

const TOLERANCE = 0.5; // grams / ml etc.

function diffTotals(oldT, newT) {
  const units = new Set([...oldT.keys(), ...newT.keys()]);
  const diffs = [];
  for (const u of units) {
    const a = oldT.get(u) || 0;
    const b = newT.get(u) || 0;
    if (Math.abs(a - b) <= TOLERANCE) continue;
    diffs.push({ unit: u, old: a, current: b, delta: b - a });
  }
  return diffs;
}

const findings = [];
for (const f of modifiedFiles()) {
  const head = headContent(f);
  if (head === null) continue;
  const cur = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const oldBlock = ingredientBlock(head).join('\n');
  const newBlock = ingredientBlock(cur).join('\n');
  const oldTok = extractQtyTokens(oldBlock);
  const newTok = extractQtyTokens(newBlock);
  const oldTotals = sumByUnit(oldTok);
  const newTotals = sumByUnit(newTok);
  const diffs = diffTotals(oldTotals, newTotals);
  if (diffs.length) findings.push({ file: f, diffs, oldTok, newTok });
}

console.log(`Files with quantity drift: ${findings.length}`);
for (const f of findings) {
  console.log(`\n${f.file}`);
  for (const d of f.diffs) {
    const unit = d.unit || '(no unit)';
    const fmt = n => Number.isInteger(n) ? String(n) : n.toFixed(2);
    console.log(`  ${unit.padEnd(8)}  HEAD=${fmt(d.old).padStart(8)}  NOW=${fmt(d.current).padStart(8)}  Δ=${d.delta > 0 ? '+' : ''}${fmt(d.delta)}`);
  }
}

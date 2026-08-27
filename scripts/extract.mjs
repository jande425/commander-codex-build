// Extracts the `const D = [...]` deck array out of the original single-file
// HTML and writes it to src/data/decks.json as typed objects. Run once.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const html = readFileSync(resolve(root, 'commander_precon_codex.html'), 'utf8');

// Grab everything between `const D = [` and the closing `];`
const m = html.match(/const D\s*=\s*(\[[\s\S]*?\]);/);
if (!m) throw new Error('Could not locate the deck array in the HTML.');

// It is a plain JS array literal of tuples — safe to evaluate here.
const rows = eval(m[1]);

const decks = rows.map(([year, commander, deck, set, code, flag], i) => ({
  id: `${code}-${slug(deck)}`,
  year,
  commander,
  deck,
  set,
  code,
  ...(flag ? { flag } : {}),
}));

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const outDir = resolve(__dirname, '..', 'src', 'data');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'decks.json'), JSON.stringify(decks, null, 2) + '\n', 'utf8');
console.log(`Wrote ${decks.length} decks to src/data/decks.json`);

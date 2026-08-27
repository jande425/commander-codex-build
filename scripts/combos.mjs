// Builds src/data/combos.json: known card combos present in each precon, via the
// Commander Spellbook find-my-combos API. Cached per deck.
//
//   npm run combos
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');
const cacheDir = resolve(__dirname, '..', '.cache', 'combos');
mkdirSync(cacheDir, { recursive: true });

const decklists = JSON.parse(readFileSync(resolve(dataDir, 'decklists.json'), 'utf8'));
const HEADERS = { 'Content-Type': 'application/json', 'User-Agent': 'CommanderCodex/0.1 (deck browser)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = 'https://backend.commanderspellbook.com/find-my-combos';

async function findCombos(deckId, list) {
  const cached = resolve(cacheDir, deckId + '.json');
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
  const cmd = new Set(list.commanders);
  const body = {
    commanders: list.commanders.map((n) => ({ card: n })),
    main: list.cards.filter((c) => !cmd.has(c.n)).map((c) => ({ card: c.n })),
  };
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(URL, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
      if (r.status === 429) { await sleep(2000); continue; }
      if (!r.ok) { await sleep(800); continue; }
      const j = await r.json();
      const included = j.results?.included || [];
      const combos = included.map((c) => ({
        cards: (c.uses || []).map((u) => u.card?.name).filter(Boolean),
        makes: (c.produces || []).map((p) => p.feature?.name || p.name).filter(Boolean),
      }));
      writeFileSync(cached, JSON.stringify(combos), 'utf8');
      await sleep(200);
      return combos;
    } catch {
      await sleep(800);
    }
  }
  return [];
}

const out = {};
let done = 0;
let withCombos = 0;
for (const [id, list] of Object.entries(decklists)) {
  const combos = await findCombos(id, list);
  if (combos.length) {
    out[id] = combos;
    withCombos++;
  }
  done++;
  if (done % 25 === 0) console.log(`  ...${done} decks (${withCombos} with combos)`);
}

writeFileSync(resolve(dataDir, 'combos.json'), JSON.stringify(out), 'utf8');
const kb = readFileSync(resolve(dataDir, 'combos.json')).length / 1024;
console.log(`\nWrote combos for ${withCombos}/${done} decks (${kb.toFixed(0)} KB).`);

// Local dev counterpart of the Vercel API functions. `expo start` doesn't run
// them, so during local development run this alongside it:
//
//   npm run proxy      # serves http://localhost:8787/api/{au-price,combos}
//
// Uses the exact same server code as production, with permissive CORS. In
// production the Vercel functions handle /api/au-price and /api/combos.
import { createServer } from 'node:http';
import { fetchAuPrices } from '../src/lib/ggFetch';
import { fetchComboSuggestions } from '../src/lib/spellbookFetch';
import { fetchArchidektByCommander } from '../src/lib/archidektFetch';

const PORT = 8787;

function readBody(req: any): Promise<string> {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c: any) => (s += c));
    req.on('end', () => resolve(s));
  });
}

createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname.endsWith('/au-price')) {
    const name = (url.searchParams.get('name') ?? '').trim();
    res.end(JSON.stringify(name ? await fetchAuPrices(name) : { stores: [] }));
    return;
  }

  if (url.pathname.endsWith('/combos')) {
    const body = JSON.parse((await readBody(req)) || '{}');
    const commanders = Array.isArray(body.commanders) ? body.commanders : [];
    const main = Array.isArray(body.main) ? body.main : [];
    res.end(JSON.stringify(await fetchComboSuggestions(commanders, main)));
    return;
  }

  if (url.pathname.endsWith('/archidekt')) {
    const commander = (url.searchParams.get('commander') ?? '').trim();
    res.end(JSON.stringify(commander ? await fetchArchidektByCommander(commander) : { decks: [] }));
    return;
  }

  res.statusCode = 404;
  res.end('not found');
}).listen(PORT, () => console.log(`Dev proxy → http://localhost:${PORT}/api/{au-price,combos}`));

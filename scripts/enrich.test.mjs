import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(new URL('./enrich.mjs', import.meta.url));
const commander = 'Test Commander';
const card = (name = commander, overrides = {}) => ({
  object: 'card', name, color_identity: ['G'], type_line: 'Legendary Creature — Elf Druid',
  cmc: 3, mana_cost: '{2}{G}', image_uris: { normal: 'https://example.test/card.jpg', art_crop: 'https://example.test/art.jpg' },
  prices: { usd: '1.25' }, scryfall_uri: 'https://example.test/card', ...overrides,
});
const success = (body = card()) => ({ status: 200, body });
const failure = (status) => ({ status, body: { object: 'error', details: `HTTP ${status} lookup failed` } });

function runEnrichment(t, responses, {
  decks = [{ id: 'test-deck', commander }], cache, priorOutput, expectedStatus = 0,
} = {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'commander-enrich-test-'));
  t.after(() => {
    // Restrict recursive cleanup to the temporary fixture created above.
    assert.equal(dirname(fixture), resolve(tmpdir()));
    assert.ok(basename(fixture).startsWith('commander-enrich-test-'));
    rmSync(fixture, { recursive: true, force: true });
  });
  mkdirSync(join(fixture, 'scripts'));
  mkdirSync(join(fixture, 'src', 'data'), { recursive: true });
  copyFileSync(script, join(fixture, 'scripts', 'enrich.mjs'));
  writeFileSync(join(fixture, 'src', 'data', 'decks.json'), JSON.stringify(decks));
  const enrichedFile = join(fixture, 'src', 'data', 'enriched.json');
  if (priorOutput !== undefined) writeFileSync(enrichedFile, priorOutput);
  if (cache !== undefined) {
    mkdirSync(join(fixture, '.cache'));
    writeFileSync(join(fixture, '.cache', 'scryfall.json'), JSON.stringify(cache));
  }
  writeFileSync(join(fixture, 'responses.json'), JSON.stringify(responses));
  const preload = join(fixture, 'mock-fetch.mjs');
  writeFileSync(preload, `
    import { appendFileSync, readFileSync } from 'node:fs';
    const responses = JSON.parse(readFileSync(new URL('./responses.json', import.meta.url), 'utf8'));
    globalThis.setTimeout = (callback) => { queueMicrotask(callback); return 0; };
    globalThis.fetch = async (url) => {
      appendFileSync(new URL('./requests.jsonl', import.meta.url), JSON.stringify(String(url)) + '\\n');
      const next = responses.shift();
      if (!next) throw new Error('Unexpected request: ' + url);
      if (next.error) throw new Error(next.error);
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
    };
  `);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(fixture, 'scripts', 'enrich.mjs')], {
    cwd: fixture, encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, expectedStatus, `Unexpected exit status:\n${result.stdout}\n${result.stderr}`);
  const requestFile = join(fixture, 'requests.jsonl');
  const rawOutput = existsSync(enrichedFile) ? readFileSync(enrichedFile, 'utf8') : undefined;
  return {
    output: result.stdout,
    stderr: result.stderr,
    requests: existsSync(requestFile) ? readFileSync(requestFile, 'utf8').trim().split('\n').map(JSON.parse) : [],
    cache: JSON.parse(readFileSync(join(fixture, '.cache', 'scryfall.json'), 'utf8')),
    rawOutput,
    enriched: rawOutput === undefined ? undefined : JSON.parse(rawOutput),
  };
}

function assertSuccessful(result, count) {
  assert.equal(result.requests.length, count);
  assert.match(result.output, /No lookup errors\./);
  assert.equal(result.enriched['test-deck'].commanders[0].name, commander);
  assert.equal(result.enriched['test-deck'].commanders[0].error, undefined);
  assert.equal(result.cache[commander].name, commander);
}

test('exhausted rate limits fail clearly without producing or caching incomplete data', (t) => {
  const result = runEnrichment(t, [failure(429), failure(429), failure(429)], { expectedStatus: 1 });
  assert.equal(result.requests.length, 3);
  assert.match(result.stderr, /429/);
  assert.match(result.stderr, /Test Commander/);
  assert.doesNotMatch(result.stderr, /TypeError/);
  assert.equal(result.enriched, undefined);
  assert.equal(Object.hasOwn(result.cache, commander), false);
});

for (const [label, first] of [
  ['rate limiting', failure(429)],
  ['server errors', failure(503)],
  ['network errors', { error: 'Connection reset' }],
]) {
  test(`retries ${label} and caches the recovered card`, (t) => {
    assertSuccessful(runEnrichment(t, [first, success()]), 2);
  });
}

for (const [label, response, message] of [
  ['server errors', failure(503), /503/],
  ['network errors', { error: 'Connection reset' }, /Connection reset/],
]) {
  test(`exhausted ${label} fail without overwriting previous enrichment`, (t) => {
    const priorOutput = '{ "previous-deck": { "preserve": true } }\n';
    const result = runEnrichment(t, [response, response, response], { expectedStatus: 1, priorOutput });
    assert.equal(result.requests.length, 3);
    assert.match(result.stderr, message);
    assert.equal(result.rawOutput, priorOutput);
    assert.equal(Object.hasOwn(result.cache, commander), false);
  });
}

test('a transient failure preserves previous enrichment and caches earlier successful lookups', (t) => {
  const priorOutput = '{ "previous-deck": { "preserve": true } }\n';
  const result = runEnrichment(t, [success(), failure(429), failure(429), failure(429)], {
    expectedStatus: 1, priorOutput,
    decks: [{ id: 'test-deck', commander }, { id: 'later-deck', commander: 'Other Commander' }],
    cache: { 'Other Commander': { name: 'Other Commander', error: 'Old failure' } },
  });
  assert.equal(result.requests.length, 4);
  assert.match(result.stderr, /429/);
  assert.equal(result.rawOutput, priorOutput);
  assert.equal(result.cache[commander].name, commander);
  assert.equal(Object.hasOwn(result.cache, 'Other Commander'), false);
});

for (const [label, cached] of [['null', null], ['error', { name: commander, error: 'Old failure' }]]) {
  test(`refetches an existing ${label} cache entry`, (t) => {
    assertSuccessful(runEnrichment(t, [success()], { cache: { [commander]: cached } }), 1);
  });
}

test('a successful cache entry avoids any network request', (t) => {
  const cached = {
    name: commander, colorIdentity: ['G'], typeLine: 'Legendary Creature — Elf Druid', cmc: 3,
    manaCost: '{2}{G}', image: 'https://example.test/card.jpg', artCrop: 'https://example.test/art.jpg',
    priceUsd: 1.25, scryfallUri: 'https://example.test/card',
  };
  const result = runEnrichment(t, [], { cache: { [commander]: cached } });
  assertSuccessful(result, 0);
  assert.deepEqual(result.enriched['test-deck'].commanders, [cached]);
  assert.deepEqual(result.cache[commander], cached);
});

for (const [label, responses] of [
  ['a permanent lookup failure', [failure(404)]],
  ['a permanent lookup failure after rate limiting', [failure(429), failure(404)]],
]) {
  test(`${label} is reported once without failing the run or caching the miss`, (t) => {
    const result = runEnrichment(t, responses);
    assert.equal(result.requests.length, responses.length);
    assert.match(result.output, /1 lookup issue\(s\) to review/);
    assert.match(result.enriched['test-deck'].commanders[0].error, /404/);
    assert.equal(Object.hasOwn(result.cache, commander), false);
  });
}

test('successful partners retain card fields and combine deck colors, types, and price', (t) => {
  const partner = 'Test Partner';
  const result = runEnrichment(t, [success(), success(card(partner, {
    color_identity: ['U', 'G'], type_line: 'Legendary Creature — Human Wizard', prices: { usd: '2.50' },
  }))], { decks: [{ id: 'test-deck', commander: `${commander} & ${partner}` }] });
  const deck = result.enriched['test-deck'];
  assert.equal(result.requests.length, 2);
  assert.deepEqual(result.requests.map((url) => new URL(url).searchParams.get('fuzzy')), [commander, partner]);
  assert.deepEqual(deck.colorIdentity, ['U', 'G']);
  assert.equal(deck.isColorless, false);
  assert.deepEqual(deck.types, ['Elf', 'Druid', 'Human', 'Wizard']);
  assert.equal(deck.priceUsd, 3.75);
  assert.deepEqual(deck.commanders[0], {
    name: commander, colorIdentity: ['G'], typeLine: 'Legendary Creature — Elf Druid', cmc: 3,
    manaCost: '{2}{G}', image: 'https://example.test/card.jpg', artCrop: 'https://example.test/art.jpg',
    priceUsd: 1.25, scryfallUri: 'https://example.test/card',
  });
  assert.deepEqual(Object.keys(result.cache), [commander, partner]);
});

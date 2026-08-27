# Commander Codex — data build

Data-generation scripts and their scheduled workflows for the Commander Codex
app. This repository holds **no application code** — only the build scripts and
the generated reference data they produce.

It exists as a separate public repository because GitHub Actions minutes are
free and unlimited on public repos. The private app repository exhausted its
monthly allowance, after which every scheduled run was refused before a single
step could execute.

## Sources

All public, none requiring an API key:

| Source | Used for |
|---|---|
| [MTGJSON](https://mtgjson.com/) | precon deck lists and contents |
| [Scryfall](https://scryfall.com/docs/api) | card data, set data, imagery |
| [EDHREC](https://edhrec.com/) | upgrade suggestions |
| [Commander Spellbook](https://commanderspellbook.com/) | combo detection |

Each provider's terms govern reuse of its data. This repository aggregates; it
does not relicense the underlying sources, and it is not affiliated with or
endorsed by any of them. Magic: The Gathering is a trademark of Wizards of the
Coast, which is not affiliated with this project.

## Layout

```
scripts/          data generation (Node built-ins + global fetch only, no deps)
  lib/            shared helpers (perceptual hashing)
  embed/          art-embedding index tooling (run manually, not scheduled)
src/data/         generated JSON — both the output and the seed input
```

Scripts resolve paths as `__dirname/../src/data`, so `scripts/` and `src/data/`
must remain siblings. The working directory a script is invoked from does not
matter.

Several scripts read existing files as seed input — `decks.json`,
`commanders-seed.json`, `art-hashes.json` — which is why the generated data is
committed here rather than produced from nothing each run.

## Workflows

| Workflow | Schedule | Does |
|---|---|---|
| `refresh-data` | daily 06:00 UTC | decklists, set names, upgrades, combos, prices |
| `deck-sync` | daily 08:00 UTC | discovers new precons; regenerates only if the list changed |
| `card-data-snapshot` | daily 09:17 UTC | builds card JSON → publishes to `commander-codex-data` |

`refresh-data` and `deck-sync` commit here, then copy the generated JSON into
the private app repository so the app keeps bundling it exactly as before. Only
`*.json` is copied — `src/data/decks.ts` in the app repo is hand-written code (a
types wrapper around `decks.json`) and is never overwritten.

## Configuration

One secret: **`REPO_SYNC_TOKEN`** — a fine-grained personal access token with
`Contents: read and write` on both `jande425/commander-decks` and
`jande425/commander-codex-data`.

Without it the builds still run and commit here; only the sync steps skip, with
a message. GitHub does not expose secrets to workflows triggered by pull
requests from forks, so the token stays safe in a public repository.

## Running locally

```bash
node scripts/decklists.mjs
node scripts/setnames.mjs
node scripts/upgrades.mjs
node scripts/combos.mjs
node --max-old-space-size=2048 scripts/prices.mjs
```

No install step — the scripts use only Node built-ins and global `fetch`.
Downloads are cached under `.cache/`, which is gitignored.

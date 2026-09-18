# Promenade

A local-first, object-centric **process mining workbench that runs entirely in
the browser** — [app.promenade.run](https://app.promenade.run).

Event logs never leave your machine. They are stored in OPFS (the browser's
origin-private filesystem), queried in-page with DuckDB-WASM, and analysed by
plugins running in WebAssembly, Pyodide or a sandboxed iframe. There is no
backend to upload to: the deployment is static files plus a small worker that
serves the plugin registry.

## Why

Object-centric event logs (OCEL 2.0) describe processes that a single case id
cannot — an order, its items, its shipments and its payments all moving at once.
Most tooling for them is a Python notebook or a server install. Promenade is
neither: open a URL, drop in a log, and the analysis runs on your own hardware
with your data staying there.

That matters for logs you are not allowed to upload anywhere, and it makes
sharing an analysis a matter of sharing a link and a file.

## What's in the box

- **Workspaces** backed by OPFS — logs, derived artifacts and their provenance,
  persisted locally across sessions.
- **Typed artifacts.** Every result has a type (`ObjectCentricEventLog`,
  `AcceptingPetriNet`, `SocialNetwork`, …). The host only offers an action where
  the types fit, so the tool surface stays small and legal.
- **Four plugin runtimes** — Rust/WASM kernels, Pyodide (pm4py and friends),
  relational (DuckDB SQL), and sandboxed TypeScript views.
- **A Python notebook** against the same in-memory data, for anything no plugin
  covers.
- **Runtime plugin install** from a registry, with no rebuild or redeploy.

The process mining itself lives in the plugins, in a separate repository:
**[promenade-pi/plugins](https://github.com/promenade-pi/plugins)** — 52 of them
covering discovery, conformance, log quality, organisational mining and a range
of visualisations.

## Repository layout

| Path | What |
|---|---|
| `src/host/` | Artifact store, action scheduler, plugin runtimes, relational engine, notebook |
| `src/ui/` | Panels, artifact tree, dialogs (dockview-based layout) |
| `src/worker/` | Pyodide and OPFS workers — the heavy lifting off the main thread |
| `src/ingest/` | Log import — OCEL 2.0 (JSON, SQLite, CSV, Parquet), XES, PNML |
| `dev-registry/` | The plugin catalogue and built `.pmplugin` packages it serves |
| `worker-entry.ts` | The Cloudflare Worker that serves the registry from R2 |

## Local dev

```bash
npm install
npm run dev
```

`vite.config.ts`'s dev-only middleware serves `/registry/*` straight from
`dev-registry/` on disk, so plugin install/update works locally with no
further setup.

## Production deploy

`app.promenade.run` is a Cloudflare **Worker with Static Assets** (not a
Pages project — this app predates a Pages project ever being created on the
account, and was originally deployed by hand from the dashboard's quick-edit
flow before `wrangler.toml`/`worker-entry.ts` existed here). It has two jobs:

- Serve the built app (`dist/`, bound as `ASSETS`) for everything.
- Serve `/registry/index.json` and `/registry/packages/*.pmplugin` from the
  `promenade-registry` R2 bucket instead — see `worker-entry.ts`.
  `wrangler.toml`'s `run_worker_first = ["/registry/*"]` is what routes those
  paths to the worker instead of straight to the (nonexistent) static file.

Deploy:

```bash
npm run deploy
```

(Just `npm run build && wrangler deploy` — `wrangler` is a devDependency here,
same as in `worker/`, so plain `wrangler` resolves without `npx`.)

This deploys to the Worker name pinned in `wrangler.toml` (`spring-dew-fa98`)
— deploying to the *same* name is what keeps the existing `app.promenade.run`
Custom Domain route working; that route lives at the platform level against
the Worker's name, not in this config, so it's untouched by a deploy that
doesn't declare `routes`.

**One-time setup**, already done, noted here in case this ever needs
recreating: R2 bucket `promenade-registry` created and bound as
`REGISTRY_BUCKET` (see `[[r2_buckets]]` in `wrangler.toml`).

Auth: either your own `wrangler login` (needs Workers Scripts + R2 Storage
permissions on the token/session), or `CLOUDFLARE_API_TOKEN` env var with a
scoped token carrying the same.

## Updating a plugin in production

Rebuilding/redeploying the app is **not** part of this — see
[`dev-registry/README.md`](dev-registry/README.md).

## Licence

MIT — see [LICENSE](LICENSE).

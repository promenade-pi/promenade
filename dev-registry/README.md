# Plugin registry

`index.json` is the catalogue the Plugins browser reads: one entry per
plugin, each with its versions, a checksum per version, and derived metadata
(actions, artifact types produced/consumed) read out of that version's own
`.pmplugin` — see the header comment in `build-index.mjs` for exactly what's
derived vs. editorial.

`packages/` holds every built `.pmplugin` this index can point at — one file
per plugin version, named `<id>-<version>.pmplugin`. Nothing here is source;
everything is produced by a plugin's own `package.sh` (or Rust/pyodide
equivalent) under `../../plugins/<name>/`.

## Regenerating the index

After building or rebuilding any plugin(s) into `packages/`:

```bash
node build-index.mjs
```

Reads every `.pmplugin` in `packages/`, derives what it can from each one's
manifest, and writes `index.json` — preserving hand-edited/editorial fields
(see below) that don't come from a manifest. `--check` (no write, nonzero
exit if stale) is what a packaging script should use as a gate.

**Don't run this before rebuilding a plugin whose id or content just
changed** — it only knows about what's physically in `packages/`; if the
built package for a renamed/changed plugin isn't there yet, its old entry
just gets silently dropped (or reverted to whatever the stale package still
says), not updated. Build first, copy into `packages/`, *then* regenerate.

## Editorial fields

A few fields are the registry's own call, not derived from any manifest, and
survive a regen even when nothing in `packages/` declares them:

- `experimental` — shown with a badge, sorted below stable entries in Browse.
- `hidden` — withheld from Browse and from "install a viewer for this"
  suggestions entirely, for something not ready to be found (a mockup, a
  withdrawn release). Direct install-by-URL and updates for whoever already
  has it still work. Currently set on `run.promenade.synchronization-lens`
  (a UI mockup, not wired to real log data).
- `recommends`, per-version `released`/`changelog`/`channel`.

Hand-edit `index.json` directly for these, then regenerate as usual — your
edit is preserved.

## Publishing to production

Local dev serves this whole directory automatically (`vite.config.ts`'s
`devCorpora` middleware). Production (`app.promenade.run`) reads it from an
R2 bucket instead — see `../README.md`'s deploy section for why. After
regenerating the index:

```bash
./publish-to-r2.sh promenade-registry
```

Uploads `index.json` and every `packages/*.pmplugin` to the bucket. This is
the entire "deploy" step for a plugin update — no app rebuild, no
`wrangler deploy`.

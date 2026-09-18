#!/usr/bin/env node
/**
 * Regenerates `dev-registry/index.json` from the packages beside it.
 *
 * The index used to be maintained by hand, which meant two places described
 * every plugin — the manifest inside the package, and the registry entry — and
 * only one of them was ever updated. Everything a package can state about
 * itself is therefore *derived* here by reading `manifest.json` out of each
 * `.pmplugin`: name, description, keywords, authors, citation, the artifact
 * types it produces, the types its views can draw, and — new — one descriptor
 * per action, so "which package has an action that turns an OCEL into a Petri
 * net" is answerable before installing anything.
 *
 * Editorial fields stay the registry's own and are preserved as they are:
 * `experimental`, `hidden`, `recommends`, per-version `released`, `changelog`,
 * `channel`.
 *
 * A hand-written `description` or `keywords` that differs from the manifest is
 * kept and reported, not overwritten — losing prose someone wrote is worse
 * than an inconsistency the run just told you about. `--adopt-manifest-text`
 * takes the manifest's wording instead, once you have decided that is where it
 * should live.
 *
 *   node dev-registry/build-index.mjs [--adopt-manifest-text] [--check]
 *
 * `--check` writes nothing and exits non-zero if the index is out of date,
 * which is what a packaging script or CI wants.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, 'index.json');
const PACKAGES = join(HERE, 'packages');

const args = process.argv.slice(2);
const adoptText = args.includes('--adopt-manifest-text');
const checkOnly = args.includes('--check');

/** Numeric-aware, so 0.10.0 sorts above 0.9.0. */
function compareVersions(a, b) {
  const parse = (v) => String(v).replace(/^v/, '').split(/[.+-]/);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) { if (nx !== ny) return nx < ny ? -1 : 1; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function manifestOf(bytes) {
  const entries = unzipSync(bytes);
  const raw = entries['manifest.json'];
  if (!raw) throw new Error('no manifest.json at the package root');
  return JSON.parse(new TextDecoder().decode(raw));
}

/** `wasm`, `pyodide + view`, `relational + wasm` — the same shape as before. */
function runtimeLabel(m) {
  const runtimes = [...new Set((m.actions ?? []).map((a) => a.runtime ?? m.runtime).filter(Boolean))].sort();
  if ((m.views ?? []).length) {
    if (!runtimes.length) return 'view';
    return `${runtimes.join(' + ')} + view`;
  }
  return runtimes.join(' + ') || m.runtime || 'unknown';
}

function derive(m) {
  const actions = (m.actions ?? []).map((a) => {
    const d = {
      id: a.id,
      label: a.label,
      ...(a.description ? { description: a.description } : {}),
      inputs: (a.inputs ?? []).map((i) => i.type),
      outputs: (a.outputs ?? []).map((o) => o.type).filter(Boolean),
      runtime: a.runtime ?? m.runtime,
    };
    if (a.internal) d.internal = true;
    return d;
  });
  // What the package *produces*: action outputs plus any artifact type it
  // defines. A type declared but never produced is still worth advertising —
  // that is how a viewer-only package for a new type is found.
  // `internal` actions are excluded: they exist only as another action's
  // stage and cannot be run on their own, so advertising their outputs (OCIM's
  // projection emits a TraditionalEventLog) describes something nobody can ask
  // for.
  const runnable = actions.filter((a) => !a.internal);
  const provides = [...new Set([
    ...runnable.flatMap((a) => a.outputs),
    ...(m.artifactTypes ?? []).map((t) => t.id),
  ])];
  // Only views that ship their own renderer count as "can draw this".
  //
  // A `kind: "native"` view is an *alias* for a host view — every miner
  // producing an AcceptingPetriNet points at the host's Petri net renderer
  // this way. The host may have that view disabled (it currently does, in
  // favour of a plugin renderer), in which case installing the miner gives
  // you nothing to look at. Claiming otherwise sends an agent — or the
  // Inspector's "no viewer installed" suggestion — after a package that
  // cannot help. Such views still land in `consumes` below, which has always
  // been the looser union.
  const renders = [...new Set((m.views ?? [])
    .filter((v) => v.entry && v.kind !== 'native')
    .flatMap((v) => v.appliesTo ?? []))];
  const rendersViaHost = [...new Set((m.views ?? [])
    .filter((v) => !v.entry || v.kind === 'native')
    .flatMap((v) => v.appliesTo ?? []))];
  const accepts = [...new Set(runnable.flatMap((a) => a.inputs))];
  return {
    name: m.name,
    description: m.description,
    runtime: runtimeLabel(m),
    keywords: m.keywords,
    authors: m.authors ?? (m.author ? [{ name: m.author }] : undefined),
    citation: m.citation,
    homepage: m.homepage,
    provides: provides.length ? provides : undefined,
    renders: renders.length ? renders : undefined,
    accepts: accepts.length ? accepts : undefined,
    // `consumes` predates `renders`/`accepts` and is still what older
    // consumers read, so it stays — as the union the field grew to mean.
    consumes: renders.length || rendersViaHost.length || accepts.length
      ? [...new Set([...renders, ...rendersViaHost, ...accepts])]
      : undefined,
    actions: actions.length ? actions : undefined,
  };
}

const previous = JSON.parse(readFileSync(INDEX, 'utf8'));
const byId = new Map(previous.plugins.map((p) => [p.id, p]));

const packages = readdirSync(PACKAGES).filter((f) => f.endsWith('.pmplugin')).sort();
const built = new Map();
const notes = [];

for (const file of packages) {
  const bytes = readFileSync(join(PACKAGES, file));
  let m;
  try {
    m = manifestOf(new Uint8Array(bytes));
  } catch (e) {
    notes.push(`! ${file}: ${e.message}`);
    continue;
  }
  const entry = built.get(m.id) ?? { id: m.id, versions: [] };
  built.set(m.id, entry);
  const old = byId.get(m.id);
  const oldVersion = old?.versions.find((v) => v.version === m.version);

  entry.versions.push({
    version: m.version,
    url: `packages/${file}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    // Dates and changelogs are the registry's editorial record; a rebuild of
    // the same version must not silently redate it.
    ...(oldVersion?.released ? { released: oldVersion.released } : {}),
    ...(oldVersion?.changelog ? { changelog: oldVersion.changelog } : {}),
    ...(oldVersion?.channel ? { channel: oldVersion.channel } : {}),
  });
  const newest = [...entry.versions].sort((a, b) => compareVersions(b.version, a.version))[0];
  // Metadata always describes the newest package, not whichever file the
  // directory listing happened to end on.
  if (newest.version === m.version) entry.__manifest = m;
}

const plugins = [];
for (const [id, entry] of [...built.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const m = entry.__manifest;
  const old = byId.get(id) ?? {};
  const derived = derive(m);

  const keepText = (field) => {
    const mine = derived[field];
    const theirs = old[field];
    if (theirs === undefined) return mine;
    const same = JSON.stringify(theirs) === JSON.stringify(mine);
    if (same || mine === undefined) return theirs;
    if (adoptText) { notes.push(`~ ${id}: adopted manifest ${field}`); return mine; }
    notes.push(`= ${id}: kept the index's own ${field} (manifest differs)`);
    return theirs;
  };

  // Computed once: calling `keepText` twice would report the same divergence
  // twice, which reads like two separate problems.
  const keywords = keepText('keywords');

  plugins.push({
    id,
    name: derived.name,
    description: keepText('description'),
    runtime: derived.runtime,
    ...(derived.authors ? { authors: derived.authors } : {}),
    ...(derived.citation ? { citation: derived.citation } : {}),
    ...(derived.homepage ? { homepage: derived.homepage } : {}),
    ...(keywords ? { keywords } : {}),
    ...(derived.provides ? { provides: derived.provides } : {}),
    ...(derived.renders ? { renders: derived.renders } : {}),
    ...(derived.accepts ? { accepts: derived.accepts } : {}),
    ...(derived.consumes ? { consumes: derived.consumes } : {}),
    ...(derived.actions ? { actions: derived.actions } : {}),
    // Editorial, and the registry's own call:
    ...(old.recommends ? { recommends: old.recommends } : {}),
    ...(old.experimental ? { experimental: old.experimental } : {}),
    ...(old.hidden ? { hidden: old.hidden } : {}),
    versions: entry.versions.sort((a, b) => compareVersions(a.version, b.version)),
  });
}

for (const p of previous.plugins) {
  if (!built.has(p.id)) notes.push(`- ${p.id}: no package in packages/, dropped from the index`);
}

const next = { registryVersion: 1, name: previous.name, plugins };
const text = `${JSON.stringify(next, null, 2)}\n`;
const unchanged = text === readFileSync(INDEX, 'utf8');

for (const note of notes) console.log(note);

if (checkOnly) {
  console.log(unchanged ? 'index.json is up to date' : 'index.json is OUT OF DATE — run build-index.mjs');
  process.exit(unchanged ? 0 : 1);
}

writeFileSync(INDEX, text);
console.log(
  `${unchanged ? 'index.json unchanged' : 'wrote index.json'}: `
  + `${plugins.length} plugins, ${packages.length} packages, `
  + `${plugins.reduce((n, p) => n + (p.actions?.length ?? 0), 0)} action descriptors`,
);

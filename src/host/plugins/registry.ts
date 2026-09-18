import { installPackage, listInstalled, previewPackage, type InstallResult, type PreviewResult } from './store';

/**
 * Plugin registry client.
 *
 * A registry is a plain JSON index at a URL. Several can be configured — a
 * lab's own alongside a community one — because a research group publishing
 * internally should not have to push to a central place first.
 *
 * Fetching a package over the network is the point at which integrity stops
 * being optional: until now packages came from a file the user picked. Every
 * entry therefore carries a SHA-256, verified after download and before a
 * single byte is written.
 */

export interface RegistryVersion {
  version: string;
  /** Relative to the index URL, or absolute. */
  url: string;
  /** Lowercase hex SHA-256 of the package bytes. Mandatory. */
  sha256: string;
  bytes?: number;
  released?: string;
  /** Host versions this build is known to work with. Advisory. */
  requiresHost?: string;
  /**
   * One line: what changed in this version, shown right next to the update
   * button so "what do I get" doesn't require opening the plugin's own
   * detail panel first. The full history lives in the package's own
   * CHANGELOG.md (if it ships one) — this is the one-line version of that.
   */
  changelog?: string;
}

/**
 * One action, as the registry describes it.
 *
 * Generated from the package's own manifest (see `dev-registry/build-index.mjs`),
 * not hand-written: the point is that "which package has an action that turns an
 * OCEL into a Petri net" is answerable *before* installing anything. Without
 * this, entry-level `provides`/`consumes` was the finest granularity available,
 * so a package's five actions were indistinguishable from outside.
 */
export interface RegistryActionDescriptor {
  id: string;
  label: string;
  /** The action author's own sentence, capped at install-time limits. */
  description?: string;
  /** Artifact types the action takes, in slot order. */
  inputs?: string[];
  /** Artifact types it produces. */
  outputs?: string[];
  runtime?: string;
  /** Not user-runnable on its own; reachable only as another action's stage. */
  internal?: boolean;
}

export interface RegistryEntry {
  id: string;
  name: string;
  description?: string;
  runtime?: 'wasm' | 'pyodide';
  authors?: Array<{ name: string; affiliation?: string }>;
  keywords?: string[];
  homepage?: string;
  /** Artifact types this package produces. Advisory, for discovery. */
  provides?: string[];
  /**
   * Artifact types this package can render.
   *
   * This is the field that lets the host answer "I have a Process Tree and
   * nothing can draw it" without either plugin knowing about the other. The
   * producer declares an output type, the viewer declares a consumed type, and
   * the registry is where the two meet — not a dependency between them.
   */
  consumes?: string[];
  /**
   * Artifact types this package's *views* can draw.
   *
   * Narrower and more precise than `consumes`, which grew to mean "anything
   * this package has an opinion about" — including action inputs, which are
   * not the same claim at all. A miner taking an OCEL is not a viewer for one.
   * Hand-written entries have no `renders`, so consumers fall back to
   * `consumes` (see `viewersFor`).
   */
  renders?: string[];
  /** Artifact types this package's actions take as input. */
  accepts?: string[];
  /** Per-action detail, so an agent can match intent before installing. */
  actions?: RegistryActionDescriptor[];
  recommends?: Array<{ id: string; reason?: string }>;
  /**
   * Marks a package that works but whose interface or output is still in
   * flux — safe to try, not yet safe to build on. The browser shows an
   * "experimental" badge and sorts these below the stable entries, so the
   * default reading order is the one a new user should follow.
   */
  experimental?: boolean;
  /**
   * Withheld from browsing and suggestion entirely — not even with an
   * "experimental" badge. For a package that isn't ready to be found by
   * anyone not already pointed at it (a mockup, a withdrawn release): direct
   * install-by-URL and updates for whoever already has it still work, same
   * as `experimental`; this only removes it from the catalog a new user
   * would ever see.
   */
  hidden?: boolean;
  versions: RegistryVersion[];
}

export interface RegistryIndex {
  registryVersion: 1;
  name: string;
  plugins: RegistryEntry[];
  /** Where the index came from; used to resolve relative package URLs. */
  sourceUrl: string;
}

/**
 * Compares two dotted versions.
 *
 * Numeric-aware, so 0.10.0 sorts above 0.9.0 — a string compare would get that
 * backwards and silently offer a downgrade as an update.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.+-]/);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x), ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      // A pre-release tag sorts below the plain version.
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Newest version in an entry, by comparison rather than by list order. */
export function latestOf(entry: RegistryEntry): RegistryVersion | undefined {
  return [...entry.versions].sort((a, b) => compareVersions(b.version, a.version))[0];
}

/**
 * Registry entries offering a viewer for an artifact type.
 *
 * Deliberately keyed on the *type*, not on which plugin produced the artifact.
 * A second miner producing the same type gets the same suggestion for free,
 * and a second viewer competes with the first on equal terms.
 */
export function viewersFor(
  index: RegistryIndex | null, type: string, installedIds: Set<string>
): RegistryEntry[] {
  if (!index) return [];
  return index.plugins.filter((p) => !installedIds.has(p.id) && !p.hidden
    // `renders` is derived from the views themselves and is the exact claim;
    // `consumes` is the older, looser field and remains the fallback for an
    // entry written before the index was generated.
    && (p.renders ?? p.consumes ?? []).includes(type));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function fetchRegistry(url: string): Promise<RegistryIndex> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`registry ${url}: ${res.status}`);
  const idx = await res.json();
  if (idx.registryVersion !== 1) {
    throw new Error(`unsupported registryVersion: ${idx.registryVersion}`);
  }
  // Absolute from here on: package URLs are resolved against this, and a
  // relative base is not a valid base for URL resolution.
  return { ...idx, sourceUrl: new URL(url, location.href).toString() };
}

/**
 * Downloads a package and verifies it before installing.
 *
 * The hash is checked against the index, not against the package — a package
 * that carried its own checksum would be attesting to itself. A mismatch aborts
 * without writing anything.
 */
export async function installFromRegistry(
  index: RegistryIndex,
  entry: RegistryEntry,
  version: RegistryVersion,
  onProgress?: (msg: string) => void
): Promise<InstallResult> {
  const url = new URL(version.url, index.sourceUrl).toString();
  onProgress?.(`downloading ${entry.name} ${version.version}`);

  let bytes: Uint8Array;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e: any) {
    return { ok: false, errors: [`download failed: ${e.message}`] };
  }

  onProgress?.('verifying checksum');
  const actual = await sha256Hex(bytes);
  if (!version.sha256) {
    return { ok: false, errors: ['registry entry has no sha256; refusing to install'] };
  }
  if (actual !== version.sha256.toLowerCase()) {
    return {
      ok: false,
      errors: [
        `checksum mismatch — the package does not match what the registry ` +
        `describes. Expected ${version.sha256.slice(0, 16)}…, got ${actual.slice(0, 16)}…`,
      ],
    };
  }

  onProgress?.('installing');
  const result = await installPackage(bytes, {
    kind: 'registry',
    name: index.name,
    url: index.sourceUrl,
  });
  if (result.ok && result.plugin) {
    // The manifest is the authority on its own id and version; a registry that
    // disagrees is describing something other than what it served.
    const m = result.plugin.manifest;
    if (m.id !== entry.id || m.version !== version.version) {
      return {
        ok: false,
        errors: [
          `registry describes ${entry.id}@${version.version}, ` +
          `package declares ${m.id}@${m.version}`,
        ],
      };
    }
  }
  return result;
}

/**
 * Downloads a package straight from an arbitrary URL — a GitHub release
 * asset, say — with no registry index behind it and therefore no expected
 * checksum to verify against. Same trust level as a local file the user
 * picked themselves: the browser fetched it, but nothing here vouches for
 * its contents beyond that.
 */
export async function installFromUrl(url: string, onProgress?: (msg: string) => void): Promise<InstallResult> {
  onProgress?.(`downloading ${url}`);
  let bytes: Uint8Array;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e: any) {
    return { ok: false, errors: [`download failed: ${e.message}`] };
  }
  onProgress?.('installing');
  return installPackage(bytes, { kind: 'url', url });
}

export interface RegistryPreview extends PreviewResult {
  bytes?: number;
}

/**
 * Downloads and unpacks a registry package without installing it.
 *
 * Selecting an entry that is not installed yet should not read as "nothing to
 * show" — the package's own README and metadata are right there in the
 * registry, one download away. This does the same fetch-and-verify as
 * `installFromRegistry`, but stops short of writing anything to OPFS or
 * registering anything with the host, so it is safe to call just from
 * clicking around the browse list.
 */
export async function previewFromRegistry(
  index: RegistryIndex,
  entry: RegistryEntry,
  version: RegistryVersion
): Promise<RegistryPreview> {
  const url = new URL(version.url, index.sourceUrl).toString();

  let bytes: Uint8Array;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e: any) {
    return { ok: false, errors: [`download failed: ${e.message}`] };
  }

  if (!version.sha256) {
    return { ok: false, errors: ['registry entry has no sha256; refusing to preview'] };
  }
  const actual = await sha256Hex(bytes);
  if (actual !== version.sha256.toLowerCase()) {
    return {
      ok: false,
      errors: [
        `checksum mismatch — the package does not match what the registry ` +
        `describes. Expected ${version.sha256.slice(0, 16)}…, got ${actual.slice(0, 16)}…`,
      ],
    };
  }

  const preview = previewPackage(bytes);
  return { ...preview, bytes: bytes.byteLength };
}

export interface UpdateCandidate {
  installedVersion: string;
  entry: RegistryEntry;
  version: RegistryVersion;
  index: RegistryIndex;
}

/** Installed plugins for which a registry offers something strictly newer. */
export async function findUpdates(indexes: RegistryIndex[]): Promise<UpdateCandidate[]> {
  const installed = await listInstalled();
  const out: UpdateCandidate[] = [];
  for (const p of installed) {
    for (const index of indexes) {
      const entry = index.plugins.find((e) => e.id === p.manifest.id);
      const latest = entry ? latestOf(entry) : undefined;
      if (!entry || !latest) continue;
      if (compareVersions(latest.version, p.manifest.version) > 0) {
        out.push({
          installedVersion: p.manifest.version,
          entry, version: latest, index,
        });
      }
    }
  }
  return out;
}

/** Registries the workspace consults. Persisted with the plugin index. */
const DEFAULT_REGISTRIES = ['/registry/index.json'];

export function configuredRegistries(): string[] {
  try {
    const raw = localStorage.getItem('promenade.registries');
    if (raw) return JSON.parse(raw);
  } catch {}
  return DEFAULT_REGISTRIES;
}

export function setRegistries(urls: string[]) {
  try { localStorage.setItem('promenade.registries', JSON.stringify(urls)); } catch {}
}

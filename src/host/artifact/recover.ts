/**
 * Rebuilding a catalog entry from what is left on disk.
 *
 * The catalog is one file describing every artifact, which makes losing it
 * a way to lose everything at once: the Parquet stays exactly where it was,
 * but nothing knows its name, its type or where it came from, and the Storage
 * panel calls the directory an orphan and offers to delete it.
 *
 * Recovery has three sources, in descending order of fidelity:
 *
 *   1. the artifact's own `artifact.json` sidecar — a complete entry, written
 *      beside the data it describes (see `data/opfs.ts`);
 *   2. a saved view's title, which is the artifact's name at the time it was
 *      opened — no structure, but the right label;
 *   3. the Parquet files themselves, which is what this module reads.
 *
 * Only (3) needs a rule, and this is it. It is deliberately conservative: a
 * directory it cannot identify is reported as unreadable rather than guessed
 * into the catalog under a wrong type, because a mislabelled artifact fails
 * later, further from the cause, and looks like a different bug.
 */
import type { Artifact } from './types';

/** The relation set an object-centric log has and a traditional one does not. */
const OCEL_MARKERS = ['object', 'e2o', 'o2o', 'object_attr'];
/** The relation a traditional (case-centric) log always has. */
const TRADITIONAL_MARKER = 'trace';

export interface RecoveredDirectory {
  id: string;
  /** File names directly inside the artifact's directory. */
  files: string[];
  bytes: number;
}

export function parquetTables(files: string[]): string[] {
  return files
    .filter((f) => f.endsWith('.parquet'))
    .map((f) => f.slice(0, -'.parquet'.length))
    .sort();
}

/**
 * The log kind a relation set implies, or `null` when it implies none.
 *
 * Object-centric markers win over the traditional one: a log carrying both
 * `object` and `trace` is not a traditional log that happens to mention
 * objects, it is an object-centric log whose events were also grouped into
 * cases, and reading it as traditional would silently drop the objects.
 */
export function inferLogType(tables: string[]): Artifact['type'] | null {
  const present = new Set(tables);
  if (OCEL_MARKERS.some((t) => present.has(t))) return 'ObjectCentricEventLog';
  if (present.has(TRADITIONAL_MARKER)) return 'TraditionalEventLog';
  return null;
}

/**
 * A catalog entry for a directory with no sidecar, or `null` if its files
 * do not identify one.
 *
 * `meta.recovered` is set so nothing downstream mistakes this for an entry
 * that survived intact: its provenance is genuinely gone, and its `meta` holds
 * only what can be measured again from the files.
 */
export function reconstructArtifact(
  dir: RecoveredDirectory,
  options: { name?: string; artifactsDir: string; now?: string } = { artifactsDir: 'artifacts' }
): Artifact | null {
  const tables = parquetTables(dir.files);
  if (!tables.length) return null;
  const type = inferLogType(tables);
  if (!type) return null;

  const files: Record<string, string> = {};
  for (const t of tables) files[t] = `${options.artifactsDir}/${dir.id}/${t}.parquet`;

  return {
    id: dir.id,
    name: options.name ?? `Recovered log (${dir.id.slice(0, 12)})`,
    type,
    createdAt: options.now ?? new Date().toISOString(),
    storage: { kind: 'parquet', files },
    meta: {
      recovered: true,
      recoveredFrom: options.name ? 'files + saved view' : 'files',
      parquetBytes: dir.bytes,
    },
    producedBy: null,
    inputs: [],
  };
}

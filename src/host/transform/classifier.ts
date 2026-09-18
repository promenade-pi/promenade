/**
 * Event classifiers.
 *
 * XES has classifiers; CSV does not; OCEL calls the field `activity`. The
 * concept is useful for all three, so it is lifted out of XES semantics and
 * made a property of the generic log model: a classifier says which parts of
 * an event make up the label an algorithm treats as "the activity".
 *
 * The decisive design choice is *where* it applies. A `{activity}` placeholder
 * in plugin SQL would mean every plugin has to remember to use it, and the ones
 * that forget silently ignore the user's choice. Instead the classifier
 * **defines the `activity` column of the log's event view**. Nothing downstream
 * changes: the Rust kernel, the pm4py plugin, the tables and the sandboxed
 * views all keep reading `activity`, and they all see the classifier the user
 * picked. Changing it recreates one view.
 *
 * That also makes it free. The classified view is a view over the Parquet view;
 * no data is copied, and a derived log inherits it because its plan already
 * reads the parent's `event` table.
 */

export type ClassifierPart =
  /** A column of the event table. */
  | 'activity' | 'lifecycle' | 'resource'
  /** `attr:<key>` — an event attribute, resolved by a join. */
  | string;

export interface Classifier {
  parts: ClassifierPart[];
  /** XES convention: parts joined with "+". */
  separator?: string;
}

export const DEFAULT_CLASSIFIER: Classifier = { parts: ['activity'] };

const COLUMNS = new Set(['activity', 'lifecycle', 'resource']);

function lit(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Whether this classifier is the identity, i.e. plain `activity`. */
export function isDefaultClassifier(c: Classifier | undefined | null): boolean {
  return !c || (c.parts.length === 1 && c.parts[0] === 'activity');
}

export function describeClassifier(c: Classifier | undefined | null): string {
  if (!c?.parts?.length) return 'activity';
  return c.parts.map((p) => (p.startsWith('attr:') ? p.slice(5) : p)).join(' + ');
}

/**
 * Builds the classified event view over a source relation.
 *
 * Attribute parts each add a LEFT JOIN — left, not inner, because an event
 * missing the attribute must keep its row: dropping it would silently shrink
 * the log as a side effect of a labeling choice.
 */
export function classifierSql(
  srcEvent: string, srcEventAttr: string | null, c: Classifier | undefined | null
): string {
  if (isDefaultClassifier(c)) return `SELECT * FROM ${srcEvent}`;

  const sep = c!.separator ?? '+';
  const joins: string[] = [];
  const exprs: string[] = [];

  c!.parts.forEach((part, i) => {
    if (COLUMNS.has(part)) {
      exprs.push(`e.${part}`);
      return;
    }
    if (part.startsWith('attr:') && srcEventAttr) {
      const alias = `a${i}`;
      joins.push(
        `LEFT JOIN ${srcEventAttr} ${alias} ` +
        `ON ${alias}.event_idx = e.event_idx AND ${alias}.key = ${lit(part.slice(5))}`
      );
      exprs.push(`${alias}.value`);
    }
  });

  if (exprs.length === 0) return `SELECT * FROM ${srcEvent}`;

  // `concat_ws` skips NULLs rather than making the whole label NULL, so an
  // event missing one part is still labeled by the parts it has.
  const label = exprs.length === 1 ? exprs[0] : `concat_ws(${lit(sep)}, ${exprs.join(', ')})`;
  return `SELECT e.* REPLACE (${label} AS activity) FROM ${srcEvent} e ${joins.join(' ')}`;
}

/** Parts a log can actually offer, from its observed capabilities. */
export function availableParts(capabilities: readonly string[] = []): ClassifierPart[] {
  const out: ClassifierPart[] = ['activity'];
  if (capabilities.includes('event.lifecycle')) out.push('lifecycle');
  if (capabilities.includes('event.resource')) out.push('resource');
  return out;
}

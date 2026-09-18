import { isComplete, type TransformOp, type ValueScope } from './types.ts';

/**
 * Compiles a transform plan into DuckDB views.
 *
 * A derived log is not a copy. The artifact tables of an imported log are
 * already views over Parquet (`CREATE VIEW … AS SELECT * FROM read_parquet(…)`),
 * so a transformed log is one more view in the same chain — which is why every
 * existing view, plugin and Python script works on it unchanged: they all
 * resolve a table name and go through `host.sql()`.
 *
 * Each operation gets its own named stage view rather than being nested into
 * one string. Nesting would duplicate the event relation on every cascading
 * filter and the SQL would grow faster than the plan; DuckDB flattens views
 * during planning anyway, so the stages cost nothing at query time.
 */

const LOGICAL = ['event', 'event_attr', 'trace', 'trace_attr'] as const;
type Logical = string;

/** Single-quote escaping. All values here come from the parameter form. */
function lit(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

export interface CompiledPlan {
  statements: string[];
  /** Logical table name -> the view a consumer should query. */
  tables: Record<string, string>;
}

export function compilePlan(
  targetId: string,
  parentTables: Record<string, string>,
  ops: TransformOp[]
): CompiledPlan {
  // Keep disabled operations in the saved definition so they can be switched
  // back on without rebuilding their parameters, but omit them completely
  // from execution (including their position in a flattened plan).
  const activeOps = ops.filter((op) => !op.disabled);
  const safe = targetId.replace(/[^a-zA-Z0-9_]/g, '_');
  const statements: string[] = [];
  let stage = 0;

  /**
   * A leading flatten changes what the plan is reading.
   *
   * Every other operation maps traditional relations to traditional relations;
   * this one maps object-centric relations to traditional ones, so it has to
   * run before `present` and `rel` are decided rather than as a step inside
   * the loop.
   */
  const head = activeOps[0]?.kind === 'flattenByObjectType'
    ? (activeOps[0] as Extract<TransformOp, { kind: 'flattenByObjectType' }>)
    : null;
  /**
   * A flatten with no object type yet still takes the flatten path.
   *
   * Skipping it the way an unfinished filter is skipped would leave the plan
   * reading the object-centric relations while the artifact claims to be a
   * traditional log — an `event` table with `event_id` where every consumer
   * expects `event_idx`. An empty log of the right shape is the honest
   * intermediate state.
   */
  const flatten = head;
  const flattenReady = !!head && isComplete(head);
  const sourceIsOcel = !!parentTables.object || !!parentTables.e2o;

  if (flatten && (!parentTables.event || !parentTables.object || !parentTables.e2o)) {
    throw new Error('Flatten by object type requires an object-centric source log');
  }

  let present: Logical[];
  let rel: Record<string, string> = {};

  if (flatten) {
    present = [...LOGICAL];
    const t = `${safe}__flat`;
    const otype = lit(flatten.objectType);

    // One case per object of the chosen type. `WHERE false` while no type is
    // chosen: the schema is right, the log is empty, and the editor says why.
    statements.push(
      `CREATE OR REPLACE VIEW ${t}__trace AS ` +
      `SELECT row_number() OVER (ORDER BY object_id) - 1 AS trace_idx, object_id AS case_id ` +
      `FROM ${parentTables.object} WHERE ` +
      (flattenReady ? `object_type = ${otype}` : 'false')
    );

    /**
     * Each (event, related object of the type) pair becomes one event.
     *
     * This is where flattening loses information, and it does so in both
     * directions at once: an event related to two objects of the type appears
     * twice, and an event related to none disappears. `src_event_id` is kept so
     * the duplication stays traceable back to the object-centric log rather
     * than becoming anonymous.
     */
    statements.push(
      `CREATE OR REPLACE VIEW ${t}__event AS ` +
      `SELECT row_number() OVER (ORDER BY tr.trace_idx, e.ts, e.event_id) - 1 AS event_idx, ` +
      `tr.trace_idx, e.activity, e.ts, ` +
      `CAST(NULL AS VARCHAR) AS lifecycle, CAST(NULL AS VARCHAR) AS resource, ` +
      `e.event_id AS src_event_id ` +
      `FROM ${parentTables.e2o} r ` +
      `JOIN ${t}__trace tr ON tr.case_id = r.object_id ` +
      `JOIN ${parentTables.event} e ON e.event_id = r.event_id`
    );

    statements.push(
      `CREATE OR REPLACE VIEW ${t}__event_attr AS ` +
      (parentTables.event_attr
        ? `SELECT ev.event_idx, ea.name AS key, 'string' AS type, ea.value ` +
          `FROM ${t}__event ev JOIN ${parentTables.event_attr} ea ` +
          `ON ea.event_id = ev.src_event_id`
        : `SELECT CAST(NULL AS BIGINT) AS event_idx, CAST(NULL AS VARCHAR) AS key, ` +
          `CAST(NULL AS VARCHAR) AS type, CAST(NULL AS VARCHAR) AS value WHERE false`)
    );

    // Object attributes become case attributes. Time-dependent ones collapse to
    // their latest value: a case attribute has no time axis to put them on, and
    // silently keeping an arbitrary one would be worse than keeping the newest.
    statements.push(
      `CREATE OR REPLACE VIEW ${t}__trace_attr AS ` +
      (parentTables.object_attr
        ? `SELECT tr.trace_idx, oa.name AS key, 'string' AS type, oa.value ` +
          `FROM ${parentTables.object_attr} oa ` +
          `JOIN ${t}__trace tr ON tr.case_id = oa.object_id ` +
          `QUALIFY row_number() OVER (` +
          `PARTITION BY oa.object_id, oa.name ORDER BY oa.ts DESC NULLS LAST) = 1`
        : `SELECT CAST(NULL AS BIGINT) AS trace_idx, CAST(NULL AS VARCHAR) AS key, ` +
          `CAST(NULL AS VARCHAR) AS type, CAST(NULL AS VARCHAR) AS value WHERE false`)
    );

    rel = {
      event: `${t}__event`,
      event_attr: `${t}__event_attr`,
      trace: `${t}__trace`,
      trace_attr: `${t}__trace_attr`,
    };
  } else {
    // An identity transform must republish every relation its source exposes.
    // Restricting this to the four case-centric tables left an OCEL-derived
    // artifact advertising `object`/`e2o` views that were never created.
    present = Object.keys(parentTables);
    for (const l of present) rel[l] = parentTables[l];
  }

  const isOcelPlan = sourceIsOcel && !flatten;

  /** Publishes the given expressions as the next stage and moves `rel` on. */
  const emit = (exprs: Partial<Record<Logical, string>>) => {
    const next: Record<string, string> = { ...rel };
    for (const l of present) {
      const body = exprs[l];
      if (!body) continue;
      const name = `${safe}__s${stage}__${l}`;
      statements.push(`CREATE OR REPLACE VIEW ${name} AS ${body}`);
      next[l] = name;
    }
    stage++;
    rel = next;
  };

  /**
   * Cascades an event-level filter to the dependent relations.
   *
   * Dropping events must drop their attributes, and a case that has lost every
   * event is no longer a case — leaving it behind would make the trace count
   * describe a log that no longer exists.
   */
  const cascadeFromEvents = (eventExpr: string) => {
    emit({ event: eventExpr });
    const e = rel.event;

    if (isOcelPlan) {
      // Event filters remove relationships and attributes of removed events,
      // but deliberately retain objects and their O2O/attribute relations.
      // Dropping now-unrelated objects would require an explicit orphan policy.
      emit({
        ...(rel.event_attr
          ? { event_attr: `SELECT * FROM ${rel.event_attr} WHERE event_id IN (SELECT event_id FROM ${e})` }
          : {}),
        ...(rel.e2o
          ? { e2o: `SELECT * FROM ${rel.e2o} WHERE event_id IN (SELECT event_id FROM ${e})` }
          : {}),
      });
      return;
    }

    emit({
      ...(rel.event_attr
        ? { event_attr: `SELECT * FROM ${rel.event_attr} WHERE event_idx IN (SELECT event_idx FROM ${e})` }
        : {}),
      ...(rel.trace
        ? { trace: `SELECT * FROM ${rel.trace} WHERE trace_idx IN (SELECT DISTINCT trace_idx FROM ${e})` }
        : {}),
      ...(rel.trace_attr
        ? { trace_attr: `SELECT * FROM ${rel.trace_attr} WHERE trace_idx IN (SELECT DISTINCT trace_idx FROM ${e})` }
        : {}),
    });
  };

  /**
   * Cascades an object-level filter through the OCEL graph.
   *
   * Keeping an object type or an object-attribute value is not merely a
   * cosmetic object-table filter: E2O/O2O references to removed objects must
   * go too, and events with no surviving object relationship are removed as
   * well.  The result is a self-contained OCEL subset rather than a log full
   * of dangling identifiers.
   */
  const pruneObjectDependents = () => {
    const o = rel.object;
    emit({
      ...(rel.object_attr
        ? { object_attr: `SELECT * FROM ${rel.object_attr} WHERE object_id IN (SELECT object_id FROM ${o})` }
        : {}),
      ...(rel.e2o
        ? { e2o: `SELECT * FROM ${rel.e2o} WHERE object_id IN (SELECT object_id FROM ${o})` }
        : {}),
      ...(rel.o2o
        ? { o2o: `SELECT * FROM ${rel.o2o} WHERE source_id IN (SELECT object_id FROM ${o}) AND target_id IN (SELECT object_id FROM ${o})` }
        : {}),
    });
  };

  const cascadeFromObjects = (objectExpr: string) => {
    if (!isOcelPlan) throw new Error('Object filters require an object-centric log');
    emit({ object: objectExpr });
    pruneObjectDependents();
    if (rel.e2o) {
      cascadeFromEvents(`SELECT * FROM ${rel.event} WHERE event_id IN (SELECT DISTINCT event_id FROM ${rel.e2o})`);
    }
  };

  /**
   * Resolves a `ValueScope` to the long-format table it rewrites.
   *
   * The three attribute scopes differ only in table and key-column name, so
   * every value repair below is written once against this.
   */
  const valueTable = (scope: ValueScope): { logical: Logical; table: string; key: string } => {
    if (scope === 'objectAttribute') {
      if (!isOcelPlan || !rel.object_attr) throw new Error('This log has no object-attribute relation');
      return { logical: 'object_attr', table: rel.object_attr, key: 'name' };
    }
    if (scope === 'caseAttribute') {
      if (isOcelPlan || !rel.trace_attr) throw new Error('This log has no case-attribute relation');
      return { logical: 'trace_attr', table: rel.trace_attr, key: 'key' };
    }
    if (!rel.event_attr) throw new Error('This log has no event-attribute relation');
    return { logical: 'event_attr', table: rel.event_attr, key: isOcelPlan ? 'name' : 'key' };
  };

  /** The relation tables a `qualifier`-scoped repair touches, when present. */
  const qualifierTables = (): Logical[] =>
    (['e2o', 'o2o'] as const).filter((l) => !!rel[l]);

  /** A stage-scoped name for a helper view that `emit` does not publish. */
  const helper = (name: string) => `${safe}__s${stage}__${name}`;

  const activityFrequencyPredicate = (table: string, column: string, min: number, max: number) =>
    `${column} IN (SELECT value FROM (` +
    `SELECT ${column} AS value, COUNT(*) AS n FROM ${table} GROUP BY 1` +
    `) frequencies WHERE n * 100.0 / NULLIF(MAX(n) OVER (), 0) BETWEEN ${Math.max(0, min)} AND ${Math.min(100, max)})`;

  const attributePredicate = (
    table: string, keyColumn: string, idColumn: string,
    op: Extract<TransformOp, { kind: 'filterEventAttribute' | 'filterObjectAttribute' }>,
  ) => {
    const parts = [`${keyColumn} = ${lit(op.key)}`];
    if (op.mode === 'equals') parts.push(`value = ${lit(op.value)}`);
    else if (op.mode === 'contains') parts.push(`value ILIKE ${lit('%' + op.value + '%')}`);
    else if (op.mode === 'numberRange') {
      if (op.min != null) parts.push(`TRY_CAST(value AS DOUBLE) >= ${Number(op.min)}`);
      if (op.max != null) parts.push(`TRY_CAST(value AS DOUBLE) <= ${Number(op.max)}`);
    }
    return `SELECT DISTINCT ${idColumn} FROM ${table} WHERE ${parts.join(' AND ')}`;
  };

  /** Restricts every relation to a set of cases. */
  const keepTraces = (keptSql: string) => {
    const kept = `${safe}__s${stage}__kept`;
    statements.push(`CREATE OR REPLACE VIEW ${kept} AS ${keptSql}`);
    emit({
      event: `SELECT * FROM ${rel.event} WHERE trace_idx IN (SELECT trace_idx FROM ${kept})`,
      trace: `SELECT * FROM ${rel.trace} WHERE trace_idx IN (SELECT trace_idx FROM ${kept})`,
      trace_attr: `SELECT * FROM ${rel.trace_attr} WHERE trace_idx IN (SELECT trace_idx FROM ${kept})`,
    });
    emit({
      event_attr:
        `SELECT * FROM ${rel.event_attr} WHERE event_idx IN (SELECT event_idx FROM ${rel.event})`,
    });
  };

  for (const op of activeOps) {
    // An operation still being typed in must not act. See `isComplete`.
    if (!isComplete(op)) continue;
    // Already applied above; it is a property of the plan's head, not a step.
    if (op.kind === 'flattenByObjectType') continue;

    switch (op.kind) {
      case 'renameActivity':
        // `* REPLACE` keeps the operation independent of the column list, so a
        // later ingest change does not silently drop columns here.
        // New renames deliberately become a no-op if the target label already
        // exists. Relabelling two categories into one is a separate, explicit
        // merge operation; older saved plans retain their historic behavior.
        emit({
          event:
            `SELECT * REPLACE (CASE WHEN activity = ${lit(op.from)}` +
            (op.allowMerge === false ? ` AND NOT EXISTS (SELECT 1 FROM ${rel.event} rename_target WHERE rename_target.activity = ${lit(op.to)})` : '') +
            ` THEN ${lit(op.to)} ` +
            `ELSE activity END AS activity) FROM ${rel.event}`,
        });
        break;

      case 'renameObjectType':
        if (!isOcelPlan) throw new Error('Object-type renames require an object-centric log');
        emit({
          object:
            `SELECT * REPLACE (CASE WHEN object_type = ${lit(op.from)}` +
            (op.allowMerge === false ? ` AND NOT EXISTS (SELECT 1 FROM ${rel.object} rename_target WHERE rename_target.object_type = ${lit(op.to)})` : '') +
            ` THEN ${lit(op.to)} ` +
            `ELSE object_type END AS object_type) FROM ${rel.object}`,
        });
        break;

      case 'mergeActivities': {
        const sources = op.sources.map(lit).join(', ');
        emit({
          event: `SELECT * REPLACE (CASE WHEN activity IN (${sources}) THEN ${lit(op.target)} ` +
            `ELSE activity END AS activity) FROM ${rel.event}`,
        });
        break;
      }

      case 'splitObjectType': {
        if (!isOcelPlan) throw new Error('Splitting an object type requires an object-centric log');
        const rules = op.rules.filter((r) => r.value && r.target);
        if (op.field && !rel.object_attr) throw new Error('This log has no object-attribute relation');
        // The matched field is resolved once per object into `__split_match`
        // rather than as a correlated subquery per WHEN branch, so the rule
        // count does not multiply the number of attribute lookups.
        const scoped = op.field
          ? `SELECT o.*, attr.value AS __split_match FROM ${rel.object} o ` +
            `LEFT JOIN (SELECT object_id, value FROM ${rel.object_attr} WHERE name = ${lit(op.field)} ` +
            `QUALIFY row_number() OVER (PARTITION BY object_id ORDER BY ts DESC NULLS LAST) = 1) attr ` +
            `ON attr.object_id = o.object_id`
          : `SELECT o.*, o.object_id AS __split_match FROM ${rel.object} o`;
        // First rule to match wins; an object matching none keeps `source`.
        // Everything outside `source` passes through unchanged.
        const whenClauses = rules.map((r) => {
          const cond = r.mode === 'equals' ? `__split_match = ${lit(r.value)}`
            : r.mode === 'regex' ? `regexp_matches(__split_match, ${lit(r.value)})`
            : `contains(__split_match, ${lit(r.value)})`;
          return `WHEN ${cond} THEN ${lit(r.target)}`;
        }).join(' ');
        emit({
          object: `SELECT * EXCLUDE (__split_match) REPLACE (` +
            `CASE WHEN object_type = ${lit(op.source)} THEN (CASE ${whenClauses} ELSE object_type END) ` +
            `ELSE object_type END AS object_type) FROM (${scoped}) matched`,
        });
        break;
      }

      case 'mergeObjectTypes': {
        if (!isOcelPlan) throw new Error('Object-type merges require an object-centric log');
        const sources = op.sources.map(lit).join(', ');
        emit({
          object: `SELECT * REPLACE (CASE WHEN object_type IN (${sources}) THEN ${lit(op.target)} ` +
            `ELSE object_type END AS object_type) FROM ${rel.object}`,
        });
        break;
      }

      case 'filterEvents': {
        if (isOcelPlan && op.column !== 'activity') {
          throw new Error(`OCEL event filters do not have a "${op.column}" column`);
        }
        const col = op.column;
        const pred =
          op.op === 'is' ? `${col} = ${lit(op.value)}`
            : op.op === 'isNot' ? `(${col} IS DISTINCT FROM ${lit(op.value)})`
            : `${col} ILIKE ${lit('%' + op.value + '%')}`;
        cascadeFromEvents(`SELECT * FROM ${rel.event} WHERE ${pred}`);
        break;
      }

      case 'filterActivities': {
        const predicates: string[] = [];
        if (op.minFrequency > 0 || op.maxFrequency < 100) {
          predicates.push(activityFrequencyPredicate(rel.event, 'activity', op.minFrequency, op.maxFrequency));
        }
        if (op.values.length) {
          const values = op.values.map(lit).join(', ');
          predicates.push(op.mode === 'include' ? `activity IN (${values})` : `activity NOT IN (${values})`);
        }
        cascadeFromEvents(`SELECT * FROM ${rel.event} WHERE ${predicates.join(' AND ')}`);
        break;
      }

      case 'filterObjectTypes': {
        if (!isOcelPlan) throw new Error('Object-type filters require an object-centric log');
        const predicates: string[] = [];
        if (op.minFrequency > 0 || op.maxFrequency < 100) {
          predicates.push(activityFrequencyPredicate(rel.object, 'object_type', op.minFrequency, op.maxFrequency));
        }
        if (op.values.length) {
          const values = op.values.map(lit).join(', ');
          predicates.push(op.mode === 'include' ? `object_type IN (${values})` : `object_type NOT IN (${values})`);
        }
        cascadeFromObjects(`SELECT * FROM ${rel.object} WHERE ${predicates.join(' AND ')}`);
        break;
      }

      case 'filterEventAttribute': {
        const keyColumn = isOcelPlan ? 'name' : 'key';
        const idColumn = isOcelPlan ? 'event_id' : 'event_idx';
        if (!rel.event_attr) throw new Error('This log has no event-attribute relation');
        const hits = attributePredicate(rel.event_attr, keyColumn, idColumn, op);
        cascadeFromEvents(`SELECT * FROM ${rel.event} WHERE ${idColumn} IN (${hits})`);
        break;
      }

      case 'filterObjectAttribute': {
        if (isOcelPlan) {
          if (!rel.object_attr) throw new Error('This log has no object-attribute relation');
          const hits = attributePredicate(rel.object_attr, 'name', 'object_id', op);
          cascadeFromObjects(`SELECT * FROM ${rel.object} WHERE object_id IN (${hits})`);
        } else {
          if (!rel.trace_attr) throw new Error('This log has no case-attribute relation');
          const hits = attributePredicate(rel.trace_attr, 'key', 'trace_idx', op);
          keepTraces(hits);
        }
        break;
      }

      case 'filterE2oCount': {
        if (!isOcelPlan || !rel.e2o) throw new Error('E2O-count filters require an object-centric log');
        const relationConditions = (op.conditions ?? []).filter((c) => c.min != null || c.max != null);
        if (relationConditions.length) {
          const predicates = relationConditions.map((condition) => {
            const count = `(SELECT COUNT(*) FROM ${rel.e2o} r ` +
              `JOIN ${rel.object} target ON target.object_id = r.object_id ` +
              `WHERE r.event_id = e.event_id ` +
              `AND target.object_type = ${lit(condition.targetType)} ` +
              `AND COALESCE(r.qualifier, '') = ${lit(condition.qualifier)})`;
            const range: string[] = [];
            if (condition.min != null) range.push(`${count} >= ${Math.max(0, Math.floor(condition.min))}`);
            if (condition.max != null) range.push(`${count} <= ${Math.max(0, Math.floor(condition.max))}`);
            // A condition applies only to the event activity that owns this
            // relation. Other event activities must pass through unchanged.
            return `(e.activity <> ${lit(condition.sourceType)} OR (${range.join(' AND ')}))`;
          });
          cascadeFromEvents(`SELECT * FROM ${rel.event} e WHERE ${predicates.join(' AND ')}`);
        } else {
          const count = `(SELECT COUNT(*) FROM ${rel.e2o} r WHERE r.event_id = e.event_id)`;
          const parts: string[] = [];
          if (op.min != null) parts.push(`${count} >= ${Math.max(0, Math.floor(op.min))}`);
          if (op.max != null) parts.push(`${count} <= ${Math.max(0, Math.floor(op.max))}`);
          cascadeFromEvents(`SELECT * FROM ${rel.event} e WHERE ${parts.join(' AND ')}`);
        }
        break;
      }

      case 'filterO2oCount': {
        if (!isOcelPlan || !rel.o2o) throw new Error('O2O-count filters require an object-centric log');
        const relationConditions = (op.conditions ?? []).filter((c) => c.min != null || c.max != null);
        if (relationConditions.length) {
          const predicates = relationConditions.map((condition) => {
            const count = `(SELECT COUNT(*) FROM ${rel.o2o} r ` +
              `JOIN ${rel.object} target ON target.object_id = r.target_id ` +
              `WHERE r.source_id = o.object_id ` +
              `AND target.object_type = ${lit(condition.targetType)} ` +
              `AND COALESCE(r.qualifier, '') = ${lit(condition.qualifier)})`;
            const range: string[] = [];
            if (condition.min != null) range.push(`${count} >= ${Math.max(0, Math.floor(condition.min))}`);
            if (condition.max != null) range.push(`${count} <= ${Math.max(0, Math.floor(condition.max))}`);
            // O2O relations are directional, just like the source/target
            // columns shown in the editor. Apply only to their source type.
            return `(o.object_type <> ${lit(condition.sourceType)} OR (${range.join(' AND ')}))`;
          });
          cascadeFromObjects(`SELECT * FROM ${rel.object} o WHERE ${predicates.join(' AND ')}`);
        } else {
          const count = `(SELECT COUNT(*) FROM ${rel.o2o} r WHERE r.source_id = o.object_id OR r.target_id = o.object_id)`;
          const parts: string[] = [];
          if (op.min != null) parts.push(`${count} >= ${Math.max(0, Math.floor(op.min))}`);
          if (op.max != null) parts.push(`${count} <= ${Math.max(0, Math.floor(op.max))}`);
          cascadeFromObjects(`SELECT * FROM ${rel.object} o WHERE ${parts.join(' AND ')}`);
        }
        break;
      }

      case 'timeRange': {
        const parts: string[] = [];
        if (op.from) parts.push(`ts >= TIMESTAMP ${lit(op.from)}`);
        if (op.to) parts.push(`ts <= TIMESTAMP ${lit(op.to)}`);
        cascadeFromEvents(`SELECT * FROM ${rel.event} WHERE ${parts.join(' AND ')}`);
        break;
      }

      case 'filterCases': {
        if (isOcelPlan) throw new Error('Case filters require a case-centric log');
        const hit = `SELECT DISTINCT trace_idx FROM ${rel.event} WHERE activity = ${lit(op.activity)}`;
        keepTraces(op.mode === 'contains'
          ? hit
          : `SELECT DISTINCT trace_idx FROM ${rel.event} WHERE trace_idx NOT IN (${hit})`);
        break;
      }

      case 'variantMinCases':
        if (isOcelPlan) throw new Error('Variant filters require a case-centric log');
        keepTraces(
          `SELECT trace_idx FROM (` +
          `SELECT trace_idx, COUNT(*) OVER (PARTITION BY variant) AS n FROM (` +
          `SELECT trace_idx, string_agg(activity, '>' ORDER BY ts, event_idx) AS variant ` +
          `FROM ${rel.event} GROUP BY 1) v) w WHERE n >= ${Math.max(1, op.minCases | 0)}`
        );
        break;

      case 'removeAttribute': {
        if (isOcelPlan && op.scope === 'trace') {
          throw new Error('Case-attribute edits require a case-centric log');
        }
        const t: Logical = op.scope === 'event' ? 'event_attr' : 'trace_attr';
        if (rel[t]) {
          const keyColumn = isOcelPlan ? 'name' : 'key';
          emit({ [t]: `SELECT * FROM ${rel[t]} WHERE ${keyColumn} <> ${lit(op.key)}` });
        }
        break;
      }

      case 'removeEventAttributes': {
        if (!rel.event_attr) throw new Error('This log has no event-attribute relation');
        const keyColumn = isOcelPlan ? 'name' : 'key';
        const idColumn = isOcelPlan ? 'event_id' : 'event_idx';
        const keys = op.keys.map(lit).join(', ');
        emit({
          event_attr: `SELECT a.* FROM ${rel.event_attr} a WHERE NOT (` +
            `a.${keyColumn} IN (${keys}) AND a.${idColumn} IN (` +
            `SELECT ${idColumn} FROM ${rel.event} WHERE activity = ${lit(op.activity)}))`,
        });
        break;
      }

      case 'removeObjectAttributes': {
        if (!isOcelPlan || !rel.object_attr) throw new Error('Object-attribute edits require an object-centric log with object attributes');
        const keys = op.keys.map(lit).join(', ');
        emit({
          object_attr: `SELECT a.* FROM ${rel.object_attr} a WHERE NOT (` +
            `a.name IN (${keys}) AND a.object_id IN (` +
            `SELECT object_id FROM ${rel.object} WHERE object_type = ${lit(op.objectType)}))`,
        });
        break;
      }

      case 'removeCaseAttributes': {
        if (isOcelPlan || !rel.trace_attr) throw new Error('Case-attribute edits require a case-centric log with case attributes');
        const keys = op.keys.map(lit).join(', ');
        emit({ trace_attr: `SELECT * FROM ${rel.trace_attr} WHERE key NOT IN (${keys})` });
        break;
      }

      /**
       * Spreads each tied group across the gap to the next distinct timestamp.
       *
       * The step is `min(requested, gap / group size)` and the result is capped
       * one microsecond short of the next distinct timestamp, so no event can
       * be pushed onto or past a real one — the failure mode of the `+1ms per
       * event` recipe this operation exists to replace. Where the gap cannot
       * hold the whole group (more ties than microseconds available) the cap
       * wins and some ties remain: refusing to separate them is correct, and
       * silently reordering the log would not be.
       */
      case 'disambiguateEventOrder': {
        const idCol = isOcelPlan ? 'event_id' : 'event_idx';
        // `event_idx` is ingest's file order, so a traditional log can honour
        // "in order of appearance" exactly. OCEL keeps the source file's own
        // identifiers and no sequence column, so the best available proxy is a
        // natural sort of the identifier — digits compared as numbers, so that
        // `e10` follows `e9` rather than `e1`.
        const identifier = isOcelPlan
          ? `TRY_CAST(regexp_extract(e.event_id, '([0-9]+)$', 1) AS BIGINT) NULLS LAST, e.event_id`
          : `e.event_idx`;
        const partition = isOcelPlan ? [] : ['trace_idx'];

        let scopedBody: string;
        if (op.tieBreak === 'attribute') {
          if (!rel.event_attr) throw new Error('This log has no event-attribute relation');
          const keyCol = isOcelPlan ? 'name' : 'key';
          scopedBody =
            `SELECT e.*, a.value AS __tb FROM ${rel.event} e ` +
            `LEFT JOIN (SELECT ${idCol}, value FROM ${rel.event_attr} WHERE ${keyCol} = ${lit(op.attribute ?? '')} ` +
            `QUALIFY row_number() OVER (PARTITION BY ${idCol} ORDER BY value) = 1) a ON a.${idCol} = e.${idCol}`;
        } else if (op.tieBreak === 'lifecycle') {
          if (isOcelPlan) throw new Error('OCEL events have no lifecycle column');
          // XES standard transition order. An unrecognised (or absent)
          // transition sorts last rather than first, so a log that uses its
          // own vocabulary degrades to the identifier rather than to noise.
          const ranks = ['schedule', 'assign', 'reassign', 'start', 'suspend', 'resume',
            'complete', 'autoskip', 'manualskip', 'withdraw', 'ate_abort', 'pi_abort'];
          const whens = ranks.map((name, i) => `WHEN ${lit(name)} THEN ${i}`).join(' ');
          scopedBody =
            `SELECT e.*, CAST(CASE lower(e.lifecycle) ${whens} ELSE NULL END AS VARCHAR) AS __tb ` +
            `FROM ${rel.event} e`;
        } else {
          scopedBody = `SELECT e.*, CAST(NULL AS VARCHAR) AS __tb FROM ${rel.event} e`;
        }

        const scoped = helper('tiebreak');
        statements.push(`CREATE OR REPLACE VIEW ${scoped} AS ${scopedBody}`);

        const partSelect = partition.length ? partition.join(', ') + ', ' : '';
        const partOver = partition.length ? `PARTITION BY ${partition.join(', ')} ` : '';
        const gap = helper('gap');
        statements.push(
          `CREATE OR REPLACE VIEW ${gap} AS ` +
          `SELECT ${partSelect}ts, COUNT(*) AS tie_n, ` +
          `LEAD(ts) OVER (${partOver}ORDER BY ts) AS next_ts ` +
          `FROM ${scoped} WHERE ts IS NOT NULL GROUP BY ${partSelect}ts`
        );

        const joinOn = [...partition.map((c) => `g.${c} = e.${c}`), 'g.ts = e.ts'].join(' AND ');
        const step = Math.max(1, Math.floor(op.stepMicroseconds));
        // `gap / tie_n` rather than `gap / (tie_n - 1)`: the last member of a
        // group must still land strictly before the next distinct timestamp.
        const perGroupStep =
          `GREATEST(1, COALESCE(LEAST(${step}, ` +
          `CAST(floor(date_diff('microsecond', g.ts, g.next_ts)::DOUBLE / g.tie_n) AS BIGINT)), ${step}))`;
        const offset =
          `to_microseconds(CAST(${perGroupStep} * ` +
          `(row_number() OVER (PARTITION BY ${partition.map((c) => `e.${c}, `).join('')}e.ts ORDER BY ` +
          `TRY_CAST(e.__tb AS DOUBLE) NULLS LAST, e.__tb NULLS LAST, ${identifier}) - 1) AS BIGINT))`;
        emit({
          event:
            `SELECT e.* EXCLUDE (__tb) REPLACE (CASE ` +
            `WHEN e.ts IS NULL OR COALESCE(g.tie_n, 1) <= 1 THEN e.ts ` +
            `ELSE LEAST(e.ts + ${offset}, ` +
            `COALESCE(g.next_ts - to_microseconds(1), TIMESTAMP '9999-12-31 23:59:59')) ` +
            `END AS ts) FROM ${scoped} e LEFT JOIN ${gap} g ON ${joinOn}`,
        });
        break;
      }

      case 'dropImplausibleTimestamps': {
        const outside = `(year(ts) < ${op.minYear | 0} OR year(ts) > ${op.maxYear | 0})`;
        if (op.mode === 'clear') {
          emit({
            event: `SELECT * REPLACE (CASE WHEN ts IS NOT NULL AND ${outside} ` +
              `THEN CAST(NULL AS TIMESTAMP) ELSE ts END AS ts) FROM ${rel.event}`,
          });
        } else {
          cascadeFromEvents(`SELECT * FROM ${rel.event} WHERE ts IS NULL OR NOT ${outside}`);
        }
        break;
      }

      case 'deduplicateRelations': {
        if (!isOcelPlan) throw new Error('Relation deduplication requires an object-centric log');
        // SQL `DISTINCT` treats two NULLs as equal, which is the same rule the
        // Log Quality check uses when it reports these duplicates.
        const wanted = op.scope === 'both' ? ['e2o', 'o2o'] : [op.scope];
        const exprs: Record<string, string> = {};
        for (const l of wanted) if (rel[l]) exprs[l] = `SELECT DISTINCT * FROM ${rel[l]}`;
        if (Object.keys(exprs).length) emit(exprs);
        break;
      }

      case 'dropSelfRelations': {
        if (!isOcelPlan || !rel.o2o) throw new Error('Self-relation cleanup requires an object-centric log with O2O relations');
        emit({ o2o: `SELECT * FROM ${rel.o2o} WHERE source_id IS DISTINCT FROM target_id` });
        break;
      }

      case 'dropDanglingRelations': {
        if (!isOcelPlan) throw new Error('Dangling-relation cleanup requires an object-centric log');
        emit({
          ...(rel.e2o ? { e2o:
            `SELECT * FROM ${rel.e2o} WHERE event_id IN (SELECT event_id FROM ${rel.event}) ` +
            `AND object_id IN (SELECT object_id FROM ${rel.object})` } : {}),
          ...(rel.o2o ? { o2o:
            `SELECT * FROM ${rel.o2o} WHERE source_id IN (SELECT object_id FROM ${rel.object}) ` +
            `AND target_id IN (SELECT object_id FROM ${rel.object})` } : {}),
        });
        break;
      }

      /**
       * Objects no event references are master data, not behaviour. Dropping
       * them deliberately does NOT cascade to events: an orphan object holds
       * no E2O row, so no event can lose its last relationship this way, and
       * running the full object cascade here would silently also remove every
       * event that had no objects to begin with — a different repair the user
       * did not ask for.
       */
      case 'dropOrphanObjects': {
        if (!isOcelPlan || !rel.e2o) throw new Error('Orphan-object cleanup requires an object-centric log');
        emit({ object: `SELECT * FROM ${rel.object} WHERE object_id IN (SELECT DISTINCT object_id FROM ${rel.e2o})` });
        pruneObjectDependents();
        break;
      }

      case 'dropEventsWithoutObjects': {
        if (!isOcelPlan || !rel.e2o) throw new Error('This repair requires an object-centric log');
        cascadeFromEvents(`SELECT * FROM ${rel.event} WHERE event_id IN (SELECT DISTINCT event_id FROM ${rel.e2o})`);
        break;
      }

      case 'dropEmptyCases': {
        if (isOcelPlan) throw new Error('Empty-case cleanup requires a case-centric log');
        const live = `SELECT DISTINCT trace_idx FROM ${rel.event}`;
        emit({
          trace: `SELECT * FROM ${rel.trace} WHERE trace_idx IN (${live})`,
          ...(rel.trace_attr
            ? { trace_attr: `SELECT * FROM ${rel.trace_attr} WHERE trace_idx IN (${live})` }
            : {}),
        });
        break;
      }

      /**
       * Collapses spelling variants onto the most frequent spelling in their
       * group. Frequency ties break lexicographically rather than by row
       * order, so the same plan compiles to the same log every time — a
       * transform that depended on scan order would not be reproducible.
       */
      case 'canonicaliseValues': {
        if (op.scope === 'qualifier') {
          const tables = qualifierTables();
          if (!tables.length) break;
          // One vocabulary across both relations: a qualifier's spelling is a
          // property of the log, not of the table it happens to appear in.
          const union = tables.map((l) => `SELECT qualifier FROM ${rel[l]}`).join(' UNION ALL ');
          const canon = helper('qualcanon');
          statements.push(
            `CREATE OR REPLACE VIEW ${canon} AS ` +
            `SELECT lower(trim(qualifier)) AS norm, qualifier, COUNT(*) AS n ` +
            `FROM (${union}) q WHERE qualifier IS NOT NULL GROUP BY 1, 2 ` +
            `QUALIFY row_number() OVER (PARTITION BY norm ORDER BY n DESC, qualifier) = 1`
          );
          const exprs: Record<string, string> = {};
          for (const l of tables) {
            exprs[l] = `SELECT r.* REPLACE (COALESCE(c.qualifier, r.qualifier) AS qualifier) ` +
              `FROM ${rel[l]} r LEFT JOIN ${canon} c ON c.norm = lower(trim(r.qualifier))`;
          }
          emit(exprs);
          break;
        }
        const { logical, table, key } = valueTable(op.scope);
        const names = op.names.map(lit).join(', ');
        const canon = helper('valcanon');
        statements.push(
          `CREATE OR REPLACE VIEW ${canon} AS ` +
          `SELECT ${key} AS k, lower(trim(value)) AS norm, value, COUNT(*) AS n ` +
          `FROM ${table} WHERE ${key} IN (${names}) AND value IS NOT NULL GROUP BY 1, 2, 3 ` +
          `QUALIFY row_number() OVER (PARTITION BY k, norm ORDER BY n DESC, value) = 1`
        );
        emit({
          [logical]: `SELECT a.* REPLACE (COALESCE(c.value, a.value) AS value) FROM ${table} a ` +
            `LEFT JOIN ${canon} c ON c.k = a.${key} AND c.norm = lower(trim(a.value))`,
        });
        break;
      }

      case 'mapSentinelValues': {
        if (op.scope === 'qualifier') throw new Error('Sentinel values apply to attributes, not qualifiers');
        const { logical, table, key } = valueTable(op.scope);
        const names = op.names.map(lit).join(', ');
        const values = op.values.map((v) => lit(v.trim().toLowerCase())).join(', ');
        emit({
          [logical]: `SELECT * REPLACE (CASE WHEN ${key} IN (${names}) ` +
            `AND lower(trim(value)) IN (${values}) THEN CAST(NULL AS VARCHAR) ELSE value END AS value) ` +
            `FROM ${table}`,
        });
        break;
      }

      /**
       * A salted digest rather than a random token: the same input maps to the
       * same output everywhere in the log, so joins, distinct counts and
       * re-identification *within* the log survive while the original value
       * does not. The salt is part of the plan, which means it travels with
       * the transformation definition and is not a secret — pseudonymisation,
       * not anonymisation, and the editor says so.
       */
      case 'removeAttributes': {
        const { logical, table, key } = valueTable(op.scope);
        emit({ [logical]: `SELECT * FROM ${table} WHERE ${key} NOT IN (${op.names.map(lit).join(', ')})` });
        break;
      }

      case 'pseudonymiseAttributes': {
        const { logical, table, key } = valueTable(op.scope);
        const names = op.names.map(lit).join(', ');
        emit({
          [logical]: op.mode === 'remove'
            ? `SELECT * FROM ${table} WHERE ${key} NOT IN (${names})`
            : `SELECT * REPLACE (CASE WHEN ${key} IN (${names}) AND value IS NOT NULL ` +
              `THEN substr(md5(${lit(op.salt)} || value), 1, 16) ELSE value END AS value) FROM ${table}`,
        });
        break;
      }
    }
  }

  // Final views under the names every consumer already resolves through
  // `tableOf(artifactId, logical)`.
  const tables: Record<string, string> = {};
  for (const l of present) {
    const name = `${safe}__${l}`;
    statements.push(`CREATE OR REPLACE VIEW ${name} AS SELECT * FROM ${rel[l]}`);
    tables[l] = name;
  }
  return { statements, tables };
}

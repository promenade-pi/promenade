import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgram } from '../../src/host/relational/sqlProfile.ts';
import { compileProgram } from '../../src/host/relational/compileProgram.ts';
import type { RelationalInputBinding } from '../../src/host/relational/types.ts';

/**
 * Engine-independence test #18 from the relational-runtime task: without
 * implementing OCPQ, prove that its shape — an object-variable binding, a
 * nested existential child condition over an E2O/O2O join, and access to
 * both the root binding set and each intermediate binding set by name — can
 * be expressed as a Promenade Relational Program.
 *
 * Mirrors a tiny BindingBoxTree:
 *
 *   root:  order objects with a "Create Order" event               (E2O join)
 *   child: does a related "item" object exist for that order?      (O2O join, existential)
 *
 * A future `BindingBoxTree -> RelationalProgram` compiler would generate
 * exactly this shape mechanically: one `-- @relation` per box, each nested
 * child joining against its parent's relation by name, and one
 * `-- @output` per binding set the caller asked to see materialised.
 */
const program = parseProgram(`
-- @relation order_objects
-- Object-variable binding: every object of type "order".
SELECT object_id AS order_id
FROM {log.objects}
WHERE object_type = 'order'

-- @relation create_order_events
-- Event-variable binding joined to its related objects (E2O join).
SELECT DISTINCT eo.object_id AS order_id
FROM {log.event_object} eo
JOIN {log.events} e ON e.event_id = eo.event_id
WHERE e.activity = 'Create Order'

-- @relation root
-- Root BindingBox: orders that have a Create Order event.
SELECT o.order_id
FROM order_objects o
JOIN create_order_events c ON c.order_id = o.order_id

-- @relation related_items
-- Nested child BindingBox: for each root order, its related "item" objects
-- (O2O join) — the binding set an existential condition quantifies over.
SELECT DISTINCT oo.source_id AS order_id, oo.target_id AS item_id
FROM {log.object_object} oo
JOIN {log.objects} it ON it.object_id = oo.target_id AND it.object_type = 'item'
WHERE oo.source_id IN (SELECT order_id FROM root)

-- @output root_bindings
SELECT order_id FROM root

-- @output child_has_item_bindings
-- Existential condition: root bindings for which a related item exists.
SELECT DISTINCT order_id FROM related_items

-- @output statistics
SELECT
  (SELECT COUNT(*) FROM root) AS root_count,
  (SELECT COUNT(DISTINCT order_id) FROM related_items) AS with_item_count
`);

const ocelInput: RelationalInputBinding[] = [
  { role: 'log', artifactId: 'a_ocel1', artifactType: 'ObjectCentricEventLog' },
];
const physicalTableOf = (artifactId: string, logical: string) => `${artifactId}__${logical}`;

test('an OCPQ-shaped nested query compiles: E2O/O2O joins, nested CTEs, three named outputs', () => {
  const compiled = compileProgram(program, ocelInput, {}, undefined, {
    physicalTableOf, declaredParams: {},
  });
  assert.deepEqual(
    compiled.statements.map((s) => s.name).sort(),
    ['child_has_item_bindings', 'root_bindings', 'statistics']
  );
});

test('the root binding set is reachable as a named intermediate relation, independent of any output', () => {
  const compiled = compileProgram(program, ocelInput, {}, ['root', 'related_items'], {
    physicalTableOf, declaredParams: {},
  });
  const names = compiled.statements.map((s) => s.name);
  assert.ok(names.includes('root'));
  assert.ok(names.includes('related_items'));
  const root = compiled.statements.find((s) => s.name === 'root')!;
  assert.equal(root.kind, 'relation');
  // A request for `root` alone must not have to compute the nested child at all.
  assert.ok(!root.sql.includes('related_items AS ('));
});

test('the nested child output pulls in exactly its transitive dependencies, nothing more', () => {
  const compiled = compileProgram(program, ocelInput, {}, undefined, {
    physicalTableOf, declaredParams: {},
  });
  const child = compiled.statements.find((s) => s.name === 'child_has_item_bindings')!;
  for (const dep of ['order_objects', 'create_order_events', 'root', 'related_items']) {
    assert.ok(child.sql.includes(`${dep} AS (`), `expected ${dep} as a dependency CTE`);
  }
  // Unrelated top-level outputs are not pulled in as dependencies.
  assert.ok(!child.sql.includes('statistics AS ('));
  assert.ok(!child.sql.includes('root_bindings AS ('));
});

test('every input reference resolves to the OCEL logical schema, not a physical or guessed name', () => {
  const compiled = compileProgram(program, ocelInput, {}, undefined, {
    physicalTableOf, declaredParams: {},
  });
  const stats = compiled.statements.find((s) => s.name === 'statistics')!;
  assert.match(stats.sql, /a_ocel1__object\b/);
  assert.match(stats.sql, /a_ocel1__e2o\b/);
  assert.match(stats.sql, /a_ocel1__event\b/);
  assert.match(stats.sql, /a_ocel1__o2o\b/);
});

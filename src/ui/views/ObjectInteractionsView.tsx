import { useEffect, useState } from 'react';
import type { Artifact } from '../../host/artifact/types';
import { payloadOf, resultStore } from '../../host/actions/results';
import { colorRegistry } from '../../host/services/colors';
import { fmtCount } from '../format';
import type { ObjectInteractionsPayload } from '../../host/relational/reference-actions/object-interactions/build';

/**
 * Object Interaction Graph — four small tables rather than a drawn graph.
 *
 * A node-link layout earns its keep once a result needs positioning and
 * curve routing (see `DfgView`/`OcdfgView`); this result is small, mostly
 * about magnitude and qualifiers, and reads faster as ranked tables than as
 * a handful of thick edges between four boxes. `AttributeTable`'s table
 * styling is reused rather than reinvented.
 */
export function ObjectInteractionsView({ artifact }: { artifact: Artifact }) {
  const [, force] = useState(0);
  useEffect(() => resultStore.subscribe(() => force((n) => n + 1)), []);

  // `payloadOf` peels the executor's `{ result, activities, stats }` envelope
  // (present right after a run) so this reads the same bare
  // `ObjectInteractionsPayload` the boot-time rehydration puts in the store —
  // see `results.ts`. Reading `resultStore.get()` directly handed back the
  // envelope, whose `objectTypes`/`interactions`/`e2oQualifiers`/`o2oRelations`
  // are all `undefined`, white-screening the app on the first `.map`.
  const result = payloadOf(artifact.id) as ObjectInteractionsPayload | undefined;
  if (!result) return <div className="view" style={{ color: 'var(--text-dim)' }}>No result yet.</div>;

  const swatch = (domain: 'objectType' | 'qualifier', value: string | null) => (
    <span
      className="swatch"
      style={{ background: value == null ? 'var(--border)' : colorRegistry.get(domain, value) }}
    />
  );

  return (
    <div className="view" style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: 16, overflow: 'auto' }}>
      <section>
        <h4>Object types</h4>
        <table className="grid">
          <thead>
            <tr>
              <th>Type</th>
              <th style={{ textAlign: 'right' }}>Objects</th>
              <th style={{ textAlign: 'right' }}>Events touched</th>
              <th style={{ textAlign: 'right' }}>Avg events / object</th>
            </tr>
          </thead>
          <tbody>
            {result.objectTypes.map((r) => (
              <tr key={r.objectType}>
                <td>{swatch('objectType', r.objectType)} {r.objectType}</td>
                <td className="num">{fmtCount(r.objectCount)}</td>
                <td className="num">{fmtCount(r.eventCount)}</td>
                <td className="num">{r.avgEventsPerObject}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h4>Interactions — object types co-occurring on the same event</h4>
        {result.interactions.length === 0 ? (
          <div style={{ color: 'var(--text-dim)' }}>No pair meets the minimum shared-events threshold.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Type A</th>
                <th>Type B</th>
                <th style={{ textAlign: 'right' }}>Shared events</th>
              </tr>
            </thead>
            <tbody>
              {result.interactions.map((r, i) => (
                <tr key={`${r.typeA}-${r.typeB}-${i}`}>
                  <td>{swatch('objectType', r.typeA)} {r.typeA}</td>
                  <td>{swatch('objectType', r.typeB)} {r.typeB}</td>
                  <td className="num">{fmtCount(r.sharedEvents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h4>E2O qualifiers — how each object type relates to the events it appears in</h4>
        <table className="grid">
          <thead>
            <tr>
              <th>Object type</th>
              <th>Qualifier</th>
              <th style={{ textAlign: 'right' }}>Count</th>
            </tr>
          </thead>
          <tbody>
            {result.e2oQualifiers.map((r, i) => (
              <tr key={`${r.objectType}-${r.qualifier}-${i}`}>
                <td>{swatch('objectType', r.objectType)} {r.objectType}</td>
                <td>
                  {r.qualifier == null
                    ? <span style={{ color: 'var(--text-dim)' }}>(none)</span>
                    : <>{swatch('qualifier', r.qualifier)} {r.qualifier}</>}
                </td>
                <td className="num">{fmtCount(r.n)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {result.o2oRelations.length > 0 && (
        <section>
          <h4>O2O relations</h4>
          <table className="grid">
            <thead>
              <tr>
                <th>Source type</th>
                <th>Target type</th>
                <th>Qualifier</th>
                <th style={{ textAlign: 'right' }}>Count</th>
              </tr>
            </thead>
            <tbody>
              {result.o2oRelations.map((r, i) => (
                <tr key={`${r.sourceType}-${r.targetType}-${r.qualifier}-${i}`}>
                  <td>{swatch('objectType', r.sourceType)} {r.sourceType}</td>
                  <td>{swatch('objectType', r.targetType)} {r.targetType}</td>
                  <td>
                    {r.qualifier == null
                      ? <span style={{ color: 'var(--text-dim)' }}>(none)</span>
                      : <>{swatch('qualifier', r.qualifier)} {r.qualifier}</>}
                  </td>
                  <td className="num">{fmtCount(r.n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

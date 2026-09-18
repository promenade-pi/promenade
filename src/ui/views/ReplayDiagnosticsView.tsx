import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Artifact, ProvenanceGraph } from '../../host/artifact/types';
import { ancestorsOf } from '../../host/artifact/types';
import { payloadOf, resultStore } from '../../host/actions/results';
import { colorRegistry } from '../../host/services/colors';
import { selectionBus, type Selection } from '../../host/services/selection';
import { fmtCount } from '../format';
import { layoutPetriNet, type PetriNetPayload } from './petriNetLayout';

interface PlaceDiagnostic { place: number; produced: number; consumed: number; missing: number; remaining: number }
interface ActivityDiagnostic { activity: number; occurrences: number; forced: number; unmapped: number }
interface VariantReplay {
  seq: number[]; case_count: number; fitness: number;
  produced: number; consumed: number; missing: number; remaining: number;
  forced_at: number[]; unmapped_at: number[];
}
/**
 * How many variant rows to draw before asking.
 *
 * Replay is linear, so its variant limit defaults five times higher than the
 * alignment's — and a real log has thousands of distinct sequences. Drawing
 * every row is a table nobody reads and a DOM that makes the whole panel
 * sluggish to scroll; the rows worth looking at are at the top under either
 * sort. The rest stay one click away rather than being dropped.
 */
const VARIANT_ROWS = 500;

interface ReplayDiagnosticsRaw {
  fitness: number; trace_fitness: number;
  produced: number; consumed: number; missing: number; remaining: number;
  total_cases: number; perfect_cases: number;
  places: PlaceDiagnostic[];
  activities: ActivityDiagnostic[];
  variants: VariantReplay[];
  stats: {
    distinct_variants: number; variant_limit_reached: boolean;
    tau_search_exhausted: number; silent_transitions: number;
  };
}

const MISSING = 'var(--danger, #d33)';
const REMAINING = 'var(--warn, #c80)';

function Stat({ n, l, title }: { n: string; l: string; title?: string }) {
  return <div className="stat" title={title}><div className="n">{n}</div><div className="l">{l}</div></div>;
}

/** The id-to-name table the scan assigned, wherever this session kept it. */
function activityNames(id: string, artifact: Artifact): string[] {
  const live = (resultStore.get(id) as any)?.activities;
  if (Array.isArray(live)) return live;
  const persisted = (artifact.meta as any)?.activityNames;
  return Array.isArray(persisted) ? persisted : [];
}

/**
 * Token-based replay diagnostics.
 *
 * The numbers are the smaller half of this. What token-based replay can say
 * and an alignment cannot is *where* — a missing token belongs to a place, so
 * the net itself is the report: a place that keeps having tokens invented for
 * it is the point where the log does something the model forbids, and a place
 * left holding tokens is a branch the model opened and the log never closed.
 * So the net is drawn decorated, and the tables underneath exist to answer
 * "which activity" and "which cases" once the eye has found the spot.
 */
export function ReplayDiagnosticsView({ artifact, graph }: {
  artifact: Artifact; graph: ProvenanceGraph;
}) {
  const [, force] = useState(0);
  useEffect(() => resultStore.subscribe(() => force((n) => n + 1)), []);
  const [sel, setSel] = useState<Selection>(selectionBus.get());
  useEffect(() => selectionBus.subscribe(setSel), []);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [sort, setSort] = useState<'frequent' | 'worst'>('frequent');
  const [showAllVariants, setShowAllVariants] = useState(false);

  // Read through `payloadOf`: during a live run the store holds the runner's
  // envelope, after a reload the bare payload, and both describe this result.
  const data = payloadOf(artifact.id) as ReplayDiagnosticsRaw | null;
  const names = activityNames(artifact.id, artifact);

  // The net this was replayed on. Its place indices are the ones the kernel
  // counted against, so the decoration can be put straight back onto it.
  const model = useMemo(() => {
    for (const id of ancestorsOf(graph, artifact.id)) {
      const a = graph.artifacts[id];
      if (!a || a.type !== 'AcceptingPetriNet') continue;
      const net = (payloadOf(id) ?? (a.storage.kind === 'inline' ? a.storage.value : null)) as PetriNetPayload | null;
      if (net && Array.isArray(net.places)) return { net, names: activityNames(id, a) };
    }
    return null;
  }, [graph, artifact.id]);

  const layout = useMemo(
    () => (model ? layoutPetriNet(model.net, model.names) : null),
    [model],
  );

  const byPlace = useMemo(() => {
    const m = new Map<number, PlaceDiagnostic>();
    for (const p of data?.places ?? []) m.set(p.place, p);
    return m;
  }, [data]);

  // Transitions are matched to diagnostics by *label*, not by index: the
  // kernel counts in the log's activity-id space (which the host resolved
  // before the run), while the net numbers its own transitions. The name is
  // the only thing both sides agree on — the same join `AlignmentView` makes.
  const forcedByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of data?.activities ?? []) {
      if (a.forced > 0) m.set(names[a.activity] ?? `#${a.activity}`, a.forced);
    }
    return m;
  }, [data, names]);
  const maxForced = Math.max(1, ...forcedByName.values());

  const sorted = useMemo(() => {
    if (!data) return [];
    if (sort === 'frequent') return data.variants;
    return [...data.variants].sort((a, b) => a.fitness - b.fitness || b.case_count - a.case_count);
  }, [data, sort]);
  const variants = showAllVariants ? sorted : sorted.slice(0, VARIANT_ROWS);

  const toggle = (i: number) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(i) ? next.delete(i) : next.add(i);
    return next;
  });

  if (!data) return <div className="view" style={{ color: 'var(--text-dim)' }}>No result yet.</div>;

  const isSel = (n: string) => sel.items.some((i) => i.kind === 'activity' && i.id === n);
  const nameOf = (id: number) => names[id] ?? `#${id}`;
  const unmapped = data.activities.filter((a) => a.unmapped > 0);

  return (
    <div className="view">
      <div className="stat-row">
        <Stat n={data.fitness.toFixed(3)} l="Fitness"
              title="Token-based fitness over the pooled counters of every case." />
        <Stat n={data.trace_fitness.toFixed(3)} l="Trace fitness"
              title="Case-weighted mean of the per-trace fitness — every case one equal vote." />
        <Stat n={fmtCount(data.perfect_cases)} l="Perfect cases"
              title="Cases replayed without inventing a token or leaving one behind." />
        <Stat n={fmtCount(data.stats.distinct_variants)} l="Variants" />
      </div>

      <p style={{ margin: '10px 0 8px', fontSize: 12, color: 'var(--text-dim)' }}>
        {fmtCount(data.produced)} produced · {fmtCount(data.consumed)} consumed ·{' '}
        <b style={{ color: data.missing > 0 ? MISSING : undefined }}>{fmtCount(data.missing)} missing</b> ·{' '}
        <b style={{ color: data.remaining > 0 ? REMAINING : undefined }}>{fmtCount(data.remaining)} remaining</b>
        {' '}over {fmtCount(data.total_cases)} cases.
        {data.stats.variant_limit_reached && <> Variant limit reached — showing the most frequent.</>}
      </p>

      {data.stats.tau_search_exhausted > 0 && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--warn)' }}>
          {fmtCount(data.stats.tau_search_exhausted)} cases hit the silent-transition search bound, so
          some transitions were forced that a longer silent path might have enabled honestly — this
          fitness is a lower bound for them.
        </p>
      )}

      {unmapped.length > 0 && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: MISSING }}>
          No transition in the model for {unmapped.map((a) => nameOf(a.activity)).join(', ')} — each
          such event costs one missing token and appears nowhere on the net below.
        </p>
      )}

      {layout ? (
        <>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', fontSize: 11, color: 'var(--text-dim)', margin: '4px 0 2px' }}>
            <span><b style={{ color: MISSING }}>−n</b> tokens the replay had to invent here</span>
            <span><b style={{ color: REMAINING }}>+n</b> tokens left behind here</span>
          </div>
          <svg width={layout.width} height={layout.height} style={{ minWidth: '100%' }}>
            <defs>
              <marker id="rdarrow" viewBox="0 0 8 8" refX="7" refY="4"
                      markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--text-dim)" />
              </marker>
            </defs>

            {layout.p2t.map(([p, t], i) => {
              const a = layout.pos.get(layout.key('p', p)), b = layout.pos.get(layout.key('t', t));
              return a && b ? (
                <line key={`pt${i}`} x1={a.x + 46} y1={a.y + 13} x2={b.x} y2={b.y + 17}
                      stroke="var(--text-dim)" strokeWidth={1} opacity={0.5} markerEnd="url(#rdarrow)" />
              ) : null;
            })}
            {layout.t2p.map(([t, p], i) => {
              const a = layout.pos.get(layout.key('t', t)), b = layout.pos.get(layout.key('p', p));
              return a && b ? (
                <line key={`tp${i}`} x1={a.x + 46} y1={a.y + 17} x2={b.x} y2={b.y + 13}
                      stroke="var(--text-dim)" strokeWidth={1} opacity={0.5} markerEnd="url(#rdarrow)" />
              ) : null;
            })}

            {/* Places: a deviating one is ringed in the colour of whichever
                deviation it carries, with the counts beside it. Missing wins
                the ring when a place has both — inventing a token is the
                stronger statement about the model being wrong. */}
            {layout.net.places.map((pl, i) => {
              const p = layout.pos.get(layout.key('p', i));
              if (!p) return null;
              const d = byPlace.get(i);
              const stroke = d?.missing ? MISSING : d?.remaining ? REMAINING : 'var(--accent)';
              const marked = layout.net.initial_marking?.includes(i) || layout.net.final_marking?.includes(i);
              return (
                <g key={`p${i}`} transform={`translate(${p.x},${p.y})`}>
                  <circle cx={13} cy={13} r={12} fill="var(--bg)" stroke={stroke}
                          strokeWidth={d ? 2.6 : 1.4} />
                  {marked && <circle cx={13} cy={13} r={4.5} fill="var(--accent)" />}
                  {d && (
                    <title>
                      {pl.id}: {d.missing} missing, {d.remaining} remaining,
                      {' '}{d.produced} produced, {d.consumed} consumed
                    </title>
                  )}
                  <text x={13} y={38} fontSize={8.5} textAnchor="middle" fill="var(--text-dim)">{pl.id}</text>
                  {d && (d.missing > 0 || d.remaining > 0) && (
                    <text x={30} y={10} fontSize={9} fontWeight={600}>
                      {d.missing > 0 && <tspan fill={MISSING}>−{fmtCount(d.missing)}</tspan>}
                      {d.missing > 0 && d.remaining > 0 && <tspan fill="var(--text-dim)"> </tspan>}
                      {d.remaining > 0 && <tspan fill={REMAINING}>+{fmtCount(d.remaining)}</tspan>}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Transitions: tinted by how often the log could only fire them
                by inventing a token. An untinted box replayed cleanly. */}
            {(layout.net.activities ?? []).map((a) => {
              const p = layout.pos.get(layout.key('t', a));
              if (!p) return null;
              const label = layout.labelOf(a);
              if (label == null) {
                return (
                  <g key={`t${a}`} transform={`translate(${p.x},${p.y})`}>
                    <rect x={13} y={7} width={20} height={20} fill="var(--text-dim)" />
                  </g>
                );
              }
              const forced = forcedByName.get(label);
              const selected = isSel(label);
              const t = forced != null ? forced / maxForced : null;
              const fill = t != null
                ? `color-mix(in srgb, ${MISSING} ${Math.round(10 + t * 45)}%, var(--bg))`
                : 'var(--bg)';
              return (
                <g key={`t${a}`} transform={`translate(${p.x},${p.y})`} style={{ cursor: 'pointer' }}
                   onClick={() => selectionBus.set(
                     selected ? [] : [{ artifactId: artifact.id, kind: 'activity', id: label }], 'replay')}>
                  <rect width={46} height={34} rx={3} fill={fill}
                        stroke={selected ? 'var(--accent)' : colorRegistry.get('activity', label)}
                        strokeWidth={selected ? 2.5 : 1.8} />
                  <title>{forced != null ? `${label} — forced ${fmtCount(forced)} times` : label}</title>
                  <text x={23} y={15} fontSize={8} textAnchor="middle" fill="var(--text)">
                    {label.length > 8 ? `${label.slice(0, 7)}…` : label}
                  </text>
                  {forced != null && (
                    <text x={23} y={27} fontSize={7.5} textAnchor="middle" fill={MISSING}>
                      −{fmtCount(forced)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </>
      ) : (
        <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          The net this was replayed on is no longer available, so the per-place diagnosis cannot be
          drawn. The totals and tables below are unaffected.
        </p>
      )}

      <table className="grid" style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>Activity</th>
            <th style={{ textAlign: 'right' }}>Occurrences</th>
            <th style={{ textAlign: 'right' }}>Forced</th>
            <th style={{ textAlign: 'right' }}>Unmapped</th>
          </tr>
        </thead>
        <tbody>
          {data.activities.map((a) => (
            <tr key={a.activity}>
              <td>{nameOf(a.activity)}</td>
              <td className="num">{fmtCount(a.occurrences)}</td>
              <td className="num" style={{ color: a.forced > 0 ? MISSING : undefined }}>{fmtCount(a.forced)}</td>
              <td className="num" style={{ color: a.unmapped > 0 ? MISSING : undefined }}>{fmtCount(a.unmapped)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pd-tabs" style={{ marginTop: 12 }}>
        <button className={sort === 'frequent' ? 'active' : ''}
                onClick={() => { setSort('frequent'); setExpanded(new Set()); }}>Most frequent</button>
        <button className={sort === 'worst' ? 'active' : ''}
                onClick={() => { setSort('worst'); setExpanded(new Set()); }}>Worst fitness</button>
      </div>

      <table className="grid" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th />
            <th>Sequence</th>
            <th style={{ textAlign: 'right' }}>Cases</th>
            <th style={{ textAlign: 'right' }}>Fitness</th>
            <th style={{ textAlign: 'right' }}>Missing</th>
            <th style={{ textAlign: 'right' }}>Remaining</th>
          </tr>
        </thead>
        <tbody>
          {variants.map((v, i) => {
            const open = expanded.has(i);
            const forcedAt = new Set(v.forced_at);
            const unmappedAt = new Set(v.unmapped_at);
            const summary = v.seq.map(nameOf).join(' → ');
            return (
              <Fragment key={i}>
                <tr className="clickable" onClick={() => toggle(i)}>
                  <td style={{ width: 14, color: 'var(--text-dim)' }}>{open ? '▾' : '▸'}</td>
                  <td title={summary} style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {summary}
                  </td>
                  <td className="num">{fmtCount(v.case_count)}</td>
                  <td className="num">{v.fitness.toFixed(3)}</td>
                  <td className="num" style={{ color: v.missing > 0 ? MISSING : undefined }}>{fmtCount(v.missing)}</td>
                  <td className="num" style={{ color: v.remaining > 0 ? REMAINING : undefined }}>{fmtCount(v.remaining)}</td>
                </tr>
                {open && (
                  <tr>
                    <td />
                    <td colSpan={5} style={{ padding: '4px 8px 10px' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                        {v.seq.map((a, j) => (
                          <span key={j} className="chip"
                                style={{ color: forcedAt.has(j) || unmappedAt.has(j) ? MISSING : undefined }}
                                title={unmappedAt.has(j) ? 'No transition in the model for this activity'
                                  : forcedAt.has(j) ? 'Could only fire by inventing a token'
                                  : 'Fired on an enabled transition'}>
                            {unmappedAt.has(j) ? '? ' : forcedAt.has(j) ? '⊘ ' : ''}{nameOf(a)}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {sorted.length > variants.length && (
        <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8 }}>
          Showing the first {fmtCount(variants.length)} of {fmtCount(sorted.length)} variants.{' '}
          <button className="ov-btn" style={{ marginLeft: 4 }} onClick={() => setShowAllVariants(true)}>Show all</button>
        </p>
      )}
    </div>
  );
}

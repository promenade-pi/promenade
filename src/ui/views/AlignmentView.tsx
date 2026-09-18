import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Artifact } from '../../host/artifact/types';
import { resultStore } from '../../host/actions/results';
import { fmtCount } from '../format';

interface MoveRaw { kind: 'sync' | 'log' | 'model' | 'silent'; activity?: number }
interface VariantRaw { seq: number[]; case_count: number; cost: number; fitness: number; moves: MoveRaw[] }
interface AlignmentSetRaw {
  variants: VariantRaw[];
  total_cases: number;
  aligned_cases: number;
  unreachable_cases: number;
  mean_fitness: number;
  precision: number;
  stats: { distinct_variants: number; variant_limit_reached: boolean; model_only_cost: number };
}

/** "A → B → C", truncated in the middle so both ends of a long sequence stay visible. */
function fmtSeq(names: string[], seq: number[], max = 6): string {
  const labels = seq.map((id) => names[id] ?? `#${id}`);
  if (labels.length <= max) return labels.join(' → ');
  const head = Math.ceil(max / 2), tail = Math.floor(max / 2);
  return [...labels.slice(0, head), `… (+${labels.length - max} more) …`, ...labels.slice(labels.length - tail)].join(' → ');
}

function moveChip(names: string[], m: MoveRaw, i: number) {
  const label = m.activity != null ? (names[m.activity] ?? `#${m.activity}`) : '';
  switch (m.kind) {
    case 'sync': return <span key={i} className="chip" title="Move on both log and model">{label}</span>;
    case 'log': return (
      <span key={i} className="chip" style={{ color: 'var(--danger, #d33)' }} title="Log move: event has no matching enabled transition">
        ⊘ {label}
      </span>
    );
    case 'model': return (
      <span key={i} className="chip" style={{ color: 'var(--warn, #c80)' }} title="Model move: transition fired without a matching event">
        + {label}
      </span>
    );
    default: return (
      <span key={i} className="chip" style={{ color: 'var(--text-dim)' }} title="Silent model move: routing only, free">
        τ
      </span>
    );
  }
}

function Stat({ n, l }: { n: string; l: string }) {
  return <div className="stat"><div className="n">{n}</div><div className="l">{l}</div></div>;
}

/**
 * Alignment explorer.
 *
 * A variant table (cost/fitness, expandable into its full move sequence) is
 * the part every result needs just to be trusted. On top of that: a
 * fitness/precision summary — the two numbers a conformance check exists to
 * produce — and a deviation summary ranking which activities the log and
 * model disagree about most, so a "which behavior should I actually look
 * at" question doesn't require reading every variant by hand. Re-sorting by
 * worst fitness answers the same question from the case side.
 */
export function AlignmentView({ artifact }: { artifact: Artifact }) {
  const [, force] = useState(0);
  useEffect(() => resultStore.subscribe(() => force((n) => n + 1)), []);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [sort, setSort] = useState<'frequent' | 'worst'>('frequent');

  const res: any = resultStore.get(artifact.id);
  const names: string[] = res?.activities ?? [];
  const data: AlignmentSetRaw | null = res?.result ?? null;

  const variants = useMemo(() => {
    if (!data) return [];
    if (sort === 'frequent') return data.variants;
    // Worst-fitness-first, ties broken by case count so the variants most
    // worth looking at (bad AND common) still sort near the top either way.
    return [...data.variants].sort((a, b) => a.fitness - b.fitness || b.case_count - a.case_count);
  }, [data, sort]);

  // Which activities the log and model disagree about most, case-weighted —
  // a variant with 10,000 cases should dominate this ranking the same way
  // it dominates mean_fitness, not count once like it would in the table.
  const deviations = useMemo(() => {
    if (!data) return { skipped: [], inserted: [] as Array<{ name: string; count: number }> };
    const skipped = new Map<number, number>();
    const inserted = new Map<number, number>();
    for (const v of data.variants) {
      for (const m of v.moves) {
        if (m.activity == null) continue;
        if (m.kind === 'log') skipped.set(m.activity, (skipped.get(m.activity) ?? 0) + v.case_count);
        else if (m.kind === 'model') inserted.set(m.activity, (inserted.get(m.activity) ?? 0) + v.case_count);
      }
    }
    const top = (m: Map<number, number>) => [...m.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([id, count]) => ({ name: names[id] ?? `#${id}`, count }));
    return { skipped: top(skipped), inserted: top(inserted) };
  }, [data, names]);

  const toggle = (i: number) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(i) ? next.delete(i) : next.add(i);
    return next;
  });

  if (!data) return <div className="view">No result yet.</div>;

  return (
    <div className="view">
      <div className="stat-row">
        <Stat n={data.mean_fitness.toFixed(3)} l="Fitness" />
        <Stat n={data.precision.toFixed(3)} l="Precision" />
        <Stat n={fmtCount(data.aligned_cases)} l="Aligned cases" />
        <Stat n={fmtCount(data.stats.distinct_variants)} l="Variants" />
      </div>

      {(deviations.skipped.length > 0 || deviations.inserted.length > 0) && (
        <div className="align-dev">
          {deviations.skipped.length > 0 && (
            <div className="align-dev-col">
              <div className="align-dev-head">Most often skipped — log ahead of the model</div>
              {deviations.skipped.map((d) => (
                <div key={d.name} className="align-dev-row">
                  <span>{d.name}</span>
                  <span className="align-dev-count">{fmtCount(d.count)}</span>
                </div>
              ))}
            </div>
          )}
          {deviations.inserted.length > 0 && (
            <div className="align-dev-col">
              <div className="align-dev-head">Most often inserted — model ahead of the log</div>
              {deviations.inserted.map((d) => (
                <div key={d.name} className="align-dev-row">
                  <span>{d.name}</span>
                  <span className="align-dev-count">{fmtCount(d.count)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <p style={{ margin: '10px 0 8px', fontSize: 12, color: 'var(--text-dim)' }}>
        {fmtCount(data.aligned_cases)} of {fmtCount(data.total_cases)} cases aligned
        {data.unreachable_cases > 0 && <> ({fmtCount(data.unreachable_cases)} unreachable)</>}
        {data.stats.variant_limit_reached && <> — variant limit reached, showing the most frequent</>}.
      </p>

      <div className="pd-tabs">
        <button className={sort === 'frequent' ? 'active' : ''} onClick={() => setSort('frequent')}>Most frequent</button>
        <button className={sort === 'worst' ? 'active' : ''} onClick={() => setSort('worst')}>Worst fitness</button>
      </div>

      <table className="grid" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th />
            <th>Sequence</th>
            <th style={{ textAlign: 'right' }}>Cases</th>
            <th style={{ textAlign: 'right' }}>Fitness</th>
            <th style={{ textAlign: 'right' }}>Cost</th>
          </tr>
        </thead>
        <tbody>
          {variants.map((v, i) => {
            const open = expanded.has(i);
            return (
              <Fragment key={i}>
                <tr className="clickable" onClick={() => toggle(i)}>
                  <td style={{ width: 14, color: 'var(--text-dim)' }}>{open ? '▾' : '▸'}</td>
                  <td title={fmtSeq(names, v.seq, 1000)}>{fmtSeq(names, v.seq)}</td>
                  <td className="num">{fmtCount(v.case_count)}</td>
                  <td className="num">{v.fitness.toFixed(3)}</td>
                  <td className="num">{v.cost}</td>
                </tr>
                {open && (
                  <tr>
                    <td />
                    <td colSpan={4} style={{ padding: '4px 8px 10px' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                        {v.moves.map((m, j) => moveChip(names, m, j))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

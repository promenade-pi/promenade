import { useEffect, useMemo, useState } from 'react';
import type { Artifact, ProvenanceGraph } from '../../host/artifact/types';
import { ancestorsOf } from '../../host/artifact/types';
import { hasTables } from '../../host/artifact/tables';
import { resultStore } from '../../host/actions/results';
import { colorRegistry } from '../../host/services/colors';
import { selectionBus, type Selection } from '../../host/services/selection';
import { fmtCount, fmtMs } from '../format';
import { useQuery, num } from './useQuery';
import { tableOf } from './tableName';
import { layoutPetriNet } from './petriNetLayout';

const LOG_TYPES = new Set(['TraditionalEventLog', 'ObjectCentricEventLog']);

/**
 * Accepting Petri net, as produced by the Alpha Miner.
 *
 * A host view rather than something the plugin ships: a plugin producing a
 * standard artifact type should not have to reimplement its visualization.
 * The manifest points here by name.
 *
 * Layout is a simple longest-path ranking — enough to read the structure,
 * without pretending to be a graph layout engine.
 */
export function PetriNetView({ artifact, graph, panelId }: {
  artifact: Artifact; graph: ProvenanceGraph; panelId: string;
}) {
  const [, force] = useState(0);
  useEffect(() => resultStore.subscribe(() => force((n) => n + 1)), []);
  const [sel, setSel] = useState<Selection>(selectionBus.get());
  useEffect(() => selectionBus.subscribe(setSel), []);

  const res: any = resultStore.get(artifact.id);

  // Frequency decoration needs the log this net was (transitively) mined
  // from — a Petri net converted from a process tree has the tree, not the
  // log, as its direct input, so this walks the whole ancestor chain rather
  // than reading `inputs[0]` alone.
  const sourceLog = useMemo(() => {
    for (const id of ancestorsOf(graph, artifact.id)) {
      const a = graph.artifacts[id];
      if (a && LOG_TYPES.has(a.type) && hasTables(a)) return a;
    }
    return null;
  }, [graph, artifact.id]);

  const freqSql = sourceLog
    ? `SELECT activity, COUNT(*) AS n FROM ${tableOf(sourceLog.id, 'event')}
       WHERE activity IS NOT NULL GROUP BY 1`
    : null;
  const freqQ = useQuery<{ activity: string; n: number }>(freqSql, [sourceLog?.id]);
  const freqByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of freqQ.rows ?? []) m.set(r.activity, num(r.n));
    return m;
  }, [freqQ.rows]);
  const maxFreq = useMemo(
    () => Math.max(1, ...freqByName.values()),
    [freqByName]
  );

  const layout = useMemo(() => {
    if (!res?.result) return null;
    return layoutPetriNet(res.result, res.activities ?? []);
  }, [res]);

  if (!layout) {
    return <div className="view" style={{ color: 'var(--text-dim)' }}>No result yet.</div>;
  }

  const { net, labelOf, pos, key, p2t, t2p } = layout;
  const stats = net.stats ?? {};
  const isSel = (n: string) => sel.items.some((i) => i.kind === 'activity' && i.id === n);

  // An arc's own "volume" is the frequency of the transition it connects to
  // — the same directly-follows-graph convention (thicker, more opaque =
  // more frequent) applied here instead of reinventing one. `fromCy`/`toCy`
  // are each endpoint's own node-center y-offset — a place circle (24px) and
  // a transition box (34px tall, since the frequency label was added) are
  // not the same size, so one shared offset would miscenter one of them.
  const edge = (
    from: { x: number; y: number }, to: { x: number; y: number }, k: string,
    fromCy: number, toCy: number, freq?: number
  ) => {
    const t = freq != null ? freq / maxFreq : null;
    const width = t != null ? 0.6 + t * 3 : 1;
    const opacity = t != null ? 0.25 + t * 0.55 : 0.5;
    return (
      <line key={k}
        x1={from.x + 46} y1={from.y + fromCy} x2={to.x} y2={to.y + toCy}
        stroke="var(--text-dim)" strokeWidth={width} opacity={opacity} markerEnd="url(#pnarrow)" />
    );
  };

  return (
    <div className="view">
      <div className="dfg-stats">
        <span>{fmtCount(stats.places)} places</span>
        <span>{fmtCount(net.activities?.length)} transitions</span>
        <span>{fmtCount(stats.arcs)} arcs</span>
        {/* Only shown when the producing algorithm reports them — the Alpha
            Miner does, pm4py's inductive miner does not. */}
        {stats.parallel_pairs != null && (
          <span>{fmtCount(stats.parallel_pairs)} parallel pairs</span>
        )}
        {stats.silent_transitions != null && (
          <span>{fmtCount(stats.silent_transitions)} silent</span>
        )}
        {res.timing && (
          <span className={res.timing.reused ? 'ok' : ''}>
            {res.timing.reused ? 'cached' : 'computed'} · prepare {fmtMs(res.timing.prepareMs)} · mine{' '}
            <b>{res.timing.finalizeMs < 1
              ? `${res.timing.finalizeMs.toFixed(2)} ms` : fmtMs(res.timing.finalizeMs)}</b>
          </span>
        )}
        {stats.truncated && (
          <span style={{ color: 'var(--warn)' }}>activity limit reached — net is partial</span>
        )}
      </div>

      <svg width={layout.width} height={layout.height} style={{ minWidth: '100%' }}>
        <defs>
          <marker id="pnarrow" viewBox="0 0 8 8" refX="7" refY="4"
                  markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--text-dim)" />
          </marker>
        </defs>

        {p2t.map(([p, t], i) => {
          const a = pos.get(key('p', p)), b = pos.get(key('t', t));
          const freq = freqByName.get(labelOf(t) ?? '');
          return a && b ? edge(a, b, `pt${i}`, 13, 17, freq) : null;
        })}
        {t2p.map(([t, p], i) => {
          const a = pos.get(key('t', t)), b = pos.get(key('p', p));
          const freq = freqByName.get(labelOf(t) ?? '');
          return a && b ? edge(a, b, `tp${i}`, 17, 13, freq) : null;
        })}

        {/* Places: circles. The initial and final marking carry a token. */}
        {net.places.map((pl: any, i: number) => {
          const p = pos.get(key('p', i));
          if (!p) return null;
          const marked = net.initial_marking?.includes(i) || net.final_marking?.includes(i);
          return (
            <g key={`p${i}`} transform={`translate(${p.x},${p.y})`}>
              <circle cx={13} cy={13} r={12} fill="var(--bg)"
                      stroke={pl.kind === 'derived' ? 'var(--border)' : 'var(--accent)'}
                      strokeWidth={pl.kind === 'derived' ? 1.4 : 2.2} />
              {marked && <circle cx={13} cy={13} r={4.5} fill="var(--accent)" />}
              <text x={13} y={38} fontSize={8.5} textAnchor="middle" fill="var(--text-dim)">
                {pl.id}
              </text>
            </g>
          );
        })}

        {/* Transitions: rectangles, colored from the host registry. Filled
            with an accent tint scaled by execution frequency when a source
            log could be traced — a plain outline when it couldn't (e.g. no
            ancestor log survives, or the net has no activities left to
            query), the same as before this view knew about frequency at
            all. */}
        {(net.activities ?? []).map((a: number) => {
          const p = pos.get(key('t', a));
          if (!p) return null;
          const label = labelOf(a);
          // A silent (tau) transition has no activity identity — nothing to
          // select, color by, or look up frequency for — so it is drawn as
          // the small filled square Petri net tools use for it, rather than
          // a mislabelled activity box.
          if (label == null) {
            return (
              <g key={`t${a}`} transform={`translate(${p.x},${p.y})`}>
                <rect x={13} y={7} width={20} height={20} fill="var(--text-dim)" />
              </g>
            );
          }
          const name = label;
          const selected = isSel(name);
          const freq = freqByName.get(name);
          const t = freq != null ? freq / maxFreq : null;
          const fill = t != null
            ? `color-mix(in srgb, var(--accent) ${Math.round(8 + t * 55)}%, var(--bg))`
            : 'var(--bg)';
          return (
            <g key={`t${a}`} transform={`translate(${p.x},${p.y})`} style={{ cursor: 'pointer' }}
               onClick={() => selectionBus.set(
                 selected ? [] : [{ artifactId: artifact.id, kind: 'activity', id: name }], panelId)}>
              <rect width={46} height={34} rx={3} fill={fill}
                    stroke={selected ? 'var(--accent)' : colorRegistry.get('activity', name)}
                    strokeWidth={selected ? 2.5 : 1.8} />
              <title>{freq != null ? `${name} — ${fmtCount(freq)} executions` : name}</title>
              <text x={23} y={15} fontSize={8} textAnchor="middle" fill="var(--text)">
                {name.length > 8 ? name.slice(0, 7) + '…' : name}
              </text>
              {freq != null && (
                <text x={23} y={27} fontSize={7.5} textAnchor="middle" fill="var(--text-dim)">
                  {fmtCount(freq)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

import { artifactTypes } from '../host/artifact/registry';
import { artifactFocus } from '../host/services/focus';
import type { Artifact, ProvenanceGraph } from '../host/artifact/types';

/**
 * Breadcrumb bar for a panel.
 *
 * The path is not a folder path — there are no folders — it is the artifact's
 * derivation chain read out of the provenance DAG: the log it came from, what
 * was derived from that, and finally this panel's view. That answers "where am
 * I" with the only hierarchy the model actually has, and it puts the artifact
 * name back on screen now that the tab no longer carries it.
 *
 * The DAG allows several inputs; the crumb follows the first, and a node with
 * more than one input says so rather than pretending the chain is linear. The
 * Provenance view remains the place where the full graph is shown.
 */
export function Breadcrumbs({
  artifact, graph, viewLabel,
}: {
  artifact: Artifact;
  graph: ProvenanceGraph;
  viewLabel: string;
}) {
  const chain: Array<{ a: Artifact; merged: boolean }> = [];
  const seen = new Set<string>();
  let cur: Artifact | undefined = artifact;
  // Depth-capped: a cycle cannot occur in a DAG, but a corrupted catalog
  // must not be able to hang the shell.
  while (cur && !seen.has(cur.id) && chain.length < 8) {
    seen.add(cur.id);
    chain.unshift({ a: cur, merged: (cur.inputs?.length ?? 0) > 1 });
    cur = cur.inputs?.[0] ? graph.artifacts[cur.inputs[0]] : undefined;
  }

  return (
    <div className="crumbs">
      {chain.map(({ a, merged }, i) => (
        <span key={a.id} className="crumb-item">
          {i > 0 && <span className="crumb-sep">›</span>}
          <button
            className={'crumb' + (a.id === artifact.id ? ' current' : '')}
            onClick={() => artifactFocus.request(a.id)}
            title={artifactTypes.get(a.type).label}
          >
            <span className="crumb-kind">{artifactTypes.get(a.type).shortLabel}</span>
            {a.name}
          </button>
          {merged && <span className="crumb-merge" title="has more than one input">+</span>}
        </span>
      ))}
      <span className="crumb-sep">›</span>
      <span className="crumb view">{viewLabel}</span>
    </div>
  );
}

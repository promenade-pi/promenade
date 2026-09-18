import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Artifact } from '../../host/artifact/types';
import type { ParamSchema } from '../../host/actions/types';
import { actionRegistry, defaultParams } from '../../host/actions/registry';
import { viewRegistry } from '../../host/views/registry';
import type { Destination } from '../../host/views/destinations';
import { ParamControls } from '../ParamControls';

/**
 * Sets a destination's parameters before it runs.
 *
 * The gallery's normal contract is "click, and refine afterwards" — a mined
 * model opens with declared defaults and every knob stays live in the
 * Inspector, which is faster than filling a form to see anything at all. Two
 * cases break that contract, and this dialog is for both:
 *
 * An **export** has no afterwards. It produces no artifact and opens no panel,
 * so a click that silently downloads OCEL-as-JSON has already decided the one
 * thing the user wanted to decide, and there is nowhere left to change it.
 *
 * And a **settings badge** on any card was previously a dead end: it announced
 * "4 settings" and gave no way to reach them, because the way to reach them is
 * a panel that does not exist until the thing has already run once.
 *
 * Deliberately the same `ParamControls` the Inspector draws, against the same
 * schema, resolved against the same artifact — so a data-bound choice (an
 * object type, an activity) offers exactly what it would offer afterwards,
 * rather than a second, thinner form that happens to look similar.
 */
export function DestinationSettings({ destination, artifact, onCancel, onSubmit }: {
  destination: Destination;
  artifact: Artifact;
  onCancel: () => void;
  /** `producerId` is set only when the user changed the prerequisite's producer. */
  onSubmit: (params: Record<string, unknown>, producerId?: string) => void;
}) {
  const schema: ParamSchema | undefined = useMemo(() => (
    destination.actionId
      ? actionRegistry.get(destination.actionId)?.params
      : destination.viewId
        ? viewRegistry.get(destination.viewId)?.params
        : undefined
  ), [destination]);

  const [params, setParams] = useState<Record<string, unknown>>(
    () => defaultParams(schema ?? { type: 'object', properties: {} }),
  );

  /**
   * A host-planned prerequisite with more than one candidate producer.
   *
   * Only ever offered for `plannedByHost` steps. A `scans` step names its
   * producer in the manifest, and that naming is load-bearing rather than
   * incidental: metro-map reads the `avgSecs` that `core.discover.ocdfg`
   * emits and pm4py's OC-DFG does not, so swapping producers there would
   * silently blank its Performance edge labels. If a plugin wants to offer
   * that choice it should say so in its manifest; the gallery must not
   * overrule an author who named one.
   */
  const step = destination.chain?.[0];
  const swappable = step?.plannedByHost && step.alternatives.length > 0 ? step : undefined;
  const [producerId, setProducerId] = useState<string>(step?.producerId ?? '');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  if (!schema) return null;

  const verb = destination.kind === 'export' ? 'Download'
    : destination.kind === 'view' ? 'Open'
    : 'Run';

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className="modal gal-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${destination.title} settings`}
      >
        <div className="gal-settings-head">
          <div className="modal-title">{destination.title}</div>
          <p className="gal-settings-sub">
            {destination.kind === 'export'
              ? 'Choose what to write, then download.'
              // Worth saying plainly: the dialog is a shortcut, not the only
              // way in, and the live loop is the better one for anything that
              // takes a while to compute.
              : 'These can also be changed live in the Inspector once it opens.'}
          </p>
        </div>

        <div className="gal-settings-body">
        {swappable && (
          <label className="gal-settings-field">
            <span>Prerequisite</span>
            <select value={producerId} onChange={(e) => setProducerId(e.target.value)}>
              <option value={swappable.producerId}>
                {swappable.producerLabel}{swappable.producerPlugin ? ` · ${swappable.producerPlugin}` : ''}
              </option>
              {swappable.alternatives.map((alt) => (
                <option key={alt.id} value={alt.id}>
                  {alt.label}{alt.pluginLabel ? ` · ${alt.pluginLabel}` : ''}
                </option>
              ))}
            </select>
            <small>
              Runs first to produce the {swappable.typeLabel} this needs. Your choice is
              remembered for every {swappable.typeLabel} the gallery has to build.
            </small>
          </label>
        )}

        <ParamControls
          schema={schema}
          values={params}
          optionArtifact={artifact}
          onChange={(key, value) => setParams((prev) => ({ ...prev, [key]: value }))}
        />
        </div>

        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button
            className="primary"
            onClick={() => onSubmit(params, swappable ? producerId : undefined)}
          >
            {verb}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

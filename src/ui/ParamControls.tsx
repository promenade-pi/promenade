import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { ParamCondition, ParamSchema } from '../host/actions/types';
import type { Artifact } from '../host/artifact/types';
import { OptionPicker } from './OptionPicker';
import {
  clampRangeHandle, epochAtPercent, keyboardPercent, percentAtEpoch, pointerPercent,
  type RangeHandle,
} from './views/rangeMath';

function epoch(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'bigint') return Number(value);
  // DuckDB metadata can reach the catalog as a number of seconds, a number
  // of milliseconds, or either representation encoded as text. `Date.parse`
  // does not parse those numeric epochs, which silently selected the old text
  // input fallback instead of the range slider for XES logs.
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== '') {
    return Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric;
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function dateValue(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The rail's own percent math (`rangeMath.ts`) degenerates whenever the
 * artifact's full time bounds collapse to a single instant (`lower ===
 * upper`): `percentAtEpoch` divides by a zero span and pins both thumbs to
 * 0%, and the end thumb's higher z-index then swallows every pointer event
 * meant for the start thumb — a slider that looks interactive but silently
 * never commits a different value. That case gets a disabled single-point
 * render instead (see `TimeRangeControl`).
 *
 * Short of that, a log whose full range sits inside one calendar day (or
 * whose two committed handles do) is still perfectly draggable — but
 * `dateValue` truncates to a bare date, so both ends print the same string
 * and dragging *looks* broken even though the underlying epoch is moving.
 * Granularity switches to minute precision whenever both ends fall on the
 * same calendar day, which is the only condition that actually predicts the
 * date-only label going ambiguous.
 */
function sameCalendarDay(a: number, b: number): boolean {
  return dateValue(a) === dateValue(b);
}
function formatByGranularity(ms: number, minuteGranularity: boolean): string {
  return minuteGranularity ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : dateValue(ms);
}
/** The value handed to `onChange`: full precision when finer than a day, so the
 * committed instant round-trips exactly instead of collapsing to midnight. */
function commitByGranularity(ms: number, minuteGranularity: boolean): string {
  return minuteGranularity ? new Date(ms).toISOString() : dateValue(ms);
}

/** A reliable two-handle rail for Inspector controls. */
function InspectorTimeRangeSlider({
  start, end, startLabel, endLabel, onPreview, onCommit, disabled,
}: {
  start: number;
  end: number;
  startLabel: string;
  endLabel: string;
  onPreview: (handle: RangeHandle, value: number) => void;
  onCommit: (handle: RangeHandle, value: number) => void;
  disabled?: boolean;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const valuesRef = useRef<[number, number]>([start, end]);
  valuesRef.current = [start, end];
  const dragRef = useRef<{ handle: RangeHandle; pointerId: number; grabOffset: number } | null>(null);
  const valueAt = (clientX: number, grabOffset = 0) => {
    const rect = railRef.current?.getBoundingClientRect();
    return rect ? pointerPercent(clientX - grabOffset, rect.left, rect.width) : 0;
  };
  const move = (handle: RangeHandle, raw: number) => {
    const [currentStart, currentEnd] = valuesRef.current;
    const next = clampRangeHandle(handle, raw, currentStart, currentEnd);
    valuesRef.current = next;
    const value = handle === 'start' ? next[0] : next[1];
    onPreview(handle, value);
    return value;
  };
  const pointerDown = (handle: RangeHandle, e: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    e.preventDefault();
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect) return;
    const current = handle === 'start' ? valuesRef.current[0] : valuesRef.current[1];
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      handle,
      pointerId: e.pointerId,
      // Keep the grabbed point stable so pressing a thumb does not nudge it.
      grabOffset: e.clientX - (rect.left + current / 100 * rect.width),
    };
  };
  const pointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (drag && drag.pointerId === e.pointerId) move(drag.handle, valueAt(e.clientX, drag.grabOffset));
  };
  const pointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const value = move(drag.handle, valueAt(e.clientX, drag.grabOffset));
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    onCommit(drag.handle, value);
  };
  const keyDown = (handle: RangeHandle, e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const current = handle === 'start' ? valuesRef.current[0] : valuesRef.current[1];
    const raw = keyboardPercent(e.key, current, e.shiftKey);
    if (raw == null) return;
    e.preventDefault();
    onCommit(handle, move(handle, raw));
  };
  const thumb = (handle: RangeHandle, value: number, label: string) => (
    <button type="button" className={`tf-time-thumb tf-time-thumb--${handle}`} style={{ left: `${value}%` }}
      role="slider" aria-label={`${handle === 'start' ? 'Start' : 'End'} of time range`}
      aria-valuemin={handle === 'start' ? 0 : start} aria-valuemax={handle === 'start' ? end : 100}
      aria-valuenow={value} aria-valuetext={label} disabled={disabled}
      onPointerDown={(e) => pointerDown(handle, e)} onPointerMove={pointerMove} onPointerUp={pointerUp}
      onPointerCancel={() => { dragRef.current = null; }} onKeyDown={(e) => keyDown(handle, e)} />
  );
  return (
    <div ref={railRef} className="tf-dual-range tf-time-range time-range-slider">
      <span className="tf-dual-rail" />
      <span className="tf-dual-selected" style={{ left: `${start}%`, right: `${100 - end}%` }} />
      {thumb('start', start, startLabel)}
      {thumb('end', end, endLabel)}
    </div>
  );
}

/**
 * A two-ended slider cannot be expressed by two unrelated `input[type=range]`
 * controls: their valid ends and their labels have to move together.  It is
 * still host-rendered, however, so third-party views get an Inspector-native
 * range picker without acquiring a way to inject arbitrary UI into the app.
 */
function TimeRangeControl({
  keyName, property, values, artifact, onChange, disabled,
}: {
  keyName: string;
  property: import('../host/actions/types').ParamProperty;
  values: Record<string, unknown>;
  artifact: Artifact | null | undefined;
  onChange: (key: string, value: unknown, cheap: boolean) => void;
  disabled?: boolean;
}) {
  const endKey = property.rangeEnd;
  const range = (artifact?.meta as any)?.timeRange;
  const fullStart = epoch(range?.[0]);
  const fullEnd = epoch(range?.[1]);
  // Keep hooks unconditional: the Inspector can change from an undated
  // artifact (text fallback) to a dated log without remounting this control.
  const [draft, setDraft] = useState<[number, number] | null>(null);
  const draftRef = useRef<[number, number] | null>(null);
  useEffect(() => {
    setDraft(null);
    draftRef.current = null;
  }, [keyName, endKey, fullStart, fullEnd, values[keyName], values[endKey]]);
  // Logs without dated events retain the useful manual ISO text inputs below.
  if (fullStart == null || fullEnd == null || !endKey) {
    return (
      <>
        <label className="param" key={keyName}>
          <span className="param-label">{property.title ?? keyName}</span>
          <input type="text" value={String(values[keyName] ?? property.default ?? '')} disabled={disabled}
                 onChange={(e) => onChange(keyName, e.target.value, !!property.cheap)} />
        </label>
        {endKey && <label className="param" key={endKey}>
          <span className="param-label">Until time</span>
          <input type="text" value={String(values[endKey] ?? '')} disabled={disabled}
                 onChange={(e) => onChange(endKey, e.target.value, !!property.cheap)} />
        </label>}
      </>
    );
  }

  const lower = Math.min(fullStart, fullEnd);
  const upper = Math.max(fullStart, fullEnd);
  const savedStart = epoch(values[keyName]);
  const savedEnd = epoch(values[endKey]);

  // The whole log resolves to a single instant: there is no narrower window
  // to drag toward, and the rail's percent math cannot represent one either
  // (see `formatByGranularity`'s doc comment). A disabled two-handle rail
  // that silently ignores every drag reads as broken; a plain readout is
  // honest about there being nothing left to pick.
  if (upper <= lower) {
    return (
      <div className="param time-range-param">
        <span className="param-label">{property.title ?? keyName}</span>
        <div className="time-range-current" aria-live="polite"><span>{formatByGranularity(lower, true)}</span></div>
        <span className="param-hint">Every event in this log falls at this instant — there is no narrower range to select.</span>
        {property.description && <span className="param-hint">{property.description}</span>}
      </div>
    );
  }

  const fine = sameCalendarDay(lower, upper);
  const start = Math.max(lower, Math.min(savedStart ?? lower, upper));
  const end = Math.max(start, Math.min(savedEnd ?? upper, upper));
  const storedStart = percentAtEpoch(lower, upper, start);
  const storedEnd = percentAtEpoch(lower, upper, end);
  const sliderStart = draft?.[0] ?? storedStart;
  const sliderEnd = draft?.[1] ?? storedEnd;
  const preview = (handle: RangeHandle, value: number) => {
    const current = draftRef.current ?? [sliderStart, sliderEnd] as [number, number];
    const next = clampRangeHandle(handle, value, current[0], current[1]);
    draftRef.current = next;
    setDraft(next);
  };
  const commit = (handle: RangeHandle, value: number) => {
    const next = clampRangeHandle(handle, value, sliderStart, sliderEnd);
    draftRef.current = null;
    setDraft(null);
    const epoch = epochAtPercent(lower, upper, handle === 'start' ? next[0] : next[1]);
    onChange(handle === 'start' ? keyName : endKey, commitByGranularity(epoch, fine), !!property.cheap);
  };

  return (
    <div className="param time-range-param">
      <span className="param-label">{property.title ?? keyName}</span>
      <div className="time-range-current" aria-live="polite">
        <span>{formatByGranularity(epochAtPercent(lower, upper, sliderStart), fine)}</span>
        <span>to</span>
        <span>{formatByGranularity(epochAtPercent(lower, upper, sliderEnd), fine)}</span>
      </div>
      <InspectorTimeRangeSlider start={sliderStart} end={sliderEnd}
        startLabel={formatByGranularity(epochAtPercent(lower, upper, sliderStart), fine)}
        endLabel={formatByGranularity(epochAtPercent(lower, upper, sliderEnd), fine)}
        onPreview={preview} onCommit={commit} disabled={disabled} />
      <div className="time-range-ends"><span>{formatByGranularity(lower, fine)}</span><span>{formatByGranularity(upper, fine)}</span></div>
      <button className="time-range-reset" type="button" disabled={disabled || (savedStart == null && savedEnd == null)}
              onClick={() => { onChange(keyName, '', !!property.cheap); onChange(endKey, '', !!property.cheap); }}>
        Full time range
      </button>
      {property.description && <span className="param-hint">{property.description}</span>}
    </div>
  );
}

/**
 * Parameter controls rendered by the host from the action's JSON Schema.
 *
 * This is why the schema lives in the manifest instead of the plugin shipping
 * its own UI: a plugin-supplied control cannot sit in the inspector column and
 * cannot be re-run on every input event, which is what makes the live loop
 * possible at all. Stage 2 — a plugin drawing its own interaction — remains
 * possible but deliberately not the path of least resistance.
 */
/**
 * Whether a `showWhen` condition currently holds. A malformed condition
 * (rejected at install time, so this is belt and braces) shows the control
 * rather than hiding it: a parameter the user cannot reach is the worse
 * failure of the two.
 */
function conditionHolds(
  c: ParamCondition, values: Record<string, unknown>, meta: Record<string, unknown> | undefined,
): boolean {
  const has = (k: 'param' | 'artifactMeta') => typeof c[k] === 'string';
  if (has('param') === has('artifactMeta')) return true; // names zero or both sources
  const actual = has('param') ? values[c.param!] : meta?.[c.artifactMeta!];
  if (c.oneOf !== undefined) return Array.isArray(c.oneOf) && c.oneOf.some((v) => Object.is(v, actual));
  if (c.equals !== undefined) return Object.is(c.equals, actual);
  if (c.notEquals !== undefined) return !Object.is(c.notEquals, actual);
  return true; // no comparator
}

export function ParamControls({
  schema, values, onChange, disabled, optionArtifact,
}: {
  schema: ParamSchema;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown, cheap: boolean) => void;
  disabled?: boolean;
  /** Artifact the data-bound options are read from. */
  optionArtifact?: Artifact | null;
}) {
  return (
    <div>
      {Object.entries(schema.properties).map(([key, p]) => {
        const v = values[key] ?? p.default;
        // Some data-bound choices only exist on one relational shape: an
        // OCEL has object types, while a traditional event log deliberately
        // does not. Hiding such a control is clearer than rendering a picker
        // whose query necessarily has no table to read.
        if (p.onlyFor && (!optionArtifact || !p.onlyFor.includes(optionArtifact.type))) return null;
        // A parameter that cannot mean anything here is not rendered at all
        // — see `ParamCondition`. Values are kept, so it comes back as it was.
        if (p.showWhen) {
          const conds = Array.isArray(p.showWhen) ? p.showWhen : [p.showWhen];
          if (!conds.every((c) => conditionHolds(c, values, optionArtifact?.meta))) return null;
        }
        const title = optionArtifact?.type === 'ObjectCentricEventLog'
          ? (p.objectCentricTitle ?? p.title ?? key)
          : (p.title ?? key);

        // `timeRangeEnd` is rendered as part of its preceding range picker.
        if (p.control === 'timeRangeEnd') return null;

        if (p.control === 'timeRange') {
          return <TimeRangeControl key={key} keyName={key} property={p} values={values}
                                   artifact={optionArtifact} onChange={onChange} disabled={disabled} />;
        }

        // Data-bound options: the host runs the query and renders the picker,
        // so a parameter like "which event types" needs no plugin-side UI.
        if (p.optionsFrom) {
          return (
            <label className="param" key={key}>
              <span className="param-label">{title}</span>
              <OptionPicker
                source={p.optionsFrom}
                artifact={optionArtifact ?? null}
                multiple={p.type === 'array'}
                value={v as any}
                disabled={disabled}
                defaultFromOptions={p.defaultFromOptions}
                onChange={(nv) => onChange(key, nv, !!p.cheap)}
              />
              {p.description && <span className="param-hint">{p.description}</span>}
            </label>
          );
        }

        if (p.type === 'array') return null; // free-form lists are not rendered yet

        if (p.type === 'file') {
          return (
            <label className="param" key={key}>
              <span className="param-label">{title}</span>
              <input
                type="file"
                accept={p.accept}
                disabled={disabled}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  file.text().then((text) => onChange(key, text, !!p.cheap));
                }}
              />
              {p.description && <span className="param-hint">{p.description}</span>}
            </label>
          );
        }

        if (p.enum) {
          // Positional labels, all or nothing: a mismatched list is dropped
          // rather than applied to the entries it happens to cover, which
          // would read as if the rest were a different kind of option.
          const labels = p.enumLabels?.length === p.enum.length ? p.enumLabels : null;
          return (
            <label className="param" key={key}>
              <span className="param-label">{title}</span>
              <select
                value={String(v)}
                disabled={disabled}
                onChange={(e) => onChange(key, e.target.value, !!p.cheap)}
              >
                {p.enum.map((o, i) => (
                  <option key={String(o)} value={String(o)}>{labels ? labels[i] : String(o)}</option>
                ))}
              </select>
              {p.description && <span className="param-hint">{p.description}</span>}
            </label>
          );
        }

        if (p.type === 'number' || p.type === 'integer') {
          const min = p.minimum ?? 0;
          const schemaMax = p.maximum ?? 100;
          // A safety-ceiling param (`maxFrom`) is bounded by the schema's
          // `maximum` at manifest time, which has to be big enough for the
          // largest log the host ever sees — meaningless as a slider's top
          // end on a smaller one, where every value past the log's own count
          // does exactly the same thing as the log's own count.
          const fromLog = p.maxFrom ? Number((optionArtifact?.meta as any)?.[p.maxFrom]) : NaN;
          const total = Number.isFinite(fromLog) && fromLog > 0 ? fromLog : null;
          const capped = total != null && total < schemaMax;
          const max = capped ? total : schemaMax;
          // The slider's own max being sensible (`capped`) says nothing about
          // whether the *current* value actually covers this log — that only
          // matters once it sits below the log's real count, which is the one
          // case worth interrupting for: a silent prefix truncation, with a
          // real fix (filter the log down to what you meant to include) one
          // click away in "Transform log", not just "raise the number".
          const exceeds = total != null && Number(v) < total;
          return (
            <label className="param" key={key}>
              <span className="param-label">
                {title}
                <b>{String(v)}</b>
              </span>
              <input
                type="range"
                min={min} max={max}
                step={p.multipleOf ?? (p.type === 'integer' ? 1 : 0.01)}
                value={Number(v)}
                disabled={disabled}
                // `input`, not `change`: the loop is meant to follow the drag.
                onInput={(e) => onChange(key, Number((e.target as HTMLInputElement).value), !!p.cheap)}
              />
              {p.description && <span className="param-hint">{p.description}</span>}
              {exceeds ? (
                <span className="param-hint param-hint-warn">
                  This log has {total!.toLocaleString()} {p.maxFrom} — only {Number(v).toLocaleString()} will
                  be used, in log order. Filter the log first ("Transform log") for a chosen subset instead
                  of an arbitrary prefix.
                </span>
              ) : capped && (
                <span className="param-hint">Capped at {max.toLocaleString()} — that is all this log has.</span>
              )}
            </label>
          );
        }

        if (p.type === 'boolean') {
          return (
            <label className="param param-inline" key={key}>
              <input
                type="checkbox" checked={!!v} disabled={disabled}
                onChange={(e) => onChange(key, e.target.checked, !!p.cheap)}
              />
              <span>{title}</span>
            </label>
          );
        }

        return (
          <label className="param" key={key}>
            <span className="param-label">{title}</span>
            <input
              type="text" value={String(v ?? '')} disabled={disabled}
              onChange={(e) => onChange(key, e.target.value, !!p.cheap)}
            />
            {p.description && <span className="param-hint">{p.description}</span>}
          </label>
        );
      })}
    </div>
  );
}

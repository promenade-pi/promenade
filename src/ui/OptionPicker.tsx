import { useEffect, useMemo, useState } from 'react';
import type { OptionSource } from '../host/actions/types';
import { loadOptions, type Option } from '../host/actions/options';
import { colorRegistry } from '../host/services/colors';
import type { Artifact } from '../host/artifact/types';
import { fmtCount } from './format';

/**
 * Host-rendered picker for data-bound parameter options.
 *
 * Exists so that "select an event type" does not force a plugin to ship its
 * own interface. A log can have hundreds of activities — aoe2 has 829 — so a
 * plain dropdown is not enough either: this searches, shows frequencies, and
 * takes its colors from the host registry so the same activity looks the same
 * here as in every panel beside it.
 */
export function OptionPicker({
  source, artifact, multiple, value, onChange, disabled, defaultFromOptions,
}: {
  source: OptionSource;
  artifact: Artifact | null;
  multiple: boolean;
  value: string[] | string | undefined;
  onChange: (v: string[] | string) => void;
  disabled?: boolean;
  /** Lets a data-bound case notion choose the most frequent available type. */
  defaultFromOptions?: 'first';
}) {
  const [options, setOptions] = useState<Option[] | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let canceled = false;
    if (!artifact) { setOptions([]); return; }
    setOptions(null);
    loadOptions(source, artifact).then((o) => !canceled && setOptions(o));
    return () => { canceled = true; };
  }, [artifact?.id, source.sql]);

  // Some data-bound controls have a meaningful neutral value (a multi-select
  // filter); a case notion does not. Pick the query's first, frequency-sorted
  // option only when the caller opted in and no saved value exists yet.
  useEffect(() => {
    if (defaultFromOptions !== 'first' || multiple || !options?.length || value) return;
    onChange(options[0].value);
  }, [defaultFromOptions, multiple, onChange, options, value]);

  const selected = useMemo(
    () => new Set(multiple ? (Array.isArray(value) ? value : []) : value ? [String(value)] : []),
    [value, multiple]
  );

  const shown = useMemo(() => {
    if (!options) return [];
    const q = query.trim().toLowerCase();
    const matching = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
    // Selected entries stay visible even when they do not match the search,
    // otherwise a filter can hide what the user already chose.
    const extra = options.filter((o) => selected.has(o.value) && !matching.includes(o));
    return [...extra, ...matching].slice(0, 300);
  }, [options, query, selected]);

  if (options === null) {
    return <div className="param-hint">loading options…</div>;
  }
  if (options.length === 0) {
    return <div className="param-hint">No options available for this artifact.</div>;
  }

  const toggle = (v: string) => {
    if (!multiple) { onChange(v); return; }
    const next = new Set(selected);
    next.has(v) ? next.delete(v) : next.add(v);
    onChange([...next]);
  };

  return (
    <div className="picker">
      {options.length > 8 && (
        <input
          className="picker-search"
          type="search"
          placeholder={`Search ${options.length} options…`}
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      {multiple && (
        <div className="picker-actions">
          <button disabled={disabled} onClick={() => onChange(shown.map((o) => o.value))}>
            Select shown
          </button>
          <button disabled={disabled} onClick={() => onChange([])}>Clear</button>
          <span className="param-hint">
            {selected.size === 0 ? 'none selected — all included' : `${selected.size} selected`}
          </span>
        </div>
      )}

      <div className="picker-list">
        {shown.map((o) => (
          <label key={o.value} className={`picker-row${selected.has(o.value) ? ' sel' : ''}`}>
            <input
              type={multiple ? 'checkbox' : 'radio'}
              checked={selected.has(o.value)}
              disabled={disabled}
              onChange={() => toggle(o.value)}
            />
            {source.colorDomain && (
              <span className="swatch"
                    style={{ background: colorRegistry.get(source.colorDomain, o.value) }} />
            )}
            <span className="picker-label">{o.label}</span>
            {o.count != null && <span className="picker-count">{fmtCount(o.count)}</span>}
          </label>
        ))}
        {shown.length === 0 && <div className="param-hint">No match.</div>}
      </div>
    </div>
  );
}

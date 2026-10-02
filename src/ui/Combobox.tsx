import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ComboboxOption {
  value: string;
  /** Right-aligned, dimmed: a count, a type. */
  detail?: string;
}

const Chevron = () => (
  <svg className="combobox-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * Picks a value from the data, replacing `<datalist>`.
 *
 * The browser's datalist filters its suggestions by whatever the field
 * already holds, so the moment an attribute has been picked the list shrinks
 * to that one entry and the others can't be browsed any more — exactly when
 * someone opens it to change their mind. Both forms here list every option on
 * open, with the current one ticked and scrolled into view.
 *
 * Two forms, because two different questions are being asked:
 *
 * - `strict` — "which of the log's X?" (an attribute to filter on, an
 *   activity to keep). Anything else would silently do nothing, so it looks
 *   and acts like a `<select>`: a button showing the choice, and a search box
 *   inside the open list. A saved value the log no longer has stays shown,
 *   flagged, rather than vanishing.
 * - free (default) — "type a value; here is what exists" (a merge target that
 *   may be a new name, a "contains" fragment). A text field, with a chevron
 *   that says suggestions exist; typing filters them.
 *
 * The list is portalled to `body` with fixed positioning, so an operation
 * card's or panel's `overflow` can't clip it.
 */
export function Combobox({
  value, options, onChange, onFocus, placeholder, ariaLabel, invalid, className, style,
  strict = false, missingLabel = 'not in this log', maxOptions = 300,
}: {
  value: string;
  options: ComboboxOption[];
  onChange: (v: string) => void;
  /** Free form only: runs before the list opens, e.g. to pre-fill and select a suggested value. */
  onFocus?: (e: ReactFocusEvent<HTMLInputElement>) => void;
  placeholder?: string;
  ariaLabel?: string;
  invalid?: boolean;
  className?: string;
  style?: CSSProperties;
  strict?: boolean;
  /** Strict form: how a current value that isn't among the options is flagged. */
  missingLabel?: string;
  maxOptions?: number;
}) {
  const [open, setOpen] = useState(false);
  // Null until the user types after opening: an untouched list shows everything.
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const missing = strict && !!value && options.length > 0 && !options.some((o) => o.value === value);
  const allOptions = useMemo(
    () => (missing ? [{ value, detail: missingLabel }, ...options] : options),
    [missing, value, missingLabel, options],
  );
  const shown = useMemo(() => {
    const q = query?.trim().toLowerCase();
    const filtered = q ? allOptions.filter((o) => o.value.toLowerCase().includes(q)) : allOptions;
    return filtered.slice(0, maxOptions);
  }, [allOptions, query, maxOptions]);

  const openList = () => {
    setQuery(null);
    setOpen(true);
    setActive(allOptions.findIndex((o) => o.value === value));
  };
  const close = (refocus = false) => {
    setOpen(false); setQuery(null); setActive(-1);
    if (refocus && strict) triggerRef.current?.focus();
  };
  const pick = (v: string) => { onChange(v); close(true); };

  // Follow the anchor while open: the editor scrolls and panels resize.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => anchorRef.current && setRect(anchorRef.current.getBoundingClientRect());
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); };
  }, [open]);

  useEffect(() => {
    if (open && strict) searchRef.current?.focus();
  }, [open, strict, rect != null]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!anchorRef.current?.contains(t) && !popRef.current?.contains(t)) close();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active, rect]);

  /** Shared by the free field and the strict search box. */
  const onListKeys = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { openList(); return; }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (shown.length ? (i + step + shown.length) % shown.length : -1));
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      if (active >= 0 && shown[active]) pick(shown[active].value); else close(true);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      close();
    }
  };

  // Below the anchor unless that runs off the window, then above it.
  const below = rect ? window.innerHeight - rect.bottom : 0;
  const placeAbove = rect ? below < 200 && rect.top > below : false;
  const searchHeight = strict ? 36 : 0;
  const popStyle: CSSProperties | undefined = rect ? {
    position: 'fixed',
    left: rect.left,
    minWidth: Math.max(rect.width, strict ? 220 : 0),
    maxWidth: Math.max(rect.width, 380),
    ...(placeAbove
      ? { bottom: window.innerHeight - rect.top + 2, maxHeight: Math.min(300, rect.top - 8) }
      : { top: rect.bottom + 2, maxHeight: Math.min(300, below - 8) }),
  } : undefined;
  const listMax = popStyle?.maxHeight != null ? Number(popStyle.maxHeight) - searchHeight - 8 : undefined;

  const list: ReactNode = (
    <ul ref={listRef} id={listId} role="listbox" className="combobox-options" style={{ maxHeight: listMax }}>
      {shown.length === 0
        ? <li className="combobox-empty">{strict ? 'No match' : `No match — “${query}” will be used as typed`}</li>
        : shown.map((o, i) => (
          <li
            key={o.value}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={o.value === value}
            className={`combobox-option${i === active ? ' active' : ''}${o.value === value ? ' current' : ''}${missing && o.value === value ? ' missing' : ''}`}
            // Keep focus where it is, so picking doesn't blur-close first.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => pick(o.value)}
            onPointerEnter={() => setActive(i)}
          >
            <span className="combobox-check" aria-hidden="true">{o.value === value ? '✓' : ''}</span>
            <span className="combobox-value" title={o.value}>{o.value === '' ? '(empty)' : o.value}</span>
            {o.detail && <small>{o.detail}</small>}
          </li>
        ))}
    </ul>
  );

  return (
    <>
      <span ref={anchorRef} className={`combobox${strict ? ' combobox--strict' : ''}${className ? ` ${className}` : ''}`} style={style}>
        {strict ? (
          <button
            ref={triggerRef}
            type="button"
            className={`combobox-trigger${missing || invalid ? ' invalid' : ''}`}
            aria-label={ariaLabel}
            aria-haspopup="listbox"
            aria-expanded={open}
            title={missing ? `“${value}” — ${missingLabel}` : value || undefined}
            onClick={() => (open ? close() : openList())}
            onKeyDown={(e) => {
              if ((e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') && !open) {
                e.preventDefault(); openList();
              } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !open) {
                // Typing on the closed select starts a search, as a native select jumps.
                e.preventDefault(); openList(); setQuery(e.key);
              }
            }}
          >
            <span className={value ? 'combobox-trigger-value' : 'combobox-placeholder'}>{value || placeholder || 'Choose…'}</span>
            <Chevron />
          </button>
        ) : (
          <>
            <input
              ref={inputRef}
              className="combobox-input"
              value={value}
              placeholder={placeholder}
              aria-label={ariaLabel}
              aria-invalid={invalid || undefined}
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
              autoComplete="off"
              onFocus={(e) => { onFocus?.(e); openList(); }}
              onClick={() => { if (!open) openList(); }}
              onChange={(e) => {
                onChange(e.target.value);
                setQuery(e.target.value);
                setOpen(true);
                setActive(-1);
              }}
              onKeyDown={onListKeys}
            />
            {options.length > 0 && (
              <button
                type="button" tabIndex={-1} className="combobox-toggle" aria-label="Show suggestions"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => { if (open) close(); else { inputRef.current?.focus(); openList(); } }}
              >
                <Chevron />
              </button>
            )}
          </>
        )}
      </span>
      {open && rect && (strict || options.length > 0) && createPortal(
        <div ref={popRef} className="combobox-pop" style={popStyle}>
          {strict && (
            <input
              ref={searchRef}
              className="combobox-search"
              placeholder="Search…"
              value={query ?? ''}
              aria-controls={listId}
              aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
              autoComplete="off"
              onChange={(e) => { setQuery(e.target.value); setActive(e.target.value ? 0 : -1); }}
              onKeyDown={onListKeys}
            />
          )}
          {list}
        </div>,
        document.body,
      )}
    </>
  );
}

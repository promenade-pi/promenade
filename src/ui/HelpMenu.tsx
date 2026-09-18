import { useEffect, useRef, useState, type ReactElement } from 'react';
import pkg from '../../package.json';
import { getPreference, setPreference, subscribe, THEME_LABEL, type ThemePreference } from './theme';

/** The project's own site — opened in a new tab so the workspace tab survives. */
const ABOUT_URL = 'https://promenade.run';

export function HelpIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true">
      <circle cx="10" cy="10" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M7.6 7.7c.2-1.15 1.2-1.95 2.4-1.95 1.35 0 2.4.9 2.4 2.05 0 1.4-1.55 1.6-2 2.55-.12.26-.18.58-.18.9"
        fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
      />
      <circle cx="10" cy="13.9" r=".95" fill="currentColor" stroke="none" />
    </svg>
  );
}

function WelcomeIcon() {
  return (
    <svg viewBox="0 0 20 20" width={16} height={16} aria-hidden="true">
      <path
        d="M10 2.5 11.4 6.9 15.9 6.9 12.3 9.6 13.6 14 10 11.2 6.4 14 7.7 9.6 4.1 6.9 8.6 6.9Z"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
      />
    </svg>
  );
}

function FeedbackIcon() {
  return (
    <svg viewBox="0 0 20 20" width={16} height={16} aria-hidden="true">
      <path
        d="M3 4.75h14v9.5H8.2L4.6 17V14.25H3Z"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round"
      />
      <path d="M6.3 8h7.4M6.3 10.9h4.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function AboutIcon() {
  return (
    <svg viewBox="0 0 20 20" width={16} height={16} aria-hidden="true">
      <circle cx="10" cy="10" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.1 10h13.8" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M10 2.75c2 2.1 3 4.55 3 7.25s-1 5.15-3 7.25c-2-2.1-3-4.55-3-7.25s1-5.15 3-7.25Z"
        fill="none" stroke="currentColor" strokeWidth="1.2"
      />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg viewBox="0 0 20 20" width={14} height={14} aria-hidden="true">
      <rect x="3" y="4.25" width="14" height="9.5" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7.2 16.5h5.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function LightIcon() {
  return (
    <svg viewBox="0 0 20 20" width={14} height={14} aria-hidden="true">
      <circle cx="10" cy="10" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M10 2.6v1.9M10 15.5v1.9M17.4 10h-1.9M4.5 10H2.6M15.23 4.77l-1.34 1.34M6.11 13.89l-1.34 1.34M15.23 15.23l-1.34-1.34M6.11 6.11 4.77 4.77"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"
      />
    </svg>
  );
}

function DarkIcon() {
  return (
    <svg viewBox="0 0 20 20" width={14} height={14} aria-hidden="true">
      <path
        d="M15.6 12.4A6.2 6.2 0 0 1 7.6 4.4a6.2 6.2 0 1 0 8 8Z"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
      />
    </svg>
  );
}

const THEME_OPTIONS: { value: ThemePreference; Icon: () => ReactElement }[] = [
  { value: 'system', Icon: SystemIcon },
  { value: 'light', Icon: LightIcon },
  { value: 'dark', Icon: DarkIcon },
];

/**
 * Appearance, as a three-way segmented control rather than a dark-mode
 * switch: "System" is a distinct choice from either fixed theme, and a
 * two-state toggle has nowhere to put it.
 *
 * The preference lives in `ui/theme.ts`, not in React state, because the
 * stamp it drives is applied before React exists (see `index.html`) and is
 * read by things outside the tree; this only mirrors it, and subscribes so a
 * change made elsewhere — or an OS flip under `system` — keeps the control
 * honest.
 */
function ThemePicker() {
  const [pref, setPref] = useState<ThemePreference>(getPreference);
  useEffect(() => subscribe((_resolved, next) => setPref(next)), []);

  return (
    <div className="help-menu-theme">
      <div className="help-menu-heading">Appearance</div>
      <div className="help-menu-segmented" role="group" aria-label="Appearance">
        {THEME_OPTIONS.map(({ value, Icon }) => (
          <button
            key={value}
            role="menuitemradio"
            aria-checked={pref === value}
            className={pref === value ? 'is-active' : ''}
            onClick={() => setPreference(value)}
          >
            <Icon /> <span>{THEME_LABEL[value]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Top-bar entry point for onboarding and support: reopens the welcome
 * dialog on demand, surfaces the installed app version, opens the feedback
 * dialog, links out to the project site, and carries the appearance setting.
 * Controlled from `App`, alongside `AgentControl` and the Compute popover, so
 * opening one closes the others — only the welcome dialog itself is lifted to
 * `App`, since more than one place may eventually want to open it.
 */
export function HelpMenu({
  open, onOpenChange, onOpenWelcome, onOpenFeedback,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenWelcome: () => void;
  onOpenFeedback: () => void;
}) {
  const setOpen = (next: boolean | ((prev: boolean) => boolean)) =>
    onOpenChange(typeof next === 'function' ? next(open) : next);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="help-topbar-control" ref={root} onMouseDown={(event) => event.stopPropagation()}>
      <button
        className={`help-topbar-button${open ? ' is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Help"
        aria-label="Help"
        aria-expanded={open}
      >
        <HelpIcon />
      </button>
      {open && (
        <div className="help-menu-popover" role="menu" aria-label="Help">
          <button
            className="help-menu-item"
            role="menuitem"
            onClick={() => { setOpen(false); onOpenWelcome(); }}
          >
            <WelcomeIcon /> <span>Welcome to Promenade</span>
          </button>
          <button
            className="help-menu-item"
            role="menuitem"
            onClick={() => { setOpen(false); onOpenFeedback(); }}
          >
            <FeedbackIcon /> <span>Send feedback…</span>
          </button>
          <a
            className="help-menu-item"
            role="menuitem"
            href={ABOUT_URL}
            target="_blank"
            rel="noreferrer noopener"
            onClick={() => setOpen(false)}
          >
            <AboutIcon /> <span>About Promenade</span>
          </a>
          <ThemePicker />
          <div className="help-menu-version">Promenade v{pkg.version}</div>
        </div>
      )}
    </div>
  );
}

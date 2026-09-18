/**
 * The app's colour scheme, as a preference plus the resolved answer.
 *
 * Three states rather than a boolean, because "follow the system" is a real
 * choice and not the absence of one: a user who never touches this setting
 * keeps tracking their OS all day, and a user who picks Light keeps Light
 * even after dusk flips the OS to dark.
 *
 * The stylesheet does the actual colour work (see the two palette blocks at
 * the top of `styles.css`); all this module does is stamp `data-theme` on
 * `<html>` so those selectors have something to key on, and tell interested
 * parties — the plugin frames, which are handed token values across a
 * message port rather than the stylesheet — when the answer changed.
 *
 * The same stamp is applied before first paint by the inline bootstrap in
 * `index.html`; keep the two in step, since the only thing worse than a
 * flash of the wrong theme is a flash that disagrees with what React then
 * renders.
 */
export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const KEY = 'promenade.theme';

const media = () => window.matchMedia('(prefers-color-scheme: dark)');

function loadPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === 'system' || raw === 'light' || raw === 'dark') return raw;
  } catch {}
  return 'system';
}

let preference: ThemePreference = loadPreference();

export function getPreference(): ThemePreference {
  return preference;
}

export function resolve(pref: ThemePreference = preference): ResolvedTheme {
  if (pref !== 'system') return pref;
  return media().matches ? 'dark' : 'light';
}

const listeners = new Set<(resolved: ResolvedTheme, pref: ThemePreference) => void>();

/**
 * Notified whenever the *resolved* theme changes — whether because the user
 * picked one or because the OS flipped underneath a `system` preference.
 * Callers that re-read computed token values (`PluginPanel`) need both, and
 * shouldn't have to watch the media query themselves to get the second.
 */
export function subscribe(fn: (resolved: ResolvedTheme, pref: ThemePreference) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function apply() {
  const resolved = resolve();
  const root = document.documentElement;
  root.dataset.theme = resolved;
  // Nothing else to switch: dockview's `--dv-*` colours are mapped onto the
  // same tokens in `styles.css`, so its chrome follows without a second theme
  // class to keep in step.
  for (const fn of listeners) fn(resolved, preference);
}

export function setPreference(next: ThemePreference) {
  preference = next;
  try { localStorage.setItem(KEY, next); } catch {}
  apply();
}

/**
 * Starts tracking the OS scheme. Called once from `main`; the listener is
 * never removed because the app owns the document for its whole lifetime.
 */
export function startTheme() {
  media().addEventListener('change', () => { if (preference === 'system') apply(); });
  apply();
}

export const THEME_LABEL: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

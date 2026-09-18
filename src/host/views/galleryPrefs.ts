/**
 * Pins and recents for the destination gallery.
 *
 * Deliberately *not* a computed "Recommended" ranking. A manifest cannot be
 * allowed to nominate itself — every author would set the flag — and a hidden
 * score the host invents is a black box a researcher can neither trust nor
 * correct. Both strips at the top of the gallery are therefore facts rather
 * than opinions: what you pinned, and what you last opened.
 *
 * Stored in `localStorage`, not the workspace's OPFS subtree, because a pin
 * is a preference about *capabilities* rather than about this particular set
 * of artifacts — the same reasoning that puts the theme preference there.
 * Keys are `Destination.key`, which carries no artifact id or version, so a
 * pin survives a reinstall and an upgrade.
 */

const PINS = 'promenade.gallery.pins';
const RECENT = 'promenade.gallery.recent';
const PRODUCERS = 'promenade.gallery.producers';
const RECENT_MAX = 12;

function read(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

function write(key: string, value: string[]) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

const listeners = new Set<() => void>();
function emit() { for (const fn of listeners) fn(); }

export function subscribeGalleryPrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function pinnedKeys(): string[] { return read(PINS); }

export function isPinned(key: string): boolean { return read(PINS).includes(key); }

export function togglePin(key: string): void {
  const current = read(PINS);
  write(PINS, current.includes(key) ? current.filter((k) => k !== key) : [...current, key]);
  emit();
}

export function recentKeys(): string[] { return read(RECENT); }

/** Most recent first, capped — the list is a reminder, not a history. */
export function noteOpened(key: string): void {
  write(RECENT, [key, ...read(RECENT).filter((k) => k !== key)].slice(0, RECENT_MAX));
  emit();
}

/**
 * Which action the planner should reach for when it needs an intermediate of
 * a given artifact type — `{ [artifactTypeId]: actionId }`.
 *
 * With two OC-DFG producers installed (the Rust one and pm4py's), the planner
 * otherwise picks by a rule the user cannot see: first-party first, then
 * fewest parameters. That rule is a reasonable default and a poor authority,
 * and which miner produced the model underneath a result is exactly the kind
 * of thing a process-mining researcher needs to own. So the preference wins
 * and the rule becomes the fallback — the same move that replaced a computed
 * "Recommended" strip with Pinned and Recent.
 *
 * Keyed by artifact type rather than by destination: the answer to "which
 * OC-DFG" is the same whoever is asking for one.
 */
function producers(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(PRODUCERS) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

export function preferredProducer(type: string): string | undefined {
  const value = producers()[type];
  return typeof value === 'string' ? value : undefined;
}

/** `undefined` clears the preference and returns the ranking to the default. */
export function setPreferredProducer(type: string, actionId: string | undefined): void {
  const next = { ...producers() };
  if (actionId) next[type] = actionId; else delete next[type];
  try { localStorage.setItem(PRODUCERS, JSON.stringify(next)); } catch {}
  emit();
}

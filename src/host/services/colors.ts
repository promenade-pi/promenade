/**
 * Color registry — a host service, deliberately not a view concern.
 *
 * If every view plugin picks its own colors, the same object type is blue in
 * one panel and orange in the panel beside it, and the two panels silently
 * disagree. Assignment therefore happens once, centrally, keyed by a stable
 * domain value. This cannot be retrofitted once several view plugins exist,
 * which is why it is here before any of them.
 *
 * Views ask for a color; they never choose one.
 */

/**
 * `artifactType` is a domain like any other: the tree needs a stable color per
 * artifact type, and a plugin-contributed type should get one without the host
 * knowing it in advance.
 */
export type ColorDomain = 'objectType' | 'activity' | 'qualifier' | 'artifactType';

/**
 * Okabe-Ito, which is color-vision-deficiency safe, extended with a few
 * distinguishable additions. Ordered so adjacent assignments stay far apart.
 */
const PALETTE = [
  '#0072B2', '#E69F00', '#009E73', '#CC79A7',
  '#56B4E9', '#D55E00', '#8E6C8A', '#4C9F70',
  '#B07AA1', '#8C564B', '#7F7F7F', '#17919B',
];

export interface ColorAssignment {
  value: string;
  color: string;
  index: number;
}

export class ColorRegistry {
  private maps = new Map<ColorDomain, Map<string, ColorAssignment>>();
  private listeners = new Set<() => void>();

  private domain(d: ColorDomain) {
    let m = this.maps.get(d);
    if (!m) { m = new Map(); this.maps.set(d, m); }
    return m;
  }

  /**
   * Stable across sessions and across panels: assignment is by first
   * appearance within a domain, and the registry is serialised with the
   * workspace so a reopened log keeps its colors.
   */
  get(domain: ColorDomain, value: string): string {
    const m = this.domain(domain);
    const hit = m.get(value);
    if (hit) return hit.color;
    const index = m.size;
    const color = PALETTE[index % PALETTE.length];
    m.set(value, { value, color, index });
    this.emit();
    return color;
  }

  /** Pre-seeds a domain so colors follow a meaningful order, not arrival order. */
  seed(domain: ColorDomain, values: string[]) {
    const m = this.domain(domain);
    for (const v of values) if (!m.has(v)) {
      const index = m.size;
      m.set(v, { value: v, color: PALETTE[index % PALETTE.length], index });
    }
    this.emit();
  }

  entries(domain: ColorDomain): ColorAssignment[] {
    return [...this.domain(domain).values()];
  }

  /** Explicit user override; survives serialisation like any other assignment. */
  set(domain: ColorDomain, value: string, color: string) {
    const m = this.domain(domain);
    m.set(value, { value, color, index: m.get(value)?.index ?? m.size });
    this.emit();
  }

  toJSON() {
    const out: Record<string, Record<string, string>> = {};
    for (const [d, m] of this.maps) {
      out[d] = Object.fromEntries([...m].map(([k, v]) => [k, v.color]));
    }
    return out;
  }

  loadJSON(data: Record<string, Record<string, string>>) {
    for (const [d, vals] of Object.entries(data ?? {})) {
      const m = this.domain(d as ColorDomain);
      for (const [value, color] of Object.entries(vals)) {
        m.set(value, { value, color, index: m.size });
      }
    }
    this.emit();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() { for (const l of this.listeners) l(); }
}

export const colorRegistry = new ColorRegistry();

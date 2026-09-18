/**
 * Layouts as named, serialisable objects.
 *
 * Only the *representation* is built now — no layout manager, no layout UI.
 * The point is that panel arrangement lives in a value that can be stored,
 * diffed and contributed, rather than as implicit state inside the docking
 * manager. That keeps saved user layouts and plugin-contributed layouts
 * (declared as JSON in a manifest, never as code) reachable later without a
 * rewrite.
 *
 * Panel geometry always belongs to the host. A layout says which panels exist
 * and roughly how they relate; plugins describe, they never arrange.
 */

import type { ArtifactTypeId } from '../artifact/types';

export interface PanelSpec {
  /**
   * View id, resolved through the view registry — or `'$primary'`, resolved
   * at apply time to whichever registered view is `primary` for the panel's
   * artifact type (falling back to plain registration order, same as
   * `openArtifact`'s own candidate-picking). Lets a layout say "this type's
   * canonical view" without hardcoding an id that might belong to a plugin
   * installed later, or that a plugin update might retire.
   */
  view: string;
  /** Which artifact the panel is bound to; `$primary` = the opened artifact. */
  artifact: string;
  title?: string;
  params?: Record<string, unknown>;
}

export type LayoutNode =
  | { split: 'row' | 'column'; children: LayoutNode[]; sizes?: number[] }
  | { panels: PanelSpec[]; activeIndex?: number };

export interface LayoutDef {
  id: string;
  label: string;
  /** Which artifact type this arrangement is the default for. */
  appliesTo?: ArtifactTypeId[];
  provider: string;
  root: LayoutNode;
}

/**
 * Default arrangements per artifact type.
 *
 * This is how a first-time user gets oriented — not a mode switcher. Opening
 * an artifact applies a sensible arrangement for its type, and the user can
 * override it freely. Nothing to explain, nothing to toggle.
 */
export const DEFAULT_LAYOUTS: LayoutDef[] = [
  {
    id: 'core.log.overview',
    label: 'Log overview',
    appliesTo: ['ObjectCentricEventLog', 'TraditionalEventLog'],
    provider: 'core',
    // Just the overview panel: Activities and Attributes are one click away
    // in the Inspector's "Views" section (driven by the view registry, not
    // by this layout), so nothing is lost by not pre-opening them — only
    // the two extra panels a first look at a log did not ask for.
    // `'$primary'` rather than `'core.logOverview'` directly: XES still
    // resolves to the core Overview (unmarked, so it wins by being first
    // registered), but OCEL's canonical Overview now comes from the bundled
    // OCEL 2.0 Inspector plugin, which declares itself `primary` for that
    // type — this layout does not need to know that, or be updated if it
    // changes again.
    root: {
      panels: [{ view: '$primary', artifact: '$primary' }],
    },
  },
];

export function layoutForType(type: ArtifactTypeId): LayoutDef | undefined {
  return DEFAULT_LAYOUTS.find((l) => l.appliesTo?.includes(type));
}

/** Flattens a layout to the panel list the docking host actually instantiates. */
export function panelsOf(node: LayoutNode, out: PanelSpec[] = []): PanelSpec[] {
  if ('panels' in node) out.push(...node.panels);
  else for (const c of node.children) panelsOf(c, out);
  return out;
}

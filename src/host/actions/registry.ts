import type { ActionDef, Applicability, InputSlot, ParamSchema } from './types';
import type { Artifact, ArtifactTypeId } from '../artifact/types';

/**
 * Action registry.
 *
 * Actions are declared, not imported by callers. Nothing here executes an
 * algorithm yet — Milestone 1 only needs the registry, the applicability
 * rules and the parameter schemas so the inspector has something real to
 * render.
 */
export class ActionRegistry {
  private actions = new Map<string, ActionDef>();
  private listeners = new Set<() => void>();

  register(a: ActionDef) {
    this.actions.set(a.id, a);
    for (const l of this.listeners) l();
  }

  unregister(id: string) {
    this.actions.delete(id);
    for (const l of this.listeners) l();
  }

  get(id: string) { return this.actions.get(id); }
  all(): ActionDef[] { return [...this.actions.values()]; }

  /**
   * Applicability for a selection.
   *
   * Multi-input actions are the interesting case: with a log selected, an
   * alignment is not simply inapplicable — it is "applicable once you also
   * pick an AcceptingPetriNet". The UI needs that distinction, so `missing`
   * is returned rather than collapsing everything to a boolean.
   */
  applicableTo(selected: Artifact[]): Applicability[] {
    const available = new Set<ArtifactTypeId>(selected.map((a) => a.type));
    const countByType = new Map<ArtifactTypeId, number>();
    for (const artifact of selected) {
      countByType.set(artifact.type, (countByType.get(artifact.type) ?? 0) + 1);
    }
    /** Capabilities of the selected artifacts, by type, for slot matching. */
    const capsByType = new Map<ArtifactTypeId, Set<string>>();
    for (const a of selected) {
      const caps = new Set<string>(((a.meta as any)?.capabilities ?? []) as string[]);
      const prev = capsByType.get(a.type);
      // Several artifacts of one type may be selected; a slot is satisfied if
      // *some* of them can fill it, which is how the host resolves slots too.
      if (prev) for (const c of caps) prev.add(c);
      else capsByType.set(a.type, caps);
    }

    // `internal` actions stay fully registered (`produce()`/`scans` still
    // resolve them via `all()`) — only the user-facing list excludes them.
    // `exportsFile` actions are excluded the same way: they belong in the
    // artifact tree's own "Export" submenu (`exportActionsFor`, below), not
    // this "Available actions" list.
    return this.all().filter((action) => !action.internal && !action.exportsFile).map((action) => {
      // A type alone does not tell us whether two same-typed roles can both
      // be filled. `baseline: OCPN, candidate: OCPN` needs *two* selected
      // OCPNs, whereas the old presence-set logic incorrectly enabled it for
      // one.  Consume a per-type count in declaration order, which is also
      // the order `App.onRun` uses to bind those roles.
      const consumedByType = new Map<ArtifactTypeId, number>();
      const missing = action.inputs.filter((slot) => {
        if (!slot.required) return false;
        const needed = (consumedByType.get(slot.type) ?? 0) + 1;
        consumedByType.set(slot.type, needed);
        return (countByType.get(slot.type) ?? 0) < needed;
      });
      // A slot whose type is present but whose required properties are not.
      // Reported apart from `missing`, because the two need different answers:
      // one asks the user to select something, the other says this log cannot
      // serve this action at all.
      const unmet: Array<{ slot: InputSlot; capabilities: string[] }> = [];
      for (const slot of action.inputs) {
        if (!slot.requires?.length || !available.has(slot.type)) continue;
        const have = capsByType.get(slot.type) ?? new Set<string>();
        const lacking = slot.requires.filter((c) => !have.has(c));
        if (lacking.length) unmet.push({ slot, capabilities: lacking });
      }

      // At least one slot must actually be filled by the selection, otherwise
      // every action would appear against every artifact.
      const anyMatched = action.inputs.some((s) => available.has(s.type));
      // Nothing matched at all: every slot is what's missing, not just the
      // required ones. An action like `transformLog` accepts either a
      // TraditionalEventLog or an ObjectCentricEventLog and marks neither
      // slot `required` — that's an "at least one of" relationship, not two
      // independent optional slots — so filtering to `required` alone would
      // report nothing missing and leave the UI with a disabled row and no
      // explanation.
      const requiredSlots = action.inputs.filter((s) => s.required);
      return {
        action,
        applicable: anyMatched && missing.length === 0 && unmet.length === 0,
        missing: anyMatched ? missing : (requiredSlots.length ? requiredSlots : action.inputs),
        unmet,
      };
    }).filter((r) => r.applicable || r.unmet.length > 0
      || r.missing.length < r.action.inputs.length);
  }

  /**
   * Export actions applicable to one artifact — the data behind the
   * artifact tree's "Export" submenu, replacing what used to be two
   * hardcoded `artifact.type === '...'` blocks (OCEL, XES) with the same
   * kind of registry-driven lookup `forType`/`applicableTo` already give
   * views and ordinary actions. A single-input, `exportsFile` action whose
   * one slot matches this artifact's type is offered; anything needing more
   * than one input isn't a plain "export this" and is left out.
   */
  exportActionsFor(artifact: Artifact): ActionDef[] {
    return this.all().filter((a) =>
      a.exportsFile && a.inputs.length === 1 && a.inputs[0].type === artifact.type
    );
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const actionRegistry = new ActionRegistry();

/** Extracts defaults so the inspector can render controls before any run. */
export function defaultParams(schema: ParamSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(schema.properties)) {
    if (p.default !== undefined) out[k] = p.default;
  }
  return out;
}

export function primaryParam(schema: ParamSchema): string | null {
  for (const [k, p] of Object.entries(schema.properties)) if (p.primary) return k;
  return null;
}

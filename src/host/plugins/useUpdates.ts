import { useEffect, useState } from 'react';
import {
  configuredRegistries, fetchRegistry, findUpdates,
  type RegistryIndex, type UpdateCandidate,
} from './registry';
import type { InstalledPlugin } from './store';

/**
 * Registry indexes and available updates for the installed set.
 *
 * Independent of `PluginList`'s own copy of this same fetch — the topbar
 * badge needs an update count before the plugins dialog is ever opened, so
 * it cannot wait for that component to mount. Consistent with how
 * Inspector.tsx also fetches registries on its own: each caller owns its
 * own concern rather than threading one fetch through props.
 */
export function usePluginUpdates(plugins: InstalledPlugin[]) {
  const [indexes, setIndexes] = useState<RegistryIndex[]>([]);
  const [updates, setUpdates] = useState<UpdateCandidate[]>([]);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    (async () => {
      const loaded: RegistryIndex[] = [];
      for (const url of configuredRegistries()) {
        try { loaded.push(await fetchRegistry(url)); }
        catch (e: any) { if (!canceled) setNote(`registry unavailable: ${e.message}`); }
      }
      if (canceled) return;
      setIndexes(loaded);
      setUpdates(await findUpdates(loaded));
    })();
    return () => { canceled = true; };
  }, [plugins]);

  return { indexes, updates, note };
}

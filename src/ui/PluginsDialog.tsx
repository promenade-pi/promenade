import { useEffect, useState } from 'react';
import { PluginList, type RegistryContext } from './PluginList';
import { PluginDetails } from './views/PluginDetails';
import type { InstalledPlugin } from '../host/plugins/store';

/**
 * Plugin management, as a dialog rather than a permanent sidebar section.
 *
 * Artifacts are workspace-specific — the tree the user is actually working
 * in. Plugins are app-wide, unrelated to which workspace happens to be open,
 * so they get their own surface instead of sharing the left rail: a list on
 * the left, the selected package's own README and metadata on the right,
 * both reusing the exact components the old sidebar section and its
 * docked detail panel already used.
 */
export function PluginsDialog({
  plugins, onClose, onImport, onFilesDropped, onRemove, onInstalled, initialTab,
}: {
  plugins: InstalledPlugin[];
  onClose: () => void;
  onImport: () => void;
  onFilesDropped?: (files: FileList) => void;
  onRemove: (id: string) => void;
  onInstalled: () => void;
  initialTab?: 'installed' | 'browse';
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [registry, setRegistry] = useState<RegistryContext | undefined>(undefined);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="pl-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="pl-dialog-head">
          <span>Plugins</span>
          <button className="pl-dialog-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="pl-dialog-body">
          <div className="pl-dialog-list">
            <PluginList
              plugins={plugins}
              selected={selected}
              onSelect={(id, reg) => { setSelected(id); setRegistry(reg); }}
              onOpen={() => {}}
              onRemove={(id) => { onRemove(id); setSelected((s) => (s === id ? null : s)); }}
              onImport={onImport}
              onFilesDropped={onFilesDropped}
              onInstalled={onInstalled}
              initialTab={initialTab}
            />
          </div>
          <div className="pl-dialog-preview">
            {selected
              ? <PluginDetails
                  pluginId={selected}
                  registry={registry}
                  onInstalled={onInstalled}
                  // The list and the panel describe the same package, so an
                  // install or update from one has to be visible in the other.
                  // `plugins` is refreshed by `onInstalled`, which makes this
                  // the signal the panel follows.
                  installed={plugins.find((p) => p.manifest.id === selected)}
                />
              : <div className="pl-dialog-empty">Select a plugin to see its details.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

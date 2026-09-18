import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { InstalledPlugin } from '../host/plugins/store';
import {
  configuredRegistries, fetchRegistry, findUpdates, installFromRegistry, installFromUrl, latestOf,
  compareVersions, type RegistryIndex, type RegistryEntry, type RegistryVersion, type UpdateCandidate,
} from '../host/plugins/registry';
import { fmtBytes } from './format';
import { ConfirmDialog } from './ConfirmDialog';
import { runtimeLabel } from '../host/plugins/manifest';

/**
 * Installed plugins, in the left column beside the artifact tree.
 *
 * The column switches between two kinds of object — artifacts and plugins —
 * which is navigation, not a mode: the workspace and inspector keep doing
 * whatever they were doing. A full-screen plugin manager would be a global
 * mode switch, which this design does not have.
 */
/**
 * The badge shown next to an installed package's name.
 *
 * A package may declare one package-level runtime, or set it separately for
 * each action. Use the shared manifest resolver so a missing package-level
 * value never produces an empty badge.
 */
function runtimeBadge(m: any): string | undefined { return runtimeLabel(m); }

/**
 * A package glyph, rather than a checkbox-shaped status marker.
 *
 * An experimental package gets a small beaker badge over its lower-right
 * corner — the same violet as the "experimental" chip and the Browse
 * section's own heading, so the three read as one signal.
 */
function PackageIcon({ experimental }: { experimental?: boolean }) {
  const label = experimental ? 'Experimental plugin package' : 'Plugin package';
  return (
    <span className="pl-package-icon" aria-label={label} title={label}>
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="m3 5.2 5-2.55 5 2.55v5.6l-5 2.55-5-2.55V5.2Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
        <path d="m3.2 5.35 4.8 2.45 4.8-2.45M8 7.8v5.4" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      </svg>
      {experimental && (
        <svg className="pl-package-icon-beaker" viewBox="0 0 10 10" aria-hidden="true">
          <circle cx="5" cy="5" r="5" className="pl-package-icon-beaker-bg" />
          <path
            d="M4 1.4h2M4.3 1.4v2.1L2.4 7.1c-.35.7.15 1.5.9 1.5h3.4c.75 0 1.25-.8.9-1.5L5.7 3.5V1.4"
            stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" fill="none"
          />
          <path d="M3.1 5.7h3.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}

function sourceLabel(plugin: InstalledPlugin): { label: string; title: string; className: string } {
  switch (plugin.source?.kind) {
    case 'local':
      return { label: 'Local', title: 'Installed from a local package file', className: 'local' };
    case 'registry':
      return {
        label: 'Registry',
        title: `Installed from the ${plugin.source.name} registry`,
        className: 'registry',
      };
    case 'bundled':
      return { label: 'Bundled', title: 'Installed from a package bundled with Promenade', className: 'bundled' };
    case 'url':
      return { label: 'URL', title: `Installed from ${plugin.source.url}`, className: 'local' };
    default:
      return { label: 'Imported', title: 'Installed before package source tracking was added', className: 'unknown' };
  }
}

/**
 * Installs a `.pmplugin` fetched from a direct download link — a GitHub
 * release asset, most often — rather than from a local file or a configured
 * registry. Same shape as `ConfirmDialog`, plus the one text field the task
 * actually needs.
 */
function InstallFromUrlDialog({
  busy, error, onCancel, onInstall,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onInstall: (url: string) => void;
}) {
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  const submit = () => { const trimmed = url.trim(); if (trimmed && !busy) onInstall(trimmed); };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-title">Install from URL</div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '0 0 8px' }}>
          A direct download link to a <code>.pmplugin</code> package — a GitHub release asset, for example.
        </p>
        <input
          ref={inputRef}
          type="url"
          value={url}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="https://github.com/owner/repo/releases/download/v1.0.0/plugin.pmplugin"
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
        {error && <div className="err" style={{ marginTop: 8 }}>{error}</div>}
        <div className="modal-actions">
          <button onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy || !url.trim()}>
            {busy ? 'Installing…' : 'Install'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Enough context to fetch and unpack a not-yet-installed package on its own. */
export interface RegistryContext {
  index: RegistryIndex;
  entry: RegistryEntry;
  version: RegistryVersion;
}

export function PluginList({
  plugins, selected, onSelect, onOpen, onRemove, onImport, onFilesDropped, onInstalled, initialTab,
}: {
  plugins: InstalledPlugin[];
  selected: string | null;
  onSelect: (id: string, registry?: RegistryContext) => void;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  onImport: () => void;
  /** Files dropped onto the list — the same install path as the file picker. */
  onFilesDropped?: (files: FileList) => void;
  onInstalled: () => void;
  initialTab?: 'installed' | 'browse';
}) {
  const [tab, setTab] = useState<'installed' | 'browse'>(initialTab ?? 'installed');
  const [indexes, setIndexes] = useState<RegistryIndex[]>([]);
  const [updates, setUpdates] = useState<UpdateCandidate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [busyAll, setBusyAll] = useState(false);
  const [allProgress, setAllProgress] = useState<{ done: number; total: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [installUrlOpen, setInstallUrlOpen] = useState(false);
  const [installUrlBusy, setInstallUrlBusy] = useState(false);
  const [installUrlError, setInstallUrlError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [updatesOnly, setUpdatesOnly] = useState(false);
  const [browseKinds, setBrowseKinds] = useState({ view: true, action: true });
  // Browse's counterpart to `updatesOnly`: a narrowing filter, off by default,
  // so the list still opens as the full catalogue. Installed entries stay in
  // the list by default because seeing "installed" next to a name is how you
  // learn you already have it; hiding them is for the other job, scanning a
  // familiar registry for what is new.
  const [notInstalledOnly, setNotInstalledOnly] = useState(false);
  // A counter, not a boolean: dragenter/dragleave fire on every child
  // boundary crossed, so a plain flag flickers off mid-drag over a row.
  const dragDepth = useRef(0);
  const [dragOver, setDragOver] = useState(false);

  // The registry is consulted on mount so an available update is visible
  // without the user going looking for it.
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
      const nextUpdates = await findUpdates(loaded);
      setUpdates(nextUpdates);
      // A completed update can make this list empty while the user still has
      // the filter selected. Clear it instead of leaving the installed list
      // blank with no visible checkbox to recover from that state.
      if (nextUpdates.length === 0) setUpdatesOnly(false);
    })();
    return () => { canceled = true; };
  }, [plugins]);

  const installUrl = async (url: string) => {
    setInstallUrlBusy(true);
    setInstallUrlError(null);
    const res = await installFromUrl(url);
    setInstallUrlBusy(false);
    if (res.ok) {
      setInstallUrlOpen(false);
      onInstalled();
    } else {
      setInstallUrlError(res.errors.join('; '));
    }
  };

  const install = async (index: RegistryIndex, entry: any, version: any) => {
    setBusy(entry.id);
    setNote(null);
    const res = await installFromRegistry(index, entry, version, setNote);
    setBusy(null);
    setNote(res.ok ? `installed ${entry.name} ${version.version}` : res.errors.join('; '));
    if (res.ok) {
      // Installing the only matching update turns an "updates only" list
      // into an empty one. Return to the normal installed view immediately.
      setUpdatesOnly(false);
      onInstalled();
    }
  };

  /**
   * Sequential, not parallel: `busy` tracks a single in-flight id, which is
   * what every per-row button's `disabled` already keys off, and the list
   * doubles as live progress ("which plugin is installing/updating right
   * now") instead of an opaque spinner. Runs against a snapshot of `targets`
   * taken at click time — a mid-batch registry refresh cannot change what's
   * already queued.
   */
  const runBatch = async (
    targets: { index: RegistryIndex; entry: RegistryEntry; version: RegistryVersion }[],
    verb: 'installed' | 'updated',
  ) => {
    if (targets.length === 0) return;
    setBusyAll(true);
    setNote(null);
    setAllProgress({ done: 0, total: targets.length });
    let okCount = 0;
    const errors: string[] = [];
    for (const t of targets) {
      setBusy(t.entry.id);
      const res = await installFromRegistry(t.index, t.entry, t.version, setNote);
      if (res.ok) okCount += 1;
      else errors.push(`${t.entry.name}: ${res.errors.join('; ')}`);
      setAllProgress((p) => (p ? { done: p.done + 1, total: p.total } : p));
    }
    setBusy(null);
    setBusyAll(false);
    setAllProgress(null);
    setUpdatesOnly(false);
    setNote(errors.length === 0
      ? `${verb} ${okCount} plugin${okCount === 1 ? '' : 's'}`
      : `${verb} ${okCount}/${targets.length} plugin${targets.length === 1 ? '' : 's'} — ${errors.join(' | ')}`);
    if (okCount > 0) onInstalled();
  };

  const installAll = () => runBatch(updates.map((u) => ({ index: u.index, entry: u.entry, version: u.version })), 'updated');

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  const shownPlugins = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...plugins]
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
      .filter((p) => {
        const m: any = p.manifest;
        if (updatesOnly && !updates.some((u) => u.entry.id === m.id)) return false;
        if (!q) return true;
        return m.name.toLowerCase().includes(q) || (m.description ?? '').toLowerCase().includes(q);
      });
  }, [plugins, query, updatesOnly, updates]);

  // An installed plugin has no "experimental" field of its own — that flag
  // lives on the registry entry it came from — so cross-reference against
  // every loaded registry by id.
  const experimentalIds = useMemo(() => {
    const ids = new Set<string>();
    for (const index of indexes) {
      for (const entry of index.plugins) {
        if ((entry as any).experimental) ids.add(entry.id);
      }
    }
    return ids;
  }, [indexes]);

  const experimentalPlugins = useMemo(
    () => shownPlugins.filter((p) => experimentalIds.has(p.manifest.id)),
    [shownPlugins, experimentalIds],
  );
  // A local package file, or one installed before source tracking existed —
  // on this machine but not from the Store and not shipped with Promenade.
  const localPlugins = useMemo(
    () => shownPlugins.filter((p) => !experimentalIds.has(p.manifest.id)
      && p.source?.kind !== 'registry' && p.source?.kind !== 'bundled'),
    [shownPlugins, experimentalIds],
  );
  const storePlugins = useMemo(
    () => shownPlugins.filter((p) => !experimentalIds.has(p.manifest.id) && p.source?.kind === 'registry'),
    [shownPlugins, experimentalIds],
  );
  // Ships with Promenade itself — lowest in the reading order since it's the
  // one group every install has by default and so is the least informative
  // to lead with.
  const bundledPlugins = useMemo(
    () => shownPlugins.filter((p) => !experimentalIds.has(p.manifest.id) && p.source?.kind === 'bundled'),
    [shownPlugins, experimentalIds],
  );

  // Every entry across every registry, unfiltered — the tab label's count,
  // distinct from browseInstallTargets which only counts what's both visible
  // and not yet installed.
  const browseTotal = useMemo(
    () => indexes.reduce((sum, index) => sum + index.plugins.filter((p) => !p.hidden).length, 0),
    [indexes],
  );

  const shownBrowseFor = (index: RegistryIndex) => {
    const q = query.trim().toLowerCase();
    return [...index.plugins]
      .sort((a, b) => a.name.localeCompare(b.name))
      .filter((entry) => {
        if (entry.hidden) return false;
        // An entry with an update pending survives the filter: it is a thing
        // to act on here, and the row already offers the button for it.
        if (notInstalledOnly) {
          const inst = plugins.find((p) => p.manifest.id === entry.id);
          const latest = inst ? latestOf(entry) : undefined;
          if (inst && !(latest && compareVersions(latest.version, inst.manifest.version) > 0)) return false;
        }
        const view = String((entry as any).runtime ?? '') === 'view';
        if ((view && !browseKinds.view) || (!view && !browseKinds.action)) return false;
        return !q || entry.name.toLowerCase().includes(q)
          || (entry.description ?? '').toLowerCase().includes(q);
      });
  };

  // Only what's currently visible — respecting the search box, the
  // Views/Actions toggle and the "Not installed" checkbox — so "install all"
  // can't reach past a filter the user set up to narrow the list down.
  const browseInstallTargets = useMemo(() => {
    const targets: { index: RegistryIndex; entry: RegistryEntry; version: RegistryVersion }[] = [];
    for (const index of indexes) {
      for (const entry of shownBrowseFor(index)) {
        if (plugins.some((p) => p.manifest.id === entry.id)) continue;
        const latest = latestOf(entry);
        if (latest) targets.push({ index, entry, version: latest });
      }
    }
    return targets;
  }, [indexes, plugins, query, browseKinds, notInstalledOnly]);

  const installAllBrowse = () => runBatch(browseInstallTargets, 'installed');


  /**
   * One browse-list row. Extracted because the list is now rendered in two
   * groups — stable packages, then anything flagged experimental under its
   * own heading — and the row markup is identical in both.
   */
  const browseRow = (index: RegistryIndex, entry: RegistryEntry) => {
    const latest = latestOf(entry);
    const inst = plugins.find((p) => p.manifest.id === entry.id);
    const cmp = inst && latest ? compareVersions(latest.version, inst.manifest.version) : 0;
    return (
      <div
        className={`t-node pl-plugin-node pl-browse-plugin-node${selected === entry.id ? ' sel' : ''}`}
        key={entry.id}
        onClick={() => onSelect(entry.id, latest ? { index, entry, version: latest } : undefined)}
        title={entry.description ?? entry.name}
      >
        <div className={`t-row${selected === entry.id ? ' sel' : ''}`}>
          <span className="t-twisty placeholder" />
          <PackageIcon experimental={!!(entry as any).experimental} />
          <span className="t-name">{entry.name}</span>
          {inst && cmp <= 0 && <span className="chip">installed</span>}
          {inst && cmp > 0 && <span className="chip third-party">update</span>}
          {!inst && latest && (
            <button
              className="pl-install"
              disabled={busy === entry.id}
              onClick={(e) => { e.stopPropagation(); install(index, entry, latest); }}
            >
              {busy === entry.id ? '…' : 'Install'}
            </button>
          )}
          {inst && cmp > 0 && latest && (
            <button
              className="pl-install"
              disabled={busy === entry.id || busyAll}
              onClick={(e) => { e.stopPropagation(); install(index, entry, latest); }}
            >
              {busy === entry.id ? '…' : `→ ${latest.version}`}
            </button>
          )}
        </div>
        <div className="t-sub">
          {latest?.version}
          {latest?.bytes ? ` · ${fmtBytes(latest.bytes)}` : ''}
          {entry.runtime ? ` · ${entry.runtime}` : ''}
          {entry.description ? ` · ${entry.description.slice(0, 60)}` : ''}
        </div>
        {inst && cmp > 0 && latest?.changelog && (
          <div className="t-sub pl-changelog">{latest.changelog}</div>
        )}
      </div>
    );
  };

  /**
   * One installed-list row. Extracted so the experimental group (shown first,
   * under the same "Experimental Plugins" heading Browse uses) and the rest
   * of the list can share identical row markup.
   */
  const installedRow = (p: InstalledPlugin) => {
    const m: any = p.manifest;
    const source = sourceLabel(p);
    const u = updates.find((x) => x.entry.id === m.id);
    const registryCtx = u ? { index: u.index, entry: u.entry, version: u.version } : undefined;
    const contributes = [
      m.actions?.length ? `${m.actions.length} action${m.actions.length > 1 ? 's' : ''}` : null,
      m.views?.length ? `${m.views.length} view${m.views.length > 1 ? 's' : ''}` : null,
      m.artifactTypes?.length ? `${m.artifactTypes.length} type${m.artifactTypes.length > 1 ? 's' : ''}` : null,
    ].filter(Boolean).join(' · ');

    return (
      <div
        className={`t-node pl-plugin-node${selected === m.id ? ' sel' : ''}`}
        key={m.id}
        onClick={() => onSelect(m.id, registryCtx)}
        onDoubleClick={() => onOpen(m.id)}
        title={m.description ?? m.name}
      >
        <div
          className={`t-row${selected === m.id ? ' sel' : ''}`}
        >
          <span className="t-twisty placeholder" />
          <PackageIcon experimental={experimentalIds.has(m.id)} />
          <span className="t-name">{m.name}</span>
          <span className="t-row-actions">
            <button
              className="t-row-action"
              title={`Remove ${m.name}`}
              onClick={(e) => { e.stopPropagation(); onSelect(m.id, registryCtx); setRemoving(true); }}
            >
              ×
            </button>
          </span>
        </div>
        <div className="pl-plugin-badges">
          <span className={`pl-source ${source.className}`} title={source.title}>{source.label}</span>
          {u ? (
            <button
              className="pl-install"
              disabled={busy === m.id || busyAll}
              onClick={(e) => { e.stopPropagation(); install(u.index, u.entry, u.version); }}
              title={u.version.changelog
                ? `Update from ${u.installedVersion} to ${u.version.version} — ${u.version.changelog}`
                : `Update from ${u.installedVersion} to ${u.version.version}`}
            >
              {busy === m.id ? '…' : `↑ ${u.version.version}`}
            </button>
          ) : runtimeBadge(m) && <span className="chip third-party">{runtimeBadge(m)}</span>}
        </div>
        <div className="t-sub">
          v{m.version} · {fmtBytes(p.bytes)}{contributes ? ` · ${contributes}` : ''}
        </div>
        {u?.version.changelog && (
          <div className="t-sub pl-changelog">↑ {u.version.version}: {u.version.changelog}</div>
        )}
      </div>
    );
  };

  return (
    <div
      className={`t-dropzone${dragOver ? ' drag-over' : ''}`}
      onDragEnter={(e) => {
        if (!onFilesDropped || !hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragOver={(e) => { if (onFilesDropped && hasFiles(e)) e.preventDefault(); }}
      onDragLeave={(e) => {
        if (!onFilesDropped || !hasFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!onFilesDropped || !hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        if (e.dataTransfer.files.length) onFilesDropped(e.dataTransfer.files);
      }}
    >
      {dragOver && (
        <div className="t-drop-hint">
          <div>Drop to install</div>
          <div className="t-drop-hint-sub">.pmplugin or .zip package</div>
        </div>
      )}
      <div className="pl-tabs">
        <button className={tab === 'installed' ? 'active' : ''} onClick={() => setTab('installed')}>
          Installed ({plugins.length})
          {updates.length > 0 && <span className="pl-badge">{updates.length}</span>}
        </button>
        <button className={tab === 'browse' ? 'active' : ''} onClick={() => setTab('browse')}>
          Browse ({browseTotal})
        </button>
      </div>

      {(tab === 'browse' || plugins.length > 6 || updates.length > 0 || updatesOnly) && (
        <div className="pl-toolbar">
          <input
            type="search"
            className="pl-search"
            placeholder={tab === 'installed' ? 'Filter installed…' : 'Filter plugins…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {tab === 'installed' && (updates.length > 0 || updatesOnly) && (
            <label className="pl-updates-toggle">
              <input
                type="checkbox"
                checked={updatesOnly}
                onChange={(e) => setUpdatesOnly(e.target.checked)}
              />
              Updates only ({updates.length})
            </label>
          )}
          {tab === 'installed' && updates.length > 1 && (
            <button
              className="pl-update-all"
              disabled={busyAll || busy !== null}
              onClick={installAll}
              title={`Update every installed plugin with a newer version in its registry:\n${
                updates.map((u) => `${u.entry.name} ${u.installedVersion} → ${u.version.version}`).join('\n')
              }`}
            >
              {busyAll ? `Updating ${allProgress?.done ?? 0}/${allProgress?.total ?? updates.length}…` : `Update all (${updates.length})`}
            </button>
          )}
          {tab === 'browse' && indexes.length > 0 && (
            <label className="pl-updates-toggle" title="Hide packages already installed and up to date. Anything with an update pending stays listed.">
              <input
                type="checkbox"
                checked={notInstalledOnly}
                onChange={(e) => setNotInstalledOnly(e.target.checked)}
              />
              Not installed
            </label>
          )}
          {tab === 'browse' && (
            <div className="pl-kind-toggles" aria-label="Plugin kind">
              <button
                className={browseKinds.view ? 'active' : ''}
                aria-pressed={browseKinds.view}
                onClick={() => setBrowseKinds((current) => ({ ...current, view: !current.view }))}
              >
                Views
              </button>
              <button
                className={browseKinds.action ? 'active' : ''}
                aria-pressed={browseKinds.action}
                onClick={() => setBrowseKinds((current) => ({ ...current, action: !current.action }))}
              >
                Actions
              </button>
            </div>
          )}
          {tab === 'browse' && browseInstallTargets.length > 0 && (
            <button
              className="pl-update-all"
              data-tour="install-all-btn"
              disabled={busyAll || busy !== null}
              onClick={installAllBrowse}
              title={`Install every listed plugin that isn't already installed:\n${
                browseInstallTargets.map((t) => `${t.entry.name} ${t.version.version}`).join('\n')
              }`}
            >
              {busyAll ? `Installing ${allProgress?.done ?? 0}/${allProgress?.total ?? browseInstallTargets.length}…` : `Install all (${browseInstallTargets.length})`}
            </button>
          )}
        </div>
      )}

      {tab === 'browse' && (
        <div className="tree">
          {indexes.length === 0 && (
            <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12 }}>
              No registry reachable.
            </div>
          )}
          {indexes.length > 0 && indexes.every((index) => shownBrowseFor(index).length === 0) && (
            <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12 }}>
              {query.trim()
                ? `Nothing matches "${query}".`
                : notInstalledOnly
                  ? 'Everything in the registry is installed and up to date.'
                  : 'Nothing to show for the current filter.'}
            </div>
          )}
          {indexes.map((index) => {
            const shown = shownBrowseFor(index);
            if (shown.length === 0) return null;
            const stable = shown.filter((e) => !(e as any).experimental);
            const experimental = shown.filter((e) => (e as any).experimental);
            return (
            <div key={index.sourceUrl}>
              <div className="pl-registry">{index.name}</div>
              {stable.map((entry) => browseRow(index, entry))}
              {experimental.length > 0 && (
                <>
                  <div
                    className="pl-registry pl-registry-experimental"
                    title="These work, but their interface or output may still change — safe to try, not yet safe to build on."
                  >
                    Experimental Plugins
                  </div>
                  {experimental.map((entry) => browseRow(index, entry))}
                </>
              )}
            </div>
            );
          })}
          {note && <div className="pl-note">{note}</div>}
        </div>
      )}

      {tab === 'installed' && (
      <>
      <div className="tree">
        {plugins.length === 0 && (
          <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12 }}>
            No plugins installed. Import a <code>.pmplugin</code> package.
          </div>
        )}
        {plugins.length > 0 && shownPlugins.length === 0 && (
          <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12 }}>
            {updatesOnly ? 'No installed plugins have updates.' : `Nothing matches "${query}".`}
          </div>
        )}

        {experimentalPlugins.length > 0 && (
          <>
            <div
              className="pl-registry pl-registry-experimental"
              title="These work, but their interface or output may still change — safe to try, not yet safe to build on."
            >
              Experimental
            </div>
            {experimentalPlugins.map((p) => installedRow(p))}
          </>
        )}
        {localPlugins.length > 0 && (
          <>
            <div className="pl-registry">Locally installed</div>
            {localPlugins.map((p) => installedRow(p))}
          </>
        )}
        {/* Store and Bundled headings only earn their keep once the list is
            already split into groups — an all-one-group list (the common
            fresh-install case: nothing but Bundled) reads fine flat. */}
        {(experimentalPlugins.length > 0 || localPlugins.length > 0 || bundledPlugins.length > 0) && storePlugins.length > 0 && (
          <div className="pl-registry">Store</div>
        )}
        {storePlugins.map((p) => installedRow(p))}
        {(experimentalPlugins.length > 0 || localPlugins.length > 0 || storePlugins.length > 0) && bundledPlugins.length > 0 && (
          <div className="pl-registry">Bundled</div>
        )}
        {bundledPlugins.map((p) => installedRow(p))}
      </div>

      </>
      )}

      {tab === 'installed' && note && <div className="pl-note">{note}</div>}

      {/* Installing is a Browse-tab concern — removing an already-installed
          plugin now lives on its own row (hover for the × next to its name)
          instead of a footer button whose enabling depended on a selection
          the Installed tab doesn't otherwise need. */}
      {tab === 'browse' && (
        <div style={{ padding: 8, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button onClick={onImport}>Install local package</button>
          <button onClick={() => { setInstallUrlError(null); setInstallUrlOpen(true); }}>
            Install from URL…
          </button>
        </div>
      )}

      {installUrlOpen && (
        <InstallFromUrlDialog
          busy={installUrlBusy}
          error={installUrlError}
          onCancel={() => setInstallUrlOpen(false)}
          onInstall={installUrl}
        />
      )}

      {removing && (() => {
        const p = plugins.find((x) => x.manifest.id === selected);
        if (!p) return null;
        return (
          <ConfirmDialog
            title="Remove plugin"
            message={
              `Remove "${p.manifest.name}"?\n\n` +
              `Artifacts it produced stay in the tree and remain queryable, ` +
              `but they can no longer be recomputed.`
            }
            confirmLabel="Remove"
            danger
            onCancel={() => setRemoving(false)}
            onConfirm={() => { setRemoving(false); onRemove(selected!); }}
          />
        );
      })()}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { listInstalled, readPluginFile, listPluginFiles, type InstalledPlugin } from '../../host/plugins/store';
import { installFromRegistry, previewFromRegistry, compareVersions } from '../../host/plugins/registry';
import type { RegistryContext } from '../PluginList';
import { actionDisplayLabels, runtimeLabel, type PluginManifest } from '../../host/plugins/manifest';
import { artifactTypes } from '../../host/artifact/registry';
import { Markdown } from '../Markdown';
import { fmtBytes } from '../format';

/**
 * Plugin details — the panel that opens when a plugin is selected.
 *
 * A dockable panel rather than a full-screen manager: plugin management is a
 * different kind of object than an artifact, but it is not a different *mode*.
 * The workspace keeps working, and a README can sit beside the log it
 * describes.
 *
 * Documentation is rendered from the package itself. A plugin in a research
 * setting is often the artifact of a paper, so authors, affiliations and a
 * citation are shown as structured metadata rather than buried in prose.
 *
 * The package is the source of truth whether or not it is installed. Picking
 * an entry from the registry browser downloads and unpacks it the same way
 * `Install` would, but stops short of writing it to OPFS — so a plugin the
 * user is only considering still shows its real README, authors and
 * citation, with an explicit notice that it is not installed yet.
 */

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
};

/** Where this panel's documentation is coming from, installed or not. */
interface DocSource {
  manifest: PluginManifest;
  installed: boolean;
  bytes: number;
  files: string[];
  read: (name: string) => Promise<Uint8Array>;
}

async function loadInstalledSource(id: string, p: InstalledPlugin): Promise<DocSource> {
  return {
    manifest: p.manifest,
    installed: true,
    bytes: p.bytes,
    files: await listPluginFiles(id),
    read: (name) => readPluginFile(id, name),
  };
}

export function PluginDetails({ pluginId, registry, onInstalled, installed }: {
  pluginId: string;
  /** Present when opened from the registry browser instead of the installed list. */
  registry?: RegistryContext;
  onInstalled?: () => void;
  /**
   * This plugin's installed record, when the surrounding surface tracks one.
   *
   * The panel resolves "installed or previewed?" once, on mount. That is right
   * for the standalone view, where nothing else can change it, and wrong in
   * the Plugins dialog, where the list beside it installs and updates the very
   * package being shown. Passing the record in lets the panel follow those
   * changes instead of describing the workspace as it was when it opened.
   */
  installed?: InstalledPlugin;
}) {
  const [source, setSource] = useState<DocSource | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const [text, setText] = useState<string>('');
  const [images, setImages] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installNote, setInstallNote] = useState<string | null>(null);
  const [latestChangelog, setLatestChangelog] = useState<{ version: string; text: string } | null>(null);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError(null);
    setSource(null);
    setPage(null);

    (async () => {
      const all = await listInstalled();
      const p = all.find((x) => x.manifest.id === pluginId);
      if (p) {
        const src = await loadInstalledSource(pluginId, p);
        if (!canceled) setSource(src);
        return;
      }

      // Not installed. Without a registry entry to fetch there is genuinely
      // nothing to show — this happens only for an id typed into a link the
      // host cannot resolve.
      if (!registry) return;

      const res = await previewFromRegistry(registry.index, registry.entry, registry.version);
      if (canceled) return;
      if (!res.ok || !res.manifest || !res.entries) {
        setError(res.errors.join('; ') || 'could not load the package');
        return;
      }
      const entries = res.entries;
      setSource({
        manifest: res.manifest,
        installed: false,
        bytes: res.bytes ?? 0,
        files: Object.keys(entries).filter((n) => !n.endsWith('/')).sort(),
        read: async (name) => {
          const b = entries[name];
          if (!b) throw new Error(`${name} not in package`);
          return b;
        },
      });
    })().catch((e) => !canceled && setError(String(e.message ?? e)))
      .finally(() => !canceled && setLoading(false));

    return () => { canceled = true; };
  }, [pluginId, registry]);

  // Images are read out of the package and handed to the renderer as blob
  // URLs. The markdown never gets to name a URL the host then fetches.
  useEffect(() => {
    if (!source) return;
    let canceled = false;
    const urls: string[] = [];

    (async () => {
      const map: Record<string, string> = {};
      for (const f of source.files) {
        const ext = f.split('.').pop()?.toLowerCase() ?? '';
        if (!MIME[ext]) continue;
        try {
          const bytes = await source.read(f);
          const url = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] }));
          urls.push(url);
          map[f] = url;
        } catch {}
      }
      if (canceled) return;
      setImages(map);
      setPage(source.manifest.readme ?? 'README.md');
    })();

    return () => {
      canceled = true;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [source]);

  useEffect(() => {
    if (!page || !source) return;
    let canceled = false;
    source.read(page)
      .then((b) => !canceled && setText(new TextDecoder().decode(b)))
      .catch(() => !canceled && setText(`_No ${page} in this package._`));
    return () => { canceled = true; };
  }, [page, source]);

  // An installed package's own CHANGELOG.md is a snapshot from when it was
  // built — it stops at whatever version existed then, so an update that's
  // shipped since is invisible in it. When the registry says something newer
  // is available, fetch that package's changelog too (the same download the
  // "not installed" preview branch already does) so the tab can show the
  // full story instead of stalling at the installed version.
  useEffect(() => {
    if (!source?.installed || !registry || compareVersions(registry.version.version, source.manifest.version) <= 0) {
      setLatestChangelog(null);
      return;
    }
    let canceled = false;
    (async () => {
      const res = await previewFromRegistry(registry.index, registry.entry, registry.version);
      if (canceled || !res.ok || !res.manifest || !res.entries) return;
      const path = res.manifest.docs?.find((d) => d.title.toLowerCase() === 'changelog')?.path ?? 'CHANGELOG.md';
      const bytes = res.entries[path];
      if (!bytes) return;
      setLatestChangelog({ version: registry.version.version, text: new TextDecoder().decode(bytes) });
    })();
    return () => { canceled = true; };
  }, [source, registry]);

  /**
   * Follow an install or update made from outside this panel.
   *
   * Two cases, and the version comparison is what catches the second: a
   * previewed package that has just been installed, and an installed one that
   * has just been updated to a newer version. Both otherwise leave the panel
   * offering an action that has already happened — an "Install" button on
   * something installed, or an "update available" banner for a version now in
   * the workspace.
   *
   * It swaps the source rather than re-running the loader effect, which is
   * what `install()` below already does for the in-panel button: the two paths
   * differ only in who pressed what, so they should land in the same state.
   */
  useEffect(() => {
    if (!installed) return;
    if (source?.installed && source.manifest.version === installed.manifest.version) return;
    let canceled = false;
    loadInstalledSource(pluginId, installed)
      .then((src) => { if (!canceled) setSource(src); })
      .catch(() => { /* the loader effect owns reporting a package it cannot read */ });
    return () => { canceled = true; };
  }, [installed, source, pluginId]);

  const install = async () => {
    if (!registry) return;
    setInstalling(true);
    setInstallNote(null);
    const res = await installFromRegistry(registry.index, registry.entry, registry.version);
    setInstalling(false);
    if (!res.ok || !res.plugin) {
      setInstallNote(res.errors.join('; '));
      return;
    }
    onInstalled?.();
    setSource(await loadInstalledSource(pluginId, res.plugin));
  };

  if (error) return <div className="view"><div className="err">{error}</div></div>;
  if (loading) return <div className="view" style={{ color: 'var(--text-dim)' }}>Loading…</div>;
  if (!source) return <div className="view" style={{ color: 'var(--text-dim)' }}>Plugin not installed.</div>;

  const m = source.manifest as any;
  const runtime = runtimeLabel(m);
  const pages = [
    { path: m.readme ?? 'README.md', title: 'Readme' },
    ...(m.docs ?? []),
  ].filter((p, i, arr) => arr.findIndex((x) => x.path === p.path) === i);
  const changelogPage = pages.find((p) => p.title.toLowerCase() === 'changelog');
  const showingLatestChangelog = !!(changelogPage && page === changelogPage.path && latestChangelog);

  /** Resolves a relative image path against the files actually in the package. */
  const resolveImage = (src: string) => {
    const clean = src.replace(/^\.\//, '');
    if (images[clean]) return images[clean];
    const hit = Object.keys(images).find((f) => f.endsWith(clean) || f.endsWith(clean.split('/').pop()!));
    return hit ? images[hit] : undefined;
  };

  return (
    <div className="pd">
      {!source.installed && (
        <div className="pd-notice">
          <span>
            Not installed — this is the package's own documentation, downloaded and
            verified but not added to the workspace.
          </span>
          <button className="primary" onClick={install} disabled={installing}>
            {installing ? 'Installing…' : 'Install'}
          </button>
          {installNote && <span className="err">{installNote}</span>}
        </div>
      )}

      {source.installed && latestChangelog && (
        <div className="pd-notice">
          <span>
            v{latestChangelog.version} is available — the Changelog tab shows what's
            changed since your installed v{m.version}.
          </span>
          <button className="primary" onClick={install} disabled={installing}>
            {installing ? 'Updating…' : `Update to ${latestChangelog.version}`}
          </button>
          {installNote && <span className="err">{installNote}</span>}
        </div>
      )}

      <div className="pd-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="pd-title">{m.name}</div>
          <div className="pd-sub">
            {m.id} · v{m.version} · {fmtBytes(source.bytes)}
            {m.license ? ` · ${m.license}` : ''}
          </div>
          {m.description && <div className="pd-desc">{m.description}</div>}
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {runtime && <span className="chip third-party">{runtime}</span>}
            {(registry?.entry as any)?.experimental && (
              <span
                className="chip experimental"
                title="Experimental — safe to try, but its interface or output may still change"
              >
                experimental
              </span>
            )}
            {!source.installed && <span className="chip third-party">not installed</span>}
            {(m.keywords ?? []).map((k: string) => <span className="chip" key={k}>{k}</span>)}
          </div>
        </div>
      </div>

      <div className="pd-body">
        <div className="pd-doc">
          {pages.length > 1 && (
            <div className="pd-tabs">
              {pages.map((p) => (
                <button
                  key={p.path}
                  className={page === p.path ? 'active' : ''}
                  onClick={() => setPage(p.path)}
                >
                  {p.title}
                </button>
              ))}
            </div>
          )}
          <Markdown source={showingLatestChangelog ? latestChangelog!.text : text} resolveImage={resolveImage} />
        </div>

        <aside className="pd-meta">
          {(m.authors?.length || m.author) && (
            <section>
              <h4>Authors</h4>
              {(m.authors ?? [{ name: m.author }]).map((a: any, i: number) => (
                <div className="pd-author" key={i}>
                  <div className="pd-author-name">{a.name}</div>
                  {a.affiliation && <div className="pd-author-line">{a.affiliation}</div>}
                  {a.email && (
                    <a className="pd-author-line" href={`mailto:${a.email}`}>{a.email}</a>
                  )}
                  {a.orcid && (
                    <a className="pd-author-line" target="_blank" rel="noopener noreferrer"
                       href={`https://orcid.org/${a.orcid}`}>ORCID {a.orcid}</a>
                  )}
                </div>
              ))}
            </section>
          )}

          {m.citation && (
            <section>
              <h4>Cite as</h4>
              {m.citation.text && <div className="pd-cite">{m.citation.text}</div>}
              {m.citation.doi && (
                <a className="pd-link" target="_blank" rel="noopener noreferrer"
                   href={`https://doi.org/${m.citation.doi}`}>doi:{m.citation.doi}</a>
              )}
              {m.citation.bibtex && (
                <details className="pd-bibtex">
                  <summary>BibTeX</summary>
                  <pre>{m.citation.bibtex}</pre>
                  <button onClick={() => navigator.clipboard?.writeText(m.citation.bibtex)}>
                    Copy
                  </button>
                </details>
              )}
            </section>
          )}

          {(m.homepage || m.repository) && (
            <section>
              <h4>Links</h4>
              {m.homepage && (
                <a className="pd-link" href={m.homepage} target="_blank" rel="noopener noreferrer">
                  Homepage
                </a>
              )}
              {m.repository && (
                <a className="pd-link" href={m.repository} target="_blank" rel="noopener noreferrer">
                  Repository
                </a>
              )}
            </section>
          )}

          <section>
            <h4>Contributes</h4>
            {(() => {
              // Two actions of one package can legitimately share a label —
              // the same capability offered for a traditional and an
              // object-centric log. Everywhere else only the applicable one is
              // ever offered; this list is the one place both appear together.
              const labels = actionDisplayLabels(
                m.actions ?? [],
                (type) => artifactTypes.get(type)?.shortLabel
              );
              return (m.actions ?? []).map((a: any) => (
                <div className="pd-contrib" key={a.id}>
                  <span className="chip">action</span> {labels.get(a.id) ?? a.label}
                </div>
              ));
            })()}
            {(m.views ?? []).map((v: any) => (
              <div className="pd-contrib" key={v.id}>
                <span className="chip">view</span> {v.label}
              </div>
            ))}
            {(m.artifactTypes ?? []).map((t: any) => (
              <div className="pd-contrib" key={t.id}>
                <span className="chip">type</span> {t.label}
              </div>
            ))}
          </section>

          {m.pythonDeps?.length > 0 && (
            <section>
              <h4>Python dependencies</h4>
              <div className="pd-deps">{m.pythonDeps.join(', ')}</div>
            </section>
          )}

          <section>
            <h4>Files</h4>
            <div className="pd-files">{source.files.map((f) => <div key={f}>{f}</div>)}</div>
          </section>
        </aside>
      </div>
    </div>
  );
}

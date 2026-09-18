/**
 * The one marker for "this came from an installed package".
 *
 * Shared rather than reimplemented: the Inspector's action and view rows
 * and the destination gallery's cards are describing the same fact about
 * the same thing, and a second badge that meant the same but looked
 * different would be a worse answer than no badge at all.
 */
/**
 * Marks a row as coming from an installed plugin rather than the core.
 *
 * Replaces a "THIRD-PARTY" text chip that was wider than the label it sat
 * under — the icon carries the same meaning at a fraction of the width, and
 * a hover fills in what the text used to spell out up front: which plugin,
 * which version.
 */
export function PluginIcon({ provider, runtime, plugins, experimental }: {
  provider: string;
  runtime?: string;
  plugins: Array<{ manifest: any }>;
  /** Same beaker badge the plugin explorer uses for a registry entry flagged
   * `experimental` — stands in for the separate "experimental" text chip,
   * which is wider than every label it sat next to. */
  experimental?: boolean;
}) {
  const p = plugins.find((pl) => pl.manifest.id === provider);
  const label = p
    ? `Provided by ${p.manifest.name} v${p.manifest.version}${runtime ? ` · ${runtime}` : ''}`
    : `Provided by ${provider}${runtime ? ` · ${runtime}` : ''}`;
  return (
    <span className="plugin-icon" title={experimental ? `${label} · Experimental` : label}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="m3.25 5.25 4.75-2.5 4.75 2.5v5.5L8 13.25l-4.75-2.5v-5.5Z"
              fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
        <path d="m3.5 5.4 4.5 2.35 4.5-2.35M8 7.75v5.25M5.75 4.05l4.6 2.4"
              fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
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

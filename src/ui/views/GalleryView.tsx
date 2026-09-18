import { useEffect, useMemo, useState } from 'react';
import type { Artifact, ProvenanceGraph } from '../../host/artifact/types';
import { artifactTypes } from '../../host/artifact/registry';
import {
  byIntent, destinationsFor, reachableFrom, type Destination, type Intent,
} from '../../host/views/destinations';
import {
  pinnedKeys, recentKeys, setPreferredProducer, subscribeGalleryPrefs, togglePin,
} from '../../host/views/galleryPrefs';
import { Thumb } from './gallery-thumbs';
import { PluginIcon } from '../PluginIcon';
import { DestinationSettings } from './DestinationSettings';

/**
 * The destination gallery.
 *
 * One tiled answer to "what can I do with this?", replacing the two flat
 * text lists (Views / Available actions) as the *primary* way in — those
 * lists stay in the Inspector for people who know what they are looking for.
 *
 * Three things the lists could not do and this can: show what a destination
 * looks like before you commit to it, put the author's own `description`
 * somewhere it is read rather than hidden in a tooltip, and group by what
 * the user is trying to do instead of by which package happened to ship it.
 * With 40 plugins contributing 49 actions and 53 views, the last one is not
 * cosmetic.
 *
 * It is a panel, not a modal overlay, for one reason: choosing is usually
 * *comparative* — "I am looking at this metro map, what else can this log
 * do?" — and a modal hides the thing you are deciding about. Being a panel
 * also means it inherits tabs, splits and focus from dockview rather than
 * reinventing them, and it can be the empty state of a fresh group.
 */

function PinIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
      {/* Mirrored about x=6 and spanning y 1.5–10.5, so the glyph's own centre
          is the viewBox's centre and the button's `place-items: center` lands
          it where it looks centred. */}
      <path d="M4.4 1.5H7.6L7.2 4.6 9 6.4V7.1H3V6.4L4.8 4.6Z" fill={on ? 'currentColor' : 'none'}
            stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M6 7.1V10.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function badgesFor(d: Destination) {
  const out: Array<{ cls: string; text: string; title?: string; settings?: boolean }> = [];
  if (d.kind === 'view') out.push({ cls: 'now', text: 'opens now' });
  else if (d.kind === 'export') out.push({ cls: 'calc', text: 'downloads a file' });
  else if (d.chain?.length) {
    out.push({
      cls: 'two',
      text: `${d.chain.length + 1} steps`,
      title: `Runs ${d.chain.map((c) => c.producerLabel).join(', then ')}, then ${d.via}. `
        + 'The intermediate result is kept for provenance but stays out of the tree.',
    });
  } else out.push({ cls: 'calc', text: 'computes' });
  if (d.paramCount > 0) {
    out.push({
      cls: 'set',
      text: `${d.paramCount} setting${d.paramCount > 1 ? 's' : ''}`,
      title: 'Set them before running — or change them live in the Inspector afterwards',
      settings: true,
    });
  }
  if (d.noRenderer) {
    out.push({
      cls: 'none', text: 'no viewer installed',
      title: `Nothing installed can draw a ${d.outputType}. The result is still produced and kept.`,
    });
  }
  return out;
}

/** "an OC-DFG", "an OC-DFG or a Petri net", "an A, a B or a C". */
function joinTypes(labels: string[]): string {
  const withArticle = labels.map((l) => `${/^[AEIOU]/i.test(l) ? 'an' : 'a'} ${l}`);
  if (withArticle.length <= 1) return withArticle[0] ?? 'what is missing';
  return `${withArticle.slice(0, -1).join(', ')} or ${withArticle[withArticle.length - 1]}`;
}

function blockedText(d: Destination): string | null {
  if (!d.blocked) return null;
  if (d.blocked.reason === 'missing') return `also select ${d.blocked.labels.join(' and ')}`;
  if (d.blocked.reason === 'unmet') return `this artifact has no ${d.blocked.capabilities.join(' or ')}`;
  return 'declared, but no implementation is registered';
}

function Card({ d, onOpen, onConfigure, pinned, onTogglePin, plugins, experimentalPluginIds }: {
  d: Destination;
  onOpen: (d: Destination) => void;
  onConfigure: (d: Destination) => void;
  pinned: boolean;
  onTogglePin: (key: string) => void;
  plugins?: Array<{ manifest: any }>;
  experimentalPluginIds?: Set<string>;
}) {
  const blocked = blockedText(d);
  const shortLabel = d.outputType ? artifactTypes.get(d.outputType).shortLabel : undefined;
  return (
    <div className={`gal-card${blocked ? ' blocked' : ''}`}>
      <button
        type="button"
        className="gal-card-main"
        disabled={!!blocked}
        // An export is the one destination with no "afterwards": it writes a
        // file and opens nothing, so a click that picked the format silently
        // would be deciding the only thing worth deciding. Everything else
        // runs on defaults and stays adjustable in the Inspector.
        onClick={() => (d.kind === 'export' && d.paramCount > 0 ? onConfigure(d) : onOpen(d))}
        title={[d.description, blocked ?? (d.kind === 'view' ? 'Open this view' : 'Run this and open the result')]
          .filter(Boolean).join('\n\n')}
      >
        <Thumb kind={d.thumb} label={shortLabel} />
        <span className="gal-card-body">
          <span className="gal-card-title">
            {d.title}
            {/* The basis belongs in the title, not only in a line underneath.
                Two metro maps — one mined from an Object-Centric Petri Net,
                one from an OC-DFG — are different results, and with the basis
                relegated to a subtitle the two cards read as a duplicate at a
                glance. It is also the fact a reader most wants next to the
                name: the same layout over a different model is a different
                claim about the process. */}
            {d.chain?.[0] && (
              <span
                className="gal-card-basis"
                title={`${d.chain[0].producerLabel}${d.chain[0].producerPlugin ? ` (${d.chain[0].producerPlugin})` : ''} runs first`
                  + (d.chain[0].alternatives.length
                    ? `\n\nAlso produces ${d.chain[0].typeLabel}: ${d.chain[0].alternatives.map((alt) => alt.label).join(', ')}`
                    : '')}
              >
                based on {d.chain[0].typeLabel}
              </span>
            )}
            {d.primary && <span className="gal-default" title="What opening this artifact shows">default</span>}
            {/* Same marker the Inspector's rows carry, including the beaker a
                registry flags `experimental` with — a card is where the user
                decides to run foreign code, so it is the last place that
                should be saying less than the list it replaced. */}
            {(!d.trusted || experimentalPluginIds?.has(d.provider)) && (
              <PluginIcon
                provider={d.provider}
                plugins={plugins ?? []}
                experimental={experimentalPluginIds?.has(d.provider)}
              />
            )}
          </span>
          <span className="gal-card-by">
            {d.via && d.via !== d.title ? `${d.via} · ` : ''}{d.pluginLabel ?? d.provider}
          </span>
          {d.description && <span className="gal-card-desc">{d.description}</span>}
          {blocked && <span className="gal-card-why">{blocked}</span>}
        </span>
      </button>
      {/* The badge row sits outside the card's own button, because one of its
          badges is itself a control and a button cannot contain a button —
          nested, it is invalid markup and unreachable by keyboard. */}
      <div className="gal-badges">
        {badgesFor(d).map((b) => (b.settings ? (
          <button
            key={b.text}
            type="button"
            className="gal-b set gal-b-settings"
            title={b.title}
            disabled={!!blocked}
            onClick={() => onConfigure(d)}
          >
            {b.text}
          </button>
        ) : (
          <span key={b.text} className={`gal-b ${b.cls}`} title={b.title}>{b.text}</span>
        )))}
      </div>
      <button
        type="button"
        className={`gal-pin${pinned ? ' on' : ''}`}
        onClick={() => onTogglePin(d.key)}
        title={pinned ? 'Unpin' : 'Pin to the top of every gallery'}
        aria-pressed={pinned}
      >
        <PinIcon on={pinned} />
      </button>
    </div>
  );
}

function Group({ title, hint, items, onOpen, onConfigure, pins, onTogglePin, plugins, experimentalPluginIds }: {
  title: string;
  hint?: string;
  items: Destination[];
  onOpen: (d: Destination) => void;
  onConfigure: (d: Destination) => void;
  pins: Set<string>;
  onTogglePin: (key: string) => void;
  plugins?: Array<{ manifest: any }>;
  experimentalPluginIds?: Set<string>;
}) {
  if (items.length === 0) return null;
  return (
    <section className="gal-group">
      <div className="gal-group-head">
        <h3>{title}</h3>
        {hint && <span className="gal-group-hint">{hint}</span>}
        <span className="gal-rule" />
        <span className="gal-count">{items.length}</span>
      </div>
      <div className="gal-grid">
        {items.map((d) => (
          <Card key={d.key} d={d} onOpen={onOpen} onConfigure={onConfigure}
                pinned={pins.has(d.key)} onTogglePin={onTogglePin}
                plugins={plugins} experimentalPluginIds={experimentalPluginIds} />
        ))}
      </div>
    </section>
  );
}

export function GalleryView({
  artifact, graph, plugins, onOpenDestination, extraSelection, experimentalPluginIds,
}: {
  artifact: Artifact;
  graph: ProvenanceGraph;
  plugins?: Array<{ manifest: any }>;
  /** Plugin ids a configured registry flags `experimental` — the same set the
   * Inspector's rows and the plugin explorer read. */
  experimentalPluginIds?: Set<string>;
  onOpenDestination?: (d: Destination, artifact: Artifact, params?: Record<string, unknown>) => void;
  /** Other selected artifacts, for actions needing more than one input. */
  extraSelection?: string[];
}) {
  const [query, setQuery] = useState('');
  /**
   * Which goal is on screen. `all` keeps the curated layout — pinned and
   * recent first, then every goal in order; any other value narrows to that
   * one goal and drops the headings, since the tab is the heading.
   */
  const [tab, setTab] = useState<'all' | Intent>('all');
  /**
   * Whether destinations one prerequisite away are offered. On by default:
   * the asymmetry it removes — "Discover metro map" reachable from a log
   * because its author wrote a `scans` declaration, "Backbone layout" not
   * reachable because its author did not — is not a distinction a user can
   * see or should have to work around. The switch stays because doubling the
   * grid is a real cost, and on a crowded log some people will want the
   * short list back.
   */
  const [withChains, setWithChains] = useState(true);
  /** The destination whose parameters are being set before it runs. */
  const [configuring, setConfiguring] = useState<Destination | null>(null);
  const [prefsTick, setPrefsTick] = useState(0);
  useEffect(() => subscribeGalleryPrefs(() => setPrefsTick((n) => n + 1)), []);

  const pluginLabel = useMemo(() => (provider: string) => (
    provider === 'core'
      ? 'Promenade'
      : plugins?.find((p) => p.manifest.id === provider)?.manifest.name ?? provider
  ), [plugins]);

  // `graph` is in the deps because a second selected artifact is resolved
  // through it; the registries are read fresh on every render anyway, which
  // is what keeps a just-installed plugin's cards appearing without a
  // subscription of our own.
  const selection = useMemo(() => [artifact, ...(extraSelection ?? [])
    .map((id) => graph.artifacts[id])
    .filter((a): a is Artifact => !!a && a.id !== artifact.id)],
  [artifact, graph, extraSelection]);

  const direct = useMemo(
    () => destinationsFor(selection, { pluginLabel }),
    [selection, pluginLabel, plugins],
  );
  /**
   * Computed even while the switch is off, so the switch can say what turning
   * it on would actually add — and name the intermediate by its real type
   * rather than with a stock example. Planning is registry arithmetic, not
   * work: nothing runs until a card is clicked.
   */
  const chained = useMemo(
    () => reachableFrom(selection, { pluginLabel }),
    // `prefsTick`: the ranking consults the stored producer preference, so a
    // change to it has to re-plan, not just re-render.
    [selection, pluginLabel, plugins, prefsTick],
  );
  const destinations = useMemo(
    () => (withChains ? [...direct, ...chained] : direct),
    [direct, chained, withChains],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? destinations.filter((d) => (
        `${d.title} ${d.via ?? ''} ${d.pluginLabel ?? ''} ${d.description ?? ''}`.toLowerCase().includes(q)
      ))
      : destinations;
    /**
     * By name, with the artifact type's own default view first.
     *
     * Registry order is install order, which is meaningless to a reader and
     * scatters things that belong together: two metro maps and a third one
     * with a variant slider ended up in three different parts of the same
     * group depending on when their packages happened to be installed. Names
     * are what the eye searches on, so names are what this sorts by — which
     * also makes siblings cluster for free, provided they are named as
     * siblings.
     */
    // Title first, then the basis — two levels rather than one concatenated
    // key, so "Metro map" (OC-DFG) and "Metro map" (OCPN) stay adjacent
    // instead of being split apart by "Metro map with variant slider". The
    // second level also stops two same-titled cards from tying and falling
    // back to install order, which varied by workspace.
    const basis = (d: Destination) => d.chain?.[0]?.typeLabel ?? '';
    return [...matched].sort((x, y) =>
      Number(!!y.primary) - Number(!!x.primary)
      || x.title.localeCompare(y.title)
      || basis(x).localeCompare(basis(y)));
  }, [destinations, query]);

  const pins = useMemo(() => new Set(pinnedKeys()), [prefsTick]);
  const recents = useMemo(() => recentKeys(), [prefsTick]);

  const byKey = useMemo(() => new Map(shown.map((d) => [d.key, d])), [shown]);
  const pinnedItems = useMemo(
    () => [...pins].map((k) => byKey.get(k)).filter((d): d is Destination => !!d),
    [pins, byKey],
  );
  // A pinned destination is already at the top; repeating it under "Recent"
  // says nothing new and costs a whole row.
  const recentItems = useMemo(
    () => recents.map((k) => byKey.get(k)).filter((d): d is Destination => !!d && !pins.has(d.key)).slice(0, 6),
    [recents, byKey, pins],
  );
  /**
   * Goals list everything, including whatever is also pinned or recent.
   *
   * Removing a card from its goal because it happened to be at the top as
   * well made the goal lie: "Discover a model" said 6 and showed 5, and the
   * one missing was the one you use most. The top strips are shortcuts, not a
   * relocation — a shortcut that empties the place you would look for the
   * thing is worse than no shortcut. The two strips *do* still dedupe against
   * each other, because they sit adjacent and repeating a card between them
   * is redundancy rather than a second place to find it.
   */
  const groups = useMemo(() => byIntent(shown), [shown]);

  /**
   * Tab counts are taken over everything matching the filter, not over what
   * is left after the pinned and recent strips: a goal's tab is the complete
   * set for that goal, and pinning something must not quietly decrement the
   * number beside it.
   */
  const tabs = useMemo(() => [
    { key: 'all' as const, label: 'All', n: shown.length },
    ...byIntent(shown).map((g) => ({ key: g.intent, label: g.label, n: g.items.length })),
  ], [shown]);

  // A goal can empty out — a different artifact is selected, or the filter
  // excludes it — and a tab that no longer exists would leave a blank panel.
  useEffect(() => {
    if (tab !== 'all' && !tabs.some((t) => t.key === tab)) setTab('all');
  }, [tabs, tab]);

  const onOpen = (d: Destination, params?: Record<string, unknown>) =>
    onOpenDestination?.(d, artifact, params);
  const type = artifactTypes.get(artifact.type);
  const blockedCount = destinations.filter((d) => d.blocked).length;
  /** The intermediate types the switch would have Promenade build, named. */
  const stepTypes = [...new Set(chained.flatMap((d) => d.chain?.map((c) => c.typeLabel) ?? []))];

  return (
    <div className="gal">
      <header className="gal-head">
        <div className="gal-head-main">
          <h2>{artifact.name}</h2>
          <div className="gal-head-sub">
            <span className="gal-type">{type.shortLabel}</span>
            <span>{type.label}</span>
          </div>
        </div>
        <div className="gal-tally">
          <b>{destinations.length}</b>
          <span>ways to look at this</span>
        </div>
      </header>

      <input
        id={`gallery-filter-${artifact.id}`}
        type="search"
        className="gal-search"
        placeholder="Filter destinations…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Filter destinations"
      />

      {chained.length > 0 && (
        <label className="gal-chain-toggle">
          <input
            id={`gallery-chains-${artifact.id}`}
            type="checkbox"
            checked={withChains}
            onChange={(e) => setWithChains(e.target.checked)}
          />
          <span className="gal-chain-text">
            <b>Also show results that need an intermediate step</b>
            <span>
              Promenade computes {joinTypes(stepTypes)} first, then keeps it out of the artifact tree.
            </span>
          </span>
          <span className="gal-chain-n">{chained.length} more</span>
        </label>
      )}

      <div className="gal-tabs" role="tablist" aria-label="Goal">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            className="gal-tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
          >
            {t.label}<span className="gal-tab-n">{t.n}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 && (
        <p className="gal-empty">
          {query ? <>Nothing matches “{query}”.</> : <>Nothing installed can act on a {type.label} yet.</>}
        </p>
      )}

      {tab === 'all' ? (
        <>
          <Group
            title="Pinned" items={pinnedItems} onOpen={onOpen} onConfigure={setConfiguring} pins={pins} onTogglePin={togglePin}
            hint="kept here because you pinned them"
            plugins={plugins} experimentalPluginIds={experimentalPluginIds}
          />
          <Group
            title="Recent" items={recentItems} onOpen={onOpen} onConfigure={setConfiguring} pins={pins} onTogglePin={togglePin}
            hint="what you opened last"
            plugins={plugins} experimentalPluginIds={experimentalPluginIds}
          />
          {groups.map((g) => (
            <Group
              key={g.intent} title={g.label} items={g.items}
              onOpen={onOpen} onConfigure={setConfiguring} pins={pins} onTogglePin={togglePin}
              plugins={plugins} experimentalPluginIds={experimentalPluginIds}
            />
          ))}
        </>
      ) : (
        <div className="gal-grid">
          {shown.filter((d) => d.intent === tab).map((d) => (
            <Card key={d.key} d={d} onOpen={onOpen} onConfigure={setConfiguring}
                  pinned={pins.has(d.key)} onTogglePin={togglePin}
                  plugins={plugins} experimentalPluginIds={experimentalPluginIds} />
          ))}
        </div>
      )}

      {configuring && (
        <DestinationSettings
          destination={configuring}
          artifact={artifact}
          onCancel={() => setConfiguring(null)}
          onSubmit={(params, producerId) => {
            const step = configuring.chain?.[0];
            /**
             * A swapped producer is applied by rewriting the plan the card is
             * carrying, not by threading a second argument all the way down to
             * `executeAction`: `ChainStep.producerId` is already what the host
             * runs, so the choice belongs in the step. It is also remembered,
             * so the next plan for this artifact type starts from it.
             */
            const swapped = step && producerId && producerId !== step.producerId;
            if (swapped) {
              setPreferredProducer(step.type, producerId);
              const alt = step.alternatives.find((x) => x.id === producerId);
              onOpen({
                ...configuring,
                chain: [{
                  ...step,
                  producerId,
                  producerLabel: alt?.label ?? producerId,
                  producerPlugin: alt?.pluginLabel,
                }],
              }, params);
            } else {
              onOpen(configuring, params);
            }
            setConfiguring(null);
          }}
        />
      )}

      {blockedCount > 0 && !query && tab === 'all' && (
        <p className="gal-foot">
          {blockedCount} {blockedCount === 1 ? 'destination needs' : 'destinations need'} something more —
          select a second artifact in the tree and they become available here.
        </p>
      )}
    </div>
  );
}

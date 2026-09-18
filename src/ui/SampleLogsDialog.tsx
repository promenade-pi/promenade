import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export interface SampleLog {
  id: string;
  /** Direct, pinned download endpoint — fetched into a local File before import. */
  url: string;
  name: string;
  fileName: string;
  format: 'OCEL 2.0 JSON' | 'OCEL 2.0 XML' | 'XES';
  size: string;
  category: 'Simulation' | 'Real-world';
  description: string;
  sourceUrl: string;
  large?: boolean;
}

/** The dialog's one distinguishing badge — which of the two log families a
 * sample imports as, object-centric or case-centric — collapsing the format
 * column's serialisation detail (JSON vs XML vs XES) down to that choice. */
export function logFamilyOf(sample: SampleLog): 'OCEL 2.0' | 'XES' {
  return sample.format.startsWith('OCEL') ? 'OCEL 2.0' : 'XES';
}

// The first five are OCEL 2.0: Ocelot's landing-page datasets. Use Zenodo's
// `/api` content endpoints rather than `record/.../files/...`: the latter
// first sends a 301 response without CORS headers, so browsers reject the
// redirect before ever reaching the otherwise downloadable file.
//
// The XES ones are traditional, single-case-notion logs — the classic
// process-mining benchmarks, not object-centric. 4TU.ResearchData, their
// official home, sends no CORS headers at all (confirmed: a browser fetch
// against it fails outright), so these are served from mirrors that do:
// an academic benchmark repo's raw GitHub copies, verified byte-for-byte
// against the original by trace/event counts. `sourceUrl` still points at
// the original citable 4TU record.
export const SAMPLE_LOGS: SampleLog[] = [
  { id: 'logistics', name: 'Logistics', category: 'Simulation', size: '10.2 MB', format: 'OCEL 2.0 JSON', fileName: 'Logistics.json', url: 'https://zenodo.org/api/records/18373888/files/container_logistics.json/content', sourceUrl: 'https://ocel-standard.org/event-logs/simulations/logistics/', description: 'Simulated overseas shipping, from customer orders to terminal departure.' },
  { id: 'order-management', name: 'Order Management', category: 'Simulation', size: '12.6 MB', format: 'OCEL 2.0 JSON', fileName: 'Order Management.json', url: 'https://zenodo.org/api/records/18373906/files/order-management.json/content', sourceUrl: 'https://ocel-standard.org/event-logs/simulations/order-management/', description: 'Customer orders, employees, packages, items, and deliveries.' },
  { id: 'procure-to-pay', name: 'Procure-to-Pay', category: 'Simulation', size: '14.3 MB', format: 'OCEL 2.0 JSON', fileName: 'Procure-to-Pay.json', url: 'https://zenodo.org/api/records/8412920/files/ocel2-p2p.json/content', sourceUrl: 'https://ocel-standard.org/event-logs/simulations/p2p/', description: 'A realistic SAP-inspired purchase requisition through payment process.' },
  { id: 'angular-github-commits', name: 'Angular GitHub Commits', category: 'Real-world', size: '178 MB', format: 'OCEL 2.0 XML', fileName: 'Angular GitHub Commits.xml', large: true, url: 'https://zenodo.org/api/records/8430332/files/angular_github_commits_ocel.xml/content', sourceUrl: 'https://ocel-standard.org/event-logs/real-world/angular-github-commits/', description: 'Angular repository commits related to affected files and branches.' },
  { id: 'scientific-publications', name: 'Scientific Publications', category: 'Real-world', size: '8.1 MB', format: 'OCEL 2.0 XML', fileName: 'Scientific Publications.xml', url: 'https://zenodo.org/api/records/17769774/files/Wil%20M.%20P.%20van%20der%20Aalst_processed.xml/content', sourceUrl: 'https://www.ocel-standard.org/event-logs/real-world/scientific-publications/', description: 'Wil van der Aalst’s publications, authors, keywords, venues, and citations.' },
  { id: 'bpi-challenge-2012', name: 'BPI Challenge 2012', category: 'Real-world', size: '2.9 MB', format: 'XES', fileName: 'BPI Challenge 2012.xes.gz', url: 'https://raw.githubusercontent.com/ERamaM/PredictiveMonitoringDatasets/master/raw_datasets/BPI_Challenge_2012.xes.gz', sourceUrl: 'https://doi.org/10.4121/uuid:3926db30-f712-4394-aebc-75976070e91f', description: 'A Dutch bank’s loan application process, from submission through offer to approval or decline.' },
  { id: 'sepsis-cases', name: 'Sepsis Cases', category: 'Real-world', size: '167 KB', format: 'XES', fileName: 'Sepsis Cases.xes.gz', url: 'https://raw.githubusercontent.com/ERamaM/PredictiveMonitoringDatasets/master/raw_datasets/SEPSIS.xes.gz', sourceUrl: 'https://doi.org/10.4121/uuid:915d2bfb-7e84-49ad-a286-dc35f063a460', description: 'Anonymised hospital trajectories of patients with suspected sepsis, from ER admission to discharge.' },
  { id: 'helpdesk', name: 'Helpdesk', category: 'Real-world', size: '229 KB', format: 'XES', fileName: 'Helpdesk.xes.gz', url: 'https://raw.githubusercontent.com/ERamaM/PredictiveMonitoringDatasets/master/raw_datasets/Helpdesk.xes.gz', sourceUrl: 'https://doi.org/10.17632/39bp3vv62t.1', description: 'IT support tickets through a software company’s helpdesk, from opening to resolution.' },
];

export function SampleLogsDialog({ onClose, onImport, disabled }: {
  onClose: () => void;
  onImport: (sample: SampleLog) => Promise<void>;
  disabled?: boolean;
}) {
  const [downloading, setDownloading] = useState<string | null>(null);
  const [confirmLarge, setConfirmLarge] = useState<SampleLog | null>(null);
  // Opt-in filter chips, not an opt-out toggle pair: nothing selected reads
  // as "no filter" and shows every sample, so clicking a chip narrows straight
  // to that format instead of first having to deselect the other one.
  const [formats, setFormats] = useState({ ocel: false, xes: false });
  const filtering = formats.ocel || formats.xes;
  const visible = SAMPLE_LOGS.filter((sample) => !filtering
    || (logFamilyOf(sample) === 'OCEL 2.0' ? formats.ocel : formats.xes));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !downloading) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, downloading]);

  const start = async (sample: SampleLog) => {
    setConfirmLarge(null);
    setDownloading(sample.id);
    try {
      await onImport(sample);
      onClose();
    } catch {
      // The host shows the actionable download/import error above the
      // workspace; keep this picker open so the user can retry or choose a
      // smaller dataset.
    } finally {
      setDownloading(null);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !downloading) onClose(); }}>
      <div className="modal sample-logs-dialog" role="dialog" aria-modal="true" aria-label="Sample logs">
        <div className="modal-title">Sample logs</div>
        <p className="sample-logs-intro">Curated object-centric (OCEL 2.0) and traditional, case-centric (XES) datasets. They download into this browser, then import exactly like a local file.</p>
        <div className="pl-kind-toggles sample-log-toggles" aria-label="Filter by format">
          <button
            className={formats.ocel ? 'active' : ''}
            aria-pressed={formats.ocel}
            onClick={() => setFormats((current) => ({ ...current, ocel: !current.ocel }))}
          >
            OCEL 2.0
          </button>
          <button
            className={formats.xes ? 'active' : ''}
            aria-pressed={formats.xes}
            onClick={() => setFormats((current) => ({ ...current, xes: !current.xes }))}
          >
            XES
          </button>
        </div>
        <div className="sample-log-list">
          {visible.length === 0 && <div className="sample-log-empty">No sample logs match the selected format.</div>}
          {visible.map((sample) => (
            <div className="sample-log-card" key={sample.id}>
              <div className="sample-log-main">
                <div className="sample-log-name">
                  {sample.name}
                  <span className="chip">{logFamilyOf(sample)}</span>
                </div>
                <div className="sample-log-meta">{sample.category} · {sample.format} · {sample.size}</div>
                <div className="sample-log-description">{sample.description}</div>
                <a href={sample.sourceUrl} target="_blank" rel="noreferrer">Dataset details ↗</a>
              </div>
              <button className="primary" disabled={!!disabled || !!downloading}
                      onClick={() => sample.large ? setConfirmLarge(sample) : void start(sample)}>
                {downloading === sample.id ? 'Downloading…' : 'Import'}
              </button>
            </div>
          ))}
        </div>
        {confirmLarge && (
          <div className="sample-large-warning" role="alert">
            <b>{confirmLarge.name} is a large download ({confirmLarge.size}).</b>
            <span>It will be downloaded into browser memory before import.</span>
            <div><button onClick={() => setConfirmLarge(null)}>Cancel</button><button className="primary" onClick={() => void start(confirmLarge)}>Download and import</button></div>
          </div>
        )}
        <div className="modal-actions">
          <button onClick={onClose} disabled={!!downloading}>Close</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * Shown when `DataClient.boot()` is refused because another tab of this
 * origin already holds the single-writer lock (see `host/data/singleWriter.ts`
 * for why only one tab can drive Promenade at a time).
 *
 * There is no "use here anyway": the other tab's DuckDB holds the OPFS access
 * handles, so this tab genuinely cannot open them until that tab lets go. So
 * the screen just waits — the moment the lock frees (the other tab closed or
 * navigated away) it reloads and boots normally. The button is a manual
 * fallback for the same thing.
 */
import { useEffect, useState } from 'react';
import { waitForWriterLockToFree } from '../host/data/singleWriter';
import { BrandLogo } from './BrandLogo';

export function AnotherTabGate() {
  const [freed, setFreed] = useState(false);

  useEffect(() => {
    let live = true;
    waitForWriterLockToFree().then(() => {
      if (!live) return;
      setFreed(true);
      window.location.reload();
    });
    return () => { live = false; };
  }, []);

  return (
    <div className="empty">
      <div className="start-screen">
        <BrandLogo height={34} />
        <h2 style={{ marginTop: 18 }}>Promenade is open in another tab</h2>
        <p>
          Your event logs and workspaces live in this browser's local storage,
          and only one tab can use the query engine at a time. Close the other
          Promenade tab to continue here.
        </p>
        <p style={{ fontSize: 11.5 }}>
          {freed
            ? 'The other tab closed — reloading…'
            : 'This tab will switch over automatically once the other one closes.'}
        </p>
        <button className="primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}

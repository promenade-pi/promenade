import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Dev-only corpus route.
 *
 * Serves the benchmark logs so the import path can be exercised end to end
 * without a native file dialog. Not part of the application: the real entry
 * point is the user's own file picker.
 */
function devCorpora() {
  const ROOTS = [
    process.env.HOME + '/Downloads',
  ];
  return {
    name: 'dev-corpora',
    apply: 'serve' as const,
    configureServer(server: any) {
      // Dev-only plugin registry, so install-from-registry and updates can be
      // exercised without a deployed index. Lives in the repo, not a session
      // scratchpad — the latter is ephemeral and disappears on cleanup,
      // silently 404ing every plugin this route used to serve.
      server.middlewares.use('/registry', (req: any, res: any) => {
        const REG = path.join(__dirname, 'dev-registry');
        const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.json';
        if (rel.includes('..')) { res.statusCode = 400; return res.end('bad path'); }
        const file = path.join(REG, rel);
        if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
        res.setHeader('Content-Type',
          rel.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        res.setHeader('Access-Control-Allow-Origin', '*');
        fs.createReadStream(file).pipe(res);
      });

      server.middlewares.use('/data', (req: any, res: any) => {
        const name = decodeURIComponent(req.url.replace(/^\//, '').split('?')[0]);
        const file = ROOTS.map((r) => path.join(r, name)).find((p) => fs.existsSync(p));
        if (!file) { res.statusCode = 404; return res.end('not found'); }
        res.setHeader('Content-Length', fs.statSync(file).size);
        res.setHeader('Content-Type', 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devCorpora()],
  server: {
    port: Number(process.env.PORT) || 5200,
    // No COOP/COEP. Milestone 0 established that the data path does not need
    // cross-origin isolation: the threaded DuckDB bundle cannot load the
    // parquet extension, so the single-threaded build is used, and that needs
    // no SharedArrayBuffer. Leaving the headers off keeps static hosting
    // without header control (e.g. GitHub Pages) viable with no workaround.
  },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  worker: { format: 'es' },
});

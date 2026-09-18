/**
 * Serves `/registry/index.json` and `/registry/packages/*.pmplugin` from the
 * R2 bucket published by `dev-registry/publish-to-r2.sh`, so a plugin update
 * ships independently of rebuilding/redeploying the app itself. Everything
 * else falls straight through to the built static app in `dist/` (bound as
 * `ASSETS` — see `wrangler.toml`'s `run_worker_first`, which is what routes
 * `/registry/*` here instead of straight to the asset lookup).
 *
 * Mirrors the dev-only middleware in `vite.config.ts` (`devCorpora`), which
 * serves the same paths from `dev-registry/` on disk during local dev.
 */

export interface Env {
  ASSETS: Fetcher;
  REGISTRY_BUCKET: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/registry/')) {
      const key = url.pathname.slice('/registry/'.length) || 'index.json';
      if (key.includes('..')) {
        return new Response('bad path', { status: 400 });
      }

      const object = await env.REGISTRY_BUCKET.get(key);
      if (!object) {
        return new Response('not found', { status: 404 });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set(
        'Content-Type',
        key.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      );
      // index.json changes with every publish; packages are immutable once
      // built (the filename embeds the version), so they can cache hard.
      headers.set(
        'Cache-Control',
        key === 'index.json' ? 'public, max-age=60' : 'public, max-age=31536000, immutable',
      );

      return new Response(object.body, { headers });
    }

    return env.ASSETS.fetch(request);
  },
};

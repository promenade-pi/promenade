/**
 * Re-exported from the host layer, which now has its own callers too
 * (`host/plugins/runtimeAdapters.ts`) — see `host/artifact/tables.ts` for
 * the actual definition. Kept here so every existing view's import path
 * keeps working unchanged.
 */
export { tableOf } from '../../host/artifact/tables';

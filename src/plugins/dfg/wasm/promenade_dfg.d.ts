/* tslint:disable */
/* eslint-disable */

/**
 * Accumulates directly-follows counts across chunks of an ordered event stream.
 *
 * Rows must arrive ordered by (case, timestamp). The host guarantees that with
 * an ORDER BY, which is where such work belongs.
 */
export class DfgBuilder {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Per-activity occurrence counts, indexed by activity id.
     */
    activityCounts(): Uint32Array;
    caseCount(): number;
    edgeCount(): number;
    /**
     * End activities above the threshold, as [activity, freq, ...].
     */
    endActivities(min_frequency: number): Uint32Array;
    /**
     * The cheap, parameter-dependent stage.
     *
     * Returns flat triples [src, dst, freq, ...] so the boundary stays a
     * single typed array rather than a serialised object graph. This is what
     * the inspector's threshold control calls on every change.
     */
    filter(min_frequency: number): Uint32Array;
    /**
     * Closes the final case. Must be called before `filter`.
     */
    finish(): void;
    /**
     * Approximate retained size, so the host can enforce a memory budget.
     */
    heapEstimate(): number;
    constructor(n_activities: number);
    /**
     * Consumes one ordered chunk. `cases` and `activities` are parallel arrays.
     */
    pushChunk(cases: Int32Array, activities: Int32Array): void;
    rowCount(): number;
    /**
     * Start activities above the threshold, as [activity, freq, ...].
     */
    startActivities(min_frequency: number): Uint32Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_dfgbuilder_free: (a: number, b: number) => void;
    readonly dfgbuilder_activityCounts: (a: number) => [number, number];
    readonly dfgbuilder_caseCount: (a: number) => number;
    readonly dfgbuilder_edgeCount: (a: number) => number;
    readonly dfgbuilder_endActivities: (a: number, b: number) => [number, number];
    readonly dfgbuilder_filter: (a: number, b: number) => [number, number];
    readonly dfgbuilder_finish: (a: number) => void;
    readonly dfgbuilder_heapEstimate: (a: number) => number;
    readonly dfgbuilder_new: (a: number) => number;
    readonly dfgbuilder_pushChunk: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly dfgbuilder_rowCount: (a: number) => number;
    readonly dfgbuilder_startActivities: (a: number, b: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

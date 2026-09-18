/**
 * Byte-stream reading over a File via File.slice().
 *
 * Deliberately never calls file.text() or file.arrayBuffer(). Besides the
 * memory cost, a V8 string caps out near 512 MB - the 579 MB BPI-2017 XES
 * throws before a parser ever sees it.
 */
import { Gunzip } from 'fflate';

export const DEFAULT_CHUNK = 8 * 1024 * 1024;

/** Yields Uint8Array chunks of `file` without ever holding the whole file. */
export async function* byteChunks(file, chunkSize = DEFAULT_CHUNK, onProgress) {
  let offset = 0;
  const total = file.size;
  while (offset < total) {
    const end = Math.min(offset + chunkSize, total);
    // slice() is lazy: no bytes are read until arrayBuffer() resolves, and the
    // buffer is released as soon as this iteration ends.
    const buf = await file.slice(offset, end).arrayBuffer();
    yield new Uint8Array(buf);
    offset = end;
    onProgress?.(offset, total);
  }
}

/** Same contract, but over a fetch() body - used for HTTP-sourced corpora. */
export async function* responseChunks(response, onProgress) {
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    yield value;
    onProgress?.(read, total);
  }
}

/**
 * A byte source abstracts where the bytes come from, so the parsers are
 * identical whether the user picked a local File or the log is being read
 * over HTTP. Only the acquisition differs; the streaming contract does not.
 */
export function fileSource(file, chunkSize = DEFAULT_CHUNK) {
  return {
    kind: 'file',
    size: file.size,
    file,
    chunks: (onProgress) => byteChunks(file, chunkSize, onProgress),
  };
}

/**
 * Decompresses a gzip-compressed File chunk-by-chunk while it is being read,
 * so a 500 MB .xes.gz never exists as a decompressed whole in memory any
 * more than a plain .xes does.
 *
 * `fflate`'s `Gunzip` is a push-based synchronous decoder: each compressed
 * chunk read off disk is pushed in, and `ondata` fires zero or more times
 * with decompressed output before `push()` returns. Progress is reported
 * against compressed bytes read, not decompressed bytes produced - the ratio
 * isn't known upfront, and this matches how the existing sources report
 * progress against the bytes they actually transfer (see `responseChunks`).
 */
export async function* gzipChunks(file, chunkSize = DEFAULT_CHUNK, onProgress) {
  let out = [];
  const gunzip = new Gunzip((chunk) => { out.push(chunk); });

  let offset = 0;
  const total = file.size;
  while (offset < total) {
    const end = Math.min(offset + chunkSize, total);
    const buf = await file.slice(offset, end).arrayBuffer();
    gunzip.push(new Uint8Array(buf), end >= total);
    offset = end;
    onProgress?.(offset, total);
    if (out.length) { yield* out; out = []; }
  }
}

export function gzipFileSource(file, chunkSize = DEFAULT_CHUNK) {
  return {
    kind: 'file-gz',
    size: file.size,
    file,
    chunks: (onProgress) => gzipChunks(file, chunkSize, onProgress),
  };
}

export async function httpSource(url) {
  const head = await fetch(url, { method: 'HEAD' });
  const size = Number(head.headers.get('content-length')) || 0;
  return {
    kind: 'http',
    size,
    url,
    chunks: async function* (onProgress) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      yield* responseChunks(res, onProgress);
    },
  };
}

/**
 * Incremental UTF-8 decode across chunk boundaries. TextDecoder with
 * {stream:true} holds back partial multi-byte sequences, so a character split
 * across two slices is not corrupted.
 */
export function makeDecoder() {
  const dec = new TextDecoder('utf-8');
  return {
    decode: (chunk) => dec.decode(chunk, { stream: true }),
    flush: () => dec.decode(),
  };
}

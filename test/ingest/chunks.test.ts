import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'fflate';
import { gzipChunks } from '../../src/ingest/lib/chunks.ts';

/** Minimal File stand-in: Node has no File.slice(), so this wraps a Buffer. */
function fakeFile(bytes: Uint8Array) {
  return {
    size: bytes.byteLength,
    slice(start: number, end: number) {
      const part = bytes.subarray(start, end);
      return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
    },
  };
}

async function collect(gen: AsyncGenerator<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const c of gen) parts.push(c);
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}

test('gzipChunks decompresses a single-member gzip stream back to the original bytes', async () => {
  const xml = '<?xml version="1.0"?><log><trace><event><string key="concept:name" value="A"/></event></trace></log>';
  const original = new TextEncoder().encode(xml);
  const compressed = gzipSync(original);

  const out = await collect(gzipChunks(fakeFile(compressed) as any, 16, undefined));
  assert.equal(new TextDecoder().decode(out), xml);
});

test('gzipChunks handles input spanning many chunks smaller than one gzip block', async () => {
  const original = new TextEncoder().encode('x'.repeat(500_000));
  const compressed = gzipSync(original);

  // Chunk size far smaller than the compressed payload, so push() is called
  // many times before the final chunk - exercises multi-push accumulation.
  const out = await collect(gzipChunks(fakeFile(compressed) as any, 97, undefined));
  assert.deepEqual(out, original);
});

test('gzipChunks reports progress against compressed bytes read', async () => {
  const original = new TextEncoder().encode('hello world '.repeat(1000));
  const compressed = gzipSync(original);

  const seen: Array<[number, number]> = [];
  await collect(gzipChunks(fakeFile(compressed) as any, 64, (done: number, total: number) => {
    seen.push([done, total]);
  }));

  assert.ok(seen.length > 1);
  assert.equal(seen.at(-1)![0], compressed.byteLength);
  for (const [, total] of seen) assert.equal(total, compressed.byteLength);
});

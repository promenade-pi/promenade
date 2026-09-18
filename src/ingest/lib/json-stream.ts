/**
 * Streaming reader for the OCEL 2.0 JSON shape.
 *
 * The document is one root object whose heavy members are arrays (`events`,
 * `objects`). Rather than a general SAX-style JSON parser, this splits those
 * arrays into their top-level elements and JSON.parse()s one element at a
 * time. Each element is a few hundred bytes, so the parse is cheap and exact,
 * while the 1.6 GB document is never a string.
 *
 * String and escape state are tracked so braces inside string literals do not
 * disturb the depth count.
 */
export class JsonRootStreamer {
  /**
   * @param onElement (arrayKey, elementObject) => void|Promise
   * @param arrays    Set of root-level array keys to stream
   */
  constructor({ arrays, onElement, onScalarKey }) {
    this.arrays = new Set(arrays);
    this.onElement = onElement;
    this.onScalarKey = onScalarKey;

    this.buf = '';
    this.base = 0; // absolute offset of buf[0]
    this.i = 0; // absolute scan position

    this.depth = 0;
    this.inString = false;
    this.escape = false;

    this.pendingKey = null; // last string seen at depth 1
    this.stringStart = -1;
    this.currentArray = null;
    this.elementStart = -1;
    this.pending = [];
  }

  write(chunk) {
    this.buf += chunk;
    this._scan();
    this._compact();
  }

  end() {
    this._scan();
  }

  /** Drop the part of the buffer no longer needed for an in-flight element. */
  _compact() {
    const keepFrom =
      this.elementStart >= 0 ? this.elementStart : this.stringStart >= 0 ? this.stringStart : this.i;
    const cut = keepFrom - this.base;
    if (cut > 1 << 20) {
      this.buf = this.buf.slice(cut);
      this.base += cut;
    }
  }

  _scan() {
    const buf = this.buf;
    const end = this.base + buf.length;

    while (this.i < end) {
      const c = buf[this.i - this.base];

      if (this.inString) {
        if (this.escape) {
          this.escape = false;
        } else if (c === '\\') {
          this.escape = true;
        } else if (c === '"') {
          this.inString = false;
          if (this.depth === 1 && this.currentArray === null) {
            // Candidate root-level key; confirmed when ':' follows.
            this.pendingKey = buf.slice(this.stringStart + 1 - this.base, this.i - this.base);
          }
          this.stringStart = -1;
        }
        this.i++;
        continue;
      }

      switch (c) {
        case '"':
          this.inString = true;
          this.stringStart = this.i;
          break;

        case '{':
        case '[':
          this.depth++;
          if (this.currentArray !== null && this.depth === 3 && this.elementStart < 0) {
            this.elementStart = this.i;
          } else if (
            c === '[' &&
            this.depth === 2 &&
            this.currentArray === null &&
            this.pendingKey !== null &&
            this.arrays.has(this.pendingKey)
          ) {
            this.currentArray = this.pendingKey;
          }
          break;

        case '}':
        case ']':
          if (this.currentArray !== null && this.depth === 3 && this.elementStart >= 0) {
            const text = buf.slice(this.elementStart - this.base, this.i + 1 - this.base);
            this.elementStart = -1;
            this.depth--;
            const r = this.onElement(this.currentArray, JSON.parse(text));
            if (r && r.then) this.pending.push(r);
            this.i++;
            continue;
          }
          this.depth--;
          if (this.depth === 1 && this.currentArray !== null && c === ']') {
            this.currentArray = null;
            this.pendingKey = null;
          }
          break;
      }
      this.i++;
    }
  }

  async drain() {
    if (this.pending.length) {
      await Promise.all(this.pending);
      this.pending.length = 0;
    }
  }
}

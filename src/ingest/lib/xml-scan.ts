/**
 * Incremental XML scanner.
 *
 * Pull-based and resumable: it is fed arbitrary string chunks and emits tag
 * events, holding back any tag that straddles a chunk boundary until the rest
 * arrives. The BPI-2017 XES is a single 579 MB line with no newlines at all,
 * so splitting on line breaks is not an option and this has to work at the
 * byte level.
 *
 * Not a general XML processor - no namespace resolution, no DTD entity
 * expansion. XES needs neither.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const cp =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

/** Parses `a="1" b='2'` into a plain object. */
function parseAttrs(src, from) {
  const attrs = {};
  let i = from;
  const n = src.length;
  while (i < n) {
    while (i < n && /\s/.test(src[i])) i++;
    if (i >= n || src[i] === '/' || src[i] === '>') break;
    let ns = i;
    while (i < n && !/[\s=/>]/.test(src[i])) i++;
    const name = src.slice(ns, i);
    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] !== '=') { attrs[name] = ''; continue; }
    i++;
    while (i < n && /\s/.test(src[i])) i++;
    const q = src[i];
    if (q === '"' || q === "'") {
      i++;
      const vs = i;
      while (i < n && src[i] !== q) i++;
      attrs[name] = decodeEntities(src.slice(vs, i));
      i++;
    } else {
      const vs = i;
      while (i < n && !/[\s>]/.test(src[i])) i++;
      attrs[name] = decodeEntities(src.slice(vs, i));
    }
  }
  return attrs;
}

export class XmlScanner {
  /**
 * @param handlers {onOpen(name, attrs, selfClosing), onClose(name), onText(text)}
   */
  constructor(handlers) {
    this.h = handlers;
    this.buf = '';
    this.pos = 0;
  }

  /** Feed a decoded string chunk; processes everything complete within it. */
  write(chunk) {
    this.buf = this.pos > 0 ? this.buf.slice(this.pos) + chunk : this.buf + chunk;
    this.pos = 0;
    this._run();
    // Drop the consumed prefix so `buf` stays near one tag, not one file.
    if (this.pos > 0) {
      this.buf = this.buf.slice(this.pos);
      this.pos = 0;
    }
  }

  end() {
    this._run();
  }

  _run() {
    const buf = this.buf;
    const n = buf.length;
    for (;;) {
      const lt = buf.indexOf('<', this.pos);
      if (lt === -1) {
        if (this.pos < n) this.h.onText?.(buf.slice(this.pos));
        this.pos = n;
        return;
      }

      if (lt > this.pos) this.h.onText?.(buf.slice(this.pos, lt));

      // Constructs whose terminator is not a bare '>'.
      if (buf.startsWith('<!--', lt)) {
        const e = buf.indexOf('-->', lt + 4);
        if (e === -1) { this.pos = lt; return; }
        this.pos = e + 3;
        continue;
      }
      if (buf.startsWith('<![CDATA[', lt)) {
        const e = buf.indexOf(']]>', lt + 9);
        if (e === -1) { this.pos = lt; return; }
        this.pos = e + 3;
        continue;
      }
      if (buf.startsWith('<?', lt)) {
        const e = buf.indexOf('?>', lt + 2);
        if (e === -1) { this.pos = lt; return; }
        this.pos = e + 2;
        continue;
      }
      if (buf.startsWith('<!', lt)) {
        const e = buf.indexOf('>', lt + 2);
        if (e === -1) { this.pos = lt; return; }
        this.pos = e + 1;
        continue;
      }

      // Ordinary tag: find '>' that is not inside an attribute value.
      let i = lt + 1;
      let quote = 0;
      let gt = -1;
      while (i < n) {
        const c = buf.charCodeAt(i);
        if (quote) {
          if (c === quote) quote = 0;
        } else if (c === 34 || c === 39) {
          quote = c;
        } else if (c === 62) {
          gt = i;
          break;
        }
        i++;
      }
      if (gt === -1) { this.pos = lt; return; } // tag spans the boundary

      const isClose = buf.charCodeAt(lt + 1) === 47; // '/'
      const selfClosing = buf.charCodeAt(gt - 1) === 47;

      if (isClose) {
        const name = buf.slice(lt + 2, gt).trim();
        this.h.onClose?.(name);
      } else {
        let ne = lt + 1;
        while (ne < gt && !/[\s/>]/.test(buf[ne])) ne++;
        const name = buf.slice(lt + 1, ne);
        const attrs =
          ne < (selfClosing ? gt - 1 : gt)
            ? parseAttrs(buf.slice(0, selfClosing ? gt - 1 : gt), ne)
            : {};
        this.h.onOpen?.(name, attrs, selfClosing);
        if (selfClosing) this.h.onClose?.(name);
      }
      this.pos = gt + 1;
    }
  }
}

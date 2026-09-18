/**
 * Minimal allowlist-style HTML sanitizer for notebook `text/html` /
 * `image/svg+xml` output.
 *
 * The common rich-output path (DataFrame previews) never goes through this —
 * it uses the structured `application/vnd.promenade.dataframe+json` MIME
 * type instead, precisely to avoid needing to sanitize markup for the
 * common case. This exists for the rarer case of a cell explicitly
 * returning/displaying raw HTML: strips script-bearing elements,
 * event-handler attributes, and `javascript:`/non-image `data:` URLs before
 * the result is ever handed to `dangerouslySetInnerHTML`. See
 * docs/python-notebook.md, "Security".
 */

const BLOCKED_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'link', 'meta', 'style', 'base', 'form']);

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (BLOCKED_TAGS.has(child.tagName.toLowerCase())) {
        child.remove();
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) { child.removeAttribute(attr.name); continue; }
        const isUrlAttr = name === 'href' || name === 'src' || name === 'action';
        const isImageDataUrl = name === 'src' && /^\s*data:image\//i.test(attr.value);
        if (isUrlAttr && !isImageDataUrl && /^\s*(javascript|data):/i.test(attr.value)) {
          child.removeAttribute(attr.name);
        }
      }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

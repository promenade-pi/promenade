import { Fragment, type ReactNode } from 'react';

/**
 * Markdown renderer for plugin documentation.
 *
 * Deliberately small and deliberately *not* backed by a general markdown
 * library plus a sanitiser. A plugin's README is third-party content, and the
 * safest way to render third-party text is never to build HTML from it at all:
 * this produces React elements directly, so `dangerouslySetInnerHTML` is never
 * used and raw HTML in the source cannot execute. Anything unsupported degrades
 * to plain text rather than being passed through.
 *
 * Supported: headings, paragraphs, lists, code blocks, inline code, bold,
 * italic, links, images, block quotes, horizontal rules, tables.
 */

/** Only these protocols may appear in a link or image the plugin authored. */
function safeHref(href: string): string | null {
  const v = href.trim();
  if (/^(https?:|mailto:)/i.test(v)) return v;
  // Relative links inside the package are resolved by the caller; anything
  // else (javascript:, data:, vbscript:) is dropped.
  return null;
}

function inline(text: string, resolve?: (src: string) => string | undefined): ReactNode[] {
  const out: ReactNode[] = [];
  // One pass over the inline constructs, longest-first so `**` beats `*`.
  const re = /(!\[([^\]]*)\]\(([^)\s]+)[^)]*\))|(\[([^\]]+)\]\(([^)\s]+)[^)]*\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(_([^_]+)_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) {
      const src = resolve?.(m[3]) ?? safeHref(m[3]);
      out.push(src
        ? <img key={key++} src={src} alt={m[2]} className="md-img" />
        : <span key={key++}>{m[2]}</span>);
    } else if (m[4]) {
      const href = safeHref(m[6]);
      out.push(href
        ? <a key={key++} href={href} target="_blank" rel="noopener noreferrer">{m[5]}</a>
        : <span key={key++}>{m[5]}</span>);
    } else if (m[7]) {
      out.push(<code key={key++}>{m[8]}</code>);
    } else if (m[9]) {
      out.push(<strong key={key++}>{m[10]}</strong>);
    } else if (m[11]) {
      out.push(<em key={key++}>{m[12]}</em>);
    } else if (m[13]) {
      out.push(<em key={key++}>{m[14]}</em>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({
  source, resolveImage,
}: {
  source: string;
  /** Maps a relative image path to a blob URL read out of the package. */
  resolveImage?: (src: string) => string | undefined;
}) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  const flushList = (ordered: boolean, items: string[]) => {
    const children = items.map((t, n) => <li key={n}>{inline(t, resolveImage)}</li>);
    blocks.push(ordered
      ? <ol key={key++}>{children}</ol>
      : <ul key={key++}>{children}</ul>);
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Fenced code: taken verbatim, never parsed for inline constructs.
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key++} className="md-code" data-lang={lang}>
          <code>{body.join('\n')}</code>
        </pre>
      );
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const Tag = `h${Math.min(6, h[1].length)}` as 'h1';
      blocks.push(<Tag key={key++} className="md-h">{inline(h[2], resolveImage)}</Tag>);
      i++;
      continue;
    }

    if (/^([-*_])\1{2,}\s*$/.test(line)) { blocks.push(<hr key={key++} />); i++; continue; }

    if (line.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) body.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={key++}>{inline(body.join(' '), resolveImage)}</blockquote>);
      continue;
    }

    // Table: a header row followed by a separator of dashes.
    if (line.includes('|') && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1] ?? '')) {
      const cells = (r: string) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      blocks.push(
        <table key={key++} className="grid md-table">
          <thead><tr>{head.map((c, n) => <th key={n}>{inline(c, resolveImage)}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, n) => (
              <tr key={n}>{r.map((c, m) => <td key={m}>{inline(c, resolveImage)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      );
      continue;
    }

    const li = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m2 = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!m2 || /\d/.test(m2[1]) !== ordered) break;
        items.push(m2[2]);
        i++;
      }
      flushList(ordered, items);
      continue;
    }

    // Paragraph: consecutive non-blank lines that start nothing else.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim()
           && !lines[i].startsWith('```') && !/^#{1,6}\s/.test(lines[i])
           && !lines[i].startsWith('>') && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
      para.push(lines[i++]);
    }
    blocks.push(<p key={key++}>{inline(para.join(' '), resolveImage)}</p>);
  }

  return <div className="md">{blocks.map((b, n) => <Fragment key={n}>{b}</Fragment>)}</div>;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, char => ESCAPES[char]!);
}

function safeUrl(url: string): string | null {
  const value = url.trim();
  return /^(https?:\/\/|mailto:|\/|#|\.{1,2}\/)/.test(value) ? value : null;
}

function slug(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_[\]()]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\w一-龥-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 行内格式：先转义，再还原反引号代码，避免代码里的字符被当成标记。 */
export function inline(text: string): string {
  const codes: string[] = [];
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
    const target = safeUrl(url);
    if (!target) return match;
    const external = /^https?:\/\//.test(target);
    const attrs = external ? ' target="_blank" rel="noreferrer"' : '';
    return `<a href="${target}"${attrs}>${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codes[Number(index)]!);
  return out;
}

type ListState = { type: 'ul' | 'ol'; items: string[] };

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let list: ListState | null = null;
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    html.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };

  const flushList = (): void => {
    if (!list) return;
    const items = list.items.map(item => `<li>${inline(item)}</li>`).join('');
    html.push(`<${list.type}>${items}</${list.type}>`);
    list = null;
  };

  const flushAll = (): void => {
    flushParagraph();
    flushList();
  };

  const isTableSeparator = (line: string): boolean =>
    /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');

  const splitRow = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map(cell => cell.trim());

  while (index < lines.length) {
    const line = lines[index]!;

    if (/^```/.test(line.trim())) {
      flushAll();
      const language = line.trim().slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index]!.trim())) {
        code.push(lines[index]!);
        index += 1;
      }
      index += 1;
      const className = language ? ` class="language-${escapeHtml(language)}"` : '';
      html.push(`<pre><code${className}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (line.trim() === '') {
      flushAll();
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      html.push(`<h${level} id="${slug(text)}">${inline(text)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flushAll();
      html.push('<hr />');
      index += 1;
      continue;
    }

    if (
      line.includes('|') &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1]!)
    ) {
      flushAll();
      const header = splitRow(line);
      const align = splitRow(lines[index + 1]!).map(cell => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
      });
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim() !== '') {
        rows.push(splitRow(lines[index]!));
        index += 1;
      }
      const head = header
        .map((cell, cellIndex) => {
          const style = align[cellIndex] ? ` style="text-align:${align[cellIndex]}"` : '';
          return `<th${style}>${inline(cell)}</th>`;
        })
        .join('');
      const body = rows
        .map(
          row =>
            `<tr>${header
              .map((_cell, cellIndex) => {
                const style = align[cellIndex] ? ` style="text-align:${align[cellIndex]}"` : '';
                return `<td${style}>${inline(row[cellIndex] ?? '')}</td>`;
              })
              .join('')}</tr>`,
        )
        .join('');
      html.push(`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushAll();
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index]!)) {
        quote.push(lines[index]!.replace(/^>\s?/, ''));
        index += 1;
      }
      html.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      continue;
    }

    const unordered = /^[-*]\s+(.*)$/.exec(line);
    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const type = unordered ? 'ul' : 'ol';
      const text = (unordered ?? ordered)![1]!;
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push(text);
      index += 1;
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }

  flushAll();
  return html.join('\n');
}

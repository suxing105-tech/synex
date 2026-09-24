import { backendUrl } from './backend-url';

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const local = (s: string) => !/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(s) || /^file:\/\//i.test(s);

function inline(source: string, id: number, depth = 0): string {
  if (depth > 5) return escapeHtml(source);
  const pattern = /`([^`\n]+)`|(!?)\[([^\]\n]*)\]\((<[^>\n]+>|[^\s)]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  let html = '', at = 0;
  for (const m of source.matchAll(pattern)) {
    html += escapeHtml(source.slice(at, m.index));
    if (m[1] !== undefined) html += `<code>${escapeHtml(m[1])}</code>`;
    else if (m[3] !== undefined) {
      const href = m[4].replace(/^<|>$/g, '');
      const label = escapeHtml(m[3] || '素材');
      if (local(href)) {
        const data = `data-href="${escapeHtml(href)}"`;
        html += m[2] ? `<span class="text-asset"><img src="${escapeHtml(backendUrl(`/api/texts/${id}/asset?href=${encodeURIComponent(href)}`))}" alt="${label}" loading="lazy"/><button type="button" ${data}>${label} · 打开 / 重新定位</button></span>`
          : `<button type="button" class="text-link" ${data}>▶ ${label}</button>`;
      } else if (!m[2] && /^https?:\/\//i.test(href)) html += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`;
      else html += `<span title="远程内容不会自动加载">${label}（外部链接：${escapeHtml(href)}）</span>`;
    } else if (m[5] !== undefined) html += `<strong>${inline(m[5], id, depth + 1)}</strong>`;
    else html += `<em>${inline(m[6], id, depth + 1)}</em>`;
    at = m.index! + m[0].length;
  }
  return html + escapeHtml(source.slice(at));
}

export interface MarkdownBlock { start: number; end: number; text: string; }
/** Blank-line blocks, while keeping fenced code (including blank lines) together. */
export function markdownBlocks(body: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let start = 0, pos = 0, fence = '';
  for (const line of body.split(/(?<=\n)/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
    }
    pos += line.length;
    if (!fence && /^\s*$/.test(line) && pos > start) {
      blocks.push({ start, end: pos, text: body.slice(start, pos) }); start = pos;
    }
  }
  if (start < body.length || !blocks.length) blocks.push({ start, end: body.length, text: body.slice(start) });
  return blocks;
}

export function renderMarkdown(source: string, id: number): string {
  const lines = source.split('\n');
  let html = '', fence = '', code: string[] = [], list = '';
  const closeList = () => { if (list) { html += `</${list}>`; list = ''; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      closeList();
      if (!fence) { fence = f[1]; code = []; }
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) { html += `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`; fence = ''; }
      else code.push(line);
      continue;
    }
    if (fence) { code.push(line); continue; }
    if (!line.trim()) { closeList(); continue; }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      closeList();
      const cells = (s: string) => s.trim().replace(/^\||\|$/g, '').split('|');
      html += '<table><thead><tr>' + cells(line).map(x => `<th>${inline(x.trim(), id)}</th>`).join('') + '</tr></thead><tbody>';
      i += 2;
      for (; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) html += '<tr>' + cells(lines[i]).map(x => `<td>${inline(x.trim(), id)}</td>`).join('') + '</tr>';
      i--; html += '</tbody></table>'; continue;
    }
    const li = line.match(/^\s*(?:([-+*])|\d+\.)\s+(.*)$/);
    if (li) {
      const kind = li[1] ? 'ul' : 'ol';
      if (list !== kind) { closeList(); html += `<${kind}>`; list = kind; }
      const task = li[2].match(/^\[([ xX])\]\s+(.*)$/);
      html += `<li>${task ? (task[1] === ' ' ? '☐ ' : '☑ ') + inline(task[2], id) : inline(li[2], id)}</li>`; continue;
    }
    closeList();
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) html += `<h${h[1].length}>${inline(h[2], id)}</h${h[1].length}>`;
    else if (/^>\s?/.test(line)) html += `<blockquote>${inline(line.replace(/^>\s?/, ''), id)}</blockquote>`;
    else if (/^([-*_])\1{2,}\s*$/.test(line)) html += '<hr/>';
    else html += `<p>${inline(line, id)}</p>`;
  }
  closeList();
  if (fence) html += `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`;
  return html || '<p class="placeholder">点击开始写作…</p>';
}

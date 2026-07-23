/* Tiny markdown renderer (headings, bold/italic, inline code, fences, lists,
 * links). Used only by drawer.js's entryEl. */

import { esc } from './util.js';

function mdInline(s) {
  // code spans and links are stashed before emphasis regexes run, so a
  // snake_case identifier or __-laden URL inside them doesn't get <em>-mangled
  const spans = [];
  const stash = (html) => `\x01${spans.push(html) - 1}\x01`;
  s = s.replace(/`([^`]+)`/g, (_, c) => stash(`<code>${c}</code>`));
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, href) => stash(`<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`));
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
  s = s.replace(/\x01(\d+)\x01/g, (_, i) => spans[Number(i)]);
  return s;
}

export function mdToHtml(raw) {
  const blocks = [];
  const text = esc(raw).replace(/```([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${code.replace(/^[ \t]*[A-Za-z0-9_+-]*\n/, '')}</code></pre>`);
    return `\x00BLOCK${blocks.length - 1}\x00`;
  });

  const lines = text.split('\n');
  const out = [];
  let listType = null;
  let para = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(mdInline).join('<br>')}</p>`);
    para = [];
  };
  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  for (const line of lines) {
    const blockMatch = line.trim().match(/^\x00BLOCK(\d+)\x00$/);
    if (blockMatch) {
      flushPara(); closeList();
      out.push(blocks[Number(blockMatch[1])]);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara(); closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${mdInline(heading[2])}</h${level}>`);
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${mdInline(ol[1])}</li>`);
      continue;
    }
    if (ul) {
      flushPara();
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${mdInline(ul[1])}</li>`);
      continue;
    }
    if (line.trim() === '') {
      flushPara(); closeList();
      continue;
    }
    para.push(line);
  }
  flushPara(); closeList();

  return out.join('\n');
}

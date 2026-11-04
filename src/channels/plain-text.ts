/**
 * WeChat shows Markdown as literal symbols, and a link to a workspace path cannot be opened on the phone (the file itself
 * is sent separately). Keep the words, drop the markup; web links keep their address.
 */
export function plainChatText(text: string): string {
  const lines: string[] = [];
  let code = false;
  for (const raw of text.split('\n')) {
    // Fences go, their contents stay verbatim: code may hold `**`, `__init__` or `|` that are not markup.
    if (/^\s*```/.test(raw)) { code = !code; continue; }
    if (code) { lines.push(raw); continue; }
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(raw)) continue;
    let line = raw;
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().slice(1, -1).split('|').map(cell => cell.trim()).join('  ');
    line = line
      .replace(/!?\[([^\]]*)\]\(<?(https?:\/\/[^)>\s]+)>?\)/g, '$1（$2）')
      .replace(/!?\[([^\]]*)\]\(<?[^)>]*>?\)/g, '$1')
      .replace(/^(\s*)#{1,6}\s+/, '$1')
      .replace(/^(\s*)>\s?/, '$1')
      .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1');
    lines.push(line);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

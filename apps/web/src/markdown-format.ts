function mathInProse(text: string) {
  return text.replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => `\n\n$$\n${body.trim()}\n$$\n\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => `$${body.trim().replace(/\n/g, ' ')}$`);
}
function outsideInlineCode(text: string) {
  let output = '', start = 0, cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== '`') { cursor++; continue; }
    output += mathInProse(text.slice(start, cursor));
    let end = cursor;
    while (text[end] === '`') end++;
    const delimiter = text.slice(cursor, end);
    const close = text.indexOf(delimiter, end);
    if (close < 0) return output + text.slice(cursor);
    output += text.slice(cursor, close + delimiter.length);
    cursor = close + delimiter.length; start = cursor;
  }
  return output + mathInProse(text.slice(start));
}
// Compatible with historical \(...\)/\[...\] answers without rewriting code samples.
export function normalizeMathMarkdown(text: string) {
  const lines = text.split('\n');
  let fence: { char: string; length: number } | undefined;
  let prose: string[] = [], output: string[] = [];
  const flush = () => { if (prose.length) { output.push(outsideInlineCode(prose.join('\n'))); prose = []; } };
  for (const line of lines) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      output.push(line);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else if (marker) { flush(); fence = { char: marker[1][0], length: marker[1].length }; output.push(line); }
    else prose.push(line);
  }
  flush();
  return output.join('\n');
}

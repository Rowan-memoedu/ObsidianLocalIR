export function extractParagraphsLinear(text, baseOffset = 0, filterEnglishTimestamps = false, stripMarkup = (value) => value) {
  const source = String(text || "");
  const paragraphs = [];
  let cursor = 0;
  let paragraphStart = null;
  let paragraphEnd = null;

  const flush = () => {
    if (paragraphStart === null || paragraphEnd === null) return;
    const raw = source.slice(paragraphStart, paragraphEnd);
    const stripped = String(stripMarkup(raw)).trim();
    if (stripped && !(filterEnglishTimestamps && /^#{1,6}\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/.test(stripped))) {
      paragraphs.push({
        index: paragraphs.length,
        text: stripped,
        start: baseOffset + paragraphStart,
        end: baseOffset + paragraphEnd
      });
    }
    paragraphStart = null;
    paragraphEnd = null;
  };

  while (cursor < source.length) {
    const newlineIndex = source.indexOf("\n", cursor);
    const lineBoundary = newlineIndex === -1 ? source.length : newlineIndex;
    const contentEnd = lineBoundary > cursor && source[lineBoundary - 1] === "\r" ? lineBoundary - 1 : lineBoundary;
    const line = source.slice(cursor, contentEnd);
    if (/^[ \t]*$/u.test(line)) {
      flush();
    } else {
      if (paragraphStart === null) paragraphStart = cursor;
      paragraphEnd = contentEnd;
    }
    cursor = newlineIndex === -1 ? source.length : newlineIndex + 1;
  }
  flush();
  return paragraphs;
}

export function extractMarkdownHeadingsLinear(text) {
  const source = String(text || "");
  const headings = [];
  let cursor = 0;
  while (cursor < source.length) {
    const newlineIndex = source.indexOf("\n", cursor);
    const lineBoundary = newlineIndex === -1 ? source.length : newlineIndex;
    const contentEnd = lineBoundary > cursor && source[lineBoundary - 1] === "\r" ? lineBoundary - 1 : lineBoundary;
    const line = source.slice(cursor, contentEnd);
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (heading) headings.push({ title: heading[2], start: cursor, end: contentEnd });
    cursor = newlineIndex === -1 ? source.length : newlineIndex + 1;
  }
  return headings;
}

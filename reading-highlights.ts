// Reading view owns rendered sections; their source offsets disambiguate repeated text.
export interface ReadingSection {
  el: HTMLElement;
  start: { offset: number };
  end: { offset: number };
}

export interface MappedText {
  node: Text;
  offsets: number[];
}

export function mapReadingText(content: string, sections: ReadingSection[]): MappedText[] {
  const mapped: MappedText[] = [];
  for (const section of sections) {
    if (!section.el || section.el.matches('.mod-ui')) continue;
    let cursor = section.start.offset;
    const end = section.end.offset;
    if (!Number.isInteger(cursor) || !Number.isInteger(end) || end <= cursor) continue;
    const walker = section.el.ownerDocument.createTreeWalker(section.el, 4);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      if (node.parentElement?.closest('.collapse-indicator, .list-bullet, .copy-code-button, .math, mjx-container, .footnote-link, .internal-embed')) continue;
      const text = node.data;
      if (!text.trim()) continue;
      const index = content.indexOf(text, cursor);
      if (index < cursor || index + text.length > end) continue;
      mapped.push({ node, offsets: Array.from({ length: text.length + 1 }, (_, i) => index + i) });
      cursor = index + text.length;
    }
  }
  return mapped;
}

export function readingSelectionOffsets(range: Range, mapped: MappedText[]): { start: number; end: number } | null {
  const boundary = (container: Node, offset: number, end: boolean) => {
    if (container.nodeType === 3) return mapped.find(item => item.node === container)?.offsets[offset];
    const child = container.childNodes[end ? offset - 1 : offset];
    if (!child) return undefined;
    const candidates = mapped.filter(item => child === item.node || child.contains(item.node));
    const item = end ? candidates[candidates.length - 1] : candidates[0];
    return item?.offsets[end ? item.offsets.length - 1 : 0];
  };
  const start = boundary(range.startContainer, range.startOffset, false);
  const end = boundary(range.endContainer, range.endOffset, true);
  return start !== undefined && end !== undefined && end > start ? { start, end } : null;
}

export function readingDecorationRanges(mapped: MappedText[], ranges: { start: number; end: number }[]): Range[] {
  const result: Range[] = [];
  for (const item of mapped) {
    for (const source of ranges) {
      const start = Math.max(source.start, item.offsets[0]);
      const end = Math.min(source.end, item.offsets[item.offsets.length - 1]);
      if (end <= start) continue;
      const range = item.node.ownerDocument.createRange();
      range.setStart(item.node, start - item.offsets[0]);
      range.setEnd(item.node, end - item.offsets[0]);
      result.push(range);
    }
  }
  return result;
}

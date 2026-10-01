import LocalIrDocumentCore from "../渐进阅读工作流/document-core/index.mjs";
import type {
  AnnotationAnchor,
  AnnotationFragment,
  AnnotationMarkKind,
  AnnotationRecord,
  AnnotationRenderMode,
  AnnotationRoute,
  AnnotationSourceFormat,
  AnnotationType,
  ArchiveAnnotationPayload,
  ArchiveFailureState,
  ArticleMusingAiStatus,
  ArticleMusingRecord,
  BilingualMatch,
  BilingualSections,
  DocRecord,
  EditorSelection,
  HierarchyContext,
  HierarchyScope,
  LegacyHighlight,
  LineRange,
  LocalIRSettings,
  MarkRange,
  MarkdownLine,
  MetricKey,
  MetricValues,
  MetricWeights,
  PendingImportRecord,
  ProtectedKind,
  ProtectedRange,
  QaCardRecord,
  ReadingStatus,
  RepairedMarkGroup,
  TextParagraph,
  TextRange
} from "./types";
import { DEFAULT_METRIC_VALUE, inferMetricsEditedByUser, snapMetricValue } from "./metric-presets";
import { Editor, normalizePath } from "obsidian";
import { extractMarkdownHeadingsLinear, extractParagraphsLinear } from "./archive-text.mjs";

export const VIEW_TYPE_LOCAL_IR = "local-incremental-reading-view";

export const DEFAULT_FOLDER = "00 Inbox/IR 工作台/00 原文队列";

export const DEFAULT_ARCHIVE_FOLDER = "04 Projects/渐进阅读工作流/RemNote 导出队列";

export const DEFAULT_SOURCE_ARCHIVE_FOLDER = "04 Projects/渐进阅读工作流/已归档原文";

export const DEFAULT_COMPLETED_SOURCE_FOLDER = "04 Projects/渐进阅读工作流/待归档原文";

export const DEFAULT_REMOVED_READING_FOLDER = "04 Projects/渐进阅读工作流/移出阅读池";

export const DEFAULT_REFINED_READING_FOLDER = "04 Projects/渐进阅读工作流/阅读区/二次阅读";

export const DEFAULT_QUESTION_QUEUE_FOLDER = "04 Projects/渐进阅读工作流/Codex 提问队列";

export const DEFAULT_LINK_IMPORT_FOLDER = "04 Projects/渐进阅读工作流/阅读区/微信";

export const DEFAULT_DOCUMENT_STATE_FOLDER = "04 Projects/渐进阅读工作流/.local-ir/browser-document-state";

export const DOCUMENT_STATE_SUFFIX = ".browser-ir.json";

export const LOCAL_IR_SERVICE_PORT_START = 37829;

export const LOCAL_IR_SERVICE_PORT_END = 37849;

export const DEFAULT_METRICS: MetricValues = {
  importance: DEFAULT_METRIC_VALUE,
  urgency: DEFAULT_METRIC_VALUE,
  difficulty: DEFAULT_METRIC_VALUE,
  interest: DEFAULT_METRIC_VALUE
};

export const DEFAULT_WEIGHTS: MetricWeights = {
  importance: 40,
  urgency: 20,
  difficulty: 15,
  interest: 25
};

export const METRIC_LABELS: Record<MetricKey, string> = {
  importance: "价值判断",
  urgency: "信息密度判断",
  difficulty: "难度",
  interest: "兴趣"
};

export const STATUS_LABELS: Record<ReadingStatus, string> = {
  inbox: "待读",
  reading: "阅读中",
  later: "Later",
  suspended: "搁置",
  done: "待批量生成导出包",
  export_package_ready: "导出包已准备（尚未正式归档）",
  archived: "正式归档成功"
};

export const ARCHIVE_ELEMENT_LABELS: Record<string, string> = {
  annotations: "批注",
  cards: "QA",
  clozeCards: "挖空",
  articleMusings: "随想"
};

export const ANNOTATION_LABELS: Record<AnnotationType, string> = {
  highlight: "仅高亮",
  comment: "普通评论",
  myth_truth: "迷思 / 真相",
  rebuttal: "反驳",
  sample_quote: "引用",
  later: "稍后处理",
  rewrite: "改写",
  refine: "精炼",
  add_viewpoint: "联想",
  rebuttal_rewrite: "反驳后改写",
  question: "提问",
  optimize: "优化",
  example_viewpoint: "例子与观点",
  qa_card: "问答卡"
};

export const ANNOTATION_MODAL_TYPES: AnnotationType[] = ["comment", "myth_truth", "sample_quote", "add_viewpoint", "question", "optimize", "example_viewpoint", "qa_card"];

export const VALID_STATUSES = new Set<ReadingStatus>(["inbox", "reading", "later", "suspended", "done", "export_package_ready", "archived"]);

export const VALID_ANNOTATION_TYPES = new Set<AnnotationType>([
  "highlight",
  "comment",
  "myth_truth",
  "rebuttal",
  "sample_quote",
  "later",
  "rewrite",
  "refine",
  "add_viewpoint",
  "rebuttal_rewrite",
  "question",
  "optimize",
  "example_viewpoint",
  "qa_card"
]);

export const PLUGIN_DATA_VERSION = 14;

export const DEFAULT_SETTINGS: LocalIRSettings = {
  settingsVersion: PLUGIN_DATA_VERSION,
  readingFolder: DEFAULT_FOLDER,
  readingFolders: [DEFAULT_FOLDER],
  excludeVisitedToday: true,
  absolutePriorityProbability: 0.2,
  defaultDeferDays: 7,
  archiveFolder: DEFAULT_ARCHIVE_FOLDER,
  sourceArchiveFolder: DEFAULT_SOURCE_ARCHIVE_FOLDER,
  completedSourceFolder: DEFAULT_COMPLETED_SOURCE_FOLDER,
  removedReadingFolder: DEFAULT_REMOVED_READING_FOLDER,
  refinedReadingFolder: DEFAULT_REFINED_READING_FOLDER,
  questionQueueFolder: DEFAULT_QUESTION_QUEUE_FOLDER,
  linkImportFolder: DEFAULT_LINK_IMPORT_FOLDER,
  documentStateFolder: DEFAULT_DOCUMENT_STATE_FOLDER,
  processingModeEnabled: false,
  clozeModeEnabled: false,
  autoMergeHighlightsEnabled: false,
  alwaysVirtualHighlightsEnabled: true,
  autoOpenAnnotationModal: false,
  metricWeights: DEFAULT_WEIGHTS,
  records: {},
  annotations: {},
  qaCards: {},
  articleMusings: {},
  pendingImports: []
};

export function getNormalizedSelection(editor: Editor): EditorSelection | null {
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  const text = editor.getRange(from, to);
  if (!text.trim()) return null;
  return {
    from,
    to,
    fromOffset: editor.posToOffset(from),
    toOffset: editor.posToOffset(to),
    text
  };
}

export function createWrappedHighlightText(id: string, selectedText: string, markKind: AnnotationMarkKind = "highlight"): { wrappedText: string; fragments: AnnotationFragment[] } {
  const protectedRanges = findProtectedMarkdownRanges(selectedText);
  const parts: { text: string; protect: boolean }[] = [];
  let cursor = 0;
  for (const range of protectedRanges) {
    if (range.start > cursor) parts.push({ text: selectedText.slice(cursor, range.start), protect: false });
    parts.push({ text: selectedText.slice(range.start, range.end), protect: true });
    cursor = range.end;
  }
  if (cursor < selectedText.length) parts.push({ text: selectedText.slice(cursor), protect: false });
  if (parts.length === 0) parts.push({ text: selectedText, protect: false });

  const fragments: AnnotationFragment[] = [];
  const kindAttr = markKind === "cloze" ? ' data-ir-kind="cloze"' : "";
  const wrappedParts = parts.flatMap((part) => {
    if (!part.text) return [part.text];
    if (part.protect) return [part.text];
    return part.text.split(/(\r?\n[ \t]*\r?\n+)/g).map((chunk) => {
      if (!chunk) return chunk;
      if (/^\r?\n[ \t]*\r?\n+$/.test(chunk)) return chunk;
      if (!chunk.trim()) return chunk;
      const index = fragments.length;
      fragments.push({ index, text: chunk });
      return `<mark data-ir-id="${id}" data-ir-fragment="${index}"${kindAttr}>${chunk}</mark>`;
    });
  });

  if (fragments.length === 0) {
    fragments.push({ index: 0, text: selectedText });
    return {
      wrappedText: selectedText,
      fragments
    };
  }

  return {
    wrappedText: wrappedParts.join(""),
    fragments
  };
}

export function findProtectedMarkdownRanges(text: string): TextRange[] {
  return findProtectedMarkdownRangesInContent(text).map((range) => ({ start: range.start, end: range.end }));
}

export function findProtectedMarkdownRangesInContent(text: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  const addMatches = (regex: RegExp) => {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      ranges.push({ start: match.index, end: match.index + match[0].length, kind: detectProtectedMatchKind(match[0]) });
      if (match[0].length === 0) regex.lastIndex += 1;
    }
  };

  addMatches(/```[\s\S]*?```/g);
  addMatches(/~~~[\s\S]*?~~~/g);
  addMatches(/\$\$[\s\S]*?\$\$/g);
  addMatches(/<style\b[\s\S]*?<\/style>/gi);
  addMatches(/<script\b[\s\S]*?<\/script>/gi);
  addMatches(/`+[\s\S]*?`+/g);
  addMatches(/!\[\[[\s\S]*?\]\]/g);
  addMatches(/\[\[[\s\S]*?\]\]/g);
  addMatches(/!\[[^\]]*?\]\([^)\n]+?\)/g);
  addMatches(/\[[^\]]+?\]\([^)\n]+?\)/g);
  addMatches(/\[[^\]]+?\]\[[^\]\n]*?\]/g);
  addMatches(/\$[^$\n]+?\$/g);
  ranges.push(...findHtmlBlockRanges(text));

  return mergeProtectedRanges(ranges, text.length);
}

export function detectProtectedMatchKind(value: string): ProtectedKind {
  if (/^```|^~~~/m.test(value)) return "code_fence";
  if (/^\$\$/.test(value)) return "math_block";
  if (/^!\[|^!\[\[/i.test(value)) return "image";
  if (/^\[|\[\[/.test(value)) return "link";
  if (/^<style/i.test(value)) return "style_block";
  if (/^<script/i.test(value)) return "html_block";
  if (/^`/.test(value)) return "code_fence";
  if (/^\$/.test(value)) return "math_block";
  return "mixed";
}

export function findHtmlBlockRanges(content: string): ProtectedRange[] {
  const lines = getMarkdownLines(content);
  const ranges: ProtectedRange[] = [];
  const blockTag = /<\/?(div|section|article|table|thead|tbody|tr|td|th|style|script|iframe|details|summary|ul|ol|li|p|h[1-6]|span)\b[^>]*>/gi;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s*<([a-z][\w-]*)(\s|>|$)/i.test(line.text)) continue;
    const firstTag = /^\s*<([a-z][\w-]*)/i.exec(line.text);
    const tag = firstTag?.[1]?.toLowerCase();
    if (!tag || tag === "mark") continue;
    let depth = 0;
    let endIndex = index;
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const text = lines[cursor].text;
      let match: RegExpExecArray | null;
      blockTag.lastIndex = 0;
      while ((match = blockTag.exec(text)) !== null) {
        const token = match[0];
        const tokenTag = match[1].toLowerCase();
        if (tokenTag !== tag) continue;
        if (/^<\//.test(token)) depth -= 1;
        else if (!/\/>$/.test(token)) depth += 1;
      }
      endIndex = cursor;
      if (depth <= 0 && cursor > index) break;
      if (cursor > index && !text.trim()) break;
    }
    if (endIndex > index) {
      ranges.push({ start: line.start, end: lines[endIndex].breakEnd, kind: tag === "style" ? "style_block" : "html_block" });
      index = endIndex;
    }
  }
  return ranges;
}

export function mergeProtectedRanges(ranges: ProtectedRange[], maxEnd: number): ProtectedRange[] {
  const sorted = ranges
    .map((range) => ({ start: clampRangeIndex(range.start, maxEnd), end: clampRangeIndex(range.end, maxEnd), kind: range.kind }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ProtectedRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      if (last.kind !== range.kind) last.kind = "mixed";
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function detectProtectedKindForSelection(content: string, fromOffset: number, toOffset: number, selectedText: string): ProtectedKind | null {
  const ranges = findProtectedMarkdownRangesInContent(content).filter((range) => rangesOverlap(range, { start: fromOffset, end: toOffset }));
  const directKinds: ProtectedKind[] = [];
  if (/```|~~~/.test(selectedText)) directKinds.push("code_fence");
  if (/<style\b|<\/style>/i.test(selectedText)) directKinds.push("style_block");
  if (/<[a-z][\w-]*\b[^>]*>|<\/[a-z][\w-]*>/i.test(selectedText)) directKinds.push("html_block");
  if (/\$\$[\s\S]*?\$\$/.test(selectedText)) directKinds.push("math_block");
  if (/!\[[^\]]*?\]\([^)\n]+?\)|!\[\[[\s\S]*?\]\]/.test(selectedText)) directKinds.push("image");
  if (/\[[^\]]+?\]\([^)\n]+?\)|\[\[[\s\S]*?\]\]/.test(selectedText)) directKinds.push("link");
  const kinds = [...ranges.map((range) => range.kind), ...directKinds].filter(Boolean);
  if (kinds.length === 0) return null;
  const unique = kinds.filter((kind, index, array) => array.indexOf(kind) === index);
  return unique.length === 1 ? unique[0] : "mixed";
}

export function getLineRangeForOffsets(content: string, fromOffset: number, toOffset: number): LineRange {
  const lines = getMarkdownLines(content);
  const startLine = lines.find((line) => fromOffset >= line.start && fromOffset <= line.breakEnd)?.index ?? 0;
  const endLine = lines.find((line) => toOffset >= line.start && toOffset <= line.breakEnd)?.index ?? startLine;
  return { startLine, endLine };
}

export function clampRangeIndex(value: number, maxEnd: number): number {
  return Math.max(0, Math.min(maxEnd, Math.round(Number(value) || 0)));
}

export function createAnnotationAnchor(
  content: string,
  fromOffset: number,
  toOffset: number,
  selectedText: string,
  fragments: AnnotationFragment[]
): AnnotationAnchor {
  return {
    sectionPath: getSectionPathAtOffset(content, fromOffset),
    paragraphIndex: getParagraphIndexAtOffset(content, fromOffset),
    sourceOffset: fromOffset,
    contextBefore: stripIrMarkup(content.slice(Math.max(0, fromOffset - 120), fromOffset)).trim(),
    contextAfter: stripIrMarkup(content.slice(toOffset, Math.min(content.length, toOffset + 120))).trim(),
    contextHash: shortHash(`${selectedText}\n${fromOffset}\n${toOffset}`),
    fragmentCount: Math.max(1, fragments.length),
    crossedBlankLines: /\r?\n[ \t]*\r?\n/.test(selectedText)
  };
}

export function createSelectionHierarchy(text: string): HierarchyContext {
  return {
    scope: "selection",
    headingPath: [],
    expandedText: stripIrMarkup(text).trim(),
    expandedAnswerText: stripIrMarkup(text).trim(),
    subtreeRange: null
  };
}

export function resolveSelectionHierarchy(content: string, fromOffset: number, toOffset: number, selectedText: string): HierarchyContext {
  const lines = getMarkdownLines(content);
  const line = lines.find((item) => fromOffset >= item.start && fromOffset <= item.breakEnd);
  if (!line) return createSelectionHierarchy(selectedText);

  const heading = parseHeadingLine(line.text);
  if (heading && selectionMatchesNodeText(selectedText, heading.title, line, fromOffset, toOffset)) {
    return createHeadingHierarchy(content, lines, line.index, heading.level, heading.title);
  }

  const listItem = parseListLine(line.text);
  if (listItem && selectionMatchesNodeText(selectedText, listItem.text, line, fromOffset, toOffset)) {
    return createListHierarchy(content, lines, line.index, listItem.indent, listItem.text);
  }

  return createSelectionHierarchy(selectedText);
}

export function resolveAnnotationHierarchy(content: string, annotation: AnnotationRecord): HierarchyContext {
  const markRange = annotation.sourceFormat === "mark" ? findFirstMarkRangeById(content, annotation.id) : null;
  const virtualRange = annotation.renderMode === "virtual_decoration" ? annotation.range : null;
  const sourceOffset = markRange?.start ?? virtualRange?.start ?? annotation.sourceOffset ?? annotation.anchor?.sourceOffset ?? null;
  if (typeof sourceOffset === "number") {
    const selected = annotation.currentText || annotation.selectedText || annotation.originalText;
    return resolveSelectionHierarchy(content, sourceOffset, markRange?.end ?? virtualRange?.end ?? sourceOffset + selected.length, selected);
  }
  if (annotation.scope !== "selection" && annotation.expandedText.trim()) {
    return {
      scope: annotation.scope,
      headingPath: annotation.headingPath,
      expandedText: annotation.expandedText,
      expandedAnswerText: annotation.expandedAnswerText || annotation.expandedText,
      subtreeRange: annotation.subtreeRange
    };
  }
  return createSelectionHierarchy(annotation.currentText || annotation.selectedText || annotation.originalText);
}

export function getMarkdownLines(content: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  const regex = /.*(?:\r?\n|$)/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = regex.exec(content)) !== null) {
    const raw = match[0];
    if (!raw && match.index === content.length) break;
    const text = raw.replace(/\r?\n$/, "");
    lines.push({
      index,
      text,
      start: match.index,
      end: match.index + text.length,
      breakEnd: match.index + raw.length
    });
    index += 1;
  }
  return lines;
}

export function parseHeadingLine(line: string): { level: number; title: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(stripIrMarkup(line));
  if (!match) return null;
  return {
    level: match[1].length,
    title: stripIrMarkup(match[2]).replace(/\s+#+$/, "").trim()
  };
}

export function parseListLine(line: string): { indent: number; text: string } | null {
  const match = /^([ \t]*)(?:[-*+]|\d+[.)])\s+(.+?)\s*$/.exec(stripIrMarkup(line));
  if (!match) return null;
  return {
    indent: countIndent(match[1]),
    text: stripIrMarkup(match[2]).trim()
  };
}

export function selectionMatchesNodeText(selectedText: string, nodeText: string, line: MarkdownLine, fromOffset: number, toOffset: number): boolean {
  const selected = normalizeComparableText(selectedText);
  const node = normalizeComparableText(nodeText);
  if (!selected || !node) return false;
  if (selected === node) return true;

  const firstNonWhitespace = line.text.search(/\S/);
  const trimmedLineStart = line.start + (firstNonWhitespace < 0 ? 0 : firstNonWhitespace);
  const trimmedLineEnd = line.start + line.text.trimEnd().length;
  const coversWholeLine = fromOffset <= trimmedLineStart && toOffset >= trimmedLineEnd;
  return coversWholeLine && normalizeComparableText(line.text).includes(node);
}

export function createHeadingHierarchy(content: string, lines: MarkdownLine[], lineIndex: number, level: number, title: string): HierarchyContext {
  let end = content.length;
  for (let index = lineIndex + 1; index < lines.length; index += 1) {
    const heading = parseHeadingLine(lines[index].text);
    if (heading && heading.level <= level) {
      end = lines[index].start;
      break;
    }
  }
  const line = lines[lineIndex];
  const expandedText = stripIrMarkup(content.slice(line.start, end)).trim();
  const expandedAnswerText = stripIrMarkup(content.slice(line.breakEnd, end)).trim();
  return {
    scope: expandedAnswerText ? "heading_subtree" : "selection",
    headingPath: getHeadingPathForLine(lines, lineIndex),
    expandedText: expandedText || title,
    expandedAnswerText: expandedAnswerText || title,
    subtreeRange: expandedAnswerText ? { start: line.start, end } : null
  };
}

export function createListHierarchy(content: string, lines: MarkdownLine[], lineIndex: number, indent: number, text: string): HierarchyContext {
  let end = lines[lineIndex].breakEnd;
  for (let index = lineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.text.trim()) {
      end = line.breakEnd;
      continue;
    }
    const nextList = parseListLine(line.text);
    const nextIndent = nextList ? nextList.indent : countIndent((/^([ \t]*)/.exec(line.text)?.[1]) || "");
    if (nextIndent <= indent) break;
    end = line.breakEnd;
  }
  const line = lines[lineIndex];
  const expandedText = stripIrMarkup(content.slice(line.start, end)).trim();
  const expandedAnswerText = stripIrMarkup(content.slice(line.breakEnd, end)).trim();
  return {
    scope: expandedAnswerText ? "list_subtree" : "selection",
    headingPath: getHeadingPathForLine(lines, lineIndex),
    expandedText: expandedText || text,
    expandedAnswerText: expandedAnswerText || text,
    subtreeRange: expandedAnswerText ? { start: line.start, end } : null
  };
}

export function getHeadingPathForLine(lines: MarkdownLine[], lineIndex: number): string[] {
  const path: string[] = [];
  for (let index = 0; index <= lineIndex; index += 1) {
    const heading = parseHeadingLine(lines[index].text);
    if (!heading) continue;
    path.splice(heading.level - 1);
    path[heading.level - 1] = heading.title;
  }
  return path.filter(Boolean);
}

export function countIndent(value: string): number {
  return value.replace(/\t/g, "    ").length;
}

export function getSectionPathAtOffset(content: string, offset: number): string[] {
  const path: string[] = [];
  const lines = content.slice(0, Math.max(0, offset)).split(/\r?\n/);
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const level = match[1].length;
    path.splice(level - 1);
    path[level - 1] = match[2];
  }
  return path.filter(Boolean);
}

export function getParagraphIndexAtOffset(content: string, offset: number): number | null {
  const paragraphs = extractParagraphs(content, 0, false);
  const found = paragraphs.find((paragraph) => offset >= paragraph.start && offset <= paragraph.end);
  return found?.index ?? null;
}

export function resolveBilingualMatch(content: string | null, annotation: AnnotationRecord): BilingualMatch {
  const empty = createEmptyBilingualMatch(annotation.currentText || annotation.selectedText);
  if (!content) return empty;

  const sections = detectBilingualSections(content);
  if (!sections.zh || !sections.en) return empty;

  const zhParagraphs = extractParagraphs(sections.zh.text, sections.zh.start, false);
  const enParagraphs = extractParagraphs(sections.en.text, sections.en.start, true);
  if (zhParagraphs.length === 0 || enParagraphs.length === 0) return empty;

  const markRange = findFirstMarkRangeById(content, annotation.id);
  const offset = markRange?.start ?? annotation.range?.start ?? annotation.anchor?.sourceOffset ?? annotation.sourceOffset;
  const zhIndex = findChineseParagraphIndex(zhParagraphs, annotation, offset);
  if (zhIndex === null) {
    return {
      ...empty,
      detected: true,
      strategy: "section-detected-no-anchor",
      warning: "检测到双语章节，但无法稳定定位中文段落。",
      needsApiResolution: true
    };
  }

  const chineseText = stripIrMarkup(zhParagraphs[zhIndex]?.text || annotation.currentText || annotation.selectedText);
  if (zhParagraphs.length === enParagraphs.length) {
    const english = enParagraphs[zhIndex]?.text || "";
    return {
      detected: true,
      strategy: "paragraph-index-exact",
      confidence: "high",
      chineseText,
      englishText: english,
      chineseParagraphIndex: zhIndex,
      englishParagraphIndex: zhIndex,
      candidates: english ? [{ index: zhIndex, text: english, score: 1 }] : [],
      warning: null,
      needsApiResolution: false
    };
  }

  const estimated = zhParagraphs.length > 1
    ? Math.round((zhIndex / (zhParagraphs.length - 1)) * Math.max(0, enParagraphs.length - 1))
    : 0;
  const candidates = enParagraphs
    .map((paragraph) => ({
      index: paragraph.index,
      text: paragraph.text,
      score: Math.max(0, 1 - Math.abs(paragraph.index - estimated) / Math.max(6, enParagraphs.length))
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  return {
    detected: true,
    strategy: "paragraph-index-normalized-window",
    confidence: "low",
    chineseText,
    englishText: "",
    chineseParagraphIndex: zhIndex,
    englishParagraphIndex: null,
    candidates,
    warning: "中英文段落数不一致，已生成候选，需要 API 语义对齐后再使用。",
    needsApiResolution: true
  };
}

export function createEmptyBilingualMatch(text: string): BilingualMatch {
  return {
    detected: false,
    strategy: "none",
    confidence: "none",
    chineseText: text,
    englishText: "",
    chineseParagraphIndex: null,
    englishParagraphIndex: null,
    candidates: [],
    warning: null,
    needsApiResolution: false
  };
}

export function detectBilingualSections(content: string): BilingualSections {
  const headings = extractMarkdownHeadingsLinear(content);

  const sectionFor = (predicate: (title: string) => boolean) => {
    const headingIndex = headings.findIndex((heading) => predicate(heading.title));
    if (headingIndex < 0) return null;
    const heading = headings[headingIndex];
    const next = headings[headingIndex + 1];
    const start = content.indexOf("\n", heading.end);
    const sectionStart = start >= 0 ? start + 1 : heading.end;
    const sectionEnd = next?.start ?? content.length;
    return {
      title: heading.title,
      text: content.slice(sectionStart, sectionEnd),
      start: sectionStart,
      end: sectionEnd
    };
  };

  return {
    zh: sectionFor((title) => /中文|Chinese/i.test(title) && !/English|英文/i.test(title)),
    en: sectionFor((title) => /English|英文/i.test(title))
  };
}

export function extractParagraphs(text: string, baseOffset: number, filterEnglishTimestamps: boolean): TextParagraph[] {
  return extractParagraphsLinear(text, baseOffset, filterEnglishTimestamps, stripIrMarkup) as TextParagraph[];
}

export function findChineseParagraphIndex(paragraphs: TextParagraph[], annotation: AnnotationRecord, offset: number | null | undefined): number | null {
  if (typeof offset === "number") {
    const byOffset = paragraphs.find((paragraph) => offset >= paragraph.start && offset <= paragraph.end);
    if (byOffset) return byOffset.index;
  }

  const needle = normalizeComparableText(annotation.currentText || annotation.selectedText || annotation.originalText);
  if (!needle) return null;
  const byText = paragraphs.find((paragraph) => normalizeComparableText(paragraph.text).includes(needle.slice(0, 80)));
  return byText?.index ?? null;
}

export function findFirstMarkRangeById(content: string, id: string): { start: number; end: number } | null {
  const regex = createMarkRegex(id, true);
  const match = regex.exec(content);
  if (!match) return null;
  return {
    start: match.index,
    end: match.index + match[0].length
  };
}

export function stripIrMarkup(value: string): string {
  return value
    .replace(/<mark\b[^>]*>/gi, "")
    .replace(/<\/mark>/gi, "")
    .replace(/==([\s\S]*?)==/g, "$1")
    .replace(/\r\n/g, "\n");
}

export function normalizeComparableText(value: string): string {
  return stripIrMarkup(value).replace(/\s+/g, "");
}

export function replaceMarkedText(content: string, id: string, nextText: string): string {
  const range = findMarkedTextRange(content, id);
  if (!range) return content;
  const existing = content.slice(range.start, range.end);
  const markKind = existing.includes('data-ir-kind="cloze"') ? "cloze" : "highlight";
  const wrapped = createWrappedHighlightText(id, nextText, markKind).wrappedText;
  return `${content.slice(0, range.start)}${wrapped}${content.slice(range.end)}`;
}

export function findMarkedTextRange(content: string, id: string): { start: number; end: number } | null {
  const regex = createMarkRegex(id, true);
  const matches = Array.from(content.matchAll(regex));
  if (matches.length === 0) return null;
  const first = matches[0];
  const last = matches[matches.length - 1];
  const start = first.index ?? 0;
  const end = (last.index ?? 0) + last[0].length;
  return { start, end };
}

export function createMarkRegex(id: string, global: boolean): RegExp {
  return new RegExp(`<mark\\b(?=[^>]*data-ir-id="${escapeRegExp(id)}")[^>]*>[\\s\\S]*?<\\/mark>`, global ? "g" : "");
}

export function findAllMarkRanges(content: string): MarkRange[] {
  const ranges: MarkRange[] = [];
  const regex = /<mark\b([^>]*)>([\s\S]*?)<\/mark>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const attrs = match[1] || "";
    const idMatch = /data-ir-id="([^"]+)"/.exec(attrs);
    if (!idMatch?.[1]) continue;
    ranges.push({
      id: idMatch[1],
      start: match.index,
      end: match.index + match[0].length,
      fullText: match[0],
      innerText: match[2] || "",
      markKind: attrs.includes('data-ir-kind="cloze"') ? "cloze" : "highlight"
    });
  }
  return ranges;
}

export function isDangerousMarkedRange(range: MarkRange, content: string): boolean {
  const protectedKind = detectProtectedKindForSelection(content, range.start, range.end, range.innerText);
  if (protectedKind) return true;
  return /<style\b|<\/style>|<script\b|<\/script>|^\s*<[a-z][\w-]*\b|```|~~~|\$\$/im.test(range.innerText);
}

export function stripMarkedRangesAndTrack(content: string, ranges: MarkRange[]): { nextContent: string; groups: RepairedMarkGroup[] } {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const fragmentsById = new Map<string, RepairedMarkGroup>();
  let cursor = 0;
  let output = "";
  for (const range of sorted) {
    if (range.start < cursor) continue;
    output += content.slice(cursor, range.start);
    const start = output.length;
    output += range.innerText;
    const end = output.length;
    const protectedKind = detectProtectedKindForSelection(output, start, end, range.innerText) || detectProtectedMatchKind(range.innerText);
    const existing = fragmentsById.get(range.id);
    if (existing) {
      existing.ranges.push({ start, end });
      if (existing.protectedKind !== protectedKind) existing.protectedKind = "mixed";
    } else {
      fragmentsById.set(range.id, {
        id: range.id,
        markKind: range.markKind,
        protectedKind,
        ranges: [{ start, end }]
      });
    }
    cursor = range.end;
  }
  output += content.slice(cursor);
  return {
    nextContent: output,
    groups: Array.from(fragmentsById.values())
      .map((group) => ({ ...group, ranges: normalizeTextRanges(group.ranges) }))
      .sort((a, b) => a.ranges[0].start - b.ranges[0].start)
  };
}

export function rangesOverlap(a: TextRange, b: TextRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function normalizeTextRanges(ranges: TextRange[]): TextRange[] {
  const sorted = ranges
    .map((range) => ({ start: Math.max(0, range.start), end: Math.max(0, range.end) }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const result: TextRange[] = [];
  for (const range of sorted) {
    const previous = result[result.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      result.push({ ...range });
    }
  }
  return result;
}

export function getAnnotationVirtualRanges(annotation: AnnotationRecord): TextRange[] {
  return LocalIrDocumentCore.recordRanges(annotation);
}

export function sameTextRanges(a: TextRange[], b: TextRange[]): boolean {
  return a.length === b.length && a.every((range, index) => range.start === b[index].start && range.end === b[index].end);
}

export function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

export function cloneAnnotation(annotation: AnnotationRecord): AnnotationRecord {
  return {
    ...annotation,
    virtualRanges: annotation.virtualRanges.map((range) => ({ ...range })),
    anchor: annotation.anchor ? { ...annotation.anchor, sectionPath: [...annotation.anchor.sectionPath] } : null,
    fragments: annotation.fragments.map((fragment) => ({ ...fragment })),
    headingPath: [...annotation.headingPath],
    subtreeRange: annotation.subtreeRange ? { ...annotation.subtreeRange } : null
  };
}

export function roulette(records: DocRecord[]): DocRecord {
  const weights = records.map((record) => Math.max(record.priority, 0.1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = Math.random() * total;

  for (let i = 0; i < records.length; i += 1) {
    cursor -= weights[i];
    if (cursor <= 0) return records[i];
  }

  return records[records.length - 1];
}

export function todayKey(): string {
  return dateKey(new Date());
}

export function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDaysKey(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return dateKey(date);
}

export function isDateOnDay(value: string | null, day: string): boolean {
  if (!value) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.startsWith(day);
  return dateKey(parsed) === day;
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function normalizeMetrics(metrics: Partial<MetricValues> | undefined): MetricValues {
  return {
    importance: snapMetricValue(metrics?.importance ?? DEFAULT_METRICS.importance),
    urgency: snapMetricValue(metrics?.urgency ?? DEFAULT_METRICS.urgency),
    difficulty: snapMetricValue(metrics?.difficulty ?? DEFAULT_METRICS.difficulty),
    interest: snapMetricValue(metrics?.interest ?? DEFAULT_METRICS.interest)
  };
}

export function captureAnnotationSnapshot(
  annotations: Record<string, AnnotationRecord>,
  ids: string[]
): Record<string, AnnotationRecord | null> {
  const snapshot: Record<string, AnnotationRecord | null> = {};
  for (const id of ids.filter((item, index, array) => item && array.indexOf(item) === index)) {
    snapshot[id] = annotations[id] ? cloneAnnotation(annotations[id]) : null;
  }
  return snapshot;
}

export function calculatePriorityWithWeights(metrics: MetricValues, weights: MetricWeights): number {
  const normalizedMetrics = normalizeMetrics(metrics);
  const totalWeight = Object.values(weights).reduce((sum, weight) => sum + Number(weight || 0), 0);
  if (totalWeight <= 0) return 0;

  const score =
    normalizedMetrics.importance * weights.importance +
    normalizedMetrics.urgency * weights.urgency +
    normalizedMetrics.difficulty * weights.difficulty +
    normalizedMetrics.interest * weights.interest;

  return round(score / totalWeight);
}

export function normalizeRecord(path: string, raw: unknown, weights: MetricWeights): DocRecord {
  const record = typeof raw === "object" && raw ? raw as Partial<DocRecord> : {};
  const metrics = normalizeMetrics(record.metrics);
  const status = normalizeStatus(record.status);
  return {
    path: record.path || path,
    title: record.title || path.split("/").pop()?.replace(/\.md$/i, "") || path,
    status,
    metrics,
    metricsEditedByUser: inferMetricsEditedByUser(metrics, record.metricsEditedByUser),
    metricPresetCheckedMtime: Number.isFinite(record.metricPresetCheckedMtime) ? Number(record.metricPresetCheckedMtime) : null,
    priority: calculatePriorityWithWeights(metrics, weights),
    visitCount: Math.max(0, Math.round(Number(record.visitCount) || 0)),
    lastVisited: record.lastVisited || null,
    deferUntil: record.deferUntil || null,
    archivedAt: record.archivedAt || null,
    archiveExportPath: record.archiveExportPath || null,
    archivePackagePath: record.archivePackagePath || null,
    archivePackageId: record.archivePackageId || null,
    archivePackageRevision: Number.isInteger(record.archivePackageRevision) ? record.archivePackageRevision! : null,
    archiveInputHash: record.archiveInputHash || null,
    exportPackageReadyAt: record.exportPackageReadyAt || null,
    archiveAttemptCount: Math.max(0, Math.round(Number(record.archiveAttemptCount) || 0)),
    archiveLastError: record.archiveLastError || null,
    archiveLastFailure: normalizeArchiveFailureState(record.archiveLastFailure),
    originalSourcePath: record.originalSourcePath || null,
    archivedSourcePath: record.archivedSourcePath || null,
    movedIntoReadingPoolFromPath: record.movedIntoReadingPoolFromPath || null,
    movedIntoReadingPoolAt: record.movedIntoReadingPoolAt || null,
    removedFromReadingPoolAt: record.removedFromReadingPoolAt || null,
    removedToPath: record.removedToPath || null,
    readingPathBeforeCompletion: record.readingPathBeforeCompletion || null,
    completedSourcePath: record.completedSourcePath || null,
    completedAt: record.completedAt || null,
    documentStateSidecarPath: record.documentStateSidecarPath || null,
    documentStateRevision: Number.isInteger(record.documentStateRevision) ? record.documentStateRevision! : null,
    documentStateUpdatedAt: record.documentStateUpdatedAt || null,
    documentStateFingerprint: record.documentStateFingerprint || null
  };
}

export function normalizeArchiveFailureState(value: unknown): ArchiveFailureState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<ArchiveFailureState>;
  const errors = Array.isArray(raw.details?.errors)
    ? raw.details!.errors.map((item) => String(item || "").replace(/[\r\n]+/g, " ").trim().slice(0, 500)).filter(Boolean).slice(0, 20)
    : [];
  return {
    code: String(raw.code || "UNEXPECTED_ERROR").slice(0, 80),
    kind: raw.kind === "blocked" ? "blocked" : "failed",
    reasonCode: raw.reasonCode ? String(raw.reasonCode).slice(0, 80) : null,
    message: String(raw.message || "Unknown batch archive package generation failure").replace(/[\r\n]+/g, " ").trim().slice(0, 500),
    details: { errors },
    retryable: raw.retryable !== false,
    occurredAt: raw.occurredAt ? String(raw.occurredAt) : null
  };
}

export function normalizeReadingFolders(value: unknown, legacyFolder: unknown): string[] {
  const legacy = normalizePath(String(legacyFolder || DEFAULT_FOLDER).trim() || DEFAULT_FOLDER);
  const folders = Array.isArray(value)
    ? value.map((item) => normalizePath(String(item || "").trim())).filter(Boolean)
    : [];
  return uniqueNormalizedPaths(folders.length > 0 ? folders : [legacy]);
}

export function uniqueNormalizedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const pathValue of paths) {
    const normalized = normalizePath(String(pathValue || "").trim());
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.length > 0 ? result : [DEFAULT_FOLDER];
}

export function normalizeStatus(status: unknown): ReadingStatus {
  return typeof status === "string" && VALID_STATUSES.has(status as ReadingStatus) ? status as ReadingStatus : "inbox";
}

export function normalizeAnnotation(id: string, raw: unknown): AnnotationRecord {
  const annotation = typeof raw === "object" && raw ? raw as Partial<AnnotationRecord> : {};
  const now = new Date().toISOString();
  const selectedText = annotation.selectedText || annotation.currentText || annotation.originalText || "";
  const originalText = annotation.originalText || selectedText;
  const currentText = annotation.currentText || selectedText;
  const rewriteMarkdown = annotation.rewriteMarkdown || "";
  return {
    ...annotation,
    id: annotation.id || id,
    path: annotation.path || "",
    selectedText: currentText,
    sourceFormat: normalizeSourceFormat(annotation.sourceFormat),
    renderMode: normalizeAnnotationRenderMode(annotation.renderMode, annotation.sourceFormat),
    protectedKind: normalizeProtectedKind(annotation.protectedKind),
    markKind: normalizeMarkKind(annotation.markKind),
    originalText,
    currentText,
    type: normalizeAnnotationType(annotation.type),
    commentMarkdown: annotation.commentMarkdown || "",
    rewriteMarkdown,
    hasRewrite: Boolean(annotation.hasRewrite || rewriteMarkdown.trim()),
    rewriteApplied: Boolean(annotation.rewriteApplied),
    orphaned: Boolean(annotation.orphaned),
    lastKnownPath: annotation.lastKnownPath || annotation.path || "",
    sourceOffset: typeof annotation.sourceOffset === "number" ? annotation.sourceOffset : null,
    range: normalizeTextRange(annotation.range),
    virtualRanges: LocalIrDocumentCore.recordRanges(annotation),
    lineRange: normalizeLineRange(annotation.lineRange),
    anchor: normalizeAnnotationAnchor(annotation.anchor),
    fragments: normalizeAnnotationFragments(annotation.fragments, currentText),
    scope: normalizeHierarchyScope(annotation.scope),
    headingPath: Array.isArray(annotation.headingPath) ? annotation.headingPath.map(String).filter(Boolean) : [],
    expandedText: String(annotation.expandedText || currentText),
    expandedAnswerText: String(annotation.expandedAnswerText || annotation.expandedText || currentText),
    subtreeRange: normalizeTextRange(annotation.subtreeRange),
    createdAt: annotation.createdAt || now,
    updatedAt: annotation.updatedAt || annotation.createdAt || now,
    archived: Boolean(annotation.archived)
  };
}

export function normalizeQaCard(id: string, raw: unknown): QaCardRecord {
  const card = typeof raw === "object" && raw ? raw as Partial<QaCardRecord> : {};
  const now = new Date().toISOString();
  const questionMarkdown = String(card.questionMarkdown || "");
  const answerMarkdown = String(card.answerMarkdown || "");
  return {
    id: card.id || id,
    path: card.path || "",
    source: card.source === "annotation" ? "annotation" : "article",
    sourceAnnotationId: card.sourceAnnotationId || null,
    questionMarkdown,
    answerMarkdown,
    answerSourceText: String(card.answerSourceText || ""),
    needsQuestionGeneration: Boolean(card.needsQuestionGeneration || !questionMarkdown.trim()),
    needsAnswerGeneration: Boolean(card.needsAnswerGeneration || !answerMarkdown.trim()),
    createdAt: card.createdAt || now,
    updatedAt: card.updatedAt || card.createdAt || now,
    archived: Boolean(card.archived)
  };
}

export function normalizeArticleMusing(id: string, raw: unknown): ArticleMusingRecord {
  const musing = typeof raw === "object" && raw ? raw as Partial<ArticleMusingRecord> : {};
  const now = new Date().toISOString();
  return {
    id: musing.id || createMusingId(),
    path: musing.path || id,
    bodyMarkdown: String(musing.bodyMarkdown || ""),
    aiStatus: normalizeMusingAiStatus(musing.aiStatus),
    createdAt: musing.createdAt || now,
    updatedAt: musing.updatedAt || musing.createdAt || now,
    archived: Boolean(musing.archived)
  };
}

export function normalizePendingImports(raw: unknown): PendingImportRecord[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: PendingImportRecord[] = [];
  const now = new Date().toISOString();

  for (const value of raw) {
    const item = typeof value === "object" && value ? value as Partial<PendingImportRecord> : {};
    const rawUrl = normalizeExternalUrl(item.url || item.normalizedUrl || "");
    const normalizedUrl = normalizePendingImportUrl(rawUrl || "");
    if (!rawUrl || !normalizedUrl || seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    const wasInterrupted = item.status === "importing";
    const brokerClientRequestId = String(item.brokerClientRequestId || "").trim() || null;
    result.push({
      id: item.id || `pending-import-${shortHash(normalizedUrl)}`,
      url: rawUrl,
      normalizedUrl,
      sourcePath: item.sourcePath ? normalizePath(String(item.sourcePath)) : null,
      status: item.status === "failed" ? "failed" : wasInterrupted && brokerClientRequestId ? "importing" : "pending",
      addedAt: item.addedAt || now,
      updatedAt: item.updatedAt || item.addedAt || now,
      lastAttemptAt: item.lastAttemptAt || null,
      attemptCount: Math.max(0, Math.round(Number(item.attemptCount) || 0)),
      lastError: item.lastError || (wasInterrupted && !brokerClientRequestId ? "上次导入未确认完成，请重试。" : null),
      brokerClientRequestId
    });
  }

  return result;
}

export function normalizeMusingAiStatus(value: unknown): ArticleMusingAiStatus {
  return value === "resolved" || value === "skipped" ? value : "pending";
}

export function trimTrailingUrlPunctuation(value: string): string {
  let candidate = String(value || "").trim().replace(/[.,;:!?，。；：！？、]+$/g, "");
  for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"], ["（", "）"], ["【", "】"], ["「", "」"], ["《", "》"]]) {
    while (candidate.endsWith(closing)) {
      const openings = candidate.split(opening).length - 1;
      const closings = candidate.split(closing).length - 1;
      if (closings <= openings) break;
      candidate = candidate.slice(0, -1);
    }
  }
  return candidate;
}

export function parseExternalUrlCandidate(value: string): string | null {
  try {
    const url = new URL(trimTrailingUrlPunctuation(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function canonicalizePendingImportUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const trackingKeys: string[] = [];
    url.searchParams.forEach((_value, key) => {
      if (/^utm_/i.test(key) || /^(fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) trackingKeys.push(key);
    });
    trackingKeys.forEach((key) => url.searchParams.delete(key));
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

export function extractExternalUrls(value: string): string[] {
  const matches = String(value || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of matches) {
    const normalized = parseExternalUrlCandidate(match);
    if (!normalized) continue;
    const dedupeKey = canonicalizePendingImportUrl(normalized) || normalized;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    urls.push(normalized);
  }
  return urls;
}

export function normalizeExternalUrl(value: string): string | null {
  return parseExternalUrlCandidate(value) || extractExternalUrls(value)[0] || null;
}

export function normalizePendingImportUrl(value: string): string | null {
  const normalized = normalizeExternalUrl(value);
  return normalized ? canonicalizePendingImportUrl(normalized) : null;
}

export function normalizeHierarchyScope(value: unknown): HierarchyScope {
  return value === "heading_subtree" || value === "list_subtree" ? value : "selection";
}

export function normalizeTextRange(value: unknown): TextRange | null {
  if (!value || typeof value !== "object") return null;
  const range = value as Partial<TextRange>;
  if (typeof range.start !== "number" || typeof range.end !== "number") return null;
  if (range.end < range.start) return null;
  return { start: range.start, end: range.end };
}

export function normalizeLineRange(value: unknown): LineRange | null {
  if (!value || typeof value !== "object") return null;
  const range = value as Partial<LineRange>;
  if (typeof range.startLine !== "number" || typeof range.endLine !== "number") return null;
  if (range.endLine < range.startLine) return null;
  return { startLine: Math.max(0, Math.round(range.startLine)), endLine: Math.max(0, Math.round(range.endLine)) };
}

export function normalizeAnnotationType(type: unknown): AnnotationType {
  return typeof type === "string" && VALID_ANNOTATION_TYPES.has(type as AnnotationType) ? type as AnnotationType : "highlight";
}

export function normalizeModalAnnotationType(type: unknown): AnnotationType {
  return typeof type === "string" && ANNOTATION_MODAL_TYPES.includes(type as AnnotationType) ? type as AnnotationType : "comment";
}

export function normalizeSourceFormat(sourceFormat: unknown): AnnotationSourceFormat {
  if (sourceFormat === "virtual") return "virtual";
  return sourceFormat === "legacy" ? "legacy" : "mark";
}

export function normalizeAnnotationRenderMode(renderMode: unknown, sourceFormat?: unknown): AnnotationRenderMode {
  if (renderMode === "virtual_decoration" || sourceFormat === "virtual") return "virtual_decoration";
  return "inline_mark";
}

export function normalizeProtectedKind(value: unknown): ProtectedKind | null {
  return value === "html_block" ||
    value === "style_block" ||
    value === "code_fence" ||
    value === "math_block" ||
    value === "link" ||
    value === "image" ||
    value === "mixed"
    ? value
    : null;
}

export function normalizeMarkKind(markKind: unknown): AnnotationMarkKind {
  return markKind === "cloze" ? "cloze" : "highlight";
}

export function normalizeAnnotationAnchor(value: unknown): AnnotationAnchor | null {
  if (!value || typeof value !== "object") return null;
  const anchor = value as Partial<AnnotationAnchor>;
  return {
    ...anchor,
    sectionPath: Array.isArray(anchor.sectionPath) ? anchor.sectionPath.map(String) : [],
    paragraphIndex: typeof anchor.paragraphIndex === "number" ? anchor.paragraphIndex : null,
    sourceOffset: typeof anchor.sourceOffset === "number" ? anchor.sourceOffset : null,
    contextBefore: String(anchor.contextBefore || ""),
    contextAfter: String(anchor.contextAfter || ""),
    contextHash: String(anchor.contextHash || ""),
    fragmentCount: Math.max(1, Math.round(Number(anchor.fragmentCount) || 1)),
    crossedBlankLines: Boolean(anchor.crossedBlankLines)
  };
}

export function normalizeAnnotationFragments(value: unknown, fallbackText: string): AnnotationFragment[] {
  if (Array.isArray(value)) {
    const fragments = value
      .map((item, index) => {
        const fragment = item as Partial<AnnotationFragment>;
        return {
          ...fragment,
          index: typeof fragment.index === "number" ? fragment.index : index,
          text: String(fragment.text || "")
        };
      })
      .filter((fragment) => fragment.text.trim());
    if (fragments.length > 0) return fragments;
  }
  return createWrappedHighlightText("normalizer", fallbackText).fragments.map((fragment) => ({
    index: fragment.index,
    text: fragment.text
  }));
}

export function annotationTemplate(type: AnnotationType): string {
  switch (type) {
    case "comment":
      return "- 评论：";
    case "myth_truth":
      return "- 迷思：\n- 真相：";
    case "rebuttal":
      return "- 对方观点：\n- 问题：\n- 反驳：";
    case "sample_quote":
      return "- 用途：sample / 引用\n- 可复用点：";
    case "later":
      return "- 稍后处理原因：";
    case "rewrite":
      return "- 改写目标：";
    case "refine":
      return "- 精炼原则：";
    case "add_viewpoint":
      return "- 原论述可取处：\n- 我补充的观点：";
    case "rebuttal_rewrite":
      return "- 原论述问题：\n- 修正后的论述方向：";
    case "question":
      return "- 问题：\n- 暂定理解：\n- 相关概念：\n- 希望后续回答的方向：";
    case "optimize":
      return "- 原内容不足：\n- 补充说明：\n- 可优化表达：";
    case "example_viewpoint":
      return "- 观点：";
    case "qa_card":
      return "- 问题：\n- 备注：";
    case "highlight":
    default:
      return "";
  }
}

export function resolveQaQuestion(annotation: ArchiveAnnotationPayload): string {
  const fromComment = extractQuestionFromComment(annotation.commentMarkdown);
  if (fromComment) return fromComment;
  const heading = annotation.headingPath[annotation.headingPath.length - 1] || "";
  if (annotation.scope === "heading_subtree" && isLikelyQuestion(heading)) return heading;
  const current = stripIrMarkup(annotation.currentText || "").trim();
  if (isLikelyQuestion(current)) return current;
  return "";
}

export function shouldCreateQaCardFromAnnotation(annotation: ArchiveAnnotationPayload): boolean {
  if (annotation.type === "qa_card") return true;
  if (annotation.type === "question") return false;
  const heading = annotation.headingPath[annotation.headingPath.length - 1] || annotation.currentText;
  return annotation.scope === "heading_subtree" && isLikelyQuestion(heading);
}

export function extractQuestionFromComment(value: string): string {
  const text = String(value || "").trim();
  if (!text) return "";
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = /^-?\s*(?:问题|Q|Question)\s*[:：]\s*(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1].trim();
  }
  const meaningful = lines.filter((line) => !/^-?\s*备注\s*[:：]?\s*$/i.test(line));
  if (meaningful.length === 1 && !/^-\s*(问题|备注)\s*[:：]?\s*$/i.test(meaningful[0])) {
    return meaningful[0].replace(/^-\s*/, "").trim();
  }
  return "";
}

export function isLikelyQuestion(value: string): boolean {
  const text = stripIrMarkup(value).replace(/^#+\s*/, "").trim();
  if (!text) return false;
  return /[?？]$/.test(text) || /^(什么|为何|为什么|如何|怎么|怎样|哪些|是否|能否|何以|Where|What|Why|How|When|Which|Can|Could|Should|Is|Are)\b/i.test(text);
}

export function renderRemNoteMultiLineCard(question: string, answer: string): string {
  const q = stripIrMarkup(question).replace(/\s+/g, " ").trim() || "待生成问题";
  const answerLines = renderCardAnswerLines(answer);
  return [`- ${q} >>>`, ...answerLines].join("\n");
}

export function renderClozeMarkdown(contextText: string, answerText: string): string {
  const context = stripIrMarkup(contextText).trim();
  const answer = stripIrMarkup(answerText).trim();
  if (!answer) return context;
  const cloze = `{{${answer}}}`;
  if (!context) return cloze;
  const index = context.indexOf(answer);
  if (index >= 0) {
    return `${context.slice(0, index)}${cloze}${context.slice(index + answer.length)}`;
  }
  return `${context}\n\n挖空：${cloze}`;
}

export function renderQaCardPreview(card: QaCardRecord): string {
  return renderRemNoteMultiLineCard(
    card.questionMarkdown || "待生成问题",
    card.answerMarkdown || card.answerSourceText || "待生成答案"
  );
}

export function renderCardAnswerLines(answer: string): string[] {
  const lines = stripIrMarkup(answer).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return ["    - 待生成答案"];
  return lines.map((line) => `    - ${line.replace(/^[-*+]\s+/, "")}`);
}

export function createQaCardId(): string {
  return `ir-card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createMusingId(): string {
  return `ir-musing-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createAnnotationId(): string {
  return `ir-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sanitizeFileName(value: string): string {
  return (value || "untitled")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "untitled";
}

export function shortHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

export function blockquote(value: string): string {
  return value.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

export function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

export function truncate(value: string, length: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= length) return normalized;
  return `${normalized.slice(0, length - 1)}…`;
}

export function isSubstantiveAnnotation(annotation: AnnotationRecord): boolean {
  return Boolean(
    annotation.commentMarkdown.trim() ||
    annotation.rewriteMarkdown.trim() ||
    annotation.hasRewrite ||
    annotation.rewriteApplied
  );
}

export function getAnnotationRoute(annotation: AnnotationRecord): AnnotationRoute {
  if (annotation.type === "qa_card") return "remnote_card";
  if (annotation.type === "question") return "codex_question_queue";
  if (isSubstantiveAnnotation(annotation)) return "remnote";
  return "refined_reading";
}

export function getRemNoteTargetDocument(annotation: AnnotationRecord): string {
  if (annotation.type === "myth_truth") return "迷思 / 真相";
  if (annotation.type === "sample_quote") return "引用";
  if (annotation.type === "add_viewpoint") return "联想";
  if (annotation.type === "optimize") return "优化";
  if (annotation.type === "example_viewpoint") return "例子与观点";
  return "普通评论";
}

export function hasAnnotationWork(annotation: AnnotationRecord): boolean {
  return Boolean(
    annotation.commentMarkdown.trim() ||
    annotation.rewriteMarkdown.trim() ||
    annotation.hasRewrite ||
    annotation.rewriteApplied ||
    annotation.type !== "highlight" ||
    annotation.archived
  );
}

export function scanLegacyHighlights(path: string, content: string): LegacyHighlight[] {
  const highlights: LegacyHighlight[] = [];
  const regex = /==([\s\S]*?)==/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const text = match[1];
    if (!text.trim()) continue;
    if (match.index > 0 && content[match.index - 1] === "=") continue;
    if (content[match.index + match[0].length] === "=") continue;
    highlights.push({
      id: `legacy-${shortHash(path)}-${match.index}`,
      path,
      text,
      startOffset: match.index,
      endOffset: match.index + match[0].length
    });
  }
  return highlights;
}

export function hasMarkId(content: string, id: string): boolean {
  return new RegExp(`<mark\\b(?=[^>]*data-ir-id="${escapeRegExp(id)}")[^>]*>`).test(content);
}

export function findSearchOffset(content: string, search: string, expectedOffset?: number | null): number {
  if (typeof expectedOffset === "number" && content.slice(expectedOffset, expectedOffset + search.length) === search) {
    return expectedOffset;
  }
  return content.indexOf(search);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

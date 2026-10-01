import { createHash } from "crypto";

export interface GuideEdit { from: number; to: number; insert: string }
export interface GuideResult { guide: string; blocks: Array<{ id: string; markdown: string }>; processorVersion: string; stages: string[]; calls: number }

const markerStart = "<!-- local-ir-reading-guide:start -->";
const markerEnd = "<!-- local-ir-reading-guide:end -->";
export const textHash = (text: string) => createHash("sha256").update(text).digest("hex");

function linesOutsideCode(text: string) {
  let fence: { char: string; length: number } | null = null;
  return [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter(line => {
    if (!line[0]) return false;
    const token = /^ {0,3}(`{3,}|~{3,})/.exec(line[0]);
    if (fence) {
      if (token?.[1][0] === fence.char && token[1].length >= fence.length) fence = null;
      return false;
    }
    if (token) { fence = { char: token[1][0], length: token[1].length }; return false; }
    return true;
  });
}

export function splitGuideDocument(markdown: string) {
  const fm = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(markdown);
  const frontmatterEnd = fm?.[0].length || 0;
  const lines = linesOutsideCode(markdown).filter(line => line.index! >= frontmatterEnd);
  let guideStart = -1, guideEnd = -1;
  for (const [startMarker, endMarker] of [[markerStart, markerEnd], ["<!-- reading-guide:start -->", "<!-- reading-guide:end -->"]]) {
    const start = lines.find(line => line[0].trim() === startMarker);
    const end = lines.find(line => line[0].trim() === endMarker);
    if (start || end) {
      if (!start || !end || end.index! < start.index!) throw new Error("导读卡边界不完整，未覆盖原文。");
      guideStart = start.index!;
      guideEnd = end.index! + end[0].length;
      break;
    }
  }
  const bodyHeading = lines.find(line => /^## 正文\s*$/.test(line[0]));
  const oldGuide = lines.find(line => /^## (阅读前置卡|导读卡)\s*$/.test(line[0]));
  const standard = Boolean(bodyHeading && (oldGuide || /^(material_id|contract_version):/m.test(fm?.[0] || "")));
  if (guideStart < 0 && oldGuide && standard) {
    guideStart = oldGuide.index!;
    const separator = lines.filter(line => line.index! > guideStart && line.index! < bodyHeading!.index! && /^---\s*$/.test(line[0])).pop();
    guideEnd = separator?.index ?? bodyHeading!.index!;
  }
  // Unknown legacy boundaries must not be guessed: avoid duplicate/nested cards.
  if (guideStart < 0 && oldGuide && !standard) throw new Error("检测到旧导读卡，但无法确认其边界；原文件未改动。");
  const title = lines.find(line => /^# [^#]/.test(line[0]) && !markdown.slice(frontmatterEnd, line.index).trim());
  const insertion = standard ? (guideStart >= 0 ? guideStart : lines.filter(line => line.index! < bodyHeading!.index! && /^---\s*$/.test(line[0])).pop()?.index ?? bodyHeading!.index!)
    : title ? title.index! + title[0].length : frontmatterEnd;
  const bodyStart = standard ? bodyHeading!.index! + bodyHeading![0].length : guideEnd >= 0 ? guideEnd : insertion;
  return { frontmatterEnd, guideStart, guideEnd, insertion, bodyStart, body: markdown.slice(bodyStart) };
}

export function hasReadingGuide(markdown: string, metadata: Record<string, any> = {}): boolean {
  if (metadata.local_ir_reading_guide === true || metadata.reading_guide === true || metadata.reading_guide?.status === "generated") return true;
  try { return splitGuideDocument(markdown).guideStart >= 0; }
  catch { return true; } // Show update/repair, never offer a second card over unknown boundaries.
}

// A projection, never a rewrite: strip existing standalone block IDs from the
// model input and retain offsets back to every original UTF-16 character.
export function guideBodyProjection(body: string) {
  const anchors = linesOutsideCode(body).filter(line => /^\s*\^[A-Za-z0-9-]+\s*$/.test(line[0]));
  const excluded = new Set<number>();
  for (const line of anchors) for (let i = line.index!; i < line.index! + line[0].length; i++) excluded.add(i);
  let text = "";
  const offsets: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (excluded.has(i) || body[i] === "\r" && body[i + 1] === "\n") continue;
    text += body[i]; offsets.push(i);
  }
  return { text, offsets };
}

export function planReadingGuideUpdate(markdown: string, result: GuideResult, now = new Date().toISOString()) {
  if (result.stages.join(",") !== "reading_guide" || !result.guide.startsWith("## 阅读前置卡")) throw new Error("非导读卡单阶段结果，未修改文件。");
  const parts = splitGuideDocument(markdown);
  const projection = guideBodyProjection(parts.body);
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  let guide = result.guide;
  const targets = new Set([...guide.matchAll(/\[\[#\^([A-Za-z0-9-]+)\|/g)].map(match => match[1]));
  const edits: GuideEdit[] = [];
  let offset = 0;
  for (const block of result.blocks) {
    const text = block.markdown.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
    const start = projection.text.indexOf(text, offset);
    if (!text || start < 0) throw new Error("导读结果与原文块不一致，原文件未改动。");
    offset = start + text.length;
    if (!targets.has(block.id)) continue;
    targets.delete(block.id);
    const rawEnd = projection.offsets[offset - 1] + 1;
    const existing = /^(?:[ \t]*\r?\n)+[ \t]*\^([A-Za-z0-9-]+)[ \t]*(?:\r?\n|$)/.exec(parts.body.slice(rawEnd));
    if (existing) {
      guide = guide.split(`[[#^${block.id}|`).join(`[[#^${existing[1]}|`);
    } else {
      if (!/^[A-Za-z0-9-]+$/.test(block.id) || new RegExp(`^\\^${block.id}$`, "m").test(markdown)) throw new Error("正文锚点冲突，原文件未改动。");
      edits.push({ from: parts.bodyStart + rawEnd, to: parts.bodyStart + rawEnd, insert: `${newline}${newline}^${block.id}${newline}` });
    }
  }
  if (targets.size) throw new Error("导读卡包含无对应正文的跳转，原文件未改动。");
  const start = parts.guideStart >= 0 ? parts.guideStart : parts.insertion;
  edits.push({ from: start, to: parts.guideEnd >= 0 ? parts.guideEnd : start,
    insert: `${start && markdown[start - 1] !== "\n" ? newline : ""}${newline}${markerStart}${newline}${guide.replace(/\r?\n/g, newline)}${newline}${markerEnd}${newline}${newline}` });
  const metadata = `local_ir_reading_guide: true${newline}local_ir_reading_guide_updated_at: ${JSON.stringify(now)}${newline}local_ir_reading_guide_body_sha256: ${textHash(parts.body)}${newline}`;
  if (parts.frontmatterEnd) {
    const fm = markdown.slice(0, parts.frontmatterEnd).replace(/^local_ir_reading_guide(?:_updated_at|_body_sha256)?:[^\r\n]*(?:\r?\n|$)/gm, "");
    const close = fm.lastIndexOf("---");
    edits.push({ from: 0, to: parts.frontmatterEnd, insert: fm.slice(0, close) + metadata + fm.slice(close) });
  } else edits.unshift({ from: 0, to: 0, insert: `---${newline}${metadata}---${newline}${newline}` });
  edits.sort((a, b) => a.from - b.from || b.to - a.to);
  let previous = 0;
  for (const edit of edits) {
    if (edit.from < previous) throw new Error("导读卡更新范围重叠，原文件未改动。");
    previous = edit.to;
  }
  return { edits, sourceHash: textHash(markdown), bodyHash: textHash(parts.body) };
}

export function applyGuideEdits(source: string, edits: GuideEdit[]) {
  let result = source;
  for (const edit of [...edits].reverse()) result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
  return result;
}

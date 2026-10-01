import { EditorState, StateEffect, Transaction, type ChangeDesc } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";
import LocalIrDocumentCore from "../渐进阅读工作流/document-core/index.mjs";
import type { AnnotationRecord } from "./types";
import { createAnnotationAnchor, getAnnotationVirtualRanges, getLineRangeForOffsets, normalizeTextRanges, sameTextRanges, stripIrMarkup } from "./model";

export interface AnnotationHistoryEntry {
  path: string;
  change: any;
  direction: "forward" | "backward";
  // The initial annotation edit was already applied by the host. Replays are not.
  replay: boolean;
}

export const annotationHistoryEffect = StateEffect.define<AnnotationHistoryEntry>();

export interface AnnotationHistoryHost {
  settings: { annotations: Record<string, AnnotationRecord> };
  isRecordFrozenForExport(path: string): boolean;
}

// Coordinates belong to the Obsidian host; record diffs and stale checks belong
// to document-core. A deletion is stored in the SAME native event as its text.
export function mappedAnnotationChange(records: AnnotationRecord[], path: string, changes: ChangeDesc, before: string | null, after: string) {
  const source = records.filter(record => record.path === path && !record.archived);
  const next = source.flatMap(annotation => {
    if (annotation.sourceFormat === "mark" && annotation.renderMode !== "virtual_decoration") {
      const marker = `data-ir-id="${annotation.id}"`;
      return before?.includes(marker) && !after.includes(marker) ? [] : [annotation];
    }
    if (annotation.renderMode !== "virtual_decoration" || annotation.orphaned) return [annotation];
    const ranges = getAnnotationVirtualRanges(annotation);
    const mapped = normalizeTextRanges(ranges.map(range => ({
      start: changes.mapPos(range.start, 1), end: changes.mapPos(range.end, -1)
    })).filter(range => range.end > range.start));
    if (!mapped.length) return [];
    const text = mapped.map(range => stripIrMarkup(after.slice(range.start, range.end))).join("\n\n");
    const oldText = before === null ? null : ranges.map(range => stripIrMarkup(before.slice(range.start, range.end))).join("\n\n");
    if (sameTextRanges(mapped, ranges) && (oldText === null || text === oldText)) return [annotation];
    const range = mapped[0];
    return [{ ...annotation, virtualRanges: mapped, range: { ...range }, sourceOffset: range.start,
      lineRange: getLineRangeForOffsets(after, range.start, mapped[mapped.length - 1].end),
      anchor: createAnnotationAnchor(after, range.start, mapped[mapped.length - 1].end, text, annotation.fragments || []),
      ...(!annotation.rewriteApplied && oldText !== null && text !== oldText ? { originalText: text, currentText: text, selectedText: text,
        expandedText: "", expandedAnswerText: "", subtreeRange: null } : {}),
      orphaned: false, updatedAt: new Date().toISOString() }];
  });
  return LocalIrDocumentCore.createChange(source, next, "editor-change");
}

export function applyAnnotationEntries(records: AnnotationRecord[], entries: AnnotationHistoryEntry[]) {
  return entries.reduce((current, entry) => entry.replay
    ? LocalIrDocumentCore.applyChange(current, entry.change, entry.direction, { path: entry.path }) : current, records);
}

export function createAnnotationHistoryExtension(host: AnnotationHistoryHost, pathOf: (state: EditorState) => string | null) {
  return [
    EditorState.transactionExtender.of(tr => {
      const entries = tr.effects.filter(effect => effect.is(annotationHistoryEffect)).map(effect => effect.value);
      if (entries.length) {
        // Also runs for native undo/menu commands (filter:false). Fail before the
        // document or history changes, never silently apply a stale snapshot.
        for (const entry of entries) if (host.isRecordFrozenForExport(entry.path)) throw new Error("document_frozen");
        applyAnnotationEntries(Object.values(host.settings.annotations), entries);
        return null;
      }
      const path = pathOf(tr.startState);
      if (!path || !tr.docChanged || host.isRecordFrozenForExport(path)) return null;
      const change = mappedAnnotationChange(Object.values(host.settings.annotations), path, tr.changes, tr.startState.doc.toString(), tr.newDoc.toString());
      return change.ids.length ? { effects: annotationHistoryEffect.of({ path, change, direction: "forward", replay: true }) } : null;
    }),
    invertedEffects.of(tr => tr.effects.filter(effect => effect.is(annotationHistoryEffect)).reverse().map(effect =>
      annotationHistoryEffect.of({ ...effect.value, direction: effect.value.direction === "forward" ? "backward" : "forward", replay: true })))
  ];
}

export function entriesFromTransactions(transactions: readonly Transaction[]): AnnotationHistoryEntry[] {
  return transactions.flatMap(tr => tr.effects.filter(effect => effect.is(annotationHistoryEffect)).map(effect => effect.value));
}

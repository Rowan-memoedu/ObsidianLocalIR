import type LocalIncrementalReadingPlugin from "./main";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { Editor, TFile, editorInfoField } from "obsidian";
import { Prec, RangeSetBuilder, StateEffect } from "@codemirror/state";
import { clampRangeIndex, getAnnotationVirtualRanges } from "./model";
import { isWholeBlockHighlightGesture } from "./editor-gestures";
import { createAnnotationHistoryExtension, entriesFromTransactions } from "./annotation-history";

export const localIrRefreshEffect = StateEffect.define<void>();

export function createVirtualHighlightExtension(plugin: LocalIncrementalReadingPlugin) {
  const historyShortcutExtension = Prec.highest(EditorView.domEventHandlers({
    keydown(event, view) {
      return plugin.handleVirtualHighlightUndoShortcut(view, event) || plugin.handleVirtualHighlightRedoShortcut(view, event);
    }
  }));
  const decorationExtension = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildVirtualHighlightDecorations(plugin, view);
    }

    update(update: ViewUpdate) {
      const entries = entriesFromTransactions(update.transactions);
      if (entries.some(entry => entry.replay)) plugin.applyEditorAnnotationEntries(entries);
      const shouldRefresh = update.docChanged ||
        update.viewportChanged ||
        entries.length > 0 ||
        update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(localIrRefreshEffect)));
      if (shouldRefresh) {
        this.decorations = buildVirtualHighlightDecorations(plugin, update.view);
      }
    }
  }, {
    decorations: (value) => value.decorations,
    eventHandlers: {
      click(event, view) {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const mark = target?.closest("[data-ir-virtual-id]") as HTMLElement | null;
        const id = mark?.getAttribute("data-ir-virtual-id");
        const annotation = id ? plugin.settings.annotations[id] : null;
        if (id && annotation && event.altKey) {
          event.preventDefault();
          plugin.queueManualMergeAnnotation(id);
          view.focus();
          return true;
        }
        if (isWholeBlockHighlightGesture(event, plugin.settings.processingModeEnabled)) {
          event.preventDefault();
          event.stopPropagation();
          void plugin.highlightWholeBlockAtClick(view, event);
          view.focus();
          return true;
        }
        if (!id || !annotation) return false;
        event.preventDefault();
        plugin.openAnnotationModal(annotation);
        view.focus();
        return true;
      }
    }
  });
  return [createAnnotationHistoryExtension(plugin, state => state.field(editorInfoField, false)?.file?.path || null), historyShortcutExtension, decorationExtension];
}

export function buildVirtualHighlightDecorations(plugin: LocalIncrementalReadingPlugin, view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const path = getEditorViewPath(view);
  if (!path) return builder.finish();
  const docLength = view.state.doc.length;
  const decorations = plugin.getAnnotationsForPath(path)
    .filter((annotation) => annotation.renderMode === "virtual_decoration" && !annotation.orphaned)
    .flatMap((annotation) => getAnnotationVirtualRanges(annotation).map((range) => ({ annotation, range })))
    .sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);
  for (const { annotation, range } of decorations) {
    const from = clampRangeIndex(range.start, docLength);
    const to = clampRangeIndex(range.end, docLength);
    if (to <= from) continue;
    builder.add(from, to, Decoration.mark({
      class: annotation.markKind === "cloze" ? "local-ir-virtual-cloze" : "local-ir-virtual-highlight",
      attributes: {
        "data-ir-virtual-id": annotation.id,
        "data-ir-kind": annotation.markKind
      }
    }));
  }
  return builder.finish();
}

export function getEditorViewPath(view: EditorView): string | null {
  try {
    const info = view.state.field(editorInfoField, false) as { file?: TFile } | null;
    return info?.file?.path || null;
  } catch {
    return null;
  }
}

export function getCodeMirrorView(editor: Editor | null): EditorView | null {
  const candidate = editor as unknown as { cm?: EditorView };
  return candidate?.cm instanceof EditorView ? candidate.cm : null;
}

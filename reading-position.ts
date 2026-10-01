import type { DocRecord } from "./types";

// Use the host's editor/ephemeral state, not a second cursor-position database.
// Honour explicit heading/search navigation when restoring a completed reading.
export function captureReadingPosition(workspace: any, path: string): DocRecord["readingPosition"] {
  if (workspace.getActiveFile()?.path !== path) return null;
  const leaf = workspace.getMostRecentLeaf?.();
  const view = leaf?.view;
  const editor = workspace.activeEditor?.file?.path === path ? workspace.activeEditor.editor : view?.file?.path === path ? view.editor : null;
  const cursor = editor?.getCursor?.("head");
  const state = leaf?.getEphemeralState?.() || view?.getEphemeralState?.() || {};
  const scroll = view?.currentMode?.getScroll?.() ?? state.scroll;
  if (!cursor && !Number.isFinite(scroll)) return null;
  return { ...(cursor ? { cursor: { line: cursor.line, ch: cursor.ch } } : {}),
    ...(Number.isFinite(scroll) ? { scroll } : {}), savedAt: new Date().toISOString() };
}

export function restoreReadingPosition(workspace: any, path: string, position: DocRecord["readingPosition"]): boolean {
  if (!position || workspace.getActiveFile()?.path !== path) return false;
  const leaf = workspace.getMostRecentLeaf?.();
  const view = leaf?.view;
  if (view?.file?.path !== path) return false;
  const ephemeral = leaf.getEphemeralState?.() || {};
  if (ephemeral.line !== undefined || ephemeral.startLoc || ephemeral.endLoc || ephemeral.subpath || ephemeral.match ||
    view.containerEl?.querySelector?.(".is-flashing")) return false;
  const editor = view.editor;
  if (position.cursor && editor?.lineCount?.() > 0) {
    const line = Math.min(position.cursor.line, editor.lineCount() - 1);
    const cursor = { line, ch: Math.min(position.cursor.ch, editor.getLine(line).length) };
    editor.setCursor(cursor);
    editor.scrollIntoView({ from: cursor, to: cursor }, true);
  }
  if (Number.isFinite(position.scroll)) view.setEphemeralState?.({ scroll: position.scroll });
  return true;
}

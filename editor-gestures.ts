export interface ModifierClick {
  ctrlKey: boolean;
  altKey: boolean;
}

export interface UndoShortcut {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface VirtualHighlightUndoAction {
  kind: string;
  path: string;
  beforeContent?: string;
  afterContent?: string;
}

export interface TextOffsetRange {
  start: number;
  end: number;
}

export function isWholeBlockHighlightGesture(event: ModifierClick, processingModeEnabled: boolean): boolean {
  return processingModeEnabled && event.ctrlKey && !event.altKey;
}

export function isPlainUndoShortcut(event: UndoShortcut): boolean {
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z";
}

export function isPlainRedoShortcut(event: UndoShortcut): boolean {
  return event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "y";
}

export function isUndoableVirtualHighlightAction(
  action: VirtualHighlightUndoAction | undefined,
  path: string,
  currentContent: string
): boolean {
  return Boolean(
    action &&
    action.kind === "merge" &&
    action.path === path &&
    typeof action.beforeContent === "string" &&
    action.beforeContent === action.afterContent &&
    action.afterContent === currentContent
  );
}

export function getMarkdownBlockRangeAtOffset(content: string, offset: number): TextOffsetRange {
  const safeOffset = Math.max(0, Math.min(content.length, Math.round(Number(offset) || 0)));
  let start = safeOffset;
  let end = safeOffset;
  const before = content.slice(0, safeOffset);
  const after = content.slice(safeOffset);
  const beforeBreak = before.search(/\r?\n[ \t]*\r?\n(?![\s\S]*\r?\n[ \t]*\r?\n)/);
  if (beforeBreak >= 0) {
    const match = /\r?\n[ \t]*\r?\n/g;
    let found: RegExpExecArray | null;
    while ((found = match.exec(before)) !== null) start = found.index + found[0].length;
  } else {
    start = 0;
  }
  const afterMatch = /\r?\n[ \t]*\r?\n/.exec(after);
  end = afterMatch ? safeOffset + afterMatch.index : content.length;
  return { start, end };
}

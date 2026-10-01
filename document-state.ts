import { createHash } from "node:crypto";

export function documentStateFileName(markdownPath: string): string {
  const normalized = markdownPath.replace(/\\/g, "/");
  const fileName = normalized.split("/").pop() || "document.md";
  const identity = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return `${fileName.slice(0, 100)}--${identity}.browser-ir.json`;
}

/** One pass over all records, including the legacy lastKnownPath alias. */
export function indexByDocument<T extends { path: string; lastKnownPath?: string; createdAt?: string }>(records: Record<string, T>): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const record of Object.values(records)) {
    for (const documentPath of new Set([record.path, record.lastKnownPath].filter(Boolean))) {
      const group = index.get(documentPath!) || [];
      group.push(record);
      index.set(documentPath!, group);
    }
  }
  for (const records of index.values()) records.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  return index;
}

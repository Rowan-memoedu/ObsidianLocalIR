export const METRIC_LEVEL_OPTIONS = [
  { label: "极低", value: 0 },
  { label: "低", value: 2.5 },
  { label: "中", value: 5 },
  { label: "高", value: 7.5 },
  { label: "极高", value: 10 }
] as const;

export const DEFAULT_METRIC_VALUE = 5;
export const MAX_METRIC_VALUE = 10;

export interface ReadingMetricPreset {
  valueJudgment?: number;
  informationDensity?: number;
}

export interface ReadingMetricValues {
  importance: number;
  urgency: number;
  difficulty: number;
  interest: number;
}

export interface ReadingMetricPresetState {
  metrics: ReadingMetricValues;
  metricsEditedByUser: boolean;
  metricPresetCheckedMtime: number | null;
}

export interface ReadingMetricPresetReconciliation {
  state: ReadingMetricPresetState;
  changed: boolean;
  presetApplied: boolean;
}

const VALUE_FRONTMATTER_KEYS = new Set([
  "value_judgment",
  "reading_value",
  "local_ir_value",
  "judgments_value_level",
  "价值判断",
  "对我的价值判断"
]);

const DENSITY_FRONTMATTER_KEYS = new Set([
  "information_density",
  "information_density_judgment",
  "density_judgment",
  "reading_density",
  "local_ir_density",
  "judgments_density_level",
  "信息密度判断"
]);

export function snapMetricValue(value: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_METRIC_VALUE;
  return METRIC_LEVEL_OPTIONS.reduce((nearest, option) =>
    Math.abs(option.value - numeric) < Math.abs(nearest.value - numeric) ? option : nearest
  ).value;
}

export function metricLevelLabel(value: number): string {
  const snapped = snapMetricValue(value);
  return METRIC_LEVEL_OPTIONS.find((option) => option.value === snapped)?.label || "中";
}

export function isDefaultMetricInitialization(metrics: ReadingMetricValues): boolean {
  return Object.values(metrics).every((value) => snapMetricValue(value) === DEFAULT_METRIC_VALUE);
}

export function inferMetricsEditedByUser(metrics: ReadingMetricValues, storedValue: unknown): boolean {
  if (typeof storedValue === "boolean") return storedValue;
  return !isDefaultMetricInitialization(metrics);
}

export function reconcileReadingMetricPreset(
  current: ReadingMetricPresetState,
  preset: ReadingMetricPreset,
  sourceMtime: number | null
): ReadingMetricPresetReconciliation {
  const normalizedMtime = Number.isFinite(sourceMtime) ? Number(sourceMtime) : null;
  const normalizedMetrics: ReadingMetricValues = {
    importance: snapMetricValue(current.metrics.importance),
    urgency: snapMetricValue(current.metrics.urgency),
    difficulty: snapMetricValue(current.metrics.difficulty),
    interest: snapMetricValue(current.metrics.interest)
  };
  const unchanged = {
    state: { ...current, metrics: normalizedMetrics },
    changed: false,
    presetApplied: false
  };
  if (current.metricsEditedByUser || !isDefaultMetricInitialization(normalizedMetrics)) return unchanged;
  if (normalizedMtime !== null && current.metricPresetCheckedMtime === normalizedMtime) return unchanged;

  const metrics = {
    ...normalizedMetrics,
    ...(preset.valueJudgment === undefined ? {} : { importance: snapMetricValue(preset.valueJudgment) }),
    ...(preset.informationDensity === undefined ? {} : { urgency: snapMetricValue(preset.informationDensity) })
  };
  const presetApplied = preset.valueJudgment !== undefined || preset.informationDensity !== undefined;
  return {
    state: {
      metrics,
      metricsEditedByUser: false,
      metricPresetCheckedMtime: normalizedMtime
    },
    changed: normalizedMtime !== current.metricPresetCheckedMtime || JSON.stringify(metrics) !== JSON.stringify(normalizedMetrics),
    presetApplied
  };
}

export function parseReadingMetricPreset(markdown: string): ReadingMetricPreset {
  const text = normalizeNewlines(markdown);
  const frontmatter = parseFrontmatterScalars(text);
  const card = extractReadingPreflightCard(text);

  const frontmatterValue = findFrontmatterValue(frontmatter, VALUE_FRONTMATTER_KEYS);
  const frontmatterDensity = findFrontmatterValue(frontmatter, DENSITY_FRONTMATTER_KEYS);
  const cardValue = extractCardJudgment(card, ["价值判断", "对我的价值判断"]);
  const cardDensity = extractCardJudgment(card, ["信息密度判断"]);

  const valueJudgment = parseJudgmentLevel(frontmatterValue) ?? parseJudgmentLevel(cardValue);
  const informationDensity = parseJudgmentLevel(frontmatterDensity) ?? parseJudgmentLevel(cardDensity);
  return {
    ...(valueJudgment === null ? {} : { valueJudgment }),
    ...(informationDensity === null ? {} : { informationDensity })
  };
}

function normalizeNewlines(value: string): string {
  return String(value || "").replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}

function normalizeFrontmatterKey(value: string): string {
  const trimmed = value.trim();
  if (/^[\u3400-\u9FFF]/u.test(trimmed)) return trimmed.replace(/[\s.-]+/gu, "_");
  return trimmed.toLowerCase().replace(/[\s.-]+/gu, "_");
}

function parseFrontmatterScalars(markdown: string): Map<string, string> {
  const result = new Map<string, string>();
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(markdown);
  if (!match) return result;
  for (const line of match[1].split("\n")) {
    const parsed = /^([^:#][^:]*):\s*(.*?)\s*$/u.exec(line);
    if (!parsed) continue;
    const value = parsed[2].replace(/^(["'])(.*)\1$/u, "$2").trim();
    if (value) result.set(normalizeFrontmatterKey(parsed[1]), value);
  }
  return result;
}

function findFrontmatterValue(frontmatter: Map<string, string>, keys: Set<string>): string {
  for (const key of keys) {
    const value = frontmatter.get(normalizeFrontmatterKey(key));
    if (value) return value;
  }
  return "";
}

function extractReadingPreflightCard(markdown: string): string {
  const heading = /^##(?!#)\s+阅读前置卡\s*$/mu.exec(markdown);
  if (!heading || heading.index === undefined) return "";
  const rest = markdown.slice(heading.index + heading[0].length);
  const nextHeading = /^##(?!#)\s+.+$/mu.exec(rest);
  return nextHeading && nextHeading.index !== undefined ? rest.slice(0, nextHeading.index) : rest;
}

function extractCardJudgment(card: string, labels: string[]): string {
  if (!card) return "";
  const escapedLabels = labels.map(escapeRegExp).join("|");
  const inline = new RegExp(`^(?:[-*+]\\s*)?(?:${escapedLabels})\\s*[：:]\\s*(.+)$`, "imu").exec(card);
  if (inline) return inline[1].trim();

  const heading = new RegExp(`^#{3,6}\\s+(?:${escapedLabels})\\s*$`, "imu").exec(card);
  if (!heading || heading.index === undefined) return "";
  const rest = card.slice(heading.index + heading[0].length);
  const nextHeading = /^#{1,6}\s+.+$/mu.exec(rest);
  const body = nextHeading && nextHeading.index !== undefined ? rest.slice(0, nextHeading.index) : rest;
  return body.split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function parseJudgmentLevel(value: string): number | null {
  const normalized = String(value || "")
    .trim()
    .replace(/^[\s>*_`"'「」『』【】\[\]()（）]+/u, "")
    .toLowerCase();
  const match = /^(跳过|不值得读|skip|very[_ -]?low|low|medium|mid|very[_ -]?high|high|极低|低|中|极高|高)(?=$|[\s。.，,；;：:!！?？*_`"'「」『』【】\[\]()（）])/iu.exec(normalized);
  if (!match) return null;
  if (["跳过", "不值得读", "skip", "very_low", "very-low", "very low", "极低"].includes(match[1])) return 0;
  if (["low", "低"].includes(match[1])) return 2.5;
  if (["medium", "mid", "中"].includes(match[1])) return 5;
  if (["high", "高"].includes(match[1])) return 7.5;
  return 10;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

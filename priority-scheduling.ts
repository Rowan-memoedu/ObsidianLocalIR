import { MAX_METRIC_VALUE, snapMetricValue } from "./metric-presets";

export interface PriorityMetricValues {
  importance: number;
  urgency: number;
  difficulty: number;
  interest: number;
}

export interface PriorityRecordLike {
  metrics: PriorityMetricValues;
  priority: number;
}

export function isExtremePriorityMetrics(metrics: PriorityMetricValues): boolean {
  return [metrics.importance, metrics.urgency, metrics.difficulty, metrics.interest]
    .every((value) => snapMetricValue(value) === MAX_METRIC_VALUE);
}

export function comparePriorityRecords(a: PriorityRecordLike, b: PriorityRecordLike): number {
  const extremeDifference = Number(isExtremePriorityMetrics(b.metrics)) - Number(isExtremePriorityMetrics(a.metrics));
  if (extremeDifference !== 0) return extremeDifference;
  return b.priority - a.priority;
}

export function findExtremePriorityRecord<T extends PriorityRecordLike>(records: T[]): T | null {
  return records.find((record) => isExtremePriorityMetrics(record.metrics)) || null;
}

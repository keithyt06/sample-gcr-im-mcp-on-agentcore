// Structured JSON logs and CloudWatch Embedded Metric Format (EMF) lines.
// Never pass tokens, secrets, codes, or raw user ids in `fields`: use hashUserId().
import { createHash } from 'node:crypto';
import { ENV, type MetricName } from '../../shared/contract';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, event, ...fields, ts: new Date().toISOString() }));
}

/** 16 hex chars of sha256: correlatable across log lines, not reversible to the id. */
export function hashUserId(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 16);
}

/** Emit one EMF metric line on stdout (technical design §6.4). */
export function metric(name: MetricName, value = 1): void {
  const namespace = process.env[ENV.METRIC_NAMESPACE] || 'ImMcp';
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [[]], Metrics: [{ Name: name, Unit: 'Count' }] }],
      },
      [name]: value,
      event: name,
    }),
  );
}

export function errName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

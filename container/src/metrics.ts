// CloudWatch Embedded Metric Format (technical design §6.4, R6).
import { createHash } from 'node:crypto';
import type { MetricName } from '../../shared/contract';

let configuredNamespace: string | undefined;

/** Set once at startup from the Runtime env (METRIC_NAMESPACE = ImMcp/<slug>). */
export function setMetricNamespace(ns: string | undefined): void {
  configuredNamespace = ns || undefined;
}

export function metric(name: MetricName, value = 1, namespace = configuredNamespace ?? process.env.METRIC_NAMESPACE ?? 'ImMcp'): void {
  const line = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [[]], Metrics: [{ Name: name, Unit: 'Count' }] }],
    },
    [name]: value,
    event: name,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export function log(level: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL', event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'INFO') process.stdout.write(`${line}\n`);
  else process.stderr.write(`${line}\n`);
}

/** 16 hex chars of sha256, same as lambda/shared/log.ts hashUserId: correlatable, not the raw id (review L-4). */
export function hashUserId(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 16);
}

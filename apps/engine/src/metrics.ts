import { env } from 'cloudflare:workers';
import { opsMetrics } from '@commerceworker/telemetry/metrics';

/**
 * The engine's operational metrics (`METRICS`, one data point per event): for code with no `env`
 * in hand (the model call's log, the order Workflow's failure path). Cheap enough to build per
 * call, and it never throws or blocks (packages/telemetry/src/metrics.ts).
 */
export const ops = () => opsMetrics(env.METRICS, 'engine');

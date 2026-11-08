import { type FlowVersion, TEMPLATES } from '@commerceworker/core';
import { flowStore } from './wire';

/** A published version of the flow: `version`, or the latest. */
export function loadFlowVersion(
  env: Env,
  flowId: string,
  version?: number,
): Promise<FlowVersion | null> {
  return flowStore(env).version(flowId, version);
}

/** Publishes the built-in templates the first time. */
export async function ensureTemplates(env: Env) {
  await flowStore(env).seed(Object.values(TEMPLATES).map((t) => t()));
}

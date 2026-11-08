/**
 * Workers-native telemetry. Logs are structured JSON on `console` (captured by Workers Logs and
 * Workers observability); spans are a pass-through until Workers tracing exposes a user API.
 * Metrics go to Analytics Engine from the adapters package, not from here.
 */

type LogFn = (obj?: unknown, msg?: string) => void;

export interface Logger {
  readonly info: LogFn;
  readonly warn: LogFn;
  readonly error: LogFn;
  readonly debug: LogFn;
}

const log =
  (level: 'info' | 'warn' | 'error' | 'debug'): LogFn =>
  (obj, msg) => {
    const line =
      typeof obj === 'string' && msg === undefined ? { msg: obj } : { ...(obj as object), msg };
    console[level](JSON.stringify({ level, ...line }));
  };

export const logger: Logger = {
  info: log('info'),
  warn: log('warn'),
  error: log('error'),
  debug: log('debug'),
};

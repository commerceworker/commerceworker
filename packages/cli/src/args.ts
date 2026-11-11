import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CommerceClient } from '@commerceworker/sdk-commerce';
import type { ManagementClient } from '@commerceworker/sdk-management';
import type { Io } from './io.js';
import type { DeviceAuthorization } from './oauth.js';
import { browserUrl, stripControl } from './origin.js';
import { CliError, EXIT, type Result, usageError } from './output.js';
import type { CommerceSession, Session, Target } from './session.js';

/** What a command is, and the helpers every command reads its flags with. */

export interface CommerceContext {
  readonly client: CommerceClient;
  readonly session: CommerceSession;
}

export interface OptionSpec {
  readonly type: 'string' | 'boolean';
  readonly short?: string;
  readonly multiple?: boolean;
  readonly description: string;
}

export interface CommandContext {
  readonly args: readonly string[];
  readonly values: Readonly<Record<string, string | boolean | string[] | undefined>>;
  readonly io: Io;
  readonly target: Target;
  readonly json: boolean;
  /** The session, resolved on first use (`doctor` and `login` work without one). */
  readonly session: () => Promise<Session>;
  readonly client: () => Promise<ManagementClient>;
  /** The commerce client and session for this command; refuses a content profile. */
  readonly commerce: () => Promise<CommerceContext>;
  /** Indent the JSON result (`--pretty`). */
  readonly pretty: boolean;
}

export interface Command {
  /** One or two words: `spaces`, `entries list`. */
  readonly name: string;
  /** Positional arguments, as shown in usage: `<id>`, `<file>`. */
  readonly args?: string;
  readonly summary: string;
  readonly options: Readonly<Record<string, OptionSpec>>;
  /** Which product's deployments it works with; `both` picks by the profile. */
  readonly product: 'content' | 'commerce' | 'both';
  readonly run: (ctx: CommandContext) => Promise<Result>;
}

export const str = (ctx: CommandContext, key: string) => ctx.values[key] as string | undefined;
export const bool = (ctx: CommandContext, key: string) => ctx.values[key] === true;
export const list = (ctx: CommandContext, key: string) =>
  (ctx.values[key] as string[] | undefined) ?? [];

export function arg(ctx: CommandContext, index: number, name: string): string {
  const value = ctx.args[index];
  if (!value) throw usageError(`Missing ${name}.`);
  return value;
}

export function int(ctx: CommandContext, key: string): number | undefined {
  const raw = str(ctx, key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw usageError(`--${key} must be a whole number.`);
  return n;
}

/** A JSON value from the flag itself, or from a file with `@path`. */
export async function jsonFlag<T>(ctx: CommandContext, key: string): Promise<T> {
  const raw = str(ctx, key);
  if (raw === undefined) throw usageError(`--${key} is required.`);
  const text = raw.startsWith('@')
    ? await readFile(resolve(ctx.io.cwd, raw.slice(1)), 'utf8')
    : raw;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw usageError(`--${key} is not valid JSON: ${(err as Error).message}`);
  }
}

/**
 * Asks before a write when a person is there to answer; refuses when nobody is (CI, an agent),
 * unless `--yes` says the caller already decided.
 */
export async function confirm(ctx: CommandContext, question: string): Promise<void> {
  if (bool(ctx, 'yes')) return;
  if (!ctx.io.interactive) {
    throw new CliError(
      'Not a terminal, so nothing can be confirmed: pass --yes to go ahead.',
      EXIT.usage,
      'confirmation_required',
    );
  }
  const answer = (await ctx.io.ask(`${question} [y/N] `)).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    throw new CliError('Cancelled.', EXIT.failure, 'cancelled');
  }
}

export const YES: OptionSpec = {
  type: 'boolean',
  short: 'y',
  description: 'Don’t ask for confirmation (required when not on a terminal)',
};

/**
 * Tells the person where to approve. Always stderr: stdout is the command's result. The browser
 * opens only when `--open` asks for it, and only for a page {@link browserUrl} vouches for (on
 * `origin`, for a commerce deployment); anything else is left for the person to type.
 */
export async function announce(ctx: CommandContext, device: DeviceAuthorization, origin?: string) {
  const url = stripControl(device.verification_uri_complete ?? device.verification_uri);
  const code = stripControl(device.user_code);
  if (bool(ctx, 'open')) {
    const href = browserUrl(device.verification_uri_complete ?? device.verification_uri, origin);
    if (href) await ctx.io.openUrl(href).catch(() => undefined);
    else
      ctx.io.stderr(
        'Not opening the browser: the verification address is not a plain https page on the deployment.',
      );
  }
  if (ctx.json) {
    ctx.io.stderr(
      JSON.stringify({
        event: 'device_authorization',
        verificationUri: url,
        userCode: code,
        expiresIn: device.expires_in,
      }),
    );
  } else {
    ctx.io.stderr(
      `Open ${url}\nand confirm the code ${code} (it expires in ${Math.round(device.expires_in / 60)} minutes). Waiting…`,
    );
  }
}

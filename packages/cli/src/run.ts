import { parseArgs } from 'node:util';
import { ManagementError } from '@commerceworker/sdk-management';
import {
  COMMANDS,
  type Command,
  type CommandContext,
  GLOBAL_OPTIONS,
  type OptionSpec,
} from './commands.js';
import type { Io } from './io.js';
import { CliError, EXIT, usageError } from './output.js';
import { clientFor, resolveSession, type Session } from './session.js';

export const VERSION = '0.1.0';

/**
 * Runs one command line and returns its exit code. Never throws and never calls `process.exit`,
 * so tests (and anything embedding the CLI) drive it like the bin does.
 */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const json = argv.includes('--json');
  try {
    if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
      io.stdout(usage(argv[0] === 'help' ? argv.slice(1) : []));
      return EXIT.ok;
    }
    if (argv[0] === '--version' || argv[0] === '-v') {
      io.stdout(json ? JSON.stringify({ version: VERSION }) : VERSION);
      return EXIT.ok;
    }
    const { command, rest } = findCommand(argv);
    const options = { ...GLOBAL_OPTIONS, ...command.options };
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
        args: [...rest],
        options: toParseOptions(options),
        allowPositionals: true,
        allowNegative: true,
        strict: true,
      });
    } catch (err) {
      throw usageError(`${(err as Error).message}\n\n${commandUsage(command)}`);
    }
    const values = parsed.values as CommandContext['values'];
    if (values.help) {
      io.stdout(commandUsage(command));
      return EXIT.ok;
    }
    const target = {
      url: values.url as string | undefined,
      space: values.space as string | undefined,
      environment: values.environment as string | undefined,
      profile: values.profile as string | undefined,
    };
    let session: Promise<Session> | undefined;
    const ctx: CommandContext = {
      args: parsed.positionals,
      values,
      io,
      target,
      json,
      session: () => {
        session ??= resolveSession(target, io);
        return session;
      },
      client: async () => clientFor(await ctx.session(), io),
    };
    const result = await command.run(ctx);
    io.stdout(json ? JSON.stringify(result.json, null, 2) : result.human);
    return result.exitCode ?? EXIT.ok;
  } catch (err) {
    const failure = describe(err);
    io.stderr(
      json
        ? JSON.stringify({ error: failure.error }, null, 2)
        : `commerceworker: ${failure.error.message}`,
    );
    return failure.exitCode;
  }
}

/** Command names are the leading words: two (`entries list`) before one (`spaces`). */
function findCommand(argv: readonly string[]): { command: Command; rest: readonly string[] } {
  const two = `${argv[0]} ${argv[1]}`;
  const byTwo = COMMANDS.find((c) => c.name === two);
  if (byTwo) return { command: byTwo, rest: argv.slice(2) };
  const byOne = COMMANDS.find((c) => c.name === argv[0]);
  if (byOne) return { command: byOne, rest: argv.slice(1) };
  const group = COMMANDS.filter((c) => c.name.startsWith(`${argv[0]} `));
  if (group.length) {
    throw usageError(
      `${argv[1] ? `Unknown command "${two}"` : `"${argv[0]}" needs a subcommand`}. Try:\n${group
        .map((c) => `  commerceworker ${c.name}${c.args ? ` ${c.args}` : ''}`)
        .join('\n')}`,
    );
  }
  throw usageError(`Unknown command "${argv[0]}". Run \`commerceworker --help\`.`);
}

function toParseOptions(options: Readonly<Record<string, OptionSpec>>) {
  return Object.fromEntries(
    Object.entries(options).map(([name, o]) => [
      name,
      {
        type: o.type,
        ...(o.short ? { short: o.short } : {}),
        ...(o.multiple ? { multiple: true } : {}),
      },
    ]),
  ) as NonNullable<Parameters<typeof parseArgs>[0]>['options'];
}

interface Failure {
  readonly exitCode: number;
  readonly error: { code: string; message: string; status?: number; details?: unknown };
}

function describe(err: unknown): Failure {
  if (err instanceof CliError) {
    return {
      exitCode: err.exitCode,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details === undefined ? {} : { details: err.details }),
      },
    };
  }
  if (err instanceof ManagementError) {
    const status = err.status;
    const apiError = (err.body as { code?: string; message?: string } | undefined) ?? {};
    return {
      exitCode: status === 401 ? EXIT.auth : EXIT.failure,
      error: {
        code: apiError.code ?? `http_${status}`,
        message:
          status === 401
            ? 'The token was refused (401). Run `commerceworker login` again.'
            : status === 403
              ? `Forbidden (403): the token lacks the scope this needs. ${apiError.message ?? ''}`.trim()
              : (apiError.message ?? err.message),
        status,
        ...(err.body === undefined ? {} : { details: err.body }),
      },
    };
  }
  return {
    exitCode: EXIT.failure,
    error: { code: 'error', message: err instanceof Error ? err.message : String(err) },
  };
}

function optionLines(options: Readonly<Record<string, OptionSpec>>): string[] {
  return Object.entries(options).map(([name, o]) => {
    const flag = `${o.short ? `-${o.short}, ` : ''}--${name}${o.type === 'string' ? ' <value>' : ''}`;
    return `  ${flag.padEnd(30)}${o.description}`;
  });
}

export function commandUsage(command: Command): string {
  return [
    `Usage: commerceworker ${command.name}${command.args ? ` ${command.args}` : ''} [options]`,
    '',
    command.summary,
    ...(Object.keys(command.options).length
      ? ['', 'Options:', ...optionLines(command.options)]
      : []),
    '',
    'Global options:',
    ...optionLines(GLOBAL_OPTIONS),
  ].join('\n');
}

function usage(topic: readonly string[]): string {
  if (topic.length) {
    const found = COMMANDS.find((c) => c.name === topic.join(' '));
    if (found) return commandUsage(found);
  }
  const width = Math.max(...COMMANDS.map((c) => `${c.name}${c.args ? ` ${c.args}` : ''}`.length));
  return [
    `commerceworker ${VERSION}: work with a commerceworker deployment from a terminal, CI or an agent.`,
    '',
    'Usage: commerceworker <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map(
      (c) => `  ${`${c.name}${c.args ? ` ${c.args}` : ''}`.padEnd(width + 2)}${c.summary}`,
    ),
    '',
    'Global options:',
    ...optionLines(GLOBAL_OPTIONS),
    '',
    'Environment: COMMERCEWORKER_TOKEN (a key or token; skips the stored profile), COMMERCEWORKER_URL,',
    'COMMERCEWORKER_SPACE, COMMERCEWORKER_ENVIRONMENT, COMMERCEWORKER_PROFILE, COMMERCEWORKER_CONFIG_DIR.',
    '',
    'Exit codes: 0 ok, 1 failed, 2 usage or confirmation needed, 3 not signed in, 4 destructive change refused.',
  ].join('\n');
}

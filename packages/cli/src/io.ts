import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

/**
 * Everything the CLI touches outside its own code. The bin passes the real process; tests pass
 * a fake fetch (or the in-process api), a temp config dir and a clock that doesn't wait.
 */
export interface Io {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** True only when both stdin and stdout are terminals: the only time the CLI asks anything. */
  readonly interactive: boolean;
  readonly fetch: typeof fetch;
  /** Where credentials are kept (see {@link configDirFor}). */
  readonly configDir: string;
  readonly cwd: string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Asks one question; called only when `interactive`. */
  readonly ask: (question: string) => Promise<string>;
  readonly platform: NodeJS.Platform;
}

/**
 * The user config directory: `COMMERCEWORKER_CONFIG_DIR`, else `$XDG_CONFIG_HOME/commerceworker`,
 * else `%APPDATA%\commerceworker` on Windows, else `~/.config/commerceworker`.
 */
export function configDirFor(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  home: string,
): string {
  if (env.COMMERCEWORKER_CONFIG_DIR) return env.COMMERCEWORKER_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'commerceworker');
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'commerceworker');
  return join(home, '.config', 'commerceworker');
}

export function processIo(): Io {
  return {
    env: process.env,
    stdout: (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
    stderr: (text) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    fetch: globalThis.fetch,
    configDir: configDirFor(process.env, process.platform, homedir()),
    cwd: process.cwd(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    platform: process.platform,
  };
}

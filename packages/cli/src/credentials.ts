import { randomBytes } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { Io } from './io.js';
import { CliError, EXIT } from './output.js';

/**
 * Signed-in deployments, one profile each, in `<config dir>/credentials.json`. The file holds
 * bearer tokens, so it is written owner-only (0600, in a 0700 directory) and replaced atomically:
 * a crash mid-write leaves the old file, never half a token.
 */

/** Which product a profile signs in to: a commerce deployment (admin origin) or a content one (API origin). */
export type Product = 'commerce' | 'content';

export interface Profile {
  /**
   * Absent in a file written before commerce commands existed; that is a content profile
   * ({@link productOf}, and `readCredentials` fills it in).
   */
  readonly product?: Product;
  /**
   * A content deployment's API origin, e.g. https://api.your-workspace.commerceworker.com; a
   * commerce deployment's admin origin, e.g. https://app.your-workspace.commerceworker.com
   */
  readonly url: string;
  /** Content only. */
  readonly space?: string;
  /** Content only. */
  readonly environment?: string;
  readonly accessToken: string;
  /** Absent for a stored API key, which has nothing to refresh. */
  readonly refreshToken?: string;
  /** When the access token expires (epoch ms); absent for a key that doesn't. */
  readonly expiresAt?: number;
  /** The OAuth client this CLI registered with the deployment, reused on the next login. */
  readonly clientId?: string;
  readonly scopes?: readonly string[];
  readonly subject?: string;
}

export interface Credentials {
  /** The profile commands use when none is named. */
  readonly current?: string;
  readonly profiles: Readonly<Record<string, Profile>>;
}

export const productOf = (profile: Pick<Profile, 'product'>): Product =>
  profile.product ?? 'content';

export const CREDENTIALS_FILE = 'credentials.json';
export const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export const credentialsPath = (io: Pick<Io, 'configDir'>) => join(io.configDir, CREDENTIALS_FILE);

export async function readCredentials(io: Pick<Io, 'configDir'>): Promise<Credentials> {
  let text: string;
  try {
    text = await readFile(credentialsPath(io), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: {} };
    throw err;
  }
  const parsed = JSON.parse(text) as Partial<Credentials>;
  // A profile saved before commerce commands has no `product`: it is a content profile, and
  // stays one when the file is next written.
  const profiles = Object.fromEntries(
    Object.entries(parsed.profiles ?? {}).map(([name, p]) => [
      name,
      { ...p, product: productOf(p) },
    ]),
  );
  return { current: parsed.current, profiles };
}

export async function writeCredentials(
  io: Pick<Io, 'configDir' | 'platform'>,
  credentials: Credentials,
): Promise<void> {
  await mkdir(io.configDir, { recursive: true, mode: DIR_MODE });
  const path = credentialsPath(io);
  // A fresh temp file each time: `mode` applies only when a file is created.
  // `wx`: never write through a file (or a link) someone else left at that name.
  const temp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: FILE_MODE,
    flag: 'wx',
  });
  await rename(temp, path);
  // Windows has no POSIX modes; the user profile directory is already private there.
  if (io.platform !== 'win32') await chmod(path, FILE_MODE);
}

const LOCK_FILE = 'credentials.lock';
/** A lock this old belongs to a process that died holding it. */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
/** A breaker's gate this old belongs to a breaker that died. */
const LOCK_BREAK_MS = 5_000;

/**
 * Runs `fn` while holding an advisory lock on the credentials (a lockfile created with O_EXCL).
 * Refresh tokens rotate, so two CLI processes that both refresh from the same stored token would
 * spend it twice and sign the person out; whoever holds the lock refreshes, and the rest re-read
 * what it saved. The lock holds a random nonce, and is removed only while it still holds ours. A
 * lock older than the stale window belongs to a dead process: a waiter breaks it by renaming it to
 * a name of its own, so only one waiter wins it. Lock ages are file times, so they use the real
 * clock, not `io.now`.
 */
export async function withCredentialsLock<T>(
  io: Pick<Io, 'configDir' | 'sleep'>,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(io.configDir, { recursive: true, mode: DIR_MODE });
  const path = join(io.configDir, LOCK_FILE);
  const nonce = randomBytes(16).toString('hex');
  const giveUp = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(path, 'wx', FILE_MODE);
      await handle.writeFile(nonce);
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const age = await stat(path).then(
      (s) => Date.now() - s.mtimeMs,
      () => 0,
    );
    if (age > LOCK_STALE_MS) {
      await breakStale(path);
      continue;
    }
    if (Date.now() > giveUp) {
      throw new CliError(
        `Another commerceworker process holds ${path}; if none is running, delete it.`,
        EXIT.failure,
        'credentials_locked',
      );
    }
    await io.sleep(50);
  }
  try {
    return await fn();
  } finally {
    // Ours only: if it was broken as stale meanwhile, the file now belongs to someone else.
    const held = await readFile(path, 'utf8').catch(() => undefined);
    if (held === nonce) await unlink(path).catch(() => undefined);
  }
}

/**
 * Breaks a stale lock. Breakers take turns through a second short-lived lockfile, so only one at a
 * time looks at the lock; it re-checks that the lock is still the stale file it saw, moves it
 * aside under a unique name, and if what it moved is not that file (the lock changed hands in
 * between) puts it back rather than steal a live lock.
 */
async function breakStale(path: string): Promise<void> {
  const gate = `${path}.break`;
  try {
    await (await open(gate, 'wx', FILE_MODE)).close();
  } catch {
    // Another waiter is breaking it. A gate left by a dead breaker ages out.
    const age = await stat(gate).then(
      (s) => Date.now() - s.mtimeMs,
      () => 0,
    );
    if (age > LOCK_BREAK_MS) await unlink(gate).catch(() => undefined);
    return;
  }
  try {
    const seen = await stat(path).catch(() => undefined);
    if (!seen || Date.now() - seen.mtimeMs <= LOCK_STALE_MS) return;
    const aside = `${path}.stale.${randomBytes(8).toString('hex')}`;
    await rename(path, aside).catch(() => undefined);
    const moved = await stat(aside).catch(() => undefined);
    // `link` fails if a lock exists again, which is the answer we want: then drop what we moved.
    if (moved && moved.ino !== seen.ino) await link(aside, path).catch(() => undefined);
    await unlink(aside).catch(() => undefined);
  } finally {
    await unlink(gate).catch(() => undefined);
  }
}

/** On POSIX, a note when others can write to the config dir: they could swap the credentials file. */
export async function configDirWarning(
  io: Pick<Io, 'configDir' | 'platform'>,
): Promise<string | undefined> {
  if (io.platform === 'win32') return undefined;
  const mode = await stat(io.configDir).then(
    (s) => s.mode & 0o777,
    () => undefined,
  );
  if (mode === undefined || (mode & 0o022) === 0) return undefined;
  return `${io.configDir} is writable by others (${mode.toString(8)}); chmod 700 it, since anyone who can write there can replace your credentials.`;
}

/** The file's permission bits, or undefined when there is no file. */
export async function credentialsMode(io: Pick<Io, 'configDir'>): Promise<number | undefined> {
  try {
    return (await stat(credentialsPath(io))).mode & 0o777;
  } catch {
    return undefined;
  }
}

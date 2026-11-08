import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Io } from './io.js';

/**
 * Signed-in deployments, one profile each, in `<config dir>/credentials.json`. The file holds
 * bearer tokens, so it is written owner-only (0600, in a 0700 directory) and replaced atomically:
 * a crash mid-write leaves the old file, never half a token.
 */

export interface Profile {
  /** The deployment's API origin, e.g. https://api.your-workspace.commerceworker.com */
  readonly url: string;
  readonly space: string;
  readonly environment: string;
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
  return { current: parsed.current, profiles: parsed.profiles ?? {} };
}

export async function writeCredentials(
  io: Pick<Io, 'configDir' | 'platform'>,
  credentials: Credentials,
): Promise<void> {
  await mkdir(io.configDir, { recursive: true, mode: DIR_MODE });
  const path = credentialsPath(io);
  // A fresh temp file each time: `mode` applies only when a file is created.
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: FILE_MODE });
  await rename(temp, path);
  // Windows has no POSIX modes; the user profile directory is already private there.
  if (io.platform !== 'win32') await chmod(path, FILE_MODE);
}

/** The file's permission bits, or undefined when there is no file. */
export async function credentialsMode(io: Pick<Io, 'configDir'>): Promise<number | undefined> {
  try {
    return (await stat(credentialsPath(io))).mode & 0o777;
  } catch {
    return undefined;
  }
}

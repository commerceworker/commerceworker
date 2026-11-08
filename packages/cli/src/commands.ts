import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { generateTypes } from '@commerceworker/sdk-codegen';
import type {
  EntryFields,
  ImportAnalysis,
  ImportInput,
  ManagementClient,
} from '@commerceworker/sdk-management';
import {
  credentialsMode,
  FILE_MODE,
  type Profile,
  readCredentials,
  writeCredentials,
} from './credentials.js';
import type { Io } from './io.js';
import { formatOf, loadModel, type Plan, planModel, renderModel, toDrafts } from './model.js';
import {
  type DeviceAuthorization,
  discover,
  pollForToken,
  registerClient,
  revoke,
  startDevice,
} from './oauth.js';
import { CliError, EXIT, pairs, type Result, table, usageError } from './output.js';
import { clientFor, profileName, type Session, type Target, trimUrl, whoAmI } from './session.js';

/** The API version this CLI is written against (`info.version` of the api's `/openapi.json`). */
export const API_VERSION = '0.1.0';

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
}

export interface Command {
  /** One or two words: `spaces`, `entries list`. */
  readonly name: string;
  /** Positional arguments, as shown in usage: `<id>`, `<file>`. */
  readonly args?: string;
  readonly summary: string;
  readonly options: Readonly<Record<string, OptionSpec>>;
  readonly run: (ctx: CommandContext) => Promise<Result>;
}

/** Options every command takes. */
export const GLOBAL_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  json: { type: 'boolean', description: 'Print the result as JSON on stdout' },
  url: { type: 'string', description: 'The deployment’s API origin (default: the profile’s)' },
  space: { type: 'string', description: 'Space id (default: the profile’s, or the token’s)' },
  environment: {
    type: 'string',
    short: 'e',
    description: 'Environment id or alias (default: main)',
  },
  profile: { type: 'string', description: 'Credentials profile (default: the current one)' },
  help: { type: 'boolean', short: 'h', description: 'Show help' },
};

const str = (ctx: CommandContext, key: string) => ctx.values[key] as string | undefined;
const bool = (ctx: CommandContext, key: string) => ctx.values[key] === true;
const list = (ctx: CommandContext, key: string) => (ctx.values[key] as string[] | undefined) ?? [];

function arg(ctx: CommandContext, index: number, name: string): string {
  const value = ctx.args[index];
  if (!value) throw usageError(`Missing ${name}.`);
  return value;
}

function int(ctx: CommandContext, key: string): number | undefined {
  const raw = str(ctx, key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw usageError(`--${key} must be a whole number.`);
  return n;
}

/** A JSON value from the flag itself, or from a file with `@path`. */
async function jsonFlag<T>(ctx: CommandContext, key: string): Promise<T> {
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
async function confirm(ctx: CommandContext, question: string): Promise<void> {
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

const YES: OptionSpec = {
  type: 'boolean',
  short: 'y',
  description: 'Don’t ask for confirmation (required when not on a terminal)',
};

// --- auth --------------------------------------------------------------------

const login: Command = {
  name: 'login',
  summary: 'Sign in to a deployment with the OAuth device flow, or store an API key',
  options: {
    token: {
      type: 'string',
      description: 'Store this API key or personal access token instead of signing in',
    },
    scope: { type: 'string', description: 'Scopes to ask for, space-separated' },
  },
  async run(ctx) {
    const { io, target } = ctx;
    const credentials = await readCredentials(io);
    const name = profileName(target, io, credentials.current);
    const existing = credentials.profiles[name];
    const rawUrl = target.url ?? io.env.COMMERCEWORKER_URL ?? existing?.url;
    if (!rawUrl) throw usageError('Pass --url, the deployment’s API origin.');
    const url = trimUrl(rawUrl);
    const token = str(ctx, 'token');

    let profile: Profile;
    if (token) {
      const me = await whoAmI(io, url, token);
      profile = {
        url,
        space: target.space ?? spaceFrom(me.spaceId),
        environment: target.environment ?? 'main',
        accessToken: token,
        scopes: me.scopes,
        subject: me.subject,
      };
    } else {
      const meta = await discover(io, url);
      let clientId = existing?.url === url ? existing.clientId : undefined;
      clientId ??= await registerClient(io, meta);
      const device = await startDevice(io, meta, clientId, str(ctx, 'scope')).catch(async (err) => {
        // A client from an earlier login may have been deleted: register again, once.
        if (err instanceof CliError && err.code === 'invalid_client' && existing?.clientId) {
          clientId = await registerClient(io, meta);
          return startDevice(io, meta, clientId, str(ctx, 'scope'));
        }
        throw err;
      });
      announce(ctx, device);
      const tokens = await pollForToken(io, meta, clientId, device);
      const me = await whoAmI(io, url, tokens.access_token);
      profile = {
        url,
        space: target.space ?? spaceFrom(me.spaceId),
        environment: target.environment ?? existing?.environment ?? 'main',
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_in ? io.now() + tokens.expires_in * 1000 : undefined,
        clientId,
        scopes: tokens.scope ? tokens.scope.split(' ') : me.scopes,
        subject: me.subject,
      };
    }
    const latest = await readCredentials(io);
    await writeCredentials(io, {
      current: name,
      profiles: { ...latest.profiles, [name]: profile },
    });
    const summary = {
      profile: name,
      url,
      space: profile.space,
      environment: profile.environment,
      subject: profile.subject,
      scopes: profile.scopes,
      method: token ? 'token' : 'device',
    };
    return {
      json: summary,
      human: `Signed in to ${url} (space ${profile.space}).\n${pairs(summary)}`,
    };
  },
};

function spaceFrom(spaceId: string): string {
  if (spaceId === '*') {
    throw usageError('This token reaches every space: pass --space.');
  }
  return spaceId;
}

/** Tells the person where to approve. Always stderr: stdout is the command's result. */
function announce(ctx: CommandContext, device: DeviceAuthorization) {
  const url = device.verification_uri_complete ?? device.verification_uri;
  if (ctx.json) {
    ctx.io.stderr(
      JSON.stringify({
        event: 'device_authorization',
        verificationUri: url,
        userCode: device.user_code,
        expiresIn: device.expires_in,
      }),
    );
  } else {
    ctx.io.stderr(
      `Open ${url}\nand confirm the code ${device.user_code} (it expires in ${Math.round(device.expires_in / 60)} minutes). Waiting…`,
    );
  }
}

const logout: Command = {
  name: 'logout',
  summary: 'Revoke the stored tokens and forget the profile',
  options: {},
  async run({ io, target }) {
    const credentials = await readCredentials(io);
    const name = profileName(target, io, credentials.current);
    const profile = credentials.profiles[name];
    if (!profile) {
      return { json: { profile: name, removed: false }, human: `No profile "${name}".` };
    }
    let revoked = false;
    // Only tokens this CLI obtained: a stored API key belongs to whoever minted it.
    if (profile.refreshToken) {
      const meta = await discover(io, profile.url).catch(() => undefined);
      if (meta) {
        revoked = await revoke(io, meta, profile.clientId, profile.refreshToken);
        await revoke(io, meta, profile.clientId, profile.accessToken);
      }
    }
    const { [name]: _gone, ...rest } = credentials.profiles;
    await writeCredentials(io, {
      current: credentials.current === name ? Object.keys(rest)[0] : credentials.current,
      profiles: rest,
    });
    return {
      json: { profile: name, removed: true, revoked },
      human: `Signed out of ${profile.url} (profile ${name}).`,
    };
  },
};

const whoami: Command = {
  name: 'whoami',
  summary: 'Show who the token is, where it points and what it may do',
  options: {},
  async run(ctx) {
    const session = await ctx.session();
    const me = await whoAmI(ctx.io, session.url, session.token);
    const out = {
      url: session.url,
      space: session.space,
      environment: session.environment,
      source: session.source,
      kind: me.kind,
      subject: me.subject,
      scopes: me.scopes,
      restricted: me.restricted,
      expiresAt: session.profile?.expiresAt
        ? new Date(session.profile.expiresAt).toISOString()
        : undefined,
    };
    return { json: out, human: pairs(out) };
  },
};

const spaces: Command = {
  name: 'spaces',
  summary: 'List the spaces the token can reach',
  options: {},
  async run(ctx) {
    const items = await (await ctx.client()).spaces.list();
    return { json: { items }, human: table(items, ['id', 'name']) };
  },
};

// --- model -------------------------------------------------------------------

const modelExport: Command = {
  name: 'model export',
  summary: 'Write the content model to a JSON or TypeScript file',
  options: {
    out: {
      type: 'string',
      short: 'o',
      description: 'File to write (.json or .ts); stdout if absent',
    },
    format: { type: 'string', description: 'json or ts (default: from --out, else json)' },
  },
  async run(ctx) {
    const drafts = toDrafts(await (await ctx.client()).contentTypes.list());
    const out = str(ctx, 'out');
    const format = (str(ctx, 'format') ?? (out ? formatOf(out) : 'json')) as 'json' | 'ts';
    if (format !== 'json' && format !== 'ts') throw usageError('--format is json or ts.');
    if (!out) {
      // With --json the model itself is the result; otherwise the file's text.
      return { json: { contentTypes: drafts }, human: renderModel(drafts, format).trimEnd() };
    }
    await writeFile(resolve(ctx.io.cwd, out), renderModel(drafts, format), 'utf8');
    return {
      json: { path: out, format, contentTypes: drafts.length },
      human: `Wrote ${drafts.length} content type(s) to ${out}.`,
    };
  },
};

const modelApply: Command = {
  name: 'model apply',
  args: '<file>',
  summary: 'Show what a model file changes, then make the space match it',
  options: {
    'dry-run': { type: 'boolean', description: 'Show the plan and change nothing' },
    'allow-destructive': {
      type: 'boolean',
      description: 'Apply changes that remove fields or block types or reshape stored values',
    },
    publish: {
      type: 'boolean',
      description: 'Publish each changed type (default; --no-publish leaves drafts)',
    },
    yes: YES,
  },
  async run(ctx) {
    const file = arg(ctx, 0, '<file>');
    const desired = await loadModel(file, ctx.io.cwd);
    const cma = await ctx.client();
    const plan = planModel(desired, await cma.contentTypes.list());
    const shown = planJson(plan);
    if (bool(ctx, 'dry-run') || plan.changes === 0) {
      return { json: { ...shown, applied: false }, human: renderPlan(plan) };
    }
    if (plan.destructive > 0 && !bool(ctx, 'allow-destructive')) {
      throw new CliError(
        `${renderPlan(plan)}\n\nRefused: ${plan.destructive} destructive change(s). ` +
          'Re-run with --allow-destructive to apply them.',
        EXIT.refused,
        'destructive_change',
        shown,
      );
    }
    const session = await ctx.session();
    if (!ctx.json) ctx.io.stderr(renderPlan(plan));
    await confirm(
      ctx,
      `Apply ${plan.changes} change(s) to ${session.space}/${session.environment}?`,
    );
    const publish = ctx.values.publish !== false;
    const applied: { apiId: string; action: string; version: number; published: boolean }[] = [];
    for (const t of plan.types) {
      if (t.action === 'unchanged') continue;
      try {
        const saved = await cma.contentTypes.create(t.draft);
        const done = publish ? await cma.contentTypes.publish(t.apiId) : saved;
        applied.push({
          apiId: t.apiId,
          action: t.action,
          version: done.version,
          published: publish,
        });
      } catch (err) {
        // Nothing applied yet: the API's own error (status, code) says it best.
        if (applied.length === 0) throw err;
        // Otherwise what applied stays applied; say so, so a re-run's plan makes sense.
        throw new CliError(
          `${t.apiId}: ${(err as Error).message} (already applied: ${applied.map((a) => a.apiId).join(', ')})`,
          EXIT.failure,
          'apply_failed',
          {
            applied,
            failed: t.apiId,
            status: (err as { status?: number }).status,
            error: (err as { body?: unknown }).body,
          },
        );
      }
    }
    return {
      json: { ...shown, applied: true, results: applied },
      human: `Applied:\n${table(applied, ['apiId', 'action', 'version', 'published'])}`,
    };
  },
};

function planJson(plan: Plan) {
  return {
    changes: plan.changes,
    destructive: plan.destructive,
    types: plan.types.map(({ apiId, action, changes }) => ({ apiId, action, changes })),
    untouched: plan.untouched,
  };
}

export function renderPlan(plan: Plan): string {
  if (plan.changes === 0) return 'No changes: the space matches the file.';
  const lines: string[] = [];
  for (const t of plan.types) {
    if (t.action === 'unchanged') continue;
    lines.push(`${t.action === 'create' ? '+' : '~'} ${t.apiId}`);
    for (const c of t.changes) {
      const mark = c.destructive
        ? '!'
        : c.kind.startsWith('add')
          ? '+'
          : c.kind.startsWith('remove')
            ? '-'
            : '~';
      lines.push(`    ${mark} ${c.path}: ${c.detail}`);
    }
  }
  lines.push(
    '',
    `${plan.changes} change(s), ${plan.destructive} destructive (!).` +
      (plan.untouched.length ? ` Not in the file, left alone: ${plan.untouched.join(', ')}.` : ''),
  );
  return lines.join('\n');
}

// --- entries -----------------------------------------------------------------

const entriesList: Command = {
  name: 'entries list',
  summary: 'List entries as they are now, drafts included',
  options: {
    'content-type': { type: 'string', description: 'Only entries of this type' },
    locale: { type: 'string', description: 'Resolve fields to this locale' },
    limit: { type: 'string', description: 'Page size, at most 100' },
    skip: { type: 'string', description: 'Entries to skip' },
    order: { type: 'string', description: 'Sort keys, e.g. -sys.updatedAt' },
    query: { type: 'string', description: 'Full-text match' },
  },
  async run(ctx) {
    const page = await (await ctx.client()).entries.list({
      contentType: str(ctx, 'content-type'),
      locale: str(ctx, 'locale'),
      limit: int(ctx, 'limit'),
      skip: int(ctx, 'skip'),
      order: str(ctx, 'order'),
      query: str(ctx, 'query'),
    });
    return {
      json: page,
      human: table(page.items, ['id', 'contentType', 'status', 'version']),
    };
  },
};

const entriesGet: Command = {
  name: 'entries get',
  args: '<id>',
  summary: 'Show one entry and its draft fields',
  options: {},
  async run(ctx) {
    const view = await (await ctx.client()).entries.get(arg(ctx, 0, '<id>'));
    return { json: view, human: `${pairs(view.entry)}\n\n${JSON.stringify(view.fields, null, 2)}` };
  },
};

const FIELDS: OptionSpec = {
  type: 'string',
  description: 'Field values as JSON, keyed by field then locale; @file reads a file',
};

const entriesCreate: Command = {
  name: 'entries create',
  summary: 'Create a draft entry',
  options: {
    'content-type': { type: 'string', description: 'The content type’s apiId (required)' },
    fields: FIELDS,
  },
  async run(ctx) {
    const contentTypeApiId = str(ctx, 'content-type');
    if (!contentTypeApiId) throw usageError('--content-type is required.');
    const fields = str(ctx, 'fields') ? await jsonFlag<EntryFields>(ctx, 'fields') : {};
    const view = await (await ctx.client()).entries.create({ contentTypeApiId, fields });
    return {
      json: view,
      human: `Created ${view.entry.id} (draft, version ${view.entry.currentVersion}).`,
    };
  },
};

const entriesUpdate: Command = {
  name: 'entries update',
  args: '<id>',
  summary: 'Save a new draft version with these field values',
  options: {
    fields: FIELDS,
    replace: {
      type: 'boolean',
      description:
        'Replace every field (default: merge into the current draft by field and locale)',
    },
  },
  async run(ctx) {
    const id = arg(ctx, 0, '<id>');
    const given = await jsonFlag<EntryFields>(ctx, 'fields');
    const cma = await ctx.client();
    // The API saves the whole draft: merging here keeps fields and locales the flag didn't name.
    const fields = bool(ctx, 'replace')
      ? given
      : mergeFields((await cma.entries.get(id)).fields, given);
    const view = await cma.entries.update(id, fields);
    return { json: view, human: `Saved ${id} (version ${view.entry.currentVersion}).` };
  },
};

export function mergeFields(current: EntryFields, patch: EntryFields): EntryFields {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(current)) out[k] = { ...v };
  for (const [k, v] of Object.entries(patch)) out[k] = { ...(out[k] ?? {}), ...v };
  return out;
}

/** What `POST …/bulk/entries/publish` takes in one request. */
const BULK_PUBLISH_MAX = 1000;

const entriesPublish: Command = {
  name: 'entries publish',
  args: '<id...>',
  summary: 'Publish the current draft of one entry, or of up to 1,000 at once',
  options: {
    'expected-version': {
      type: 'string',
      description: 'One entry only: refuse (409) if the draft is no longer this version',
    },
  },
  async run(ctx) {
    const ids = [...ctx.args];
    if (ids.length === 0) throw usageError('Missing <id>.');
    const expectedVersion = int(ctx, 'expected-version');
    const cma = await ctx.client();
    if (ids.length === 1) {
      const id = ids[0] as string;
      const entry = await cma.entries.publish(
        id,
        expectedVersion === undefined ? undefined : { expectedVersion },
      );
      return { json: entry, human: `Published ${id} (version ${entry.publishedVersion}).` };
    }
    if (expectedVersion !== undefined) {
      throw usageError('--expected-version holds one entry; publish the others without it.');
    }
    if (ids.length > BULK_PUBLISH_MAX) {
      throw usageError(
        `At most ${BULK_PUBLISH_MAX} ids at once; for more, start a bulk job (POST …/bulk/jobs).`,
      );
    }
    const summary = await cma.entries.bulkPublish(ids);
    const failed = summary.results.filter((r) => !r.ok);
    return {
      json: summary,
      human: [
        `Published ${summary.succeeded} of ${summary.total}.`,
        ...failed.map((r) => `${r.id}: ${r.error ?? 'failed'}`),
      ].join('\n'),
      // Some published and some didn't: the caller has to look.
      exitCode: summary.failed > 0 ? EXIT.failure : EXIT.ok,
    };
  },
};

// --- assets ------------------------------------------------------------------

const MIME: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
};

const assetsUpload: Command = {
  name: 'assets upload',
  args: '<file>',
  summary: 'Upload a file as a new asset (multipart above 100 MiB)',
  options: {
    title: { type: 'string', description: 'Title, in --locale' },
    locale: { type: 'string', description: 'Locale for --title (default en-US)' },
    folder: { type: 'string', description: 'Folder id to file it in' },
    mime: { type: 'string', description: 'Media type (default: from the file extension)' },
    publish: { type: 'boolean', description: 'Publish it once uploaded' },
  },
  async run(ctx) {
    const file = arg(ctx, 0, '<file>');
    const body = new Uint8Array(await readFile(resolve(ctx.io.cwd, file)));
    const contentType =
      str(ctx, 'mime') ?? MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const title = str(ctx, 'title');
    const folderId = str(ctx, 'folder');
    const cma = await ctx.client();
    let asset = await cma.assets.upload({
      fileName: basename(file),
      contentType,
      body,
      ...(title ? { title: { [str(ctx, 'locale') ?? 'en-US']: title } } : {}),
      ...(folderId ? { folderId } : {}),
    });
    if (bool(ctx, 'publish')) asset = await cma.assets.publish(asset.id);
    return {
      json: asset,
      human: `Uploaded ${basename(file)} as ${asset.id} (${asset.status}, ${body.byteLength} bytes).`,
    };
  },
};

// --- import ------------------------------------------------------------------

const SOURCE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.csv': 'csv',
  '.json': 'json',
  '.xml': 'wxr',
  '.wxr': 'wxr',
};

/** `a=b` pairs from a repeatable flag. */
function keyValues(ctx: CommandContext, key: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of list(ctx, key)) {
    const at = pair.indexOf('=');
    if (at <= 0) throw usageError(`--${key} takes name=value, got "${pair}".`);
    out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}

const importCommand: Command = {
  name: 'import',
  args: '<file>',
  summary: 'Import a CSV, JSON or WXR file into one content type, as drafts',
  options: {
    source: { type: 'string', description: 'csv, json or wxr (default: from the extension)' },
    'content-type': { type: 'string', description: 'The content type records become (required)' },
    map: {
      type: 'string',
      multiple: true,
      description: 'targetField=sourceField, repeated; none lists the source fields',
    },
    identity: {
      type: 'string',
      description: 'Target field holding each record’s source id (makes re-runs update)',
    },
    locale: { type: 'string', description: 'Locale values are written under' },
    conflicts: { type: 'string', description: 'skip (default), update or fail' },
    option: {
      type: 'string',
      multiple: true,
      description: 'Source option name=value, repeated (e.g. postType=page for WXR)',
    },
    'dry-run': { type: 'boolean', description: 'Analyze only: report what would happen' },
    job: { type: 'boolean', description: 'Run as a durable job (for large files)' },
    yes: YES,
  },
  async run(ctx) {
    const file = arg(ctx, 0, '<file>');
    const source = str(ctx, 'source') ?? SOURCE_BY_EXTENSION[extname(file).toLowerCase()];
    if (!source) throw usageError('Can’t tell the format from the extension: pass --source.');
    const contentTypeApiId = str(ctx, 'content-type');
    if (!contentTypeApiId) throw usageError('--content-type is required.');
    const conflicts = str(ctx, 'conflicts');
    if (conflicts && !['skip', 'update', 'fail'].includes(conflicts)) {
      throw usageError('--conflicts is skip, update or fail.');
    }
    const options = keyValues(ctx, 'option');
    const input: ImportInput = {
      source,
      payload: await readFile(resolve(ctx.io.cwd, file), 'utf8'),
      mapping: {
        contentTypeApiId,
        fields: keyValues(ctx, 'map'),
        ...(str(ctx, 'identity') ? { identityField: str(ctx, 'identity') } : {}),
        ...(str(ctx, 'locale') ? { locale: str(ctx, 'locale') } : {}),
      },
      ...(Object.keys(options).length ? { sourceOptions: options } : {}),
      ...(conflicts ? { conflicts: conflicts as 'skip' | 'update' | 'fail' } : {}),
    };
    const cma = await ctx.client();
    const analysis = await cma.imports.analyze(input);
    const report = renderAnalysis(analysis);
    if (bool(ctx, 'dry-run')) return { json: { analysis, imported: false }, human: report };
    if (!analysis.executable) {
      throw new CliError(
        `${report}\n\nThe mapping blocks the import.`,
        EXIT.failure,
        'not_executable',
        {
          analysis,
        },
      );
    }
    if (!ctx.json) ctx.io.stderr(report);
    await confirm(ctx, `Import ${analysis.willCreate + analysis.willUpdate} record(s)?`);
    if (bool(ctx, 'job')) {
      const started = await cma.imports.start(input);
      return {
        json: { analysis, imported: true, job: started.job },
        human: `Started job ${started.job.id}. Entries arrive as drafts.`,
      };
    }
    const result = await cma.imports.run(input);
    return {
      json: { analysis, imported: true, result },
      human: `Created ${result.created}, updated ${result.updated}, skipped ${result.skipped}, failed ${result.failed.length}. Entries arrive as drafts.`,
    };
  },
};

function renderAnalysis(a: ImportAnalysis): string {
  return [
    pairs({
      contentType: a.contentTypeApiId,
      locale: a.locale,
      records: a.records,
      willCreate: a.willCreate,
      willUpdate: a.willUpdate,
      willSkip: a.willSkip,
      invalid: a.invalid,
      unmappedSourceFields: a.unmappedSourceFields.join(', ') || undefined,
      missingRequiredFields: a.missingRequiredFields.join(', ') || undefined,
      unknownTargetFields: a.unknownTargetFields.join(', ') || undefined,
      executable: a.executable,
    }),
    ...a.warnings.map((w) => `warning: ${w}`),
    ...a.issues.slice(0, 10).map((i) => `${i.externalId}: ${i.messages.join('; ')}`),
  ].join('\n');
}

// --- types -------------------------------------------------------------------

const types: Command = {
  name: 'types',
  summary: 'Generate TypeScript types from the content model',
  options: {
    out: { type: 'string', short: 'o', description: 'File to write; stdout if absent' },
  },
  async run(ctx) {
    const session = await ctx.session();
    const contentTypes = await (await ctx.client()).contentTypes.list();
    const source = generateTypes(contentTypes as unknown as Parameters<typeof generateTypes>[0], {
      banner: `Generated by commerceworker types from ${session.space}/${session.environment}. Do not edit by hand.`,
    });
    const out = str(ctx, 'out');
    if (!out)
      return { json: { source, contentTypes: contentTypes.length }, human: source.trimEnd() };
    await writeFile(resolve(ctx.io.cwd, out), source, 'utf8');
    return {
      json: { path: out, contentTypes: contentTypes.length },
      human: `Wrote ${contentTypes.length} content type(s) to ${out}.`,
    };
  },
};

// --- doctor ------------------------------------------------------------------

export interface Check {
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly detail: string;
}

const doctor: Command = {
  name: 'doctor',
  summary: 'Check sign-in, reachability, the API version and access to the space',
  options: {},
  async run(ctx) {
    const { io } = ctx;
    const checks: Check[] = [];
    const add = (name: string, status: Check['status'], detail: string) =>
      checks.push({ name, status, detail });

    const mode = await credentialsMode(io);
    if (mode !== undefined && io.platform !== 'win32') {
      if (mode & 0o077) {
        add(
          'credentials',
          'fail',
          `credentials.json is readable by others (${mode.toString(8)}); chmod 600 it`,
        );
      } else add('credentials', 'ok', `credentials.json is private (${FILE_MODE.toString(8)})`);
    }

    let session: Session | undefined;
    try {
      session = await ctx.session();
      add(
        'auth',
        'ok',
        `token from ${session.source === 'env' ? 'COMMERCEWORKER_TOKEN' : `profile ${session.source}`}`,
      );
    } catch (err) {
      add('auth', 'fail', (err as Error).message);
    }

    const url = session?.url ?? (ctx.target.url ? trimUrl(ctx.target.url) : undefined);
    if (url) {
      const started = io.now();
      try {
        const res = await io.fetch(`${url}/health`);
        const body = (await res.json().catch(() => ({}))) as {
          status?: string;
          scheduler?: string;
        };
        if (res.ok) {
          add('reachable', 'ok', `${url} answered in ${io.now() - started} ms`);
          if (body.scheduler === 'stale')
            add('scheduler', 'warn', 'the engine’s cron is not ticking');
        } else add('reachable', 'fail', `${url}/health answered ${res.status}`);
      } catch (err) {
        add('reachable', 'fail', `can’t reach ${url}: ${(err as Error).message}`);
      }
      try {
        const res = await io.fetch(`${url}/openapi.json`);
        const version = res.ok
          ? ((await res.json()) as { info?: { version?: string } }).info?.version
          : undefined;
        if (!version) add('api version', 'warn', `no version at ${url}/openapi.json`);
        else if (
          major(version) !== major(API_VERSION) ||
          (major(version) === '0' && minor(version) !== minor(API_VERSION))
        ) {
          add('api version', 'fail', `API ${version}; this CLI is written for ${API_VERSION}`);
        } else add('api version', 'ok', `API ${version} (CLI expects ${API_VERSION})`);
      } catch (err) {
        add('api version', 'warn', (err as Error).message);
      }
    }

    if (session) {
      try {
        const me = await whoAmI(io, session.url, session.token);
        add(
          'token',
          'ok',
          `${me.kind}${me.subject ? ` for ${me.subject}` : ''}; scopes ${me.scopes.join(' ')}`,
        );
        if (session.profile?.expiresAt && session.profile.expiresAt <= io.now()) {
          add('token', 'warn', 'the access token has expired');
        }
      } catch (err) {
        add('token', 'fail', (err as Error).message);
      }
      try {
        const n = (await clientFor(session, io).contentTypes.list()).length;
        add('space', 'ok', `${session.space}/${session.environment}: ${n} content type(s)`);
      } catch (err) {
        add('space', 'fail', `${session.space}/${session.environment}: ${(err as Error).message}`);
      }
    }

    const ok = checks.every((c) => c.status !== 'fail');
    const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' } as const;
    return {
      json: { ok, checks },
      human: checks.map((c) => `${mark[c.status]}  ${c.name}: ${c.detail}`).join('\n'),
      exitCode: ok ? EXIT.ok : EXIT.failure,
    };
  },
};

const major = (v: string) => v.split('.')[0];
const minor = (v: string) => v.split('.')[1];

export const COMMANDS: readonly Command[] = [
  login,
  logout,
  whoami,
  spaces,
  modelExport,
  modelApply,
  entriesList,
  entriesGet,
  entriesCreate,
  entriesUpdate,
  entriesPublish,
  assetsUpload,
  importCommand,
  types,
  doctor,
];

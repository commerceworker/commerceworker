import { type PluginSettings, SecretUnreadableError, type Webhook } from '@commerceworker/domain';
import type {
  ContentStore,
  PluginSettingsRepo,
  SecretSealer,
  StoredSecretColumn,
  StoredSecretRef,
  WebhookRepo,
} from '@commerceworker/ports';
import { secretContext } from './secret-sealer';

/**
 * Secrets at rest, applied at the store seam.
 *
 * `withSealedSecrets` decorates a `ContentStore` so every secret column is
 * sealed on write and opened on read. Use-cases, the MCP tools and the event
 * dispatcher keep seeing plaintext `Webhook`s and plugin settings and never
 * learn the format; the
 * store adapters keep persisting opaque strings and never learn the key. One
 * decorator serves every `ContentStore` implementation (D1, in-memory),
 * so the sealing logic exists exactly once and is testable without a database.
 *
 * `resealSecrets` is the daily sweep: it moves values sealed under
 * `DATA_KEY_PREVIOUS` onto `DATA_KEY` after a key rotation.
 */

function contextFor(ref: StoredSecretRef): string {
  if (ref.column === 'webhooks.secret') return secretContext.webhookSecret(ref.id);
  if (ref.column === 'plugin_settings.secrets') {
    const slash = ref.id.indexOf('/');
    return secretContext.pluginSetting(
      ref.id.slice(0, slash),
      ref.id.slice(slash + 1),
      ref.key ?? '',
    );
  }
  return secretContext.webhookHeader(ref.id, ref.key ?? '');
}

async function mapHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  fn: (value: string, name: string) => Promise<string>,
): Promise<Record<string, string> | undefined> {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name] = await fn(value, name);
  return out;
}

/** Wraps a `WebhookRepo` so the signing secret and every header value are sealed at rest. */
export function sealedWebhookRepo(inner: WebhookRepo, sealer: SecretSealer): WebhookRepo {
  const seal = async (w: Webhook): Promise<Webhook> => {
    const headers = await mapHeaders(w.headers, (v, name) =>
      sealer.seal(v, secretContext.webhookHeader(w.id, name)),
    );
    return {
      ...w,
      secret: await sealer.seal(w.secret, secretContext.webhookSecret(w.id)),
      ...(headers ? { headers } : {}),
    };
  };
  const open = async (w: Webhook): Promise<Webhook> => {
    const headers = await mapHeaders(w.headers, (v, name) =>
      sealer.open(v, secretContext.webhookHeader(w.id, name)),
    );
    return {
      ...w,
      secret: await sealer.open(w.secret, secretContext.webhookSecret(w.id)),
      ...(headers ? { headers } : {}),
    };
  };
  const openAll = (ws: Webhook[]) => Promise.all(ws.map(open));

  return {
    create: async (scope, webhook) => inner.create(scope, await seal(webhook)),
    get: async (scope, id) => {
      const w = await inner.get(scope, id);
      return w ? open(w) : null;
    },
    list: async (scope) => openAll(await inner.list(scope)),
    listByTopic: async (scope, type) => openAll(await inner.listByTopic(scope, type)),
    update: async (scope, webhook) => inner.update(scope, await seal(webhook)),
    delete: (scope, id) => inner.delete(scope, id),
    recordDelivery: (scope, delivery) => inner.recordDelivery(scope, delivery),
    getDelivery: (scope, webhookId, id) => inner.getDelivery(scope, webhookId, id),
    listDeliveries: (scope, webhookId, opts) => inner.listDeliveries(scope, webhookId, opts),
    deleteDeliveriesBefore: (before, limit) => inner.deleteDeliveriesBefore(before, limit),
  };
}

/** Wraps a `PluginSettingsRepo` so every secret setting is sealed at rest, each on its own. */
export function sealedPluginSettingsRepo(
  inner: PluginSettingsRepo,
  sealer: SecretSealer,
): PluginSettingsRepo {
  const each = async (
    p: PluginSettings,
    fn: (value: string, context: string) => Promise<string>,
  ): Promise<PluginSettings> => {
    const secrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(p.secrets)) {
      secrets[key] = await fn(value, secretContext.pluginSetting(p.spaceId, p.pluginId, key));
    }
    return { ...p, secrets };
  };
  return {
    get: async (spaceId, pluginId) => {
      const p = await inner.get(spaceId, pluginId);
      return p ? each(p, (v, c) => sealer.open(v, c)) : null;
    },
    save: async (settings, expectedVersion) =>
      inner.save(await each(settings, (v, c) => sealer.seal(v, c)), expectedVersion),
    delete: (spaceId, pluginId) => inner.delete(spaceId, pluginId),
  };
}

/**
 * Decorates `store` so secrets are sealed on write and opened on read. Every
 * other member — repos, `withTransaction`, adapter extras such as `close` —
 * passes through to the original object untouched. `storedSecrets` stays raw:
 * it is the sweep's view of the sealed values.
 */
export function withSealedSecrets<S extends ContentStore>(store: S, sealer: SecretSealer): S {
  const webhooks = sealedWebhookRepo(store.webhooks, sealer);
  const pluginSettings = sealedPluginSettingsRepo(store.pluginSettings, sealer);
  // A Proxy rather than a spread: the in-memory store is a class instance whose
  // members a spread would detach from their prototype.
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'webhooks') return webhooks;
      if (prop === 'pluginSettings') return pluginSettings;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Every sealed column, in sweep order. */
const SEALED_COLUMNS: readonly StoredSecretColumn[] = [
  'webhooks.secret',
  'webhooks.headers',
  'plugin_settings.secrets',
];

/** Values examined per sweep run by default — bounds one cron tick's work. */
export const DEFAULT_RESEAL_BATCH = 500;
const PAGE_SIZE = 100;
/** Unreadable refs reported per run (the count is always exact). */
const MAX_REPORTED_UNREADABLE = 20;

export interface ResealSecretsSummary {
  /** Values examined (each was not sealed under the current key). */
  readonly examined: number;
  /** Values written back sealed under the current key. */
  readonly resealed: number;
  /** Values that changed between read and write (rotated, or another sweep won): left alone. */
  readonly skipped: number;
  /** Values neither DATA_KEY nor DATA_KEY_PREVIOUS opens. */
  readonly unreadable: number;
  /** Where the unreadable values live (never the values). Capped. */
  readonly unreadableRefs: readonly StoredSecretRef[];
  /**
   * True when the run reached the end of every column within its budget. A
   * complete run with nothing unreadable means no stored value needs
   * DATA_KEY_PREVIOUS any more.
   */
  readonly complete: boolean;
}

/**
 * The reseal sweep. Reads the values NOT sealed under the current key (the
 * store filters on the current key's prefix), opens each under
 * `DATA_KEY_PREVIOUS`, and writes it back sealed under `DATA_KEY` with a compare-and-set, so a secret changed by a
 * user between the read and the write is never overwritten with its old value.
 *
 * Bounded: at most `maxRows` values per run; the next run continues, since
 * resealed values drop out of the scan. Unreadable values are counted and
 * reported but never modified — destroying them would make a lost key
 * unrecoverable.
 */
export async function resealSecrets(
  ctx: { readonly store: ContentStore; readonly sealer: SecretSealer },
  opts: { readonly maxRows?: number } = {},
): Promise<ResealSecretsSummary> {
  const budget = Math.max(1, opts.maxRows ?? DEFAULT_RESEAL_BATCH);
  const prefix = await ctx.sealer.currentPrefix();
  const repo = ctx.store.storedSecrets;
  let examined = 0;
  let resealed = 0;
  let skipped = 0;
  let unreadable = 0;
  const unreadableRefs: StoredSecretRef[] = [];
  let complete = true;

  for (const column of SEALED_COLUMNS) {
    let after: { id: string; key?: string } | undefined;
    for (;;) {
      if (examined >= budget) {
        complete = false;
        break;
      }
      const limit = Math.min(PAGE_SIZE, budget - examined);
      const page = await repo.scan(column, {
        excludePrefix: prefix,
        limit,
        ...(after ? { after } : {}),
      });
      for (const row of page) {
        examined++;
        const context = contextFor(row);
        let next: string;
        try {
          next = await ctx.sealer.seal(await ctx.sealer.open(row.value, context), context);
        } catch (err) {
          if (!(err instanceof SecretUnreadableError)) throw err;
          unreadable++;
          if (unreadableRefs.length < MAX_REPORTED_UNREADABLE) {
            unreadableRefs.push({
              column: row.column,
              id: row.id,
              ...(row.key !== undefined ? { key: row.key } : {}),
            });
          }
          continue;
        }
        if (await repo.replace(row, row.value, next)) resealed++;
        else skipped++;
      }
      const last = page[page.length - 1];
      if (page.length < limit || !last) break;
      after = { id: last.id, ...(last.key !== undefined ? { key: last.key } : {}) };
    }
  }

  return { examined, resealed, skipped, unreadable, unreadableRefs, complete };
}

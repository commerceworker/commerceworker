/**
 * The daily resealing of secrets at rest (see `encryptSecret` in core): every stored secret moves
 * onto the current `DATA_KEY`, values stored before encryption are sealed, and values under
 * `DATA_KEY_PREVIOUS` after a rotation are sealed again under the new key.
 */
import {
  decryptSecret,
  encryptSecret,
  SecretUnreadable,
  sealedWithCurrent,
  secretContext,
} from '@commerceworker/core';
import {
  SEALED_COLUMNS,
  type SealedColumn,
  type SealedSecretStore,
} from '@commerceworker/ports/commerce';

/** What each column's values are sealed for: a value moved to another row won't open. */
export function sealContext(column: SealedColumn, id: string): string {
  switch (column) {
    case 'users.totp_secret':
      return secretContext.totp(id);
    case 'webhook_subscriptions.secret':
    case 'webhook_subscriptions.previous_secret':
      return secretContext.webhookSubscription(id);
    case 'integrations.secret':
    case 'integrations.previous_secret':
      return secretContext.integration(id);
    case 'plugin_secrets.value': {
      const [pluginId, name] = id.split('/') as [string, string];
      return secretContext.plugin(pluginId, name);
    }
  }
}

/**
 * Seals every stored secret under the current key (`keys[0]`). `unreadable` counts values neither
 * key opens (each is logged). Once a sweep has run with both keys and nothing is unreadable,
 * nothing needs the previous key any more. A value that changed while this ran is left to it.
 */
export async function resealSecrets(
  ports: { readonly secrets: SealedSecretStore },
  keys: readonly [string | undefined, string | undefined],
) {
  if (!keys[0]) {
    console.error('DATA_KEY is not set: secrets at rest are not resealed');
    return { resealed: 0, unreadable: 0 };
  }
  let resealed = 0;
  let unreadable = 0;
  for (const column of SEALED_COLUMNS)
    for (const { id, value } of await ports.secrets.values(column)) {
      if (await sealedWithCurrent(keys, value)) continue;
      const context = sealContext(column, id);
      try {
        const plaintext = await decryptSecret(keys, value, context);
        await ports.secrets.replace(
          column,
          id,
          value,
          await encryptSecret(keys, plaintext, context),
        );
        resealed++;
      } catch (err) {
        if (!(err instanceof SecretUnreadable)) throw err;
        console.error(
          `reseal: ${column} for ${id} can't be read with DATA_KEY or DATA_KEY_PREVIOUS`,
        );
        unreadable++;
      }
    }
  return { resealed, unreadable };
}

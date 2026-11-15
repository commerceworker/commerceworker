/**
 * The deployment's human sign-in tables, read and written by the admin web app (apps/studio): people
 * and their deployment role (`member` < `admin`), sessions, two-factor sign-in, passkeys, SCIM
 * groups, the sign-in throttle, password reset codes, workspace settings and the tamper-evident
 * admin audit log. Must match migrations/0002_auth.sql (and 0021_password_resets.sql) column for
 * column and index for index. Content permissions (spaces, roles, scopes) are not here: the api
 * resolves them.
 *
 * The api's own credentials (api_keys, OAuth grants) live in schema.ts; nothing here replaces them.
 */

import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * People with a deployment role (`member` or `admin`; ROLES in apps/studio/app/lib/roles.ts). `password_hash` is PBKDF2 (`pbkdf2:<iter>:<salt>:<hash>`),
 * or `pbkdf2p:…` over the password peppered with `PASSWORD_PEPPER`.
 */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    passwordHash: text('password_hash'),
    /** The identity provider's subject for single sign-on, linked on first SSO sign-in. */
    externalSub: text('external_sub'),
    /** Explicitly linked by an admin during unified-admin migration; independent of OIDC. */
    commerceSubject: text('commerce_subject'),
    createdAt: integer('created_at').notNull(),
    lastLoginAt: integer('last_login_at'),
    disabledAt: integer('disabled_at'),
    /** Authenticator-app secret (base32, stored encrypted), set once two-factor sign-in is on. */
    totpSecret: text('totp_secret'),
    totpEnabledAt: integer('totp_enabled_at'),
    /** The last 30-second step a code was accepted for; older or equal steps are refused. */
    totpLastStep: integer('totp_last_step'),
    /** The password was set by an operator (first or reset); the person must choose their own. */
    passwordChangeDue: integer('password_change_due', { mode: 'boolean' }).notNull().default(false),
    /** When a temporary password stops working; null for one the person chose. */
    passwordExpiresAt: integer('password_expires_at'),
    /** The identity provider's own id for this person, as SCIM provisioning sent it. */
    scimExternalId: text('scim_external_id'),
  },
  (t) => [
    uniqueIndex('users_email').on(t.email),
    uniqueIndex('users_commerce_subject')
      .on(t.commerceSubject)
      .where(sql`${t.commerceSubject} IS NOT NULL`),
    uniqueIndex('users_external_sub').on(t.externalSub).where(sql`${t.externalSub} IS NOT NULL`),
  ],
);

/** Groups the identity provider pushes over SCIM; admins map them to roles. */
export const scimGroups = sqliteTable('scim_groups', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  externalId: text('external_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const scimGroupMembers = sqliteTable(
  'scim_group_members',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => scimGroups.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index('scim_group_members_user').on(t.userId),
  ],
);

/** Signed-in sessions; the cookie holds a random token and only its SHA-256 is stored. */
export const sessions = sqliteTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    /** Last request on this session (updated at most every few minutes); null means `created_at`. */
    lastSeenAt: integer('last_seen_at'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** Last sign-in again at the identity provider for a step-up (`auth_time` checked), or null. */
    reauthAt: integer('reauth_at'),
  },
  (t) => [index('sessions_user').on(t.userId), index('sessions_expires').on(t.expiresAt)],
);

/** One-use two-factor recovery codes, stored as SHA-256; a row is deleted when its code is used. */
export const recoveryCodes = sqliteTable(
  'recovery_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('recovery_codes_user').on(t.userId)],
);

/**
 * A correct password from someone with two-factor on, waiting for their code. The
 * `__Host-cw_2fa` cookie holds a random token; only its SHA-256 is stored.
 */
export const signInChallenges = sqliteTable('sign_in_challenges', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

/**
 * Passkeys (WebAuthn credentials): signing in with one, with user verification, takes the place of
 * a password and code. `id` is the credential id and `public_key` its COSE key, both base64url.
 */
export const passkeys = sqliteTable(
  'passkeys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    publicKey: text('public_key').notNull(),
    /** The authenticator's signature counter; a lower one than stored means a cloned key. */
    counter: integer('counter').notNull().default(0),
    /** JSON array of transports (usb, nfc, ble, internal, hybrid), as the browser reported. */
    transports: text('transports').notNull().default('[]'),
    name: text('name').notNull(),
    /** Synced by a password manager or platform, rather than bound to one device. */
    backedUp: integer('backed_up', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [index('passkeys_user').on(t.userId)],
);

/**
 * The challenge a passkey registration or sign-in must answer, used once. A sign-in's id is the
 * SHA-256 of its cookie; a registration's is `reg:<user id>`.
 */
export const passkeyChallenges = sqliteTable('passkey_challenges', {
  id: text('id').primaryKey(),
  challenge: text('challenge').notNull(),
  userId: text('user_id'),
  expiresAt: integer('expires_at').notNull(),
});

/**
 * Self-service password reset codes (migration 0021). Only `code_hash` is kept: HMAC-SHA256 with
 * `PASSWORD_PEPPER` over the row id and the emailed code. `browser_hash` is the SHA-256 of the
 * nonce in the asking browser's cookie, which a typed code must come from. A code works once
 * (`used_at`), until `expires_at`; its tries are counted in `auth_failures` (`reset-try`). A new
 * code for the person deletes their older rows.
 */
export const passwordResets = sqliteTable(
  'password_resets',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    codeHash: text('code_hash').notNull(),
    browserHash: text('browser_hash').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
  },
  (t) => [
    index('password_resets_user').on(t.userId, t.createdAt),
    index('password_resets_expires').on(t.expiresAt),
  ],
);

/** Settings operators change in the app; `key` names one, e.g. `two_factor_required`. */
export const workspaceSettings = sqliteTable('workspace_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
  /** Who changed it, as the audit trail names them. */
  updatedBy: text('updated_by').notNull(),
});

/** Failed authentication attempts per key in a fixed window; see `throttle.ts` in the web app. */
export const authFailures = sqliteTable('auth_failures', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  windowStart: integer('window_start').notNull(),
});

/**
 * The admin audit log: sign-ins, people, SSO, SCIM and settings changes, written by the web app
 * (`audit.server.ts`) through `appendAudit`. Append-only: the database refuses updates, and deletes
 * of events younger than 90 days (triggers in migration 0002). Each event is sealed into a hash
 * chain (`seq`, `prevHash`, `hash`; `sealAuditRow` in apps/studio/app/lib/audit-chain.ts). Named
 * `admin_audit` so it does not clash with the api's per-space `audit_log`.
 */
export const adminAudit = sqliteTable(
  'admin_audit',
  {
    id: text('id').primaryKey(),
    at: integer('at').notNull(),
    action: text('action').notNull(),
    /** Who acted, as the audit trail names them (email or name); null if nobody signed in. */
    actor: text('actor'),
    actorId: text('actor_id'),
    actorKind: text('actor_kind'),
    /** What it acted on, e.g. a person's email. */
    target: text('target'),
    /** JSON with action-specific fields, e.g. `{ "from": "member", "to": "admin" }`. */
    detail: text('detail'),
    ip: text('ip'),
    /** Its place in the chain, from 1; unique. */
    seq: integer('seq'),
    /** The hash of the event before it, or `genesis` for the first. */
    prevHash: text('prev_hash'),
    hash: text('hash'),
  },
  (t) => [
    index('admin_audit_at').on(t.at),
    index('admin_audit_action').on(t.action, t.at),
    uniqueIndex('admin_audit_seq').on(t.seq),
  ],
);

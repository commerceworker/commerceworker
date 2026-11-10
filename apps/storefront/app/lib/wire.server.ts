/**
 * The storefront's composition root for its own D1 reads: the one place that binds the D1 adapters
 * (@commerceworker/db) to the ports (@commerceworker/ports/commerce), as apps/web/app/lib/wire.server.ts
 * does for the admin. Only agentic checkout's platforms (their keys, by hash) and settings, and the
 * name of the customer a cart is for, are read here; everything else the buyer does goes through
 * the engine. Tests swap a port for its
 * in-memory twin in @commerceworker/test-kit/commerce.
 */
import { env } from 'cloudflare:workers';
import { d1PricingStore } from '@commerceworker/db/pricing-store';
import { d1UcpStore } from '@commerceworker/db/ucp-store';
import { d1WorkspaceStore } from '@commerceworker/db/workspace-store';
import type { Clock } from '@commerceworker/ports';
import type { PricingStore, UcpStore, WorkspaceStore } from '@commerceworker/ports/commerce';

/** Wall-clock time. */
const systemClock: Clock = { now: () => new Date() };

/** Agentic checkout's settings, read from the workspace's. */
export const workspaceStore = (): WorkspaceStore => d1WorkspaceStore(env.DB, systemClock);

/** Agentic checkout's platforms, their keys and profiles. */
export const ucpStore = (): UcpStore => d1UcpStore(env.DB);

/** Customers, for the name a cart's page shows. */
export const pricingStore = (): PricingStore => d1PricingStore(env.DB, systemClock);

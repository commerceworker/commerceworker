/**
 * The public storefront's settings, the admin's part: whether hosted checkout is on, the flow that
 * prices it and whether buyers may change the lines. The storefront reads them through the engine
 * (`StorefrontRpc.storefrontSettings`), which reads the same row on every call; a change made here
 * reaches the storefront within its 30 seconds' cache of them.
 */

import {
  changeStorefrontSettings,
  readStorefrontAdminSettings,
} from '@commerceworker/application/commerce';
import type { StorefrontSettings } from '@commerceworker/core';
import { flowStore, workspaceStore } from './wire.server';

/** The settings as stored, hosted checkout off until an admin turns it on. */
export const storefrontAdmin = () => readStorefrontAdminSettings({ workspace: workspaceStore() });

/** Sets the settings; turning hosted checkout on needs a flow that takes cards. */
export const setStorefrontSettings = (next: StorefrontSettings, by: string) =>
  changeStorefrontSettings({ workspace: workspaceStore(), flows: flowStore() }, next, by);

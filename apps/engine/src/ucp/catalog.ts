/**
 * UCP catalog search and lookup, over REST (`POST /ucp/v1/catalog/{search,lookup,product}`) and MCP
 * (`search_catalog`, `lookup_catalog`, `get_product`): the engine's side. It gates on what the
 * platform negotiated and validates the request; the use-cases (packages/application) read the
 * published catalog through the `CatalogReader` bound in ../wire.ts and map it with core.
 *
 * Read-only, so there is no idempotency key and nothing is stored. A request's `context` and
 * `signals` describe a shopper and may identify one: they are read for the currency and language
 * and go nowhere else, not into a log line or an error.
 */

import {
  getCatalogProduct,
  lookupCatalog,
  searchCatalog,
} from '@commerceworker/application/commerce';
import {
  CATALOG_LOOKUP_CAPABILITY,
  CATALOG_SEARCH_CAPABILITY,
  type UcpCapability,
  type UcpCatalogOp,
  ucpError,
  ucpGetProductInput,
  ucpLookupInput,
  ucpSearchInput,
} from '@commerceworker/core';
import { CatalogEdgeError, catalogReader } from '../wire';
import type { UcpContext, UcpResult } from './checkout';
import { ucpSettings } from './config';

export type CatalogOp = UcpCatalogOp;

/** The capability each operation needs: `get_product` is part of lookup. */
const NEEDS: Record<CatalogOp, UcpCapability> = {
  search_catalog: CATALOG_SEARCH_CAPABILITY,
  lookup_catalog: CATALOG_LOOKUP_CAPABILITY,
  get_product: CATALOG_LOOKUP_CAPABILITY,
};

const refuse = (status: number, code: string, content: string): UcpResult => ({
  status,
  body: ucpError(code, content),
});

/**
 * Whether a request body is declared JSON. The catalog's routes and the MCP binding take only JSON,
 * which is also what lets the storefront read a body for its budget knowing how to read it.
 */
export const isJson = (request: Request) =>
  /^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '');

/** The tags of an Accept-Language header, most preferred first (`q=0` is a refusal). */
export function acceptedLanguages(header: string | null | undefined): string[] {
  return (header ?? '')
    .split(',')
    .slice(0, 20)
    .flatMap((part, i) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(p)?.[1]).find(Boolean);
      const weight = q === undefined ? 1 : Number(q);
      return tag && tag !== '*' && weight > 0 && Number.isFinite(weight)
        ? [{ tag, weight, i }]
        : [];
    })
    .sort((a, b) => b.weight - a.weight || a.i - b.i)
    .map((x) => x.tag);
}

/** Runs one catalog operation for a negotiated platform. `raw` is the request body, parsed. */
export async function catalogCall(
  env: Env,
  ctx: UcpContext,
  op: CatalogOp,
  raw: unknown,
  acceptLanguage: string[] = [],
): Promise<UcpResult> {
  if (!ctx.capabilities.has(NEEDS[op]))
    return refuse(403, 'forbidden', `The platform profile does not support ${NEEDS[op]}.`);
  const settings = await ucpSettings(env);
  // Catalog capabilities are on whenever checkout is, as the storefront and discovery have it.
  if (!settings.checkoutFlowId)
    return refuse(404, 'not_found', 'Agentic checkout is not turned on for this workspace.');
  const ports = { catalog: catalogReader(env) };
  const run = { productUrl: settings.productUrl };
  const invalid = (issue: string | undefined) =>
    refuse(400, 'invalid_request', issue ?? 'Invalid request');
  try {
    switch (op) {
      case 'search_catalog': {
        const input = ucpSearchInput.safeParse(raw);
        return input.success
          ? await searchCatalog(ports, run, input.data, acceptLanguage)
          : invalid(input.error.issues[0]?.message);
      }
      case 'lookup_catalog': {
        const input = ucpLookupInput.safeParse(raw);
        return input.success
          ? await lookupCatalog(ports, run, input.data, acceptLanguage)
          : invalid(input.error.issues[0]?.message);
      }
      default: {
        const input = ucpGetProductInput.safeParse(raw);
        return input.success
          ? await getCatalogProduct(ports, run, input.data, acceptLanguage)
          : invalid(input.error.issues[0]?.message);
      }
    }
  } catch (err) {
    // The edge or the catalog failed: nothing about the request goes in the log.
    if (err instanceof CatalogEdgeError) {
      console.error(err.message);
      return refuse(503, 'catalog_unavailable', 'The catalog is not available right now.');
    }
    throw err;
  }
}

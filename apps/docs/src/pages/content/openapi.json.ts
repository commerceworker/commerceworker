/**
 * The REST API's OpenAPI document, as the API generates it from its own mounted routes
 * (scripts/openapi.ts writes it before each build), so the explorer at /content/api/ matches the code at
 * this commit. Every deployment serves the same document at its own GET /openapi.json.
 */

import type { APIRoute } from 'astro';
import spec from '../../generated/content-openapi.json';

export const prerender = true;

export const GET: APIRoute = () => Response.json(spec);

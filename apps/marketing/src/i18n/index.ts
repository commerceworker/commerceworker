import type { Locale } from '../lib/site';
import { type Copy, en } from './en';
import { es } from './es';

export type { Copy };

/** The copy for a locale. */
export const copy = (locale: Locale): Copy => (locale === 'es' ? es : en);

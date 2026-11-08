/**
 * Copies the Scalar API explorer's browser bundle out of node_modules into public/vendor/, so
 * /api/ loads it from this site rather than a third-party CDN: the version is the one the lockfile
 * pins, the page's CSP needs no external script host, and the explorer works offline in dev.
 * The copy is generated on every build (gitignored), never edited.
 */
import { copyFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
// The package exports no package.json, so find it through this site's own node_modules link.
const pkg = realpathSync(join(site, 'node_modules', '@scalar', 'api-reference'));
const out = join(site, 'public', 'vendor', 'scalar');
mkdirSync(out, { recursive: true });
copyFileSync(join(pkg, 'dist', 'browser', 'standalone.js'), join(out, 'standalone.js'));
console.log('vendor-scalar: public/vendor/scalar/standalone.js');

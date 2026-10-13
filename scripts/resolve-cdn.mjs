/**
 * Node module-resolve hook: an app's browser modules import glen-charts from
 * jsDelivr (https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-charts@<tag>/...).
 * Under Node (precompute) those resolve to this local copy of the library,
 * so the same extension module serves both.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolvePath, dirname } from 'node:path';

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const CDN = /^https:\/\/cdn\.jsdelivr\.net\/gh\/SchmidtDSE\/glen-charts@[^/]+\/(.+)$/;

export async function resolve(specifier, context, next) {
    const m = specifier.match(CDN);
    if (m) return { url: pathToFileURL(resolvePath(ROOT, m[1])).href, shortCircuit: true };
    return next(specifier, context);
}

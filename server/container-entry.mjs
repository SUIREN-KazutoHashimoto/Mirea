// Linux image only. Direct Windows/Node execution continues to use index.js.
import {preflightTrueNas} from './truenas-preflight.mjs';
if (process.env.MIREA_TRUENAS_PREFLIGHT !== undefined) {
  if (process.env.MIREA_TRUENAS_PREFLIGHT !== '1') throw Error('MIREA_TRUENAS_PREFLIGHT must be 1 or unset');
  await preflightTrueNas();
}
await import('./index.js');

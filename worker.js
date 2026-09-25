/**
 * worker.js — the whole site as a single Cloudflare Worker.
 *
 * Same two jobs the local `server.js` does, and the same split: static files
 * come from the asset store, and the one call the browser cannot make for
 * itself — IRSA's frame index, which sends no CORS headers — goes through the
 * relay. Pixels are not involved either way; the browser reads those straight
 * from the S3 mirror by byte range.
 *
 * The relay is the same module the Pages Function uses, so there is one
 * implementation whichever way this is deployed.
 */

import { onRequestGet } from './functions/api/search.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/search') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: { allow: 'GET' } });
      }
      return onRequestGet({
        request,
        env,
        waitUntil: (p) => ctx.waitUntil(p),
      });
    }

    return env.ASSETS.fetch(request);
  },
};

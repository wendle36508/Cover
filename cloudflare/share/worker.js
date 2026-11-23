// worker.js - Cover's share links on Cloudflare (go.covergiving.com). Free plan: 100,000 opens a day.
// Asks Cover's database for the nonprofit's name and photos (share_card), then answers with the
// preview card page from card.js. If the database can't be reached, it still sends people on to
// the sponsor page, so a shared link never dead-ends. Deploy: see README.md next to this file.

import { cardFor, cardHtml, destinationUrl, parseSharePath, SITE } from "./card.js";

async function loadOrg(env, slug) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/share_card`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${env.SUPABASE_PUBLISHABLE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ org_slug: slug }),
  });
  if (!response.ok) throw new Error(`share_card answered ${response.status}`);
  return response.json(); // null when there's no such nonprofit
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Use GET.", { status: 405 });
    const path = parseSharePath(new URL(request.url).pathname);
    if (!path) return Response.redirect(SITE, 302);
    let org;
    try {
      org = await loadOrg(env, path.org);
    } catch (error) {
      console.error("share: couldn't load", path.org, error instanceof Error ? error.message : error);
      return Response.redirect(destinationUrl(path.org), 302);
    }
    if (!org) return Response.redirect(SITE, 302);
    const card = cardFor(org, path.dog);
    return new Response(request.method === "HEAD" ? null : cardHtml(card, org.name), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
    });
  },
};

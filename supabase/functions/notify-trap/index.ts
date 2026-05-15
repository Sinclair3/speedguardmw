// SpeedGuard Malawi — Trap Verification Push Notifier
// Pure Deno crypto — no npm dependencies (avoids boot failures)
// Stores notification in sg_notifications, sends empty push,
// service worker fetches the text and shows the notification.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUB       = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIV      = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT   = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@speedguardmw.com";

const VOTES_TO_VERIFY = 3;
const COOLDOWN_MS     = 24 * 60 * 60 * 1000;

const ZONE_LABEL: Record<string, string> = {
  north:   "Northern M1",
  central: "Central M1",
  south:   "Southern M1",
};

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ── helpers ──────────────────────────────────────────────

function trapZone(km: number): string {
  return km < 400 ? "north" : km < 700 ? "central" : "south";
}

function fromB64url(s: string): Uint8Array {
  return Uint8Array.from(
    atob(s.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0)
  );
}

function toB64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── VAPID JWT (ES256) — pure SubtleCrypto ─────────────────

async function vapidJWT(audience: string): Promise<string> {
  const header  = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 43200,
    sub: VAPID_SUBJECT,
  };

  const enc = (o: object) =>
    toB64url(new TextEncoder().encode(JSON.stringify(o)));

  const unsigned = `${enc(header)}.${enc(payload)}`;

  // Build JWK from raw public (65-byte uncompressed point) + private (32-byte raw)
  const pub = fromB64url(VAPID_PUB);
  const jwk = {
    kty: "EC", crv: "P-256",
    d:   VAPID_PRIV,
    x:   toB64url(pub.slice(1, 33)),
    y:   toB64url(pub.slice(33, 65)),
    key_ops: ["sign"],
  };

  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );

  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned)
  );

  return `${unsigned}.${toB64url(new Uint8Array(sig))}`;
}

// ── Send empty push (payload fetched by SW from sg_notifications) ──

async function sendPush(endpoint: string): Promise<{ ok: boolean; status: number }> {
  const { protocol, host } = new URL(endpoint);
  const jwt = await vapidJWT(`${protocol}//${host}`);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${jwt},k=${VAPID_PUB}`,
      "TTL": "3600",
      "Content-Length": "0",
    },
  });

  return { ok: res.ok, status: res.status };
}

// ── Main handler ─────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    const body = await req.json().catch(() => null);
    if (!body) return new Response("bad request", { status: 400, headers: CORS });

    const trap = body.record ?? body;
    if (!trap?.id) return new Response("no trap", { status: 200, headers: CORS });

    if ((trap.yes_votes ?? 0) < VOTES_TO_VERIFY) {
      return new Response("not verified yet", { status: 200, headers: CORS });
    }

    // 24 h cooldown
    if (trap.last_notified) {
      const age = Date.now() - new Date(trap.last_notified).getTime();
      if (age < COOLDOWN_MS) {
        return new Response("cooldown", { status: 200, headers: CORS });
      }
    }

    const zone = trapZone(trap.km ?? 0);
    const db   = createClient(SUPABASE_URL, SUPABASE_KEY);

    const { data: subs } = await db
      .from("sg_push_subs")
      .select("endpoint")
      .contains("zones", [zone]);

    if (!subs || subs.length === 0) {
      return new Response(`no subs: ${zone}`, { status: 200, headers: CORS });
    }

    // Mark cooldown before sending (prevent double-fire)
    await db.from("sg_traps")
      .update({ last_notified: new Date().toISOString() })
      .eq("id", trap.id);

    // Store notification text — service worker fetches this on wake-up
    await db.from("sg_notifications").insert({
      title: `⚠️ Verified Trap — ${ZONE_LABEL[zone]}`,
      body:  `${trap.name} · km ${trap.km ?? "?"} · ${trap.limit_kmh ?? "?"} km/h zone`,
      zone,
    });

    // Fire empty push to every matching subscriber
    const results = await Promise.allSettled(subs.map((s) => sendPush(s.endpoint)));

    const sent   = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - sent;

    // Remove dead subscriptions (410 Gone)
    const dead = results
      .map((r, i) =>
        r.status === "rejected" ||
        (r.status === "fulfilled" && (r.value as any).status === 410)
          ? subs[i].endpoint : null
      )
      .filter(Boolean) as string[];

    if (dead.length) {
      await db.from("sg_push_subs").delete().in("endpoint", dead);
    }

    console.log(`${trap.name} | zone=${zone} | sent=${sent} failed=${failed}`);
    return new Response(
      JSON.stringify({ trap: trap.name, zone, sent, failed }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("notify-trap:", err);
    return new Response(String(err), { status: 500, headers: CORS });
  }
});

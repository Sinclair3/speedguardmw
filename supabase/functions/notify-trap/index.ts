// SpeedGuard Malawi — Trap Verification Push Notifier
// Triggered by Supabase DB webhook on sg_traps UPDATE
// Sends zone-filtered Web Push when a trap reaches 3 confirmations

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// @deno-types="npm:@types/web-push"
import webpush from "npm:web-push";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUB     = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIV    = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@speedguardmw.com";

const VOTES_TO_VERIFY = 3;
const COOLDOWN_MS     = 24 * 60 * 60 * 1000; // 24 hours

const ZONE_LABEL: Record<string, string> = {
  north:   "Northern M1",
  central: "Central M1",
  south:   "Southern M1",
};

function trapZone(km: number): string {
  if (km < 400) return "north";
  if (km < 700) return "central";
  return "south";
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUB, VAPID_PRIV);

serve(async (req) => {
  try {
    const payload = await req.json().catch(() => null);
    if (!payload) return new Response("bad request", { status: 400 });

    // Supabase webhook: { type, table, schema, record, old_record }
    const trap = payload.record ?? payload; // handle direct calls too
    if (!trap?.id) return new Response("no trap record", { status: 200 });

    // Only fire when yes_votes just reached the threshold
    if ((trap.yes_votes ?? 0) < VOTES_TO_VERIFY) {
      return new Response("not yet verified", { status: 200 });
    }

    // 24-hour cooldown — don't spam the same trap
    if (trap.last_notified) {
      const age = Date.now() - new Date(trap.last_notified).getTime();
      if (age < COOLDOWN_MS) {
        return new Response("cooldown active", { status: 200 });
      }
    }

    const zone = trapZone(trap.km ?? 0);
    const db   = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Get all subscribers who want alerts for this zone
    const { data: subs, error: subErr } = await db
      .from("sg_push_subs")
      .select("endpoint, p256dh, auth")
      .contains("zones", [zone]);

    if (subErr) {
      console.error("Subscriber fetch error:", subErr.message);
      return new Response("db error", { status: 500 });
    }

    if (!subs || subs.length === 0) {
      return new Response(`no subscribers for zone: ${zone}`, { status: 200 });
    }

    // Mark last_notified immediately to prevent double-fire
    await db.from("sg_traps")
      .update({ last_notified: new Date().toISOString() })
      .eq("id", trap.id);

    const notification = JSON.stringify({
      title: `⚠️ Verified Trap — ${ZONE_LABEL[zone]}`,
      body:  `${trap.name} · km ${trap.km ?? "?"} · ${trap.limit_kmh ?? "?"} km/h zone`,
      icon:  "/icon-192.png",
      badge: "/icon-96.png",
      data:  { url: "/" },
    });

    // Send push to every matching subscriber
    const results = await Promise.allSettled(
      subs.map((sub) =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          notification,
          { TTL: 3600 }
        )
      )
    );

    const sent   = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - sent;

    // Clean up dead subscriptions (push service returned 410 Gone)
    const deadEndpoints = results
      .map((r, i) =>
        r.status === "rejected" && (r.reason as any)?.statusCode === 410
          ? subs[i].endpoint
          : null
      )
      .filter(Boolean) as string[];

    if (deadEndpoints.length > 0) {
      await db.from("sg_push_subs")
        .delete()
        .in("endpoint", deadEndpoints);
      console.log(`Removed ${deadEndpoints.length} dead subscription(s)`);
    }

    console.log(`Trap "${trap.name}" · zone=${zone} · sent=${sent} · failed=${failed}`);
    return new Response(
      JSON.stringify({ trap: trap.name, zone, sent, failed }),
      { headers: { "Content-Type": "application/json" }, status: 200 }
    );

  } catch (err) {
    console.error("notify-trap error:", err);
    return new Response(String(err), { status: 500 });
  }
});

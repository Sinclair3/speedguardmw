// Pansewu AI — OpenRouter proxy (server-side key, no user setup needed)

const OPENROUTER_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const AI_MODEL       = "google/gemma-4-26b-a4b-it:free";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    const body = await req.json().catch(() => null);
    if (!body?.messages) {
      return new Response("missing messages", { status: 400, headers: CORS });
    }

    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "Content-Type":  "application/json",
        "HTTP-Referer":  "https://sinclair3.github.io/speedguardmw",
        "X-Title":       "Pansewu AI",
      },
      body: JSON.stringify({
        model:       AI_MODEL,
        messages:    body.messages,
        max_tokens:  512,
        temperature: 0.4,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("OpenRouter error:", JSON.stringify(data));
      return new Response(JSON.stringify(data), { status: res.status, headers: CORS });
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("ai-chat:", err);
    return new Response(String(err), { status: 500, headers: CORS });
  }
});

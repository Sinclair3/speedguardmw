// Pansewu AI — OpenRouter proxy (server-side key, no user setup needed)

const OPENROUTER_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Ordered list — tries each until one succeeds
const FREE_MODELS = [
  "qwen/qwen3-14b:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "liquid/lfm-2.5-1.2b-instruct:free",
  "google/gemma-4-26b-a4b-it:free",
];

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

    let lastError: any = null;

    for (const model of FREE_MODELS) {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_KEY}`,
          "Content-Type":  "application/json",
          "HTTP-Referer":  "https://sinclair3.github.io/speedguardmw",
          "X-Title":       "Pansewu AI",
        },
        body: JSON.stringify({
          model,
          messages:    body.messages,
          max_tokens:  512,
          temperature: 0.4,
        }),
      });

      const data = await res.json();

      if (res.ok && data.choices?.[0]?.message) {
        console.log(`Served by: ${model}`);
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      // 429 or 503 — try next model
      lastError = data;
      console.warn(`${model} failed (${res.status}), trying next...`);
    }

    // All models failed
    console.error("All models failed:", JSON.stringify(lastError));
    return new Response(JSON.stringify(lastError), { status: 429, headers: CORS });

  } catch (err) {
    console.error("ai-chat:", err);
    return new Response(String(err), { status: 500, headers: CORS });
  }
});

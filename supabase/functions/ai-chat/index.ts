// Pansewu AI — Groq proxy (server-side key, no user setup needed)
// Calls Groq chat completions and streams the response back.

const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY")!;
const GROQ_URL     = "https://api.groq.com/openai/v1/chat/completions";
const AI_MODEL     = "llama-3.1-8b-instant";

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

    const groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        model:       AI_MODEL,
        messages:    body.messages,
        max_tokens:  512,
        temperature: 0.4,
      }),
    });

    if (!groqRes.ok) {
      const err = await groqRes.text();
      console.error("Groq error:", err);
      return new Response(err, { status: groqRes.status, headers: CORS });
    }

    const data = await groqRes.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("ai-chat:", err);
    return new Response(String(err), { status: 500, headers: CORS });
  }
});

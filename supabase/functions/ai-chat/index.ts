// Pansewu AI — Google Gemini proxy (server-side key, no user setup needed)

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

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

    // Convert OpenAI-style messages to Gemini format
    const systemMsg = body.messages.find((m: any) => m.role === "system");
    const chatMsgs  = body.messages.filter((m: any) => m.role !== "system");

    const contents = chatMsgs.map((m: any) => ({
      role:  m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const geminiBody: any = {
      contents,
      generationConfig: {
        maxOutputTokens: 512,
        temperature:     0.4,
      },
    };

    if (systemMsg) {
      geminiBody.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }

    const res = await fetch(GEMINI_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(geminiBody),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Gemini error:", err);
      return new Response(err, { status: res.status, headers: CORS });
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    // Return in OpenAI-compatible shape so frontend needs no changes
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: text } }]
    }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("ai-chat:", err);
    return new Response(String(err), { status: 500, headers: CORS });
  }
});

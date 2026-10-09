export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // Make GET show something useful in the preview
    if (request.method === "GET") {
      return new Response("OK. Send POST JSON: {\"messages\":[{\"role\":\"user\",\"content\":\"...\"}]}", {
        headers: cors,
      });
    }

    if (request.method !== "POST") {
      return new Response("Use POST", { status: 405, headers: cors });
    }

    const { messages } = await request.json();

    const body = {
      model: "gpt-4.1-mini",
instructions:
  "You are an assistant for Sergey Alexeev's personal website. " +
  "Use the uploaded CV/cover letters as the source of truth. " +
  "Answer in 3–6 bullet points. " +
  "For each answer: (1) state whether Sergey has done similar work, (2) name relevant methods/tools, (3) list 1–3 concrete examples from the documents, (4) state what info you’d need from the employer/client. " +
  "If the documents do not support a claim, say you don't know and suggest contacting Sergey.",
      input: messages,
      tools: [
        {
          type: "file_search",
          vector_store_ids: [env.VECTOR_STORE_ID],
          max_num_results: 8,
        },
      ],
    };

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const raw = await r.text();
    if (!r.ok) return new Response(raw, { status: 500, headers: cors });

    const data = JSON.parse(raw);
    const msg = (data.output || []).find((x) => x.type === "message");
    const answer = (msg?.content || [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("")
      .trim();

    return new Response(JSON.stringify({ text: answer }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};

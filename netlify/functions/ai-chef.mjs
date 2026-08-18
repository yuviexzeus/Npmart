/* ═══════════════════════════════════════════════════════════════════
   NP MART — AI CHEF SERVER-SIDE PROXY
   ───────────────────────────────────────────────────────────────────
   Keeps API keys OFF the public page. The browser calls /api/ai-chef
   and never sees a key, so Google/OpenRouter leaked-key scanners can
   no longer auto-revoke them.

   REQUIRED Netlify environment variables (Site config > Environment
   variables). Scope must include "Functions". Variables set inside
   netlify.toml are NOT available to functions — use the Netlify UI.

     OPENROUTER_API_KEY   (optional)  e.g. sk-or-v1-...
     GEMINI_API_KEY       (optional)  e.g. AQ.Ab... or AIza...

   Set at least one. If both are set, OpenRouter is tried first and
   Gemini is the fallback.

   NOTE: env values are baked in at deploy time. After adding or
   changing a variable you MUST trigger a new deploy.
   ═══════════════════════════════════════════════════════════════════ */

/* Overall budget. Netlify kills a synchronous function around 10s,
   so we stop trying new providers once we pass this mark. */
const TOTAL_BUDGET_MS = 8500;
const PER_ATTEMPT_MS = 6000;

/* OpenRouter free-tier slugs. The free roster rotates often — if all
   of these start failing, check https://openrouter.ai/models with the
   "free" filter and update this list. */
const OPENROUTER_MODELS = [
  "openrouter/free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "openai/gpt-oss-20b:free"
];

/* Gemini models on the generateContent endpoint. */
const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite"
];

function timeoutSignal(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(t) };
}

async function callOpenRouter(apiKey, prompt, model, siteUrl) {
  const { signal, clear } = timeoutSignal(PER_ATTEMPT_MS);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
        // Optional OpenRouter attribution headers.
        "HTTP-Referer": siteUrl || "https://npmarttest.netlify.app",
        "X-Title": "NP Mart AI Chef"
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 1200
      })
    });

    const bodyText = await res.text();

    if (!res.ok) {
      return { ok: false, status: res.status, detail: bodyText.slice(0, 400) };
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return { ok: false, status: res.status, detail: "Non-JSON body from OpenRouter" };
    }

    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      return { ok: false, status: res.status, detail: "Empty content in OpenRouter response" };
    }
    return { ok: true, text };
  } catch (err) {
    const isAbort = err?.name === "AbortError";
    return { ok: false, status: isAbort ? 504 : 0, detail: isAbort ? "Timed out" : String(err?.message || err) };
  } finally {
    clear();
  }
}

async function callGemini(apiKey, prompt, model) {
  const { signal, clear } = timeoutSignal(PER_ATTEMPT_MS);
  try {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) + ":generateContent";

    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        // Native endpoint + x-goog-api-key works with BOTH the legacy
        // AIza standard keys and the newer AQ. auth keys.
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1200,
          // Forces clean JSON so the client never has to regex it out
          // of a Markdown code fence.
          responseMimeType: "application/json"
        }
      })
    });

    const bodyText = await res.text();

    if (!res.ok) {
      return { ok: false, status: res.status, detail: bodyText.slice(0, 400) };
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return { ok: false, status: res.status, detail: "Non-JSON body from Gemini" };
    }

    const parts = data?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts)
      ? parts.map(p => p?.text || "").join("").trim()
      : "";

    if (!text) {
      const blocked = data?.promptFeedback?.blockReason
        || data?.candidates?.[0]?.finishReason
        || "Empty content in Gemini response";
      return { ok: false, status: res.status, detail: String(blocked) };
    }
    return { ok: true, text };
  } catch (err) {
    const isAbort = err?.name === "AbortError";
    return { ok: false, status: isAbort ? 504 : 0, detail: isAbort ? "Timed out" : String(err?.message || err) };
  } finally {
    clear();
  }
}

export default async (req) => {
  const startedAt = Date.now();
  const budgetLeft = () => TOTAL_BUDGET_MS - (Date.now() - startedAt);

  let payload;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ ok: false, error: "bad_request", message: "Body must be JSON." }, { status: 400 });
  }

  const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt) {
    return Response.json({ ok: false, error: "bad_request", message: "Missing 'prompt'." }, { status: 400 });
  }
  if (prompt.length > 12000) {
    return Response.json({ ok: false, error: "bad_request", message: "Prompt too long." }, { status: 413 });
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const siteUrl = process.env.URL;

  if (!openrouterKey && !geminiKey) {
    return Response.json({
      ok: false,
      error: "not_configured",
      message: "No AI provider key is set. Add OPENROUTER_API_KEY and/or GEMINI_API_KEY in Netlify (scope: Functions), then redeploy."
    }, { status: 503 });
  }

  // Every failure is recorded so the real reason is visible in the
  // Netlify function log and in the JSON response.
  const attempts = [];

  if (openrouterKey) {
    for (const model of OPENROUTER_MODELS) {
      if (budgetLeft() < 1500) break;
      const r = await callOpenRouter(openrouterKey, prompt, model, siteUrl);
      if (r.ok) {
        return Response.json({ ok: true, text: r.text, provider: "openrouter", model, attempts });
      }
      attempts.push({ provider: "openrouter", model, status: r.status, detail: r.detail });
      // A bad key will fail identically on every model — don't burn
      // the remaining budget proving it.
      if (r.status === 401 || r.status === 403) break;
    }
  }

  if (geminiKey) {
    for (const model of GEMINI_MODELS) {
      if (budgetLeft() < 1500) break;
      const r = await callGemini(geminiKey, prompt, model);
      if (r.ok) {
        return Response.json({ ok: true, text: r.text, provider: "gemini", model, attempts });
      }
      attempts.push({ provider: "gemini", model, status: r.status, detail: r.detail });
      if (r.status === 400 || r.status === 401 || r.status === 403) break;
    }
  }

  console.error("[ai-chef] all providers failed", JSON.stringify(attempts));

  return Response.json({
    ok: false,
    error: "all_providers_failed",
    message: "Every configured AI provider rejected the request.",
    attempts
  }, { status: 502 });
};

export const config = {
  path: "/api/ai-chef",
  method: ["POST"]
};

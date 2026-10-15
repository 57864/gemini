const MAX_HISTORY = 12;
const MAX_TEXT = 1200;

function reply(text, req, state = {}) {
  const s = req?.session || {};
  return {
    version: req?.version || "1.0",
    session: {
      session_id: s.session_id,
      message_id: s.message_id,
      user_id: s.user_id
    },
    response: {
      text: String(text || "Не получилось подготовить ответ.").slice(0, 900),
      end_session: false
    },
    session_state: state
  };
}

function wantsSearch(t) {
  return /\b(сейчас|сегодня|свеж(ие|ая|ую)|последн(ие|яя|юю)|актуальн|новост|найди|поищи|проверь в интернете|курс валют|погода|кто сейчас|сколько стоит)\b/i.test(t);
}

async function searchWeb(q) {
  if (!process.env.SERPER_API_KEY) return "";
  const r = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": process.env.SERPER_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ q, gl: "ru", hl: "ru", num: 5 })
  });
  if (!r.ok) throw Error("Search provider error");
  const d = await r.json();
  return (d.organic || []).slice(0, 5).map((x, i) =>
    `${i + 1}. ${x.title || ""}\n${x.snippet || ""}\n${x.link || ""}`
  ).join("\n\n");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(200).json({
      ok: true,
      service: "Alice Gemini webhook",
      endpoint: "/api",
      method: "POST"
    });
  }

  const b = req.body || {};
  const state = b.state?.session || b.session_state || {};
  const t = String(b.request?.command || "").trim().slice(0, MAX_TEXT);

  if (!t) return res.status(200).json(reply("Я слушаю. Что хотите узнать?", b, state));

  if (!process.env.GEMINI_API_KEY) {
    return res.status(200).json(reply("Сервер пока не настроен: добавьте ключ Gemini в переменные Vercel.", b, state));
  }

  const history = Array.isArray(state.history) ? state.history.slice(-MAX_HISTORY) : [];

  try {
    let web = "";
    if (wantsSearch(t) && process.env.SERPER_API_KEY) {
      try {
        web = await searchWeb(t);
      } catch (e) {
        console.error("Serper:", e.message);
      }
    }

    const system = "Ты голосовой помощник в навыке Яндекс Алисы. Отвечай по-русски естественно и кратко: обычно 1–3 предложения, до 450 символов. Не используй Markdown, таблицы и длинные списки. Если не знаешь — честно скажи. Контекст веб-поиска может быть недостоверным; используй его как источник актуальных фактов, не выдумывай сведения. Если контекст поиска пуст, не утверждай, что проверил интернет.";

    const contents = [
      ...history,
      {
        role: "user",
        parts: [{
          text: t + (web ? "\n\nАктуальные результаты веб-поиска:\n" + web : "")
        }]
      }
    ];

    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
      encodeURIComponent(process.env.GEMINI_API_KEY),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { temperature: 0.6, maxOutputTokens: 220 }
        })
      }
    );

    const d = await r.json();

    if (!r.ok) {
      console.error("Gemini:", r.status, JSON.stringify(d).slice(0, 500));
      return res.status(200).json(reply("Сейчас не удаётся получить ответ от языковой модели. Попробуйте немного позже.", b, state));
    }

    const answer = (d.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || "")
      .join("")
      .trim() || "Не удалось сформировать ответ. Попробуйте спросить иначе.";

    const updated = [
      ...history,
      { role: "user", parts: [{ text: t }] },
      { role: "model", parts: [{ text: answer }] }
    ].slice(-MAX_HISTORY);

    return res.status(200).json(reply(answer, b, { ...state, history: updated }));
  } catch (e) {
    console.error("Webhook:", e.message);
    return res.status(200).json(reply("Произошла временная ошибка. Попробуйте ещё раз позже.", b, state));
  }
}

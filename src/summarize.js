// Bonus: AI one-line change summary, falling back to a plain diff summary.
const config = require('./config');
const { basicSummary, addedText, removedText } = require('./diff');

async function summarize(name, before, after) {
  const fallback = basicSummary(before, after);
  if (!config.openai.key) return fallback;
  try {
    const res = await fetch(`${config.openai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openai.key}` },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        model: config.openai.model,
        max_tokens: 60,
        messages: [
          { role: 'system', content: 'You summarize website changes in ONE short line (max 20 words), e.g. "Price dropped from ₹999 to ₹799". No preamble.' },
          { role: 'user', content: `Page: ${name}\nREMOVED:\n${removedText(before, after).slice(0, 2000)}\nADDED:\n${addedText(before, after).slice(0, 2000)}` },
        ],
      }),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || fallback;
  } catch {
    return fallback;
  }
}

module.exports = { summarize };

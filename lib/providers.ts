// Provider adapters for hosted (BYO API key) task execution.
// v1 ships Anthropic; the RunResult shape is what future adapters implement.
import Anthropic from '@anthropic-ai/sdk';

export type RunResult = {
  text: string;
  stopReason: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

const MODEL_MAP: Record<string, string> = {
  default: 'claude-opus-4-8',
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
};

// Which provider key each card-model choice needs
export const MODEL_PROVIDER: Record<string, 'anthropic' | 'openai' | 'google'> = {
  default: 'anthropic', fable: 'anthropic', opus: 'anthropic', sonnet: 'anthropic', haiku: 'anthropic',
  gpt: 'openai', 'gpt-luna': 'openai',
  'gemini-pro': 'google', 'gemini-flash': 'google',
};

export const CARD_MODELS = Object.keys(MODEL_PROVIDER);

export async function runAnthropicTask(opts: {
  apiKey: string;
  model: string;
  effort: string;
  prompt: string;
}): Promise<RunResult> {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const model = MODEL_MAP[opts.model] ?? MODEL_MAP.default;
  const isFable = model === 'claude-fable-5';
  const isHaiku = model === 'claude-haiku-4-5';

  const params: Record<string, unknown> = {
    model,
    max_tokens: isHaiku ? 16000 : 32000,
    messages: [{ role: 'user', content: opts.prompt }],
  };
  // Fable: thinking is always on — omit the param. Haiku 4.5: no adaptive thinking / effort.
  if (!isFable && !isHaiku) params.thinking = { type: 'adaptive' };
  if (!isHaiku && opts.effort && opts.effort !== 'default') {
    params.output_config = { effort: opts.effort };
  }

  let message: Anthropic.Message | Anthropic.Beta.BetaMessage;
  if (isFable) {
    // Opt into server-side refusal fallbacks so a classifier decline is
    // rescued by Opus 4.8 instead of failing the task.
    const stream = client.beta.messages.stream({
      ...params,
      betas: ['server-side-fallback-2026-06-01'],
      fallbacks: [{ model: 'claude-opus-4-8' }],
    } as unknown as Parameters<typeof client.beta.messages.stream>[0]);
    message = await stream.finalMessage();
  } else {
    const stream = client.messages.stream(params as unknown as Parameters<typeof client.messages.stream>[0]);
    message = await stream.finalMessage();
  }

  if (message.stop_reason === 'refusal') {
    throw new Error('The model declined this request (safety refusal).');
  }

  const blocks = message.content as Array<{ type: string; text?: string }>;
  const text = blocks
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n');

  return {
    text,
    stopReason: message.stop_reason,
    model: message.model,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

const OPENAI_MODEL: Record<string, string> = { gpt: 'gpt-5.6', 'gpt-luna': 'gpt-5.6-luna' };
const OPENAI_EFFORT: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };

export async function runOpenAITask(opts: { apiKey: string; model: string; effort: string; prompt: string }): Promise<RunResult> {
  const model = OPENAI_MODEL[opts.model] ?? 'gpt-5.6';
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: opts.prompt }],
  };
  if (OPENAI_EFFORT[opts.effort]) body.reasoning_effort = OPENAI_EFFORT[opts.effort];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI: ${data.error?.message || res.status}`);
  const choice = data.choices?.[0];
  return {
    text: choice?.message?.content || '',
    stopReason: choice?.finish_reason ?? null,
    model: data.model || model,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

const GEMINI_MODEL: Record<string, string> = { 'gemini-flash': 'gemini-3.5-flash', 'gemini-pro': 'gemini-3.1-pro-preview' };

export async function runGeminiTask(opts: { apiKey: string; model: string; effort: string; prompt: string }): Promise<RunResult> {
  const model = GEMINI_MODEL[opts.model] ?? 'gemini-3.5-flash';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': opts.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: opts.prompt }] }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini: ${data.error?.message || res.status}`);
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .map((p: { text?: string }) => p.text || '')
    .join('');
  return {
    text,
    stopReason: candidate?.finishReason ?? null,
    model,
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

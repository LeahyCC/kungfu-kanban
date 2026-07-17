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

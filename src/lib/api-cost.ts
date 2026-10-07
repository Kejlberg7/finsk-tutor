export type ResponseTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

/** Estimate standard gpt-6-luna text cost in USD using current published rates. */
export function estimateResponseCostUsd(model: string, usage: ResponseTokenUsage): number | null {
  if (!model.startsWith("gpt-6-luna")) return null;
  const { inputTokens, cachedInputTokens, outputTokens } = usage;
  if (![inputTokens, cachedInputTokens, outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0)
    || cachedInputTokens > inputTokens) return null;
  return ((inputTokens - cachedInputTokens) * 0.10 + cachedInputTokens * 0.01 + outputTokens * 0.50) / 1_000_000;
}

export function readResponseTokenUsage(value: unknown): ResponseTokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown };
  };
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cachedInputTokens = usage.input_tokens_details?.cached_tokens ?? 0;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number" || typeof cachedInputTokens !== "number") return null;
  const result = { inputTokens, cachedInputTokens, outputTokens };
  return [inputTokens, cachedInputTokens, outputTokens].every((item) => Number.isSafeInteger(item) && item >= 0)
    && cachedInputTokens <= inputTokens ? result : null;
}

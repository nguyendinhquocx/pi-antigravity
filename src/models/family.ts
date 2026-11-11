/**
 * Model family routing for the smart multi-account balancer.
 *
 * Antigravity quota is pooled per model family (Claude, Gemini, Argon), so every
 * request must be classified into the family whose quota pool it will consume.
 */
export type ModelFamily = "claude" | "gemini" | "argon" | "unknown";

/**
 * Classify a model id into its quota family.
 * "argon" must be checked before "gemini" because "gemini-4-argon" contains both
 * substrings but draws from the separate Argon quota pool. Claude/GPT models share
 * one pool on Antigravity, so "gpt" ids map to the "claude" family.
 */
export function detectModelFamily(modelId: string): ModelFamily {
  const lower = modelId.toLowerCase();
  if (lower.includes("argon")) return "argon";
  if (lower.includes("claude") || lower.includes("gpt")) return "claude";
  if (lower.includes("gemini")) return "gemini";
  return "unknown";
}

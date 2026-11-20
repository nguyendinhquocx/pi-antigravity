import assert from "node:assert/strict";
import { formatUsageSummary } from "../src/usage/usage.js";

console.log("Running usage formatter tests...");

const baseUsage = {
  projectId: "test",
  endpoint: "test",
  groups: [],
  models: [],
  fetchedAt: Date.now(),
};

// Regression fixture for #3501 error message
const message3501 =
  "/v1internal:retrieveUserQuotaSummary failed: You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. Please contact your administrator to request a license. (#3501)";

const out = formatUsageSummary({
  ...baseUsage,
  quotaSummaryError: message3501,
});

assert.ok(out.includes("needs a paid subscription"));

const freeTierOut = formatUsageSummary({
  ...baseUsage,
  planLabel: "Starter (free-tier)",
  quotaSummaryError: message3501,
  models: [
    { modelId: "gemini-3.8-flash" },
    { modelId: "gemini-4-argon" },
    { modelId: "claude-sonnet-5.5", remainingFraction: 0.28, resetTime: "2026-11-27T00:00:00Z" },
    { modelId: "gpt-oss-120b", remainingFraction: 0 },
  ],
});
assert.ok(freeTierOut.includes("Per-model quota data"), freeTierOut);
assert.ok(freeTierOut.includes("Claude/GPT model quota"), freeTierOut);
assert.ok(freeTierOut.includes("28% left"), freeTierOut);
assert.ok(freeTierOut.includes("0% left"), freeTierOut);
assert.ok(freeTierOut.includes("Gemini: quota values not returned by API (1 model listed)"), freeTierOut);
assert.ok(freeTierOut.includes("Argon: quota values not returned by API (1 model listed)"), freeTierOut);
assert.ok(!freeTierOut.includes("Gemini: 0% left"), freeTierOut);

// Existing aggregate summaries keep precedence over model-level fallback.
const aggregateOut = formatUsageSummary({
  ...baseUsage,
  groups: [{
    displayName: "Claude",
    buckets: [{ bucketId: "week", displayName: "Week", remainingFraction: 0.6 }],
  }],
  models: [{ modelId: "claude-sonnet-5.5", remainingFraction: 0.1 }],
});
assert.ok(aggregateOut.includes("Claude"), aggregateOut);
assert.ok(aggregateOut.includes("60% left"), aggregateOut);
assert.ok(!aggregateOut.includes("Per-model quota data"), aggregateOut);

// A numeric zero is real exhausted quota, not the same as a missing field.
const zeroQuotaOut = formatUsageSummary({
  ...baseUsage,
  quotaSummaryError: message3501,
  models: [{ modelId: "gemini-3.8-flash", remainingFraction: 0 }],
});
assert.ok(zeroQuotaOut.includes("Gemini model quota"), zeroQuotaOut);
assert.ok(zeroQuotaOut.includes("0% left"), zeroQuotaOut);
assert.ok(!zeroQuotaOut.includes("quota values not returned"), zeroQuotaOut);

console.log("Usage formatter tests passed!");

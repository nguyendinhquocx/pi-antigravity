import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchMultiAccountUsage,
  formatFamilyQuotaLines,
  formatMultiAccountUsage,
  formatUsageSummary,
} from "../src/usage/usage.js";
import { mergeAvailableModelsResults } from "../src/client/client.js";

console.log("Running usage formatter tests...");

const FUTURE_RESET = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString();
const NEAR_RESET = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
const PAST_RESET = new Date(Date.now() - 60 * 1000).toISOString();

const baseUsage = {
  projectId: "test",
  endpoint: "test",
  groups: [],
  models: [],
  fetchedAt: Date.now(),
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// --- formatFamilyQuotaLines: one line per family, min remaining, provenance ---

const geminiIds = Array.from({ length: 12 }, (_, i) => `gemini-model-${i}`);
const familyFixture = [
  ...geminiIds.map((modelId) => ({ modelId, remainingFraction: 1, resetTime: FUTURE_RESET })),
  { modelId: "claude-sonnet-4-6", remainingFraction: 0.5, resetTime: NEAR_RESET },
  { modelId: "claude-opus-4-6", remainingFraction: 0.25, resetTime: FUTURE_RESET },
  { modelId: "argon-model", noQuota: true, remainingFraction: undefined },
];

const familyLines = formatFamilyQuotaLines(familyFixture as never);
assert.equal(familyLines.length, 3, familyLines.join("\n"));
assert.ok(
  familyLines[0]?.startsWith("Gemini shared · 100% remaining · reset ~"),
  familyLines.join("\n"),
);
assert.ok(familyLines[0]?.includes("derived from 12/12 models"), familyLines.join("\n"));
assert.ok(familyLines[1]?.startsWith("Claude/GPT shared · 25% remaining"), familyLines.join("\n"));
assert.ok(familyLines[1]?.includes("derived from 2/2 models"), familyLines.join("\n"));
assert.ok(familyLines[1]?.includes("reset ~"), familyLines.join("\n"));
assert.ok(
  familyLines[2]?.includes("Argon: quota unavailable (0/1 models returned values)"),
  familyLines.join("\n"),
);
// No raw model ids anywhere in the family lines.
assert.ok(!familyLines.join("\n").includes("gemini-model-0"), familyLines.join("\n"));

// Numeric zero is real exhausted quota, not "unavailable".
const zeroLines = formatFamilyQuotaLines([
  { modelId: "gemini-3.8-flash", remainingFraction: 0 },
]);
assert.ok(zeroLines.join("\n").includes("Gemini shared · 0% remaining"), zeroLines.join("\n"));

// Reset rules for the tightest model row(s):
// single tightest with valid reset -> show it
const singleTied = formatFamilyQuotaLines([
  { modelId: "claude-a", remainingFraction: 0.25, resetTime: NEAR_RESET },
  { modelId: "claude-b", remainingFraction: 0.5, resetTime: NEAR_RESET },
]);
assert.ok(singleTied.join("\n").includes("reset ~2h"), singleTied.join("\n"));

// single tightest without reset -> reset unknown
const noReset = formatFamilyQuotaLines([
  { modelId: "claude-a", remainingFraction: 0.25 },
  { modelId: "claude-b", remainingFraction: 0.5, resetTime: NEAR_RESET },
]);
assert.ok(noReset.join("\n").includes("reset unknown"), noReset.join("\n"));

// single tightest with unparseable reset -> reset unknown
const badReset = formatFamilyQuotaLines([
  { modelId: "claude-a", remainingFraction: 0.25, resetTime: "not-a-date" },
]);
assert.ok(badReset.join("\n").includes("reset unknown"), badReset.join("\n"));

// tied minimums with different resets -> varies/unknown (independent of row order)
const varied = formatFamilyQuotaLines([
  { modelId: "claude-a", remainingFraction: 0.1, resetTime: NEAR_RESET },
  { modelId: "claude-b", remainingFraction: 0.1, resetTime: FUTURE_RESET },
  { modelId: "claude-c", remainingFraction: 0.9, resetTime: FUTURE_RESET },
]);
assert.ok(varied.join("\n").includes("reset varies/unknown"), varied.join("\n"));
assert.ok(varied.join("\n").includes("10% remaining"), varied.join("\n"));

const variedReordered = formatFamilyQuotaLines([
  { modelId: "claude-c", remainingFraction: 0.9, resetTime: FUTURE_RESET },
  { modelId: "claude-b", remainingFraction: 0.1, resetTime: FUTURE_RESET },
  { modelId: "claude-a", remainingFraction: 0.1, resetTime: NEAR_RESET },
]);
assert.ok(variedReordered.join("\n").includes("reset varies/unknown"), variedReordered.join("\n"));

// tied minimums with the same valid reset -> show it
const agreed = formatFamilyQuotaLines([
  { modelId: "claude-a", remainingFraction: 0.1, resetTime: FUTURE_RESET },
  { modelId: "claude-b", remainingFraction: 0.1, resetTime: FUTURE_RESET },
]);
assert.ok(agreed.join("\n").includes("reset ~6d"), agreed.join("\n"));
assert.ok(!agreed.join("\n").includes("varies"), agreed.join("\n"));

// tied minimums with mixed valid/invalid resets -> varies/unknown
const mixedValidity = formatFamilyQuotaLines([
  { modelId: "claude-a", remainingFraction: 0.1, resetTime: NEAR_RESET },
  { modelId: "claude-b", remainingFraction: 0.1, resetTime: "not-a-date" },
]);
assert.ok(mixedValidity.join("\n").includes("reset varies/unknown"), mixedValidity.join("\n"));

// tied minimums with no parseable reset at all -> reset unknown
const allInvalid = formatFamilyQuotaLines([
  { modelId: "claude-a", remainingFraction: 0.1, resetTime: "not-a-date" },
  { modelId: "claude-b", remainingFraction: 0.1 },
]);
assert.ok(allInvalid.join("\n").includes("reset unknown"), allInvalid.join("\n"));
assert.ok(!allInvalid.join("\n").includes("varies"), allInvalid.join("\n"));

// a reset already in the past renders as "now" but the percent still shows
const past = formatFamilyQuotaLines([
  { modelId: "claude-a", remainingFraction: 0.42, resetTime: PAST_RESET },
]);
assert.ok(past.join("\n").includes("42% remaining"), past.join("\n"));
assert.ok(past.join("\n").includes("reset ~now"), past.join("\n"));

// --- formatUsageSummary (single-account legacy view) ---

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
    { modelId: "gpt-oss-120b", remainingFraction: 0.6 },
  ],
});
assert.ok(freeTierOut.includes("Family quota estimates"), freeTierOut);
assert.ok(freeTierOut.includes("Claude/GPT shared · 28% remaining"), freeTierOut);
assert.ok(freeTierOut.includes("derived from 2/2 models"), freeTierOut);
assert.ok(freeTierOut.includes("Gemini: quota unavailable (0/1 models returned values)"), freeTierOut);
assert.ok(freeTierOut.includes("Argon: quota unavailable (0/1 models returned values)"), freeTierOut);
assert.ok(!freeTierOut.includes("Gemini: 0% remaining"), freeTierOut);
// No per-model id dump in the family view.
assert.ok(!freeTierOut.includes("gemini-3.8-flash"), freeTierOut);

// Existing aggregate summaries keep precedence over family fallback.
const aggregateOut = formatUsageSummary({
  ...baseUsage,
  groups: [
    {
      displayName: "Claude",
      buckets: [{ bucketId: "week", displayName: "Week", remainingFraction: 0.6 }],
    },
  ],
  models: [{ modelId: "claude-sonnet-5.5", remainingFraction: 0.1 }],
});
assert.ok(aggregateOut.includes("Claude"), aggregateOut);
assert.ok(aggregateOut.includes("60% left"), aggregateOut);
assert.ok(!aggregateOut.includes("Family quota estimates"), aggregateOut);

// --- formatMultiAccountUsage: per-account report ---

const paidUsage = {
  ...baseUsage,
  planLabel: "Google AI Pro (g1-pro-tier)",
  groups: [
    {
      displayName: "Claude",
      buckets: [
        { bucketId: "week", displayName: "Week", remainingFraction: 0.6 },
        { bucketId: "5h", displayName: "5H" }, // remainingFraction missing -> unknown
      ],
    },
    {
      displayName: "Gemini 5H quota",
      buckets: [{ bucketId: "5h", displayName: "5H", remainingFraction: 0 }],
    },
  ],
  models: [],
};

const freeAccountUsage = {
  ...baseUsage,
  planLabel: "Starter (free-tier)",
  quotaSummaryError: message3501,
  models: [
    { modelId: "gemini-a", remainingFraction: 1, resetTime: FUTURE_RESET },
    { modelId: "gemini-b", remainingFraction: 1, resetTime: FUTURE_RESET },
    { modelId: "claude-x" },
    { modelId: "claude-y" },
  ],
  catalogError: "fetchAvailableModels failed: no endpoint available",
};

const multiOut = formatMultiAccountUsage({
  totalAccounts: 3,
  accounts: [
    { label: "owner@example.com", email: "owner@example.com", accountId: "owner", active: true, usage: paidUsage },
    {
      label: "free@example.com",
      email: "free@example.com",
      accountId: "free",
      active: false,
      usage: freeAccountUsage,
    },
    { label: "dead@example.com", email: "dead@example.com", accountId: "dead", active: false, error: "token refresh failed: invalid_grant" },
  ],
});

assert.ok(multiOut.includes("Antigravity quota across 3 linked accounts"), multiOut);
// Active account renders first with its paid buckets.
assert.ok(multiOut.indexOf("* owner@example.com") > -1, multiOut);
assert.ok(multiOut.indexOf("* owner@example.com") < multiOut.indexOf("free@example.com"), multiOut);
assert.ok(multiOut.includes("owner@example.com — Google AI Pro (g1-pro-tier)"), multiOut);
assert.ok(multiOut.includes("Week: 60% left"), multiOut);
// Missing bucket fraction stays unknown, not 0%; a real numeric zero still renders as exhausted.
assert.ok(multiOut.includes("5H: ?% left"), multiOut);
assert.ok(multiOut.includes("5H: 0% left"), multiOut);
// Free account: family lines only, no model ids, catalog error surfaced.
assert.ok(multiOut.includes("Gemini shared · 100% remaining"), multiOut);
assert.ok(multiOut.includes("derived from 2/2 models"), multiOut);
assert.ok(multiOut.includes("Claude/GPT: quota unavailable (0/2 models returned values)"), multiOut);
assert.ok(!multiOut.includes("gemini-a"), multiOut);
assert.ok(multiOut.includes("needs a paid subscription"), multiOut);
// Catalog error surfaces only when no family data could be rendered at all.
const catalogDownNoFamilies = formatMultiAccountUsage({
  totalAccounts: 1,
  accounts: [
    {
      label: "quiet@example.com",
      accountId: "quiet",
      active: false,
      usage: {
        ...baseUsage,
        quotaSummaryError: message3501,
        catalogError: "fetchAvailableModels failed: offline",
        models: [],
      },
    },
  ],
});
assert.ok(
  catalogDownNoFamilies.includes("Model catalog unavailable: fetchAvailableModels failed: offline"),
  catalogDownNoFamilies,
);
// Failed account renders a dedicated unavailable line.
assert.ok(multiOut.includes("dead@example.com — unavailable: token refresh failed"), multiOut);

// Paid summary survives a failed model catalog: buckets render, catalog error is quiet.
const paidCatalogDown = formatMultiAccountUsage({
  totalAccounts: 1,
  accounts: [
    {
      label: "owner@example.com",
      accountId: "owner",
      active: true,
      usage: { ...paidUsage, catalogError: "fetchAvailableModels failed: offline" },
    },
  ],
});
assert.ok(paidCatalogDown.includes("Week: 60% left"), paidCatalogDown);
assert.ok(!paidCatalogDown.includes("Model catalog unavailable"), paidCatalogDown);

// Seven linked accounts: seven headings, active first (fetchMultiAccountUsage
// already orders accounts; the formatter renders the report as-is), stable order after.
const restAccounts = [0, 1, 2, 4, 5, 6].map((i) => ({
  label: `user${i}@example.com`,
  accountId: `user${i}`,
  active: false,
  usage: { ...baseUsage, models: [{ modelId: "gemini-a", remainingFraction: 1, resetTime: FUTURE_RESET }] },
}));
const seven = [
  {
    label: "user3@example.com",
    accountId: "user3",
    active: true,
    usage: paidUsage,
  },
  ...restAccounts,
];
const sevenOut = formatMultiAccountUsage({ totalAccounts: 7, accounts: seven });
assert.ok(sevenOut.includes("Antigravity quota across 7 linked accounts"), sevenOut);
assert.ok(sevenOut.includes("* user3@example.com"), sevenOut);
const headingIndices = seven.map((a) => sevenOut.indexOf(a.label));
assert.ok(headingIndices.every((idx) => idx > -1), `missing headings: ${sevenOut}`);
assert.deepEqual(
  [...headingIndices].sort((a, b) => a - b),
  headingIndices,
  "account headings must keep stable order",
);
assert.ok(headingIndices[0] === Math.min(...headingIndices), "active account must render first");

// --- mergeAvailableModelsResults: quotaInfo merges field-wise ---

const dailyResult = {
  endpoint: "https://daily-cloudcode-pa.googleapis.com",
  status: 200,
  data: {
    models: {
      "claude-x": { displayName: "Claude X", quotaInfo: { remainingFraction: 0.5, resetTime: NEAR_RESET } },
      "gemini-a": { displayName: "Gemini A", quotaInfo: { remainingFraction: 1 } },
    },
  },
};
const cloudResult = {
  endpoint: "https://cloudcode-pa.googleapis.com",
  status: 200,
  data: {
    models: {
      // Later endpoint omits remainingFraction but refreshes resetTime + metadata.
      "claude-x": { displayName: "Claude X v2", quotaInfo: { resetTime: FUTURE_RESET } },
      // Later endpoint drops quotaInfo entirely.
      "gemini-a": { displayName: "Gemini A v2" },
      "claude-new": { displayName: "Claude New", quotaInfo: { remainingFraction: 0.9 } },
    },
    defaultAgentModelId: "claude-new",
  },
};

const merged = mergeAvailableModelsResults([undefined, dailyResult, cloudResult]);
const mergedModels = merged.data.models as Record<
  string,
  { displayName?: string; quotaInfo?: { remainingFraction?: number; resetTime?: string } }
>;
assert.equal(
  mergedModels["claude-x"]?.quotaInfo?.remainingFraction,
  0.5,
  "daily quota value must survive a later endpoint that omits the field",
);
assert.equal(
  mergedModels["claude-x"]?.quotaInfo?.resetTime,
  FUTURE_RESET,
  "a value clearly returned by the later endpoint wins",
);
assert.equal(mergedModels["claude-x"]?.displayName, "Claude X v2");
assert.equal(
  mergedModels["gemini-a"]?.quotaInfo?.remainingFraction,
  1,
  "quotaInfo must survive when the later record has none",
);
assert.equal(mergedModels["gemini-a"]?.displayName, "Gemini A v2");
assert.equal(mergedModels["claude-new"]?.quotaInfo?.remainingFraction, 0.9);
assert.equal(merged.data.defaultAgentModelId, "claude-new");
// A later endpoint returning null for a quota field counts as missing: keep
// the earlier valid value instead of erasing it.
const nulledLater = mergeAvailableModelsResults([
  dailyResult,
  {
    endpoint: "https://cloudcode-pa.googleapis.com",
    status: 200,
    data: {
      models: { "claude-x": { displayName: "Claude X", quotaInfo: { remainingFraction: null } } },
    },
  },
]);
const nulledModels = nulledLater.data.models as Record<
  string,
  { quotaInfo?: { remainingFraction?: number } }
>;
assert.equal(nulledModels["claude-x"]?.quotaInfo?.remainingFraction, 0.5);

// A later endpoint returning an explicit 0 replaces the earlier value.
const zeroedLater = mergeAvailableModelsResults([
  dailyResult,
  {
    endpoint: "https://cloudcode-pa.googleapis.com",
    status: 200,
    data: { models: { "claude-x": { displayName: "Claude X", quotaInfo: { remainingFraction: 0 } } } },
  },
]);
const zeroedModels = zeroedLater.data.models as Record<string, { quotaInfo?: { remainingFraction?: number } }>;
assert.equal(zeroedModels["claude-x"]?.quotaInfo?.remainingFraction, 0);

// --- fetchMultiAccountUsage: store read, rotation persist, isolation ---

function writeStoreFixture(dir: string): { authBytesBefore: string } {
  const now = Date.now();
  const account = (email: string, access: string, addedAt: number, expires = 0) => ({
    type: "oauth",
    email,
    access,
    refresh: `${email}-refresh`,
    expires,
    projectId: "proj-x",
    accountId: email,
    addedAt,
    lastUsedAt: addedAt,
  });
  const store = {
    version: 1,
    activeAccountId: "active@example.com",
    accounts: {
      "active@example.com": account("active@example.com", "active-access", now - 3000, now + 3600_000),
      "old1@example.com": account("old1@example.com", "old1-access", now - 2000),
      "old2@example.com": account("old2@example.com", "old2-access", now - 1000),
    },
  };
  writeFileSync(join(dir, "antigravity-accounts.json"), `${JSON.stringify(store, null, 2)}\n`);
  const authBytesBefore = `${JSON.stringify({ anthropic: { token: "keep-me" }, antigravity: { type: "oauth", email: "active@example.com", access: "active-access", refresh: "active@example.com-refresh", expires: now + 3600_000, projectId: "proj-x" } }, null, 2)}\n`;
  writeFileSync(join(dir, "auth.json"), authBytesBefore);
  return { authBytesBefore };
}

const freeModelsForAccount = [
  { modelId: "gemini-a", remainingFraction: 1, resetTime: FUTURE_RESET },
];

async function runMultiAccountStoreTest(): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), "antigravity-usage-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tempDir;
  try {
    const { authBytesBefore } = writeStoreFixture(tempDir);
    const activeApiKey = JSON.stringify({ token: "active-access", projectId: "proj-x" });

    const refreshCalls: string[] = [];
    const fetchTokens: string[] = [];
    const report = await fetchMultiAccountUsage(activeApiKey, {
      refreshAccount: async (account) => {
        refreshCalls.push(account.accountId);
        await sleep(10); // widen the overlap window between the two non-active rotations
        return { ...account, access: `${account.accountId}-fresh-access`, expires: Date.now() + 3600_000 };
      },
      fetchUsage: async (creds) => {
        const token = creds.token;
        fetchTokens.push(token);
        if (token === "old2@example.com-fresh-access") throw new Error("quota RPC 503 boom");
        return {
          ...baseUsage,
          planLabel: token === "active-access" ? "Google AI Pro (g1-pro-tier)" : "Starter (free-tier)",
          models: freeModelsForAccount,
        };
      },
    });

    assert.equal(report.totalAccounts, 3);
    assert.equal(report.accounts[0]?.label, "active@example.com");
    assert.equal(report.accounts[0]?.active, true);
    assert.equal(report.accounts[0]?.usage?.planLabel, "Google AI Pro (g1-pro-tier)");
    assert.deepEqual(
      report.accounts.slice(1).map((a) => a.label),
      ["old1@example.com", "old2@example.com"],
      "non-active accounts keep stable addedAt order",
    );
    // Active credential is reported as-is: no refresh call for it.
    assert.ok(!refreshCalls.includes("active@example.com"), refreshCalls.join(","));
    assert.ok(fetchTokens.includes("active-access"), fetchTokens.join(","));
    // One account failing must not hide the others.
    assert.ok(report.accounts[2]?.error?.includes("quota RPC 503 boom"), report.accounts[2]?.error);
    assert.ok(report.accounts[1]?.usage, "old1 must still render");

    // Rotations persisted into the right rows (both concurrent writes landed).
    const savedStore = JSON.parse(
      readFileSync(join(tempDir, "antigravity-accounts.json"), "utf8"),
    ) as {
      activeAccountId?: string;
      accounts: Record<string, { access: string; refresh: string }>;
    };
    assert.equal(savedStore.accounts["old1@example.com"]?.access, "old1@example.com-fresh-access");
    assert.equal(savedStore.accounts["old2@example.com"]?.access, "old2@example.com-fresh-access");
    assert.equal(savedStore.accounts["old1@example.com"]?.refresh, "old1@example.com-refresh");
    assert.equal(
      savedStore.accounts["active@example.com"]?.access,
      "active-access",
      "active store row must stay untouched",
    );
    assert.equal(savedStore.activeAccountId, "active@example.com");
    // auth.json is never rewritten by the report.
    assert.equal(readFileSync(join(tempDir, "auth.json"), "utf8"), authBytesBefore);

    // Empty store -> fall back to the ModelRegistry credential.
    rmSync(join(tempDir, "antigravity-accounts.json"));
    const solo = await fetchMultiAccountUsage(activeApiKey, {
      fetchUsage: async () => ({ ...baseUsage, models: freeModelsForAccount }),
    });
    assert.equal(solo.totalAccounts, 1);
    assert.equal(solo.accounts[0]?.active, true);
    assert.ok(solo.accounts[0]?.usage);

    // Empty store + unusable credential -> per-account error, not a crash.
    const broken = await fetchMultiAccountUsage("not-json", {
      fetchUsage: async () => ({ ...baseUsage }),
    });
    assert.equal(broken.totalAccounts, 1);
    assert.ok(broken.accounts[0]?.error);

    const formatted = formatMultiAccountUsage(report);
    assert.ok(formatted.includes("Antigravity quota across 3 linked accounts"), formatted);
    assert.ok(formatted.includes("* active@example.com — Google AI Pro"), formatted);
    assert.ok(formatted.includes("old2@example.com — unavailable"), formatted);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await runMultiAccountStoreTest();

console.log("Usage formatter tests passed!");

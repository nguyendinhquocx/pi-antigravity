import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  antigravityHeaders,
  endpointCandidates,
  extractProjectId,
  fetchAvailableModelsCatalog,
  parseApiKey,
  resolveProjectId,
} from "../client/client.js";
import {
  setLastEndpoint,
  setLastError,
  setLastProjectId,
  setLastStatus,
} from "../diagnostics/diagnostics.js";
import { isRecord } from "../utils/util.js";
import { getCreditsStatus } from "../utils/credits.js";
import { safeError, redactSecrets } from "../utils/security.js";
import { antigravityFetch } from "../utils/http.js";
import { extractRecommendedModelIds } from "../models/grouping.js";
import { detectModelFamily, type ModelFamily } from "../models/family.js";
import {
  ensureFresh,
  apiKeyFor,
  loadAccountStore,
  updateRememberedAccount,
  type AccountsFile,
  type StoredAccount,
} from "../auth/accounts.js";
import type {
  AccountUsage,
  AccountUsageReport,
  AntigravityApiKey,
  AntigravityOAuthCredentials,
  ApiErrorBody,
  AvailableModelsRaw,
  CreditBalanceInfo,
  LoadCodeAssistRaw,
  ModelQuotaRow,
  MultiAccountUsage,
  QuotaBucket,
  QuotaGroup,
  QuotaSummaryRaw,
  TierInfo,
  TierRaw,
} from "../types/types.js";

export type { AccountUsageReport, MultiAccountUsage };

function clampFraction(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function remainingPercent(remaining?: number): number | undefined {
  if (remaining === undefined) return undefined;
  return Math.round(remaining * 1000) / 10;
}

function progressBar(remaining?: number, width = 20): string {
  if (remaining === undefined) return `[${"?".repeat(width)}]`;
  const filled = Math.max(0, Math.min(width, Math.round(remaining * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function parseResetTimestamp(resetTime?: string): number | undefined {
  if (!resetTime) return undefined;
  const ts = Date.parse(resetTime);
  return Number.isFinite(ts) ? ts : undefined;
}

function relativeReset(ts: number): string {
  const delta = ts - Date.now();
  if (delta <= 0) return "now";
  const totalMin = Math.round(delta / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatReset(resetTime?: string): string {
  if (!resetTime) return "n/a";
  const ts = parseResetTimestamp(resetTime);
  if (ts === undefined) return resetTime;
  return relativeReset(ts);
}

function jsonHeaders(token: string): Record<string, string> {
  return {
    ...antigravityHeaders(token),
    Accept: "application/json",
  };
}

async function postJson(
  path: string,
  token: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ endpoint: string; status: number; data: unknown }> {
  let lastErrorText = "";
  for (const endpoint of endpointCandidates()) {
    if (signal?.aborted) {
      throw new Error(`${path} aborted: account query deadline exceeded`);
    }
    try {
      const res = await antigravityFetch(`${endpoint}${path}`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify(body),
        signal,
      });
      setLastEndpoint(endpoint);
      setLastStatus(res.status);
      const text = await res.text();
      let data: unknown;
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = { raw: text } satisfies ApiErrorBody;
      }
      if (!res.ok) {
        const errorBody = isRecord(data) ? (data as ApiErrorBody) : undefined;
        lastErrorText =
          typeof errorBody?.error?.message === "string" ? errorBody.error.message : text;
        if (![403, 404, 429, 500, 502, 503, 504].includes(res.status)) {
          throw new Error(`${path} failed (${String(res.status)}): ${lastErrorText.slice(0, 300)}`);
        }
        continue;
      }
      return { endpoint, status: res.status, data };
    } catch (error) {
      if (signal?.aborted) {
        throw new Error(`${path} aborted: account query deadline exceeded`, { cause: error });
      }
      lastErrorText = safeError(error);
      setLastError(lastErrorText);
    }
  }
  throw new Error(`${path} failed: ${lastErrorText || "no endpoint available"}`);
}

function parseQuotaSummary(data: unknown): { groups: QuotaGroup[]; description?: string } {
  const summary = (isRecord(data) ? data : {}) as QuotaSummaryRaw;
  const groups: QuotaGroup[] = [];
  for (const group of summary.groups || []) {
    const buckets: QuotaBucket[] = [];
    for (const bucket of group.buckets || []) {
      const remaining = clampFraction(bucket.remainingFraction);
      if (remaining === undefined && !bucket.bucketId && !bucket.displayName) continue;
      buckets.push({
        bucketId: String(bucket.bucketId || bucket.displayName || "unknown"),
        displayName: String(bucket.displayName || bucket.bucketId || "Limit"),
        window: bucket.window ? String(bucket.window) : undefined,
        resetTime: bucket.resetTime ? String(bucket.resetTime) : undefined,
        description: bucket.description ? String(bucket.description) : undefined,
        // Missing stays undefined (rendered as "unknown"); a real 0 survives clamping.
        remainingFraction: remaining,
      });
    }
    if (!buckets.length && !group.displayName) continue;
    groups.push({
      displayName: String(group.displayName || "Quota group"),
      description: group.description ? String(group.description) : undefined,
      buckets,
    });
  }
  return {
    groups,
    description: summary.description ? String(summary.description) : undefined,
  };
}

function parseModels(data: unknown): {
  models: ModelQuotaRow[];
  defaultAgentModelId?: string;
  agentModelSorts?: unknown;
} {
  const raw = (isRecord(data) ? data : {}) as AvailableModelsRaw;
  const modelsObj = raw.models && isRecord(raw.models) ? raw.models : {};
  const models: ModelQuotaRow[] = [];
  const recommendedIds = extractRecommendedModelIds(raw.agentModelSorts);
  for (const [modelId, info] of Object.entries(modelsObj)) {
    if (!info || !isRecord(info)) continue;
    if (info.isInternal || String(modelId).startsWith("chat_")) continue;
    const qi = isRecord(info.quotaInfo) ? info.quotaInfo : {};
    models.push({
      modelId,
      displayName:
        typeof info.displayName === "string"
          ? info.displayName
          : typeof info.label === "string"
            ? info.label
            : typeof info.modelName === "string"
              ? info.modelName
              : undefined,
      remainingFraction: clampFraction(qi.remainingFraction),
      resetTime: qi.resetTime ? String(qi.resetTime) : undefined,
      modelProvider:
        typeof info.modelProvider === "string"
          ? info.modelProvider
          : typeof info.apiProvider === "string"
            ? info.apiProvider
            : undefined,
      supportsThinking: !!info.supportsThinking,
      supportsImages: !!info.supportsImages,
      recommended: !!info.recommended || (recommendedIds?.has(modelId) ?? false),
    });
  }
  models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return {
    models,
    defaultAgentModelId:
      raw.defaultAgentModelId || raw.defaultAgentModel
        ? String(raw.defaultAgentModelId || raw.defaultAgentModel)
        : undefined,
    agentModelSorts: raw.agentModelSorts,
  };
}

export function parseCredits(list: unknown): CreditBalanceInfo[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const result: CreditBalanceInfo[] = [];
  for (const item of list) {
    if (!item || !isRecord(item)) continue;
    const amt = item.creditAmount ?? item.credit_amount;
    const min = item.minimumCreditAmountForUsage ?? item.minimum_credit_amount_for_usage;
    const typ = item.creditType ?? item.credit_type;
    const num = typeof amt === "number" ? amt : typeof amt === "string" ? Number(amt) : undefined;
    if (num !== undefined && Number.isFinite(num)) {
      result.push({
        creditType: typeof typ === "string" ? typ : "GOOGLE_ONE_AI",
        creditAmount: num,
        minimumCreditAmountForUsage:
          typeof min === "number" ? min : typeof min === "string" ? Number(min) : undefined,
      });
    }
  }
  return result.length ? result : undefined;
}

function parseTier(value: unknown): TierInfo | undefined {
  if (!isRecord(value)) return undefined;
  const tier = value as TierRaw;
  if (!tier.id && !tier.name) return undefined;
  const credits = parseCredits(tier.availableCredits ?? tier.available_credits);
  return {
    id: tier.id ? String(tier.id) : undefined,
    name: tier.name ? String(tier.name) : undefined,
    description: tier.description ? String(tier.description) : undefined,
    availableCredits: credits,
  };
}

async function loadCodeAssistSafe(token: string, signal?: AbortSignal) {
  try {
    return await postJson(
      "/v1internal:loadCodeAssist",
      token,
      {
        metadata: {
          ideType: "ANTIGRAVITY",
          platform: "PLATFORM_UNSPECIFIED",
          pluginType: "GEMINI",
        },
      },
      signal,
    );
  } catch {
    return null;
  }
}

/**
 * The user-quota-summary RPC is gated behind a paid subscription: free-tier
 * accounts get 403 SUBSCRIPTION_REQUIRED (#3501). It is best-effort diagnostics
 * only — never let it block the rest of the account data (models, tier, project).
 */
async function fetchQuotaSummarySafe(
  token: string,
  signal?: AbortSignal,
): Promise<
  | { ok: true; result: { endpoint: string; status: number; data: unknown } }
  | {
      ok: false;
      error: string;
    }
> {
  try {
    return {
      ok: true,
      result: await postJson("/v1internal:retrieveUserQuotaSummary", token, {}, signal),
    };
  } catch (error) {
    const msg = safeError(error);
    setLastError(msg);
    return { ok: false, error: msg };
  }
}

export async function fetchAccountUsage(
  apiKeyRaw: string,
  opts?: { signal?: AbortSignal },
): Promise<AccountUsage> {
  const creds = parseApiKey(apiKeyRaw);
  return fetchAccountUsageForCredentials(creds, opts?.signal);
}

/**
 * Core per-account usage load. The quota-summary RPC, the model catalog and
 * loadCodeAssist stay independent: a catalog failure must never hide an
 * authoritative paid summary, and a summary failure must not block the
 * free-tier family fallback built from merged model data.
 */
export async function fetchAccountUsageForCredentials(
  creds: AntigravityApiKey,
  signal?: AbortSignal,
): Promise<AccountUsage> {
  const token = creds.token;
  const initialProjectId =
    creds.projectId ||
    resolveProjectId({
      token,
      credentialProjectId: creds.projectId,
    });

  // Fetch loadCodeAssist, quota summary, and available models all in parallel
  // to minimize command execution latency.
  const [assistResult, summaryRes, catalogResult] = await Promise.all([
    loadCodeAssistSafe(token, signal),
    fetchQuotaSummarySafe(token, signal),
    fetchAvailableModelsCatalogSafe(token, initialProjectId, signal),
  ]);

  // Derive project ID from the loadCodeAssist response or stored project ID.
  const discoveredProject = assistResult ? extractProjectId(assistResult.data) : undefined;
  const projectId = resolveProjectId({
    token,
    warmedProject: discoveredProject ?? null,
    credentialProjectId: creds.projectId,
  });
  setLastProjectId(projectId);

  const summary = summaryRes.ok ? summaryRes.result : null;
  const quotaSummaryError = summaryRes.ok ? undefined : summaryRes.error;
  const { groups, description } = summary
    ? parseQuotaSummary(summary.data)
    : { groups: [], description: undefined };
  const { models, defaultAgentModelId, agentModelSorts } = parseModels(
    catalogResult.ok ? catalogResult.result.data : undefined,
  );

  const assistData = (isRecord(assistResult?.data) ? assistResult.data : {}) as LoadCodeAssistRaw;
  const productTier = parseTier(assistData.currentTier);
  const paidTier = parseTier(assistData.paidTier);
  const availableCredits =
    paidTier?.availableCredits ??
    productTier?.availableCredits ??
    parseCredits(assistData.availableCredits ?? assistData.available_credits);

  // Google returns currentTier=free-tier even for Google AI Pro accounts.
  // The real subscription lives in paidTier (e.g. g1-pro-tier / Google AI Pro).
  const planLabel = paidTier?.name
    ? `${paidTier.name}${paidTier.id ? ` (${paidTier.id})` : ""}`
    : productTier?.name
      ? `${productTier.name}${productTier.id ? ` (${productTier.id})` : ""}`
      : undefined;

  return {
    projectId,
    endpoint:
      summary?.endpoint ??
      (catalogResult.ok ? catalogResult.result.endpoint : undefined) ??
      assistResult?.endpoint,
    productTier,
    paidTier,
    planLabel,
    availableCredits,
    groups,
    groupDescription: description,
    quotaSummaryError,
    catalogError: catalogResult.ok ? undefined : catalogResult.error,
    models,
    defaultAgentModelId,
    agentModelSorts,
    fetchedAt: Date.now(),
  };
}

/**
 * The model catalog is auxiliary data for the usage view. Every endpoint can
 * fail (offline, blocked, timeout) without losing the authoritative summary,
 * so resolve to an explicit error instead of throwing.
 */
async function fetchAvailableModelsCatalogSafe(
  token: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<
  | { ok: true; result: { endpoint: string; status: number; data: AvailableModelsRaw } }
  | { ok: false; error: string }
> {
  try {
    return {
      ok: true,
      result: await fetchAvailableModelsCatalog(token, projectId, signal),
    };
  } catch (error) {
    const msg = safeError(error);
    setLastError(msg);
    return { ok: false, error: msg };
  }
}

function quotaErrorNote(msg: string): string {
  if (/SUBSCRIPTION_REQUIRED|#3501|(?:lack|missing).*license/i.test(msg)) {
    return "Aggregate quota summary needs a paid subscription; showing model-level quota data where the API returned it.";
  }
  return `Aggregate quota summary unavailable: ${msg.slice(0, 160)}`;
}

const MODEL_QUOTA_FAMILIES: Exclude<ModelFamily, "unknown">[] = ["gemini", "claude", "argon"];
const MODEL_QUOTA_FAMILY_LABELS: Record<Exclude<ModelFamily, "unknown">, string> = {
  gemini: "Gemini",
  claude: "Claude/GPT",
  argon: "Argon",
};

/**
 * Reset text for a family whose estimate comes from its tightest model row(s).
 * Rules: a single tightest row shows its reset when parseable, "reset unknown"
 * otherwise; several tied rows show the reset only when every tied row parses
 * to the same timestamp, otherwise "reset varies/unknown".
 */
function familyResetText(tiedResetTimes: Array<string | undefined>): string {
  const stamps = tiedResetTimes.map(parseResetTimestamp);
  const valid = stamps.filter((ts): ts is number => ts !== undefined);
  if (valid.length === 0) return "reset unknown";
  if (valid.length !== stamps.length) {
    return tiedResetTimes.length === 1 ? "reset unknown" : "reset varies/unknown";
  }
  if (new Set(valid).size !== 1) return "reset varies/unknown";
  return `reset ~${relativeReset(valid[0])}`;
}

/**
 * Free-tier accounts may lack aggregate groups but still return per-model quota.
 * Collapse model rows into at most one line per quota family: the family
 * estimate is the MIN remaining fraction across quota-bearing models (the
 * tightest pool hits the wall first, mirroring the balancer), with provenance
 * counts so missing values stay visibly unknown instead of reading as 0%.
 */
export function formatFamilyQuotaLines(models: ModelQuotaRow[]): string[] {
  const byFamily = new Map<Exclude<ModelFamily, "unknown">, ModelQuotaRow[]>();
  for (const model of models) {
    const family = detectModelFamily(model.modelId);
    if (family === "unknown") continue;
    const rows = byFamily.get(family) ?? [];
    rows.push(model);
    byFamily.set(family, rows);
  }

  const lines: string[] = [];
  for (const family of MODEL_QUOTA_FAMILIES) {
    const familyModels = byFamily.get(family);
    if (!familyModels?.length) continue;
    const label = MODEL_QUOTA_FAMILY_LABELS[family];
    const known = familyModels.filter((model) => model.remainingFraction !== undefined);
    if (known.length === 0) {
      lines.push(`${label}: quota unavailable (0/${familyModels.length} models returned values)`);
      continue;
    }
    const tightest = Math.min(...known.map((model) => model.remainingFraction as number));
    const tied = known.filter((model) => model.remainingFraction === tightest);
    const percent = remainingPercent(tightest);
    lines.push(
      `${label} shared · ${percent ?? "?"}% remaining · ${familyResetText(tied.map((m) => m.resetTime))} · derived from ${known.length}/${familyModels.length} models`,
    );
  }
  return lines;
}

export function formatUsageSummary(usage: AccountUsage): string {
  const lines: string[] = [];

  if (usage.planLabel) lines.push(usage.planLabel);

  if (!usage.groups.length) {
    if (usage.quotaSummaryError) {
      lines.push(quotaErrorNote(usage.quotaSummaryError));
    } else {
      lines.push("No quota groups returned.");
    }
    const familyLines = formatFamilyQuotaLines(usage.models);
    if (familyLines.length > 0) {
      lines.push("");
      lines.push(
        "Family quota estimates from the model catalog (missing values mean unknown, not 0% remaining):",
      );
      lines.push(...familyLines);
    }
    return lines.join("\n");
  }

  for (const group of usage.groups) {
    if (lines.length) lines.push("");
    lines.push(group.displayName);
    for (const bucket of group.buckets) {
      const rem = remainingPercent(bucket.remainingFraction);
      lines.push(
        `  ${progressBar(bucket.remainingFraction)} ${bucket.displayName}: ${rem ?? "?"}% left · resets ${formatReset(bucket.resetTime)}`,
      );
    }
  }

  return lines.join("\n").trimEnd();
}

export async function fetchRemainingCredits(apiKeyRaw?: string): Promise<{
  availableCredits?: CreditBalanceInfo[];
  overagesEnabled: boolean;
  planLabel?: string;
}> {
  const creds = parseApiKey(apiKeyRaw);
  const assistResult = await loadCodeAssistSafe(creds.token);
  const assistData = (isRecord(assistResult?.data) ? assistResult.data : {}) as LoadCodeAssistRaw;
  const productTier = parseTier(assistData.currentTier);
  const paidTier = parseTier(assistData.paidTier);
  const availableCredits =
    paidTier?.availableCredits ??
    productTier?.availableCredits ??
    parseCredits(assistData.availableCredits ?? assistData.available_credits);
  const status = getCreditsStatus();
  const planLabel = paidTier?.name
    ? `${paidTier.name}${paidTier.id ? ` (${paidTier.id})` : ""}`
    : productTier?.name
      ? `${productTier.name}${productTier.id ? ` (${productTier.id})` : ""}`
      : undefined;

  return {
    availableCredits,
    overagesEnabled: status.enabled,
    planLabel,
  };
}

export function formatModelsList(usage: AccountUsage, opts?: { all?: boolean }): string {
  const lines: string[] = [];
  lines.push("Antigravity available models");
  lines.push(`project=${usage.projectId}`);
  if (usage.defaultAgentModelId) lines.push(`defaultAgentModel=${usage.defaultAgentModelId}`);
  lines.push("");

  const recommendedIds = extractRecommendedModelIds(usage.agentModelSorts);
  const rows = opts?.all
    ? usage.models
    : recommendedIds && recommendedIds.size > 0
      ? usage.models.filter((m) => recommendedIds.has(m.modelId))
      : usage.models.filter((m) => !/tab_|chat_/i.test(m.modelId));

  if (!rows.length) {
    lines.push("No models returned.");
    return lines.join("\n");
  }

  const maxId = Math.max(...rows.map((m) => m.modelId.length), 8);
  for (const m of rows) {
    const rem = remainingPercent(m.remainingFraction);
    const flags = [
      m.recommended ? "recommended" : "",
      m.supportsThinking ? "thinking" : "",
      m.supportsImages ? "images" : "",
    ]
      .filter(Boolean)
      .join(",");
    const name = m.displayName && m.displayName !== m.modelId ? `  ${m.displayName}` : "";
    lines.push(
      `${m.modelId.padEnd(maxId)}  rem ${rem === undefined ? "  ?" : String(rem).padStart(5)}%  reset ${formatReset(m.resetTime).padEnd(8)}${flags ? `  [${flags}]` : ""}${name}`,
    );
  }
  lines.push("");
  lines.push("Note: remaining % is pool-shared (not a private per-model budget).");
  return lines.join("\n");
}

// --- Multi-account usage report ---

const ACCOUNT_QUERY_TIMEOUT_MS = 30_000;
const ACCOUNT_QUERY_CONCURRENCY = 2;

export type AccountRefreshFn = (
  account: StoredAccount,
  signal?: AbortSignal,
) => Promise<StoredAccount>;

export type FetchAccountUsageFn = (
  creds: AntigravityApiKey,
  signal?: AbortSignal,
) => Promise<AccountUsage>;

const defaultRefreshAccount: AccountRefreshFn = (account, signal) => ensureFresh(account, signal);

const defaultFetchAccountUsage: FetchAccountUsageFn = (creds, signal) =>
  fetchAccountUsageForCredentials(creds, signal);

/**
 * Serialized write queue for non-active token rotations. Google may rotate
 * refresh tokens on refresh; with accounts refreshing in parallel a naive
 * whole-store save could resurrect a stale snapshot and drop another account's
 * rotation. updateRememberedAccount re-reads the latest store per call, and the
 * chain below makes sure only one such write runs at a time. Never touches the
 * active account id or auth.json.
 */
let rotationPersistChain: Promise<void> = Promise.resolve();

function queueRotationPersist(
  previous: StoredAccount,
  fresh: AntigravityOAuthCredentials,
): Promise<void> {
  const task = rotationPersistChain.then(() => {
    try {
      updateRememberedAccount(previous, fresh);
    } catch {
      // Best-effort persistence (e.g. transient file lock on Windows): the
      // in-memory token still serves this report.
    }
  });
  rotationPersistChain = task.catch(() => {});
  return task;
}

/** Active account first, then remaining rows in stable addedAt/accountId order. */
function orderAccountsForReport(store: AccountsFile): StoredAccount[] {
  const rows = Object.values(store.accounts).sort(
    (a, b) => a.addedAt - b.addedAt || a.accountId.localeCompare(b.accountId),
  );
  const activeId = store.activeAccountId;
  if (!activeId) return rows;
  return [
    ...rows.filter((account) => account.accountId === activeId),
    ...rows.filter((account) => account.accountId !== activeId),
  ];
}

async function buildAccountUsageReport(
  account: StoredAccount,
  active: boolean,
  activeApiKeyRaw: string | undefined,
  opts: { refreshAccount: AccountRefreshFn; fetchUsage: FetchAccountUsageFn },
): Promise<AccountUsageReport> {
  const base: AccountUsageReport = {
    label: account.email || account.accountId,
    email: account.email,
    accountId: account.accountId,
    active,
  };
  try {
    // One deadline covers refresh + quota queries for the whole account.
    const signal = AbortSignal.timeout(ACCOUNT_QUERY_TIMEOUT_MS);
    let creds: AntigravityApiKey;
    if (active && activeApiKeyRaw) {
      // The active credential is Pi-managed (auth.json + provider refresh path);
      // report it as-is instead of racing the provider's own rotation.
      creds = parseApiKey(activeApiKeyRaw);
    } else {
      const fresh = await opts.refreshAccount(account, signal);
      if (fresh.access !== account.access || fresh.refresh !== account.refresh) {
        await queueRotationPersist(account, fresh);
      }
      creds = apiKeyFor(fresh);
    }
    return { ...base, usage: await opts.fetchUsage(creds, signal) };
  } catch (error) {
    return { ...base, error: redactSecrets(safeError(error)).slice(0, 160) };
  }
}

/**
 * Load usage for every linked account in antigravity-accounts.json (direct store
 * read — no syncCurrentAuth, no account switching). Accounts run with bounded
 * concurrency; each has its own 30s deadline, so one stalled refresh or API call
 * only marks that account unavailable and never drops the others. With no
 * linked accounts at all, falls back to the current ModelRegistry credential.
 */
export async function fetchMultiAccountUsage(
  activeApiKeyRaw?: string,
  opts: { refreshAccount?: AccountRefreshFn; fetchUsage?: FetchAccountUsageFn } = {},
): Promise<MultiAccountUsage> {
  const refreshAccount = opts.refreshAccount ?? defaultRefreshAccount;
  const fetchUsage = opts.fetchUsage ?? defaultFetchAccountUsage;
  const store = loadAccountStore();
  const ordered = orderAccountsForReport(store);

  if (ordered.length === 0) {
    // Multi-account store never set up: keep the single-credential behavior.
    const base: AccountUsageReport = { label: "active credential", active: true };
    try {
      const creds = parseApiKey(activeApiKeyRaw);
      const signal = AbortSignal.timeout(ACCOUNT_QUERY_TIMEOUT_MS);
      return { totalAccounts: 1, accounts: [{ ...base, usage: await fetchUsage(creds, signal) }] };
    } catch (error) {
      return {
        totalAccounts: 1,
        accounts: [{ ...base, error: redactSecrets(safeError(error)).slice(0, 160) }],
      };
    }
  }

  const reports = new Array<AccountUsageReport>(ordered.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < ordered.length) {
      const index = cursor++;
      const account = ordered[index];
      if (!account) continue;
      reports[index] = await buildAccountUsageReport(
        account,
        account.accountId === store.activeAccountId,
        activeApiKeyRaw,
        { refreshAccount, fetchUsage },
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(ACCOUNT_QUERY_CONCURRENCY, ordered.length) }, () => worker()),
  );
  return { totalAccounts: ordered.length, accounts: reports };
}

/** Render the per-account quota report described by the UX contract. */
export function formatMultiAccountUsage(report: MultiAccountUsage): string {
  const lines: string[] = [];
  const count = report.totalAccounts;
  lines.push(
    count === 1
      ? "Antigravity quota (1 linked account)"
      : `Antigravity quota across ${count} linked accounts`,
  );

  for (const account of report.accounts) {
    lines.push("");
    const marker = account.active ? "*" : " ";
    const name = account.label || account.accountId || "unknown account";
    if (!account.usage) {
      const reason = account.error || "no usage data";
      lines.push(`${marker} ${name} — unavailable: ${reason}`);
      continue;
    }
    const usage = account.usage;
    lines.push(`${marker} ${name}${usage.planLabel ? ` — ${usage.planLabel}` : ""}`);

    if (usage.groups.length > 0) {
      // Authoritative paid summary; the model-catalog fallback stays out of the way.
      for (const group of usage.groups) {
        lines.push(`  ${group.displayName}`);
        for (const bucket of group.buckets) {
          const rem = remainingPercent(bucket.remainingFraction);
          lines.push(
            `    ${progressBar(bucket.remainingFraction)} ${bucket.displayName}: ${rem ?? "?"}% left · resets ${formatReset(bucket.resetTime)}`,
          );
        }
      }
      continue;
    }

    if (usage.quotaSummaryError) {
      lines.push(`  ${quotaErrorNote(usage.quotaSummaryError)}`);
    } else {
      lines.push("  No aggregate quota groups returned.");
    }
    const familyLines = formatFamilyQuotaLines(usage.models);
    if (familyLines.length > 0) {
      lines.push(...familyLines.map((line) => `  ${line}`));
    } else if (usage.catalogError) {
      lines.push(`  Model catalog unavailable: ${usage.catalogError.slice(0, 120)}`);
    } else {
      lines.push("  No model quota data returned.");
    }
  }

  return lines.join("\n");
}

export async function resolveApiKeyFromContext(
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  try {
    return await ctx.modelRegistry.getApiKeyForProvider("antigravity");
  } catch {
    return undefined;
  }
}

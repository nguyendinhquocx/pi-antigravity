import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelFamily } from "../models/family.js";
import type { AntigravityApiKey } from "../types/types.js";
import { apiKeyFor, ensureFresh, loadAccountStore, saveAccountStore } from "./accounts.js";
import type { AccountsFile, StoredAccount } from "./accounts.js";

/**
 * Smart multi-account balancer.
 *
 * Picks the healthiest linked account for a model family on every request,
 * entirely in memory: auth.json is never rewritten here (per-request isolation
 * for parallel sessions/subagents). Only antigravity-accounts.json may be
 * updated, to persist refreshed access tokens for later requests.
 */

/** Hard quota-wall (429) blacklist: account is benched for this long. */
const QUOTA_429_COOLDOWN_MS = 10 * 60 * 1000;
/** Refresh-token failure blacklist: benched longer so dead accounts stop costing latency. */
const TOKEN_FAIL_COOLDOWN_MS = 30 * 60 * 1000;
/** Score gap below which two accounts count as equal and round-robin takes over. */
const SCORE_TIE_EPSILON = 0.02;

/** accountId -> blacklist expiry (ms epoch). Accounts dinged by 429s or dead refresh tokens. */
const rateLimitedAccounts = new Map<string, number>();
/** accountId -> dispatch sequence. Monotonic counter (not wall clock) so round-robin
 * still rotates for burst requests landing in the same millisecond. */
const lastDispatchedAt = new Map<string, number>();
let dispatchSequence = 0;

export function markAccountRateLimited(
  accountId: string,
  cooldownMs: number = QUOTA_429_COOLDOWN_MS,
): void {
  rateLimitedAccounts.set(accountId, Date.now() + cooldownMs);
}

export function isAccountAvailable(accountId: string): boolean {
  const expiresAt = rateLimitedAccounts.get(accountId);
  if (expiresAt === undefined) return true;
  if (Date.now() >= expiresAt) {
    rateLimitedAccounts.delete(accountId);
    return true;
  }
  return false;
}

/** Clear in-memory blacklist and round-robin state. Exposed for tests. */
export function resetBalancerState(): void {
  rateLimitedAccounts.clear();
  lastDispatchedAt.clear();
  dispatchSequence = 0;
}

// --- Quota cache (written by costats into %LOCALAPPDATA%\quoc-ai-usage) ---

type QuotaCacheBucketRaw = { label?: unknown; pct?: unknown; reset_iso?: unknown };
type QuotaCacheGroupRaw = { name?: unknown; buckets?: unknown };
type QuotaCacheAccountRaw = { email?: unknown; groups?: unknown };

export type AntigravityQuotaCache = {
  accounts?: QuotaCacheAccountRaw[];
  groups?: QuotaCacheGroupRaw[];
};

function quotaCachePath(): string | undefined {
  const base = process.env.LOCALAPPDATA;
  if (!base) return undefined;
  return join(base, "quoc-ai-usage", "antigravity_cache.json");
}

/** Read the costats quota cache; tolerant of missing or malformed files. */
export function loadQuotaCache(): AntigravityQuotaCache | undefined {
  const path = quotaCachePath();
  if (!path || !existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isQuotaCacheShape(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isQuotaCacheShape(value: unknown): value is AntigravityQuotaCache {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Array.isArray narrows unknown to any[]; route through here to keep element types. */
function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function lastDispatch(accountId: string): number {
  return lastDispatchedAt.get(accountId) ?? 0;
}

function stampDispatch(accountId: string): void {
  lastDispatchedAt.set(accountId, ++dispatchSequence);
}

/**
 * Remaining-quota score of one account for a model family, in [0, 1].
 *
 * Reads the costats cache (accounts[].groups[].buckets[]) where `pct` is the USED
 * percentage, so remaining = (100 - pct) / 100. A bucket whose reset time has
 * passed counts as fully available (1.0). The family score is the MIN across all
 * buckets of that family (both 5H and weekly windows): the tightest window is
 * what will hit the wall first. Returns -1 when there is no cached data for the
 * account, signalling "quota unknown".
 */
export function calculateAccountScore(
  account: StoredAccount,
  family: ModelFamily,
  cacheData?: AntigravityQuotaCache,
): number {
  const cache = cacheData ?? loadQuotaCache();
  if (!cache) return -1;
  const email = account.email?.trim().toLowerCase();
  if (!email) return -1;
  const accounts = asArray<QuotaCacheAccountRaw>(cache.accounts);
  const entry = accounts.find(
    (candidate) =>
      typeof candidate?.email === "string" && candidate.email.trim().toLowerCase() === email,
  );
  const groups = asArray<QuotaCacheGroupRaw>(entry?.groups);
  const now = Date.now();
  const remaining: number[] = [];
  for (const group of groups) {
    if (typeof group?.name !== "string" || group.name.trim().toLowerCase() !== family) continue;
    const buckets = asArray<QuotaCacheBucketRaw>(group.buckets);
    for (const bucket of buckets) {
      const resetIso = typeof bucket?.reset_iso === "string" ? bucket.reset_iso : undefined;
      const resetAt = resetIso !== undefined ? Date.parse(resetIso) : Number.NaN;
      if (Number.isFinite(resetAt) && resetAt <= now) {
        remaining.push(1);
        continue;
      }
      if (typeof bucket?.pct === "number" && Number.isFinite(bucket.pct)) {
        remaining.push(Math.max(0, (100 - bucket.pct) / 100));
      }
    }
  }
  if (remaining.length === 0) return -1;
  return Math.min(...remaining);
}

/**
 * Pick the best available account for a family and return it with a fresh token.
 *
 * Ordering: with cached quota data, highest remaining score first (accounts within
 * SCORE_TIE_EPSILON count as tied and rotate by least-recently-dispatched);
 * without any cache data, pure in-memory round-robin. Each candidate goes through
 * ensureFresh: dead refresh tokens bench the account (30 min) and the next one is
 * tried. Refreshed tokens are persisted to antigravity-accounts.json so later
 * requests reuse them — never to auth.json.
 */
export async function selectBestAccountForFamily(
  family: ModelFamily,
  store: AccountsFile,
  triedAccountIds: ReadonlySet<string> = new Set<string>(),
  cacheData?: AntigravityQuotaCache,
): Promise<StoredAccount | undefined> {
  const cache = cacheData ?? loadQuotaCache();
  const healthy = Object.values(store.accounts).filter(
    (account) => !triedAccountIds.has(account.accountId) && isAccountAvailable(account.accountId),
  );
  if (healthy.length === 0) return undefined;

  const scored = healthy.map((account) => ({
    account,
    score: calculateAccountScore(account, family, cache),
  }));
  const hasCache = scored.some((entry) => entry.score >= 0);
  // Least-recently-dispatched first; accountId breaks ties deterministically.
  const byRoundRobin = (a: StoredAccount, b: StoredAccount) =>
    lastDispatch(a.accountId) - lastDispatch(b.accountId) || a.accountId.localeCompare(b.accountId);

  const ordered = scored.sort((a, b) => {
    if (hasCache && Math.abs(a.score - b.score) >= SCORE_TIE_EPSILON) {
      return b.score - a.score;
    }
    return byRoundRobin(a.account, b.account);
  });

  for (const candidate of ordered) {
    let fresh: StoredAccount;
    try {
      fresh = await ensureFresh(candidate.account);
    } catch {
      // Refresh token no longer valid: bench this account, try the next one.
      markAccountRateLimited(candidate.account.accountId, TOKEN_FAIL_COOLDOWN_MS);
      continue;
    }
    if (
      fresh.access !== candidate.account.access ||
      fresh.expires !== candidate.account.expires
    ) {
      store.accounts[fresh.accountId] = fresh;
      try {
        const latest = loadAccountStore();
        latest.accounts[fresh.accountId] = fresh;
        saveAccountStore(latest);
      } catch {
        // Best-effort persistence: never bench a healthy account on Windows file-lock races.
      }
    }
    stampDispatch(fresh.accountId);
    return fresh;
  }
  return undefined;
}

/**
 * In-memory 429 failover: pick the next healthy account for a family without
 * rewriting auth.json. Excludes accounts already tried in this request (by id and
 * by access token, since tokens rotate on refresh). Returns undefined when the
 * pool is exhausted.
 */
export async function failoverToNextAccountInMemory(
  family: ModelFamily,
  store: AccountsFile,
  triedAccountIds: ReadonlySet<string> = new Set<string>(),
  triedAccessTokens: ReadonlySet<string> = new Set<string>(),
  cacheData?: AntigravityQuotaCache,
): Promise<AntigravityApiKey | undefined> {
  const excluded = new Set(triedAccountIds);
  for (const account of Object.values(store.accounts)) {
    if (triedAccessTokens.has(account.access)) excluded.add(account.accountId);
  }
  const next = await selectBestAccountForFamily(family, store, excluded, cacheData);
  if (!next || triedAccessTokens.has(next.access)) return undefined;
  return apiKeyFor(next);
}

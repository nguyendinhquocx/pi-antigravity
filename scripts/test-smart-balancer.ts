import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-antigravity-balancer-"));

const {
  calculateAccountScore,
  failoverToNextAccountInMemory,
  isAccountAvailable,
  loadQuotaCache,
  markAccountRateLimited,
  resetBalancerState,
  selectBestAccountForFamily,
} = await import("../src/auth/balancer.ts");
const { loadAccountStore, saveAccountStore } = await import("../src/auth/accounts.ts");

// Sanity: the costats cache reader must never throw, file or no file.
loadQuotaCache();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const FRESH_EXPIRES = Date.now() + 60 * 60 * 1000;

type FixtureAccount = {
  accountId: string;
  email: string;
  access: string;
  refresh: string;
  expires: number;
  projectId: string;
  addedAt: number;
  lastUsedAt: number;
};

function account(
  id: string,
  access: string,
  overrides: Partial<FixtureAccount> = {},
): FixtureAccount {
  return {
    accountId: id,
    email: id,
    access,
    refresh: `refresh-${id}`,
    expires: FRESH_EXPIRES,
    projectId: `proj-${id}`,
    addedAt: 1,
    lastUsedAt: 1,
    ...overrides,
  };
}

type FixtureBucket = { label: string; pct: number; reset_iso?: string };
type FixtureGroup = { name: string; buckets: FixtureBucket[] };

function group(name: string, pct5h?: number, pctWeek?: number): FixtureGroup {
  const buckets: FixtureBucket[] = [];
  if (pct5h !== undefined) buckets.push({ label: "5H", pct: pct5h });
  if (pctWeek !== undefined) buckets.push({ label: "Week", pct: pctWeek });
  return { name, buckets };
}

function cacheFor(
  perAccount: Record<string, FixtureGroup[]>,
): { accounts: { email: string; groups: FixtureGroup[] }[] } {
  return {
    accounts: Object.entries(perAccount).map(([email, groups]) => ({ email, groups })),
  };
}

function writeStore(accounts: FixtureAccount[]): ReturnType<typeof loadAccountStore> {
  const store = loadAccountStore();
  store.accounts = {};
  for (const entry of accounts) store.accounts[entry.accountId] = entry;
  saveAccountStore(store);
  return store;
}

const authPath = join(process.env.PI_CODING_AGENT_DIR!, "auth.json");
function assertNoAuthJson(context: string): void {
  assert(!existsSync(authPath), `${context}: auth.json was written by the balancer`);
}

// --- calculateAccountScore ---
{
  const store = writeStore([account("solo@example.com", "access-solo")]);
  const solo = Object.values(store.accounts)[0]!;
  const cache = cacheFor({
    "solo@example.com": [group("Claude", 8, 3), group("Gemini", 100), group("Argon", 20)],
  });
  // pct is USED %, so remaining is (100 - pct) / 100; family score is min across buckets.
  assert(calculateAccountScore(solo, "claude", cache) === 0.92, "claude min(5H,Week) wrong");
  assert(calculateAccountScore(solo, "gemini", cache) === 0, "exhausted bucket must score 0");
  assert(calculateAccountScore(solo, "argon", cache) === 0.8, "argon week bucket wrong");
  assert(calculateAccountScore(solo, "unknown", cache) === -1, "unknown family must score -1");
  assert(
    calculateAccountScore(account("ghost@example.com", "x"), "claude", cache) === -1,
    "account missing from cache must score -1",
  );
  // Reset window already passed -> bucket counts as fully available.
  const past = new Date(Date.now() - 60_000).toISOString();
  const resetCache = cacheFor({ "solo@example.com": [group("Claude", 100)] });
  (resetCache.accounts[0]!.groups[0]!.buckets[0] as FixtureBucket).reset_iso = past;
  assert(calculateAccountScore(solo, "claude", resetCache) === 1, "reset bucket must score 1.0");
}

// --- Scenario 1: skewed quotas -> highest remaining account wins ---
{
  resetBalancerState();
  writeStore([
    account("a@example.com", "access-a"),
    account("b@example.com", "access-b"),
    account("c@example.com", "access-c"),
  ]);
  const cache = cacheFor({
    "a@example.com": [group("Claude", 60, 40)],
    "b@example.com": [group("Claude", 20, 20)],
    "c@example.com": [group("Claude", 0, 10)],
  });
  const store = loadAccountStore();
  const best = await selectBestAccountForFamily("claude", store, new Set<string>(), cache);
  assert(best?.access === "access-c", `expected c (highest quota), got ${best?.email}`);
  assertNoAuthJson("quota-first selection");
}

// --- Scenario 2: highest-quota account has a dead token -> falls back to next ---
{
  resetBalancerState();
  // c's access token expired and its refresh token is bogus: ensureFresh must fail
  // (400 from the token endpoint, or a transport error offline) and bench the account.
  writeStore([
    account("a@example.com", "access-a"),
    account("b@example.com", "access-b"),
    account("c@example.com", "access-c-stale", {
      expires: Date.now() - 60_000,
      refresh: "bogus-refresh-c",
    }),
  ]);
  const cache = cacheFor({
    "a@example.com": [group("Claude", 60, 40)],
    "b@example.com": [group("Claude", 20, 20)],
    "c@example.com": [group("Claude", 0, 10)],
  });
  const store = loadAccountStore();
  const best = await selectBestAccountForFamily("claude", store, new Set<string>(), cache);
  assert(best?.access === "access-b", `expected fallback to b, got ${best?.email}`);
  assert(!isAccountAvailable("c@example.com"), "dead account must be benched after failure");
  assertNoAuthJson("dead-token fallback");
}

// --- Scenario 3: no cache -> round-robin spreads dispatches evenly ---
{
  resetBalancerState();
  const accounts = [
    account("a@example.com", "access-a"),
    account("b@example.com", "access-b"),
    account("c@example.com", "access-c"),
  ];
  writeStore(accounts);
  const store = loadAccountStore();
  const noCache = { accounts: [] };
  const picks: string[] = [];
  for (let i = 0; i < 6; i++) {
    const pick = await selectBestAccountForFamily("gemini", store, new Set<string>(), noCache);
    picks.push(pick?.accountId ?? "none");
  }
  const counts = new Map(picks.map((id) => [id, picks.filter((p) => p === id).length]));
  assert(
    picks.every((p) => accounts.some((a) => a.accountId === p)),
    `round-robin picked unknown accounts: ${picks.join(",")}`,
  );
  assert(
    [...counts.values()].every((count) => count === 2),
    `round-robin uneven: ${picks.join(",")}`,
  );
  // Tied scores with cache present must also rotate round-robin.
  resetBalancerState();
  const tied = cacheFor({
    "a@example.com": [group("Gemini", 10)],
    "b@example.com": [group("Gemini", 10)],
    "c@example.com": [group("Gemini", 10)],
  });
  const tiedPicks: string[] = [];
  for (let i = 0; i < 3; i++) {
    const pick = await selectBestAccountForFamily("gemini", store, new Set<string>(), tied);
    tiedPicks.push(pick?.accountId ?? "none");
  }
  assert(
    new Set(tiedPicks).size === 3,
    `tied scores must rotate, got ${tiedPicks.join(",")}`,
  );
  assertNoAuthJson("round-robin");
}

// --- Scenario 4: single account -> returns it even when quota is low ---
{
  resetBalancerState();
  writeStore([account("d@example.com", "access-d")]);
  const cache = cacheFor({ "d@example.com": [group("Claude", 95)] });
  const store = loadAccountStore();
  const best = await selectBestAccountForFamily("claude", store, new Set<string>(), cache);
  assert(best?.access === "access-d", "single account must be returned");
  assertNoAuthJson("single account");
}

// --- Scenario 5: in-memory 429 failover skips tried ids/tokens and benched accounts ---
{
  resetBalancerState();
  writeStore([
    account("a@example.com", "access-a"),
    account("b@example.com", "access-b"),
    account("c@example.com", "access-c"),
  ]);
  const cache = cacheFor({
    "a@example.com": [group("Claude", 10)],
    "b@example.com": [group("Claude", 20)],
    "c@example.com": [group("Claude", 0)],
  });
  const store = loadAccountStore();
  // Current account c hit the wall: bench it, then fail over past tried ids/tokens.
  markAccountRateLimited("c@example.com");
  const next = await failoverToNextAccountInMemory(
    "claude",
    store,
    new Set<string>(["c@example.com"]),
    new Set<string>(["access-c", "access-a"]),
    cache,
  );
  assert(next?.token === "access-b", `expected failover to b, got ${next?.token ?? "none"}`);

  // Exhaust the whole pool: everything tried or benched -> undefined.
  markAccountRateLimited("b@example.com");
  const exhausted = await failoverToNextAccountInMemory(
    "claude",
    store,
    new Set<string>(["c@example.com"]),
    new Set<string>(["access-c", "access-a", "access-b"]),
    cache,
  );
  assert(exhausted === undefined, "failover must return undefined when the pool is empty");
  assertNoAuthJson("429 failover");
}

// --- Scenario 6: blacklist expiry ---
{
  markAccountRateLimited("temp@example.com", 0);
  assert(isAccountAvailable("temp@example.com"), "expired cooldown must release the account");
  markAccountRateLimited("fresh@example.com");
  assert(!isAccountAvailable("fresh@example.com"), "default cooldown must bench the account");
}

// --- Scenario 7: default account in auth.json is NOT wrongly excluded from 429 failover ---
{
  resetBalancerState();
  // Account A is active in auth.json, Account B has higher quota.
  // Balancer picks B. When B hits 429, failover MUST consider A!
  writeStore([
    account("a@example.com", "access-a"),
    account("b@example.com", "access-b"),
  ]);
  const cache = cacheFor({
    "a@example.com": [group("Claude", 40)],
    "b@example.com": [group("Claude", 10)],
  });
  const store = loadAccountStore();
  const triedAccountIds = new Set<string>();
  const triedAccessTokens = new Set<string>();

  // Balancer picks B
  const best = await selectBestAccountForFamily("claude", store, triedAccountIds, cache);
  assert(best?.accountId === "b@example.com", "expected B to be selected");
  triedAccountIds.add(best.accountId);
  triedAccessTokens.add(best.access);

  // Now B hits 429: bench B, fail over
  markAccountRateLimited("b@example.com");
  const next = await failoverToNextAccountInMemory(
    "claude",
    store,
    triedAccountIds,
    triedAccessTokens,
    cache,
  );
  assert(next?.token === "access-a", `expected failover to account A, got ${next?.token ?? "none"}`);
  assertNoAuthJson("failover-back-to-default");
}

console.log("smart balancer tests: ok");

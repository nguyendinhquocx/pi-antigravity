import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { streamAntigravity } from "../src/stream/stream.js";
import { ANTIGRAVITY_MODELS } from "../src/models/index.js";

const savedFetch = globalThis.fetch;
const savedPrewarm = process.env.ANTIGRAVITY_NO_PREWARM;
process.env.ANTIGRAVITY_NO_PREWARM = "1";
const bodies: any[] = [];
const model = { ...ANTIGRAVITY_MODELS[0], api: "antigravity", provider: "antigravity" } as Model<Api>;
const options = { apiKey: JSON.stringify({ token: "test", projectId: "test-project" }), sessionId: "recovery-test" };
try {
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (++calls === 1) throw new Error("fetch failed");
    return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n');
  }) as typeof fetch;
  const first = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  assert.equal(calls, 2, "transport errors try the next endpoint");
  assert.notEqual(bodies[0].request.sessionId, bodies[1].request.sessionId);
  const second = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.notEqual(bodies[1].request.sessionId, bodies[2].request.sessionId);

  globalThis.fetch = (async () => { throw new Error("transport timed out"); }) as typeof fetch;
  const failed = await streamAntigravity(model, { messages: [] }, options).result();
  assert.match(failed.errorMessage ?? "", /timed out/);
  const controller = new AbortController();
  controller.abort();
  let abortCalls = 0;
  globalThis.fetch = (async () => { abortCalls++; throw new Error("cancelled"); }) as typeof fetch;
  const aborted = await streamAntigravity(model, { messages: [] }, { ...options, signal: controller.signal }).result();
  assert.equal(aborted.stopReason, "aborted");
  assert.ok(abortCalls <= 1, "caller cancellation never falls through endpoints");

  // Recovery test 1: MALFORMED_FUNCTION_CALL retries and succeeds on attempt 2
  let malformedCalls = 0;
  globalThis.fetch = (async () => {
    if (++malformedCalls === 1) {
      return new Response('data: {"response":{"candidates":[{"finishReason":"MALFORMED_FUNCTION_CALL"}]}}\n\ndata: [DONE]\n\n');
    }
    return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"recovered from malformed call"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n');
  }) as typeof fetch;
  const malformedRecovered = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(malformedRecovered.stopReason, "stop");
  assert.equal(malformedCalls, 2, "MALFORMED_FUNCTION_CALL must trigger auto-retry");
  assert.equal(malformedRecovered.content[0]?.type === "text" ? malformedRecovered.content[0].text : "", "recovered from malformed call");

  // Recovery test 2: Thinking-only (no real text) retries and succeeds on attempt 2
  let thinkingOnlyCalls = 0;
  globalThis.fetch = (async () => {
    if (++thinkingOnlyCalls === 1) {
      return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"just thinking"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n');
    }
    return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"second thought"},{"text":"now answering"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n');
  }) as typeof fetch;
  const thinkingRecovered = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(thinkingRecovered.stopReason, "stop");
  assert.equal(thinkingOnlyCalls, 2, "Thinking-only response must trigger auto-retry");
  const recoveredText = thinkingRecovered.content.find((b) => b.type === "text");
  assert.equal(recoveredText?.type === "text" ? recoveredText.text : "", "now answering");

  // Recovery test 3: generic RESOURCE_EXHAUSTED 429 on gemini-3.8-flash-high degrades
  // to the fallback runtime candidate (gemini-3.7-flash-high) instead of failing the turn.
  let capacityCalls = 0;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (++capacityCalls === 1) {
      assert.equal(body.model, "gemini-3.8-flash-high");
      return new Response(
        JSON.stringify({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } }),
        { status: 429 },
      );
    }
    assert.equal(body.model, "gemini-3.7-flash-high");
    return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"served by fallback model"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n');
  }) as typeof fetch;
  const fallbackServed = await streamAntigravity(
    model,
    { messages: [] },
    { ...options, reasoning: "high" },
  ).result();
  assert.equal(fallbackServed.stopReason, "stop");
  assert.equal(capacityCalls, 2, "capacity 429 must try the fallback runtime candidate");
  const fallbackText = fallbackServed.content.find((b) => b.type === "text");
  assert.equal(fallbackText?.type === "text" ? fallbackText.text : "", "served by fallback model");

  // Recovery test 4: capacity 429 rotates to the next linked account (in memory,
  // auth.json untouched) when the whole runtime-candidate list is throttled.
  const isolatedDir = mkdtempSync(join(tmpdir(), "pi-antigravity-recovery-"));
  process.env.PI_CODING_AGENT_DIR = isolatedDir;
  const storedAccounts = {
    version: 1,
    activeAccountId: "acc-a",
    accounts: {
      "acc-a": {
        accountId: "acc-a",
        email: "a@test.local",
        access: "token-a",
        refresh: "refresh-a",
        expires: Date.now() + 60 * 60 * 1000,
        projectId: "proj-a",
        addedAt: 1,
        lastUsedAt: 1,
      },
      "acc-b": {
        accountId: "acc-b",
        email: "b@test.local",
        access: "token-b",
        refresh: "refresh-b",
        expires: Date.now() + 60 * 60 * 1000,
        projectId: "proj-b",
        addedAt: 1,
        lastUsedAt: 1,
      },
    },
  };
  writeFileSync(join(isolatedDir, "antigravity-accounts.json"), JSON.stringify(storedAccounts));
  let rotationCalls = 0;
  const seenTokens: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seenTokens.push(String(headers.Authorization ?? "").replace("Bearer ", ""));
    if (++rotationCalls <= 2) {
      // Throttle both runtime candidates (gemini-3.8-flash-high then gemini-3.7-flash-high)
      // on the first account before the in-memory rotation kicks in.
      return new Response(
        JSON.stringify({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } }),
        { status: 429 },
      );
    }
    return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"served by second account"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n');
  }) as typeof fetch;
  const rotated = await streamAntigravity(
    model,
    { messages: [] },
    {
      apiKey: JSON.stringify({ token: "token-a", projectId: "proj-a" }),
      sessionId: "rotation-test",
      reasoning: "high",
    },
  ).result();
  assert.equal(rotated.stopReason, "stop");
  assert.ok(seenTokens.includes("token-a"), "first attempt used the throttled account");
  assert.ok(seenTokens.includes("token-b"), "capacity 429 rotated to the next account");
  const rotatedText = rotated.content.find((b) => b.type === "text");
  assert.equal(rotatedText?.type === "text" ? rotatedText.text : "", "served by second account");
} finally {
  globalThis.fetch = savedFetch;
  if (savedPrewarm === undefined) delete process.env.ANTIGRAVITY_NO_PREWARM;
  else process.env.ANTIGRAVITY_NO_PREWARM = savedPrewarm;
}
console.log("stream recovery: endpoint fallback, fresh identity, transport errors and cancellation passed");

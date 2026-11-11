import { detectModelFamily } from "../src/models/family.js";

const cases: Array<[string, string]> = [
  // Static catalog models
  ["gemini-3.8-flash", "gemini"],
  ["gemini-3.7-flash", "gemini"],
  ["gemini-3.6-flash", "gemini"],
  ["gemini-3.5-flash", "gemini"],
  ["gemini-3.1-pro", "gemini"],
  ["claude-opus-4-6", "claude"],
  ["claude-sonnet-4-6", "claude"],
  // Dynamic catalog models
  ["gemini-4-argon", "argon"],
  ["claude-sonnet-5-5", "claude"],
  ["claude-opus-5-5", "claude"],
  // GPT models share the Claude quota pool
  ["gpt-oss-120b", "claude"],
  ["gpt-oss-20b", "claude"],
  ["GPT-OSS-120B", "claude"],
  ["Claude-Sonnet-5-5", "claude"],
  // Argon must win over gemini even with case variants
  ["Gemini-4-Argon", "argon"],
  // Unknown / unmapped ids
  ["", "unknown"],
  ["unmapped-model-x", "unknown"],
  ["image-model-pro", "unknown"],
];

let failures = 0;
for (const [modelId, expected] of cases) {
  const actual = detectModelFamily(modelId);
  if (actual !== expected) {
    failures++;
    console.error(`FAIL detectModelFamily(${JSON.stringify(modelId)}) = ${actual}, want ${expected}`);
  }
}

if (failures > 0) {
  throw new Error(`${failures} model family detection case(s) failed`);
}
console.log(`family tests: ok (${cases.length} cases)`);

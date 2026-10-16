// Minimal smoke test: load the plugin and verify it registers the expected
// tools. Run with `npm test` (or `node scripts/smoke.mjs`).
//
// It does not talk to the OpenCode server; it only checks the plugin shape and
// tool registration.

import plugin from "../index.js";

const added = [];

const ctx = {
  location: { directory: process.cwd() },
  options: {},
  tool: {
    async transform(callback) {
      callback({ add: (tool) => added.push(tool) });
      return { dispose: async () => {} };
    },
  },
};

if (plugin.id !== "opencode-session-tool") {
  console.error(`FAIL: unexpected plugin id "${plugin.id}"`);
  process.exit(1);
}

await plugin.setup(ctx);

const names = added.map((t) => t.name);
const expected = ["session_list", "session_read", "session_search", "session_info"];
const missing = expected.filter((name) => !names.includes(name));

console.log(`plugin id: ${plugin.id}`);
console.log(`tools: ${names.join(", ")}`);

if (missing.length > 0) {
  console.error(`FAIL: missing tools: ${missing.join(", ")}`);
  process.exit(1);
}

for (const tool of added) {
  if (typeof tool.execute !== "function") {
    console.error(`FAIL: tool "${tool.name}" has no execute function`);
    process.exit(1);
  }
  if (!tool.input || tool.input.type !== "object") {
    console.error(`FAIL: tool "${tool.name}" has no object input schema`);
    process.exit(1);
  }
}

console.log("OK");

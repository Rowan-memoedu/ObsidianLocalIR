import assert from "node:assert/strict";
import { readPluginSource } from "./plugin-source.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const source = readPluginSource();

assert.ok(source.includes("/api/browser-import/requests"), "Obsidian must submit URL work through the import-request interface");
assert.ok(source.includes("/api/browser-import/requests/${encodeURIComponent(created.request_id)}"), "Obsidian must poll the request receipt");
assert.ok(source.includes("client_request_id: clientRequestId"), "Obsidian must make request creation idempotent across lost responses");
assert.ok(source.includes("resumeInterruptedPendingImports"), "Obsidian must resume persisted browser-import requests after reload");
assert.ok(source.includes("brokerClientRequestId"), "pending imports must retain the durable broker request identity");
assert.ok(source.includes("for (let attempt = 1; attempt <= 3; attempt += 1)"), "local broker transport must retry transient failures");
assert.equal(source.includes("url: `http://127.0.0.1:${port}/api/highlights/import-local-urls`"), false, "Obsidian must not use server-side URL acquisition");
assert.ok(source.includes('"idempotent_replay"'), "Obsidian must preserve idempotent broker receipts as success");
assert.ok(source.includes('"imported_with_warnings"'), "Obsidian must preserve readable warning receipts as success");
assert.ok(source.includes("Markdown 有瑕疵，请复核"), "Obsidian must distinguish readable Markdown warnings from failed imports");
assert.ok(source.includes('"requires_browser_auth"'), "Obsidian must preserve the browser-auth degraded status");
assert.ok(source.includes('"requires_js_render"'), "Obsidian must preserve the JavaScript-render degraded status");
assert.ok(source.includes("等待后台静默抓取与标准加工"), "Obsidian receipt UI must describe the shared background executor");
assert.ok(source.includes("saveSettings({ flushDocumentStateSidecars: false })"), "queue-only state changes must not flush document sidecars");
assert.ok(source.includes("const diskEntry = await adapter.stat(current).catch(() => null)"), "folder creation must inspect disk state outside the Obsidian index");
assert.ok(source.includes("if (afterCreate?.type === \"folder\") continue"), "hidden or concurrently created folders must be idempotent");
assert.ok(source.includes("if (activeFilePath === this.lastHandledActiveFilePath) return"), "sidebar focus changes must not rerender away the first import-button click");
assert.ok(source.includes("this.lastHandledActiveFilePath = this.app.workspace.getActiveFile()?.path || null"), "first sidebar focus must compare against the file active at plugin load");

console.log(JSON.stringify({
  status: "passed",
  checks: ["request_interface", "receipt_polling", "idempotent_request_creation", "reload_resume", "transport_retry", "legacy_server_fetch_removed", "idempotent_replay_preserved", "readable_warning_preserved", "degraded_statuses_preserved", "shared_background_executor_ui", "queue_save_isolated", "hidden_folder_idempotency", "first_click_preserved"]
}, null, 2));

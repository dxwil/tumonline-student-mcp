import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createAccessToken, saveTumToken } from "../src/access.js";
import { createDownloadDesk } from "../src/download-desk.js";
import { startHttpServer } from "../src/http-server.js";
import { FIXTURES, tempDir, testEnv, TOKEN } from "./support.js";

function raw(port, headers, path = "/healthz") {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

test("health, missing bearer, host allowlist, and origin allowlist", async () => {
  const stateDir = tempDir();
  const server = await startHttpServer({
    env: testEnv(stateDir, { TUMONLINE_MCP_PUBLIC_URL: "https://tumonline-mcp.kersys.lt", TUMONLINE_MCP_ALLOWED_HOSTS: "tumonline-mcp.kersys.lt" }),
    host: "127.0.0.1",
    port: 0,
    log: () => {},
  });
  const port = server.address().port;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.deepEqual(await health.json(), { ok: true });
    const missing = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: "{}" });
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get("www-authenticate"), /resource_metadata/);
    assert.match(missing.headers.get("www-authenticate"), /mcp:tools/);
    const query = await fetch(`http://127.0.0.1:${port}/mcp?token=1`);
    assert.equal(query.status, 400);
    assert.equal(await raw(port, { host: "evil.example" }), 403);
    const evilOrigin = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { origin: "https://evil.example" } });
    assert.equal(evilOrigin.status, 403);
    assert.equal(await raw(port, { host: "tumonline-mcp.kersys.lt" }), 200);
    const created = createAccessToken(stateDir, { label: "laptop" });
    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    assert.equal(init.status, 200);
    assert.match(init.headers.get("mcp-session-id"), /^[a-f0-9]{64}$/);
  } finally {
    await closeServer(server);
  }
});

test("a one-time /files link streams the body and does not embed it or log the token", async () => {
  const stateDir = tempDir();
  const env = testEnv(stateDir);
  const userId = `u_${"a".repeat(32)}`;
  saveTumToken(stateDir, userId, env, { token: TOKEN, source: "pasted", confirmed: true, tokenName: "tumonline-student-mcp" });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response("file-bytes", { status: 200, headers: { "content-type": "text/plain" } });
  };
  const downloads = createDownloadDesk();
  const logs = [];
  const server = await startHttpServer({ env, fetchImpl, downloads, host: "127.0.0.1", port: 0, log: (line) => logs.push(line) });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const issued = downloads.issue({ userId, url: "https://campus.tum.de/tumonline/co/example", filename: "note.txt", mimeType: "text/plain", base });
    assert.match(issued.downloadUrl, /\/files\//);
    assert.equal(JSON.stringify(issued).includes("file-bytes"), false);
    const head = await fetch(issued.downloadUrl, { method: "HEAD" });
    assert.equal(head.status, 200);
    const first = await fetch(issued.downloadUrl);
    assert.equal(await first.text(), "file-bytes");
    assert.equal(first.headers.get("content-disposition").includes("note.txt"), true);
    const second = await fetch(issued.downloadUrl);
    assert.equal(second.status, 404);
    assert.match(calls[0], new RegExp(`pToken=${TOKEN}`));
    assert.equal(logs.join("").includes(TOKEN), false);
  } finally {
    await closeServer(server);
  }
});

test("static bearer creation prints the bearer once and a connect request does not print the TUMonline token", async () => {
  const stateDir = tempDir();
  const { main } = await import("../src/server.js");
  const stdout = [];
  const stderr = [];
  const code = await main(["token", "create", "--label", "laptop"], testEnv(stateDir), async () => new Response(""), {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  assert.equal(code, 0);
  assert.match(stdout.join(""), /^tsm_/);
  const listed = [];
  await main(["token", "list"], testEnv(stateDir), async () => new Response(""), { stdout: (text) => listed.push(text), stderr: () => {} });
  assert.match(listed.join(""), /laptop/);
  assert.equal(listed.join("").includes(stdout.join("").trim()), false);
  const requested = [];
  const connect = await main(["connect", "request", "ab12cde"], testEnv(stateDir), async (url) => {
    assert.match(String(url), /requestToken/);
    return new Response(FIXTURES.token, { headers: { "content-type": "text/xml" } });
  }, { stdout: (text) => requested.push(text), stderr: () => {} });
  assert.equal(connect, 0);
  assert.match(requested.join("\n"), /Token-Management/);
  assert.equal(requested.join("").includes(TOKEN), false);
});

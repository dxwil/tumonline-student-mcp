import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadTumToken } from "../src/access.js";
import { startHttpServer } from "../src/http-server.js";
import { FIXTURES, mockTum, tempDir, testEnv, TOKEN, TOKEN_B, TUM_ID } from "./support.js";

const REDIRECT = "http://127.0.0.1:9/callback";
const ACCEPT = "application/json, text/event-stream";

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function tumFetch(map = {}) {
  return mockTum([
    { match: (url) => url.pathname.endsWith(".requestToken"), body: (url) => (map.request ?? FIXTURES.token) },
    { match: (url) => url.pathname.endsWith(".isTokenConfirmed"), body: (url) => (url.searchParams.get("pToken") === TOKEN_B ? FIXTURES.confirmed : (map.confirmed ?? FIXTURES.confirmed)) },
    { match: (url) => url.pathname.endsWith(".id"), body: (url) => (url.searchParams.get("pToken") === TOKEN_B ? FIXTURES.identity.replace("ab12cde", "xy99zzz") : FIXTURES.identity) },
  ]);
}

async function boot(fetchImpl) {
  const stateDir = tempDir();
  const logs = [];
  const server = await startHttpServer({
    env: testEnv(stateDir),
    fetchImpl,
    host: "127.0.0.1",
    port: 0,
    log: (line) => logs.push(line),
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, stateDir, logs };
}

async function register(base) {
  const response = await fetch(new URL("/register", base), {
    method: "POST",
    headers: { "content-type": "application/json", host: new URL(base).host },
    body: JSON.stringify({ client_name: "Test Client", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function authorizePage(base, clientId) {
  const { verifier, challenge } = pkce();
  const url = new URL("/authorize", base);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "mcp:tools");
  url.searchParams.set("resource", `${base}/mcp`);
  url.searchParams.set("state", "xyz");
  const response = await fetch(url);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("referrer-policy"), "same-origin");
  const txn = /name="txn" value="([^"]+)"/.exec(html)[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  const cookie = (response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie")]).join(";");
  return { verifier, html, txn, csrf, cookie };
}

async function postForm(base, fields, cookie) {
  return fetch(new URL("/authorize", base), {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: base,
      cookie,
    },
    body: new URLSearchParams(fields),
  });
}

async function exchange(base, clientId, code, verifier) {
  const response = await fetch(new URL("/token", base), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: `${base}/mcp` }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("discovery, PKCE sign-in, encrypted token, refresh rotation, and revoke", async () => {
  const tum = tumFetch();
  const { server, base, stateDir, logs } = await boot(tum.fetchImpl);
  try {
    const metadata = await fetch(new URL("/.well-known/oauth-authorization-server", base));
    const body = await metadata.json();
    assert.equal(body.code_challenge_methods_supported[0], "S256");
    assert.deepEqual(body.scopes_supported, ["mcp:tools"]);
    const resource = await fetch(new URL("/.well-known/oauth-protected-resource", base));
    assert.equal((await resource.json()).resource, `${base}/mcp`);
    const client = await register(base);
    const page = await authorizePage(base, client.client_id);
    assert.match(page.html, /Token-Management/);
    assert.match(page.html, /calendar, lectures, grades/);
    const requested = await postForm(base, { txn: page.txn, csrf: page.csrf, action: "request", tum_id: TUM_ID }, page.cookie);
    const requestedHtml = await requested.text();
    assert.equal(requested.status, 200);
    assert.match(requestedHtml, /Check activation/);
    assert.equal(requestedHtml.includes(TOKEN), false);
    const checked = await postForm(base, { txn: page.txn, csrf: page.csrf, action: "check" }, page.cookie);
    assert.equal(checked.status, 302);
    const code = new URL(checked.headers.get("location")).searchParams.get("code");
    const tokens = await exchange(base, client.client_id, code, page.verifier);
    assert.equal(tokens.token_type, "Bearer");
    assert.equal(tokens.scope, "mcp:tools");
    const stored = fs.readFileSync(findTokenFile(stateDir), "utf8");
    assert.equal(stored.includes(TOKEN), false);
    const userId = path.basename(path.dirname(findTokenFile(stateDir)));
    assert.equal(loadTumToken(stateDir, userId, testEnv(stateDir)).confirmed, true);
    const session = await mcp(base, tokens.access_token, "get_identity", {});
    assert.equal(session.identity.tumId, "ab12cde");
    assert.equal(JSON.stringify(session).includes(TOKEN), false);
    const refreshed = await fetch(new URL("/token", base), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id, resource: `${base}/mcp` }),
    });
    const next = await refreshed.json();
    assert.equal(refreshed.status, 200);
    assert.notEqual(next.refresh_token, tokens.refresh_token);
    const reused = await fetch(new URL("/token", base), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id, resource: `${base}/mcp` }),
    });
    assert.equal(reused.status, 400);
    const revoked = await fetch(new URL("/revoke", base), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: next.refresh_token, client_id: client.client_id }),
    });
    assert.equal(revoked.status, 200);
    const after = await fetch(new URL("/mcp", base), { headers: { authorization: `Bearer ${next.access_token}`, accept: ACCEPT, "content-type": "application/json" }, method: "POST", body: "{}" });
    assert.equal(after.status, 401);
    assert.match(logs.join(""), /\/authorize/);
    assert.equal(logs.join("").includes(TOKEN), false);
    assert.equal(tum.calls.some((call) => call.pathname.endsWith(".requestToken") && call.username === TUM_ID), true);
  } finally {
    await closeServer(server);
  }
});

test("pasting an activated token signs in, and a second user stays separate", async () => {
  const tum = tumFetch();
  const { server, base } = await boot(tum.fetchImpl);
  try {
    const client = await register(base);
    const first = await authorizePage(base, client.client_id);
    const pasted = await postForm(base, { txn: first.txn, csrf: first.csrf, action: "paste", existing_token: TOKEN }, first.cookie);
    assert.equal(pasted.status, 302);
    const code = new URL(pasted.headers.get("location")).searchParams.get("code");
    const tokens = await exchange(base, client.client_id, code, first.verifier);
    const mine = await mcp(base, tokens.access_token, "get_identity", {});
    assert.equal(mine.identity.tumId, "ab12cde");
    const secondPage = await authorizePage(base, client.client_id);
    const secondPaste = await postForm(base, { txn: secondPage.txn, csrf: secondPage.csrf, action: "paste", existing_token: TOKEN_B }, secondPage.cookie);
    const secondCode = new URL(secondPaste.headers.get("location")).searchParams.get("code");
    const secondTokens = await exchange(base, client.client_id, secondCode, secondPage.verifier);
    const other = await mcp(base, secondTokens.access_token, "get_identity", {});
    assert.equal(other.identity.tumId, "xy99zzz");
    const html = await pasted.text().catch(() => "");
    assert.equal(String(html).includes(TOKEN), false);
  } finally {
    await closeServer(server);
  }
});

test("a form post without a same-origin Origin is rejected, and PKCE is required", async () => {
  const tum = tumFetch();
  const { server, base } = await boot(tum.fetchImpl);
  try {
    const client = await register(base);
    const page = await authorizePage(base, client.client_id);
    const missing = await fetch(new URL("/authorize", base), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: page.cookie },
      body: new URLSearchParams({ txn: page.txn, csrf: page.csrf, action: "request", tum_id: TUM_ID }),
    });
    assert.equal(missing.status, 403);
    const bad = new URL("/authorize", base);
    bad.searchParams.set("response_type", "code");
    bad.searchParams.set("client_id", client.client_id);
    bad.searchParams.set("redirect_uri", REDIRECT);
    bad.searchParams.set("code_challenge", "not-s256");
    bad.searchParams.set("code_challenge_method", "plain");
    bad.searchParams.set("resource", `${base}/mcp`);
    const response = await fetch(bad, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.match(response.headers.get("location"), /error=invalid_request/);
  } finally {
    await closeServer(server);
  }
});

test("token limit and an unknown TUM ID stay on the page and are not logged with the token", async () => {
  const tum = tumFetch({ request: FIXTURES.tokenLimit });
  const { server, base, logs } = await boot(tum.fetchImpl);
  try {
    const client = await register(base);
    const page = await authorizePage(base, client.client_id);
    const limited = await postForm(base, { txn: page.txn, csrf: page.csrf, action: "request", tum_id: TUM_ID }, page.cookie);
    const html = await limited.text();
    assert.equal(limited.status, 400);
    assert.match(html, /Token-Limit/);
    assert.equal(logs.join("").includes(TOKEN), false);
  } finally {
    await closeServer(server);
  }
});

async function mcp(base, access, name, args) {
  const init = await fetch(new URL("/mcp", base), {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, accept: ACCEPT, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } }),
  });
  assert.equal(init.status, 200);
  const session = init.headers.get("mcp-session-id");
  const call = await fetch(new URL("/mcp", base), {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, accept: ACCEPT, "content-type": "application/json", "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  const payload = await call.json();
  assert.equal(payload.result.isError, false);
  return JSON.parse(payload.result.content[0].text);
}

function findTokenFile(stateDir) {
  const users = path.join(stateDir, "users");
  for (const entry of fs.readdirSync(users)) {
    const file = path.join(users, entry, "tum-token.json");
    if (fs.existsSync(file)) return file;
  }
  throw new Error("missing token file");
}

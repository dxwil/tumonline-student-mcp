import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureUserDir, envForAccount, hasTumToken, loadTumToken, saveTumToken, verifyBearer, withStateLock } from "./access.js";
import { SafeError } from "./errors.js";
import { activationSteps, assertExistingToken, assertTumId, confirmToken, requestNewToken, tokenNameFrom } from "./tumonline.js";

const SCOPE = "mcp:tools";
const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const TXN_TTL_MS = 10 * 60 * 1000;
const FORM_LIMIT = 16 * 1024;
const CLIENT_LIMIT = 200;
const OAUTH_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/register",
  "/authorize",
  "/token",
  "/revoke",
]);

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

export function createOAuthRuntime(options = {}) {
  return {
    pending: new Map(),
    userLimit: positive(options.loginFailureLimit, 8),
    ipLimit: positive(options.loginIpFailureLimit, 40),
    loginLimiter: createLoginLimiter(positive(options.loginFailureWindowMs, 15 * 60 * 1000)),
  };
}

export function wwwAuthenticate(config, boundPort, error) {
  const metadata = `${publicBaseUrl(config, boundPort)}/.well-known/oauth-protected-resource`;
  const parts = ['Bearer realm="tumonline-student-mcp"'];
  if (error) parts.push(`error="${error}"`);
  parts.push(`resource_metadata="${metadata}"`, `scope="${SCOPE}"`);
  return parts.join(", ");
}

export function authenticateBearer(stateDir, presented) {
  const staticResult = verifyBearer(stateDir, presented);
  const oauthResult = matchAccessToken(stateDir, presented);
  if (staticResult.account) {
    return { account: { ...staticResult.account, kind: "static", grantId: null }, revokedUserId: null, known: true, expired: false };
  }
  if (oauthResult.account) {
    return { account: oauthResult.account, revokedUserId: null, known: true, expired: false };
  }
  const known = Boolean(staticResult.revokedUserId || oauthResult.known);
  return {
    account: null,
    revokedUserId: staticResult.revokedUserId || oauthResult.revokedUserId || null,
    known,
    expired: oauthResult.expired === true,
  };
}

export function oauthCallerState(stateDir, userId) {
  let store;
  try {
    store = loadStore(stateDir);
  } catch {
    return "none";
  }
  const now = Date.now();
  const entries = [...store.access, ...store.refresh].filter((entry) => entry && entry.userId === userId);
  if (entries.length === 0) return "none";
  const live = entries.some((entry) => !entry.revokedAt && (typeof entry.expiresAt !== "number" || entry.expiresAt > now));
  return live ? "live" : "revoked";
}

export function oauthSessionLive(stateDir, userId) {
  return hasTumToken(stateDir, userId);
}

export function revokeOAuthGrant(stateDir, grantId) {
  if (typeof grantId !== "string" || !/^g_[a-f0-9]{32}$/.test(grantId)) return;
  withStateLock(stateDir, () => {
    const store = loadStore(stateDir);
    const now = new Date().toISOString();
    for (const entry of store.access) {
      if (entry.grantId === grantId && !entry.revokedAt) entry.revokedAt = now;
    }
    for (const entry of store.refresh) {
      if (entry.grantId === grantId && !entry.revokedAt) entry.revokedAt = now;
    }
    writeStore(stateDir, prune(store, Date.now()));
  });
}

export async function routeOAuth(ctx) {
  if (!OAUTH_PATHS.has(ctx.pathname)) return false;
  try {
    await dispatchOAuth(ctx);
  } catch {
    if (!ctx.res.headersSent) {
      sendJson(ctx.res, 500, { error: "server_error", error_description: "The request could not be completed." });
      ctx.logStatus(500);
    }
  }
  return true;
}

async function dispatchOAuth(ctx) {
  const { pathname, req } = ctx;
  if (pathname.startsWith("/.well-known/")) {
    if (req.method !== "GET") {
      sendJson(ctx.res, 405, { error: "invalid_request" }, { Allow: "GET" });
      ctx.logStatus(405);
      return;
    }
    req.resume();
    const base = publicBaseUrl(ctx.config, ctx.boundPort);
    sendJson(ctx.res, 200, pathname.endsWith("/oauth-authorization-server") ? authorizationMetadata(base) : resourceMetadata(base));
    ctx.logStatus(200);
    return;
  }
  if (pathname === "/register") {
    await registerClient(ctx);
    return;
  }
  if (pathname === "/authorize") {
    await authorize(ctx);
    return;
  }
  if (pathname === "/token") {
    await token(ctx);
    return;
  }
  await revoke(ctx);
}

function resourceMetadata(base) {
  return { resource: canonicalResource(base), authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: [SCOPE] };
}

function authorizationMetadata(base) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
  };
}

async function registerClient(ctx) {
  if (ctx.req.method !== "POST") {
    sendJson(ctx.res, 405, { error: "invalid_request" }, { Allow: "POST" });
    ctx.logStatus(405);
    return;
  }
  if (!isJson(ctx.req.headers["content-type"])) {
    sendJson(ctx.res, 400, { error: "invalid_request", error_description: "Client registration must be JSON." });
    ctx.logStatus(400);
    return;
  }
  let body;
  try {
    body = JSON.parse((await readLimited(ctx.req, FORM_LIMIT)).toString("utf8"));
  } catch (error) {
    const status = error?.code === "payload_too_large" ? 413 : 400;
    sendJson(ctx.res, status, { error: status === 413 ? "invalid_request" : "invalid_client_metadata", error_description: "The registration was not accepted." });
    ctx.logStatus(status);
    return;
  }
  const redirectUris = validateRedirects(body?.redirect_uris);
  const name = cleanName(body?.client_name);
  const grants = body?.grant_types == null ? ["authorization_code", "refresh_token"] : body.grant_types;
  const responses = body?.response_types == null ? ["code"] : body.response_types;
  const authMethod = body?.token_endpoint_auth_method ?? "none";
  if (
    !redirectUris ||
    !Array.isArray(grants) || grants.length === 0 || grants.some((grant) => grant !== "authorization_code" && grant !== "refresh_token") ||
    !Array.isArray(responses) || responses.length !== 1 || responses[0] !== "code" ||
    authMethod !== "none"
  ) {
    sendJson(ctx.res, 400, { error: "invalid_client_metadata", error_description: "The client metadata was not accepted." });
    ctx.logStatus(400);
    return;
  }
  let client;
  try {
    client = withStateLock(ctx.config.stateDir, () => {
      const store = prune(loadStore(ctx.config.stateDir), Date.now());
      if (store.clients.length >= CLIENT_LIMIT) return null;
      const created = { id: `c_${crypto.randomBytes(16).toString("hex")}`, name, redirectUris, createdAt: new Date().toISOString() };
      store.clients.push(created);
      writeStore(ctx.config.stateDir, store);
      return created;
    });
  } catch {
    sendJson(ctx.res, 500, { error: "server_error", error_description: "The client could not be registered." });
    ctx.logStatus(500);
    return;
  }
  if (!client) {
    sendJson(ctx.res, 400, { error: "invalid_client_metadata", error_description: "No more clients can be registered." });
    ctx.logStatus(400);
    return;
  }
  sendJson(ctx.res, 201, {
    client_id: client.id,
    client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  ctx.logStatus(201);
}

async function authorize(ctx) {
  if (ctx.req.method === "GET") {
    ctx.req.resume();
    showAuthorize(ctx);
    return;
  }
  if (ctx.req.method !== "POST") {
    sendHtml(ctx.res, 405, page({ error: "This sign-in page does not accept that method." }));
    ctx.logStatus(405);
    return;
  }
  if (!sameOriginPost(ctx.req.headers.origin)) {
    sendHtml(ctx.res, 403, page({ error: "The sign-in form was not sent from this site. Reload the page and try again." }));
    ctx.logStatus(403);
    return;
  }
  await submitAuthorize(ctx);
}

function showAuthorize(ctx) {
  const params = ctx.url.searchParams;
  const client = findClient(ctx.config.stateDir, params.get("client_id"));
  const redirectUri = params.get("redirect_uri");
  if (!client || typeof redirectUri !== "string" || !client.redirectUris.includes(redirectUri)) {
    sendHtml(ctx.res, 400, page({ error: "This sign-in request is not from a registered client." }));
    ctx.logStatus(400);
    return;
  }
  const problem = authorizeProblem(params, publicBaseUrl(ctx.config, ctx.boundPort));
  if (problem) {
    redirectError(ctx, redirectUri, problem.error, problem.description, safeState(params.get("state")));
    return;
  }
  sweepPending(ctx.oauth.pending);
  if (ctx.oauth.pending.size >= 100) ctx.oauth.pending.delete(ctx.oauth.pending.keys().next().value);
  const csrf = crypto.randomBytes(32).toString("base64url");
  const txn = crypto.randomBytes(32).toString("hex");
  ctx.oauth.pending.set(txn, {
    csrf,
    clientId: client.id,
    clientName: client.name,
    redirectUri,
    codeChallenge: params.get("code_challenge"),
    state: safeState(params.get("state")),
    resource: canonicalResource(publicBaseUrl(ctx.config, ctx.boundPort)),
    expiresAt: Date.now() + TXN_TTL_MS,
    phase: "start",
    userId: null,
    tumId: "",
  });
  sendHtml(ctx.res, 200, page(pageModel(ctx, txn)), { "Set-Cookie": csrfCookie(csrf, ctx.config) });
  ctx.logStatus(200);
}

async function submitAuthorize(ctx) {
  if (!isForm(ctx.req.headers["content-type"])) {
    sendHtml(ctx.res, 400, page({ error: "The sign-in form was not accepted. Reload the page and try again." }));
    ctx.logStatus(400);
    return;
  }
  let form;
  try {
    form = new URLSearchParams((await readLimited(ctx.req, FORM_LIMIT)).toString("utf8"));
  } catch {
    sendHtml(ctx.res, 413, page({ error: "The sign-in form was too large." }));
    ctx.logStatus(413);
    return;
  }
  const txnId = form.get("txn");
  const txn = typeof txnId === "string" ? ctx.oauth.pending.get(txnId) : null;
  if (!txn || txn.expiresAt <= Date.now()) {
    sendHtml(ctx.res, 400, page({ error: "This sign-in page expired. Start again from the client." }));
    ctx.logStatus(400);
    return;
  }
  const cookie = readCookie(ctx.req.headers.cookie, "oauth_csrf");
  const posted = form.get("csrf") ?? "";
  if (!fixedEqual(cookie, txn.csrf) || !fixedEqual(posted, txn.csrf)) {
    ctx.oauth.loginLimiter.fail(`ip:${ctx.clientAddress}`, ctx.oauth.ipLimit);
    sendHtml(ctx.res, 400, page({ error: "The sign-in form was not accepted. Reload the page and try again." }));
    ctx.logStatus(400);
    return;
  }
  const action = form.get("action") ?? "";
  const tumId = (form.get("tum_id") ?? "").trim();
  let pasted = form.get("existing_token") ?? "";
  const blocked = ctx.oauth.loginLimiter.blocked(`ip:${ctx.clientAddress}`, ctx.oauth.ipLimit) || (tumId !== "" && ctx.oauth.loginLimiter.blocked(`user:${tumId.toLowerCase()}`, ctx.oauth.userLimit));
  if (blocked) {
    pasted = "";
    sendHtml(ctx.res, 429, page({ ...pageModel(ctx, txnId), error: "Too many sign-in attempts. Wait and try again." }), {
      "Set-Cookie": csrfCookie(txn.csrf, ctx.config),
      "Retry-After": "60",
    });
    ctx.logStatus(429);
    return;
  }
  try {
    if (action === "request") {
      await requestAction(ctx, txn, txnId, tumId);
      return;
    }
    if (action === "paste") {
      await pasteAction(ctx, txn, txnId, pasted);
      return;
    }
    if (action === "check") {
      await checkAction(ctx, txn, txnId);
      return;
    }
    failForm(ctx, txn, txnId, "Choose request, paste, or check activation.");
  } catch (error) {
    pasted = "";
    ctx.oauth.loginLimiter.fail(`ip:${ctx.clientAddress}`, ctx.oauth.ipLimit);
    if (tumId !== "") ctx.oauth.loginLimiter.fail(`user:${tumId.toLowerCase()}`, ctx.oauth.userLimit);
    const message = error instanceof SafeError ? error.message : "The token step could not be completed.";
    failForm(ctx, txn, txnId, message, error instanceof SafeError && error.code === "rate_limited" ? 429 : 400);
  } finally {
    pasted = "";
  }
}

async function requestAction(ctx, txn, txnId, tumId) {
  assertTumId(tumId);
  const userId = txn.userId ?? `u_${crypto.randomBytes(16).toString("hex")}`;
  const accountEnv = envForAccount(ctx.config.env, ctx.config.stateDir, userId);
  const issued = await requestNewToken(accountEnv, ctx.fetchImpl, tumId);
  ensureUserDir(ctx.config.stateDir, userId);
  saveTumToken(ctx.config.stateDir, userId, accountEnv, {
    token: issued.token,
    tumId,
    tokenName: issued.tokenName,
    source: "requested",
    createdAt: new Date().toISOString(),
    confirmed: false,
  });
  txn.userId = userId;
  txn.tumId = tumId;
  txn.phase = "activate";
  sendHtml(ctx.res, 200, page(pageModel(ctx, txnId)), { "Set-Cookie": csrfCookie(txn.csrf, ctx.config) });
  ctx.logStatus(200);
}

async function pasteAction(ctx, txn, txnId, pasted) {
  const token = assertExistingToken(pasted);
  const userId = txn.userId ?? `u_${crypto.randomBytes(16).toString("hex")}`;
  const accountEnv = envForAccount(ctx.config.env, ctx.config.stateDir, userId);
  const name = tokenNameFrom(accountEnv);
  let confirmed = false;
  try {
    confirmed = await confirmToken(accountEnv, ctx.fetchImpl, token);
  } catch (error) {
    if (!(error instanceof SafeError) || error.code !== "token_unconfirmed") throw error;
  }
  ensureUserDir(ctx.config.stateDir, userId);
  saveTumToken(ctx.config.stateDir, userId, accountEnv, {
    token,
    tumId: txn.tumId || "",
    tokenName: name,
    source: "pasted",
    createdAt: new Date().toISOString(),
    confirmed,
  });
  txn.userId = userId;
  txn.phase = confirmed ? "start" : "activate";
  if (!confirmed) {
    sendHtml(ctx.res, 200, page({ ...pageModel(ctx, txnId), error: "The token is stored, but TUMonline has not confirmed it yet. Activate it, then choose Check activation." }), {
      "Set-Cookie": csrfCookie(txn.csrf, ctx.config),
    });
    ctx.logStatus(200);
    return;
  }
  finishGrant(ctx, txn, txnId, userId);
}

async function checkAction(ctx, txn, txnId) {
  if (!txn.userId) {
    failForm(ctx, txn, txnId, "Request a token or paste one before checking activation.");
    return;
  }
  const accountEnv = envForAccount(ctx.config.env, ctx.config.stateDir, txn.userId);
  const stored = loadTumToken(ctx.config.stateDir, txn.userId, accountEnv);
  if (!stored?.token) {
    failForm(ctx, txn, txnId, "No token is stored for this sign-in yet.");
    return;
  }
  const confirmed = await confirmToken(accountEnv, ctx.fetchImpl, stored.token);
  saveTumToken(ctx.config.stateDir, txn.userId, accountEnv, { ...stored, confirmed });
  if (!confirmed) {
    txn.phase = "activate";
    sendHtml(ctx.res, 200, page({ ...pageModel(ctx, txnId), error: "TUMonline still says the token is not active. Finish activation and the rights, then check again." }), {
      "Set-Cookie": csrfCookie(txn.csrf, ctx.config),
    });
    ctx.logStatus(200);
    return;
  }
  finishGrant(ctx, txn, txnId, txn.userId);
}

function finishGrant(ctx, txn, txnId, userId) {
  const code = `oac_${crypto.randomBytes(32).toString("base64url")}`;
  withStateLock(ctx.config.stateDir, () => {
    const store = prune(loadStore(ctx.config.stateDir), Date.now());
    store.codes.push({
      hash: sha256(code),
      clientId: txn.clientId,
      userId,
      redirectUri: txn.redirectUri,
      codeChallenge: txn.codeChallenge,
      resource: txn.resource,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    writeStore(ctx.config.stateDir, store);
  });
  ctx.oauth.pending.delete(txnId);
  redirectOk(ctx, txn.redirectUri, code, txn.state);
}

function failForm(ctx, txn, txnId, message, status = 400) {
  sendHtml(ctx.res, status, page({ ...pageModel(ctx, txnId), error: message }), {
    "Set-Cookie": csrfCookie(txn.csrf, ctx.config),
    ...(status === 429 ? { "Retry-After": "60" } : {}),
  });
  ctx.logStatus(status);
}

async function token(ctx) {
  if (ctx.req.method !== "POST") {
    sendJson(ctx.res, 405, { error: "invalid_request" }, { Allow: "POST" });
    ctx.logStatus(405);
    return;
  }
  const form = await readForm(ctx);
  if (!form) return;
  const grant = form.get("grant_type");
  const base = publicBaseUrl(ctx.config, ctx.boundPort);
  if (grant === "authorization_code") {
    exchangeCode(ctx, form, base);
    return;
  }
  if (grant === "refresh_token") {
    exchangeRefresh(ctx, form, base);
    return;
  }
  sendJson(ctx.res, 400, { error: "unsupported_grant_type", error_description: "This server issues authorization codes and refresh tokens." });
  ctx.logStatus(400);
}

function exchangeCode(ctx, form, base) {
  const code = form.get("code") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  const clientId = form.get("client_id") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const resource = form.get("resource") ?? "";
  if (!resourceAccepted(resource, base) || !pkceVerifier(verifier)) {
    sendJson(ctx.res, 400, { error: "invalid_grant", error_description: "The authorization code could not be redeemed." });
    ctx.logStatus(400);
    return;
  }
  let issued = null;
  withStateLock(ctx.config.stateDir, () => {
    const store = prune(loadStore(ctx.config.stateDir), Date.now());
    const digest = sha256Buffer(code);
    let index = -1;
    for (let i = 0; i < store.codes.length; i += 1) {
      if (hashEquals(store.codes[i].hash, digest)) index = i;
    }
    if (store.codes.length === 0) crypto.timingSafeEqual(digest, Buffer.alloc(32));
    if (index < 0) {
      writeStore(ctx.config.stateDir, store);
      return;
    }
    const entry = store.codes[index];
    store.codes.splice(index, 1);
    const challengeOk = pkceMatches(verifier, entry.codeChallenge);
    const sameClient = entry.clientId === clientId && entry.redirectUri === redirectUri && entry.resource === canonicalResource(base);
    if (!challengeOk || !sameClient || entry.expiresAt <= Date.now()) {
      writeStore(ctx.config.stateDir, store);
      return;
    }
    issued = issueTokens(store, { userId: entry.userId, clientId: entry.clientId, resource: entry.resource });
    writeStore(ctx.config.stateDir, store);
  });
  if (!issued) {
    sendJson(ctx.res, 400, { error: "invalid_grant", error_description: "The authorization code could not be redeemed." });
    ctx.logStatus(400);
    return;
  }
  sendJson(ctx.res, 200, tokenResponse(issued));
  ctx.logStatus(200);
}

function exchangeRefresh(ctx, form, base) {
  const refresh = form.get("refresh_token") ?? "";
  const clientId = form.get("client_id") ?? "";
  const resource = form.get("resource") ?? "";
  if (!resourceAccepted(resource, base)) {
    sendJson(ctx.res, 400, { error: "invalid_target", error_description: "The resource was not accepted." });
    ctx.logStatus(400);
    return;
  }
  let issued = null;
  withStateLock(ctx.config.stateDir, () => {
    const store = prune(loadStore(ctx.config.stateDir), Date.now());
    const digest = sha256Buffer(refresh);
    let found = null;
    for (const entry of store.refresh) {
      if (hashEquals(entry.hash, digest)) found = entry;
    }
    if (!found) {
      if (store.refresh.length === 0) crypto.timingSafeEqual(digest, Buffer.alloc(32));
      writeStore(ctx.config.stateDir, store);
      return;
    }
    if (found.clientId !== clientId || found.resource !== canonicalResource(base) || found.revokedAt || found.expiresAt <= Date.now() || !oauthSessionLive(ctx.config.stateDir, found.userId)) {
      if (found.revokedAt || found.expiresAt <= Date.now() || !oauthSessionLive(ctx.config.stateDir, found.userId)) revokeGrantInStore(store, found.grantId);
      writeStore(ctx.config.stateDir, store);
      return;
    }
    found.revokedAt = new Date().toISOString();
    issued = issueTokens(store, { userId: found.userId, clientId: found.clientId, resource: found.resource, grantId: found.grantId });
    writeStore(ctx.config.stateDir, store);
  });
  if (!issued) {
    sendJson(ctx.res, 400, { error: "invalid_grant", error_description: "The refresh token could not be redeemed." });
    ctx.logStatus(400);
    return;
  }
  sendJson(ctx.res, 200, tokenResponse(issued));
  ctx.logStatus(200);
}

async function revoke(ctx) {
  if (ctx.req.method !== "POST") {
    sendJson(ctx.res, 405, { error: "invalid_request" }, { Allow: "POST" });
    ctx.logStatus(405);
    return;
  }
  const form = await readForm(ctx);
  if (!form) return;
  const tokenValue = form.get("token") ?? "";
  const clientId = form.get("client_id") ?? "";
  withStateLock(ctx.config.stateDir, () => {
    const store = prune(loadStore(ctx.config.stateDir), Date.now());
    const digest = sha256Buffer(tokenValue);
    let grantId = null;
    let kind = null;
    for (const entry of store.access) {
      if (hashEquals(entry.hash, digest) && entry.clientId === clientId) {
        grantId = entry.grantId;
        kind = "access";
      }
    }
    for (const entry of store.refresh) {
      if (hashEquals(entry.hash, digest) && entry.clientId === clientId) {
        grantId = entry.grantId;
        kind = "refresh";
      }
    }
    if (store.access.length + store.refresh.length === 0) crypto.timingSafeEqual(digest, Buffer.alloc(32));
    const now = new Date().toISOString();
    if (kind === "refresh" && grantId) revokeGrantInStore(store, grantId);
    else if (kind === "access" && grantId) {
      for (const entry of store.access) {
        if (entry.grantId === grantId && hashEquals(entry.hash, digest) && !entry.revokedAt) entry.revokedAt = now;
      }
    }
    writeStore(ctx.config.stateDir, store);
  });
  sendEmpty(ctx.res, 200);
  ctx.logStatus(200);
}

function issueTokens(store, fields) {
  const grantId = fields.grantId ?? `g_${crypto.randomBytes(16).toString("hex")}`;
  const access = `oaat_${crypto.randomBytes(32).toString("base64url")}`;
  const refresh = `oart_${crypto.randomBytes(32).toString("base64url")}`;
  const now = Date.now();
  store.access.push({ hash: sha256(access), userId: fields.userId, clientId: fields.clientId, grantId, resource: fields.resource, expiresAt: now + ACCESS_TTL_MS, revokedAt: null });
  store.refresh.push({ hash: sha256(refresh), userId: fields.userId, clientId: fields.clientId, grantId, resource: fields.resource, expiresAt: now + REFRESH_TTL_MS, revokedAt: null });
  return { access, refresh, expiresIn: Math.floor(ACCESS_TTL_MS / 1000) };
}

function tokenResponse(issued) {
  return { access_token: issued.access, token_type: "Bearer", expires_in: issued.expiresIn, refresh_token: issued.refresh, scope: SCOPE };
}

function revokeGrantInStore(store, grantId) {
  const now = new Date().toISOString();
  for (const entry of store.access) if (entry.grantId === grantId && !entry.revokedAt) entry.revokedAt = now;
  for (const entry of store.refresh) if (entry.grantId === grantId && !entry.revokedAt) entry.revokedAt = now;
}

function matchAccessToken(stateDir, presented) {
  const digest = sha256Buffer(typeof presented === "string" ? presented : "\0");
  let store;
  try {
    store = loadStore(stateDir);
  } catch {
    store = emptyStore();
  }
  let found = null;
  let known = false;
  let expired = false;
  let revokedUserId = null;
  const now = Date.now();
  for (const entry of store.access) {
    if (!hashEquals(entry.hash, digest)) continue;
    known = true;
    if (entry.revokedAt) {
      revokedUserId = entry.userId;
      continue;
    }
    if (entry.expiresAt <= now) {
      expired = true;
      revokedUserId = entry.userId;
      continue;
    }
    if (!found) found = { id: "oauth", userId: entry.userId, label: "", kind: "oauth", grantId: entry.grantId };
  }
  if (store.access.length === 0) crypto.timingSafeEqual(digest, Buffer.alloc(32));
  return { account: found, known, expired: expired && !found, revokedUserId: found ? null : revokedUserId };
}

function authorizeProblem(params, base) {
  if (params.get("response_type") !== "code") return { error: "invalid_request", description: "response_type must be code." };
  if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? "")) {
    return { error: "invalid_request", description: "PKCE S256 is required." };
  }
  if (!resourceAccepted(params.get("resource"), base)) return { error: "invalid_target", description: "The resource was not accepted." };
  const scope = params.get("scope");
  if (scope != null && scope !== SCOPE) return { error: "invalid_scope", description: "The requested scope was not accepted." };
  const state = params.get("state");
  if (state != null && safeState(state) == null && state !== "") return { error: "invalid_request", description: "The state parameter was not accepted." };
  return null;
}

function pageModel(ctx, txnId) {
  const txn = ctx.oauth.pending.get(txnId);
  let tokenName = "tumonline-student-mcp";
  try {
    tokenName = tokenNameFrom(ctx.config.env);
  } catch {
    tokenName = "tumonline-student-mcp";
  }
  return {
    tokenName,
    clientName: txn?.clientName,
    redirectHost: redirectHost(txn?.redirectUri),
    txn: txnId,
    csrf: txn?.csrf,
    tumId: txn?.tumId ?? "",
    phase: txn?.phase ?? "start",
    steps: activationSteps(tokenName),
    error: null,
  };
}

function page(model) {
  const error = model.error ? `<p class="error" role="alert">${escapeHtml(model.error)}</p>` : "";
  const who = model.clientName ? `<p>${escapeHtml(model.clientName)} is asking to connect. The result goes only to ${escapeHtml(model.redirectHost || "the registered client")}.</p>` : "";
  const steps = (model.steps ?? []).map((step) => `<li>${escapeHtml(step)}</li>`).join("");
  const activate = model.phase === "activate"
    ? `<section><h2>Activate the token</h2><ol>${steps}</ol>
<form method="post" action="/authorize">
<input type="hidden" name="txn" value="${escapeHtml(model.txn)}">
<input type="hidden" name="csrf" value="${escapeHtml(model.csrf)}">
<button type="submit" name="action" value="check">Check activation</button>
</form></section>`
    : "";
  const preview = model.phase !== "activate" && steps
    ? `<section><h2>After you request a token</h2><ol>${steps}</ol></section>`
    : "";
  const start = model.txn
    ? `<section><h2>Request a token</h2>
<form method="post" action="/authorize">
<input type="hidden" name="txn" value="${escapeHtml(model.txn)}">
<input type="hidden" name="csrf" value="${escapeHtml(model.csrf)}">
<label>TUM ID <input name="tum_id" autocomplete="username" maxlength="16" value="${escapeHtml(model.tumId ?? "")}"></label>
<button type="submit" name="action" value="request">Request token</button>
</form></section>
<section><h2>Use an existing token</h2>
<form method="post" action="/authorize">
<input type="hidden" name="txn" value="${escapeHtml(model.txn)}">
<input type="hidden" name="csrf" value="${escapeHtml(model.csrf)}">
<label>Activated token <input name="existing_token" type="password" autocomplete="off" maxlength="128"></label>
<button type="submit" name="action" value="paste">Use token</button>
</form>
<p>The token is encrypted on this server and is not shown again.</p></section>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect TUMonline</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:36rem;line-height:1.45;color:#1b1b1b}
.note{background:#f4f1ea;padding:.75rem 1rem}
section{margin-top:1.5rem}
label{display:block;margin-top:1rem}
input{width:100%;box-sizing:border-box;padding:.45rem}
button{margin-top:1rem;padding:.5rem 1rem}
.error{color:#8a1f1f}
</style>
</head>
<body>
<h1>Connect TUMonline</h1>
<p class="note">This is an unofficial server. It is not run by TUM or TUMonline. It does not ask for your password or single sign-on. A Campus token is stored encrypted for your MCP user and is never shown on this page.</p>
${who}
${error}
${activate}
${preview}
${start}
</body>
</html>`;
}

function redirectHost(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function redirectOk(ctx, redirectUri, code, state) {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  sendRedirect(ctx.res, url.toString());
  ctx.logStatus(302);
}

function redirectError(ctx, redirectUri, error, description, state) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  sendRedirect(ctx.res, url.toString());
  ctx.logStatus(302);
}

function safeState(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function validateRedirects(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) return null;
  const unique = [];
  for (const entry of value) {
    if (!validRedirect(entry) || unique.includes(entry)) return null;
    unique.push(entry);
  }
  return unique;
}

function validRedirect(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 512 || /[\s#\\]/.test(value)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (!/^[a-z][a-z0-9+.-]*:$/.test(url.protocol)) return false;
  return !["javascript:", "data:", "file:", "blob:", "about:", "vbscript:"].includes(url.protocol);
}

function resourceAccepted(value, base) {
  if (typeof value !== "string" || value.length > 300) return false;
  let url;
  let expected;
  try {
    url = new URL(value);
    expected = new URL(base);
  } catch {
    return false;
  }
  if (url.origin !== expected.origin || url.search || url.hash || url.username || url.password) return false;
  const pathName = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return pathName === "/mcp" || pathName === "/";
}

function canonicalResource(base) {
  return `${base}/mcp`;
}

export function publicBaseUrl(config, boundPort) {
  if (config.publicOrigin) return config.publicOrigin;
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  const display = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${display}:${boundPort ?? config.port}`;
}

function pkceVerifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

function pkceMatches(verifier, challenge) {
  if (!pkceVerifier(verifier) || typeof challenge !== "string") return false;
  const actual = Buffer.from(crypto.createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  if (actual.length !== expected.length) {
    crypto.timingSafeEqual(actual, actual);
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

function findClient(stateDir, clientId) {
  if (typeof clientId !== "string" || !/^c_[a-f0-9]{32}$/.test(clientId)) return null;
  return loadStore(stateDir).clients.find((client) => client.id === clientId) ?? null;
}

function cleanName(value) {
  if (typeof value !== "string") return "MCP client";
  const cleaned = value.replace(/[^\p{L}\p{N} .'_()+-]/gu, "").trim().slice(0, 80);
  return cleaned || "MCP client";
}

function emptyStore() {
  return { version: 1, clients: [], codes: [], access: [], refresh: [] };
}

function loadStore(stateDir) {
  const file = path.join(path.resolve(stateDir), "oauth.json");
  if (!fs.existsSync(file)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      version: 1,
      clients: Array.isArray(parsed?.clients) ? parsed.clients.filter(validClient) : [],
      codes: Array.isArray(parsed?.codes) ? parsed.codes.filter(validCode) : [],
      access: Array.isArray(parsed?.access) ? parsed.access.filter(validAccess) : [],
      refresh: Array.isArray(parsed?.refresh) ? parsed.refresh.filter(validRefresh) : [],
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(stateDir, store) {
  const file = path.join(path.resolve(stateDir), "oauth.json");
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = path.join(directory, `.oauth.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(store)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function prune(store, now) {
  store.codes = store.codes.filter((entry) => entry.expiresAt > now).slice(-100);
  store.access = store.access.filter((entry) => entry.expiresAt > now - 60 * 60 * 1000 && (!entry.revokedAt || Date.parse(entry.revokedAt) > now - 60 * 60 * 1000)).slice(-500);
  store.refresh = store.refresh.filter((entry) => entry.expiresAt > now - 24 * 60 * 60 * 1000).slice(-500);
  return store;
}

function validClient(entry) {
  return entry && typeof entry.id === "string" && /^c_[a-f0-9]{32}$/.test(entry.id) && typeof entry.name === "string" && Array.isArray(entry.redirectUris);
}

function validCode(entry) {
  return entry && typeof entry.hash === "string" && /^[a-f0-9]{64}$/.test(entry.hash) && typeof entry.userId === "string" && typeof entry.clientId === "string" && typeof entry.redirectUri === "string" && typeof entry.codeChallenge === "string" && typeof entry.expiresAt === "number";
}

function validAccess(entry) {
  return validRefresh(entry);
}

function validRefresh(entry) {
  return entry && typeof entry.hash === "string" && /^[a-f0-9]{64}$/.test(entry.hash) && typeof entry.userId === "string" && typeof entry.grantId === "string" && typeof entry.expiresAt === "number";
}

function hashEquals(hexHash, digest) {
  if (typeof hexHash !== "string" || !/^[a-f0-9]{64}$/.test(hexHash)) {
    crypto.timingSafeEqual(digest, Buffer.alloc(digest.length));
    return false;
  }
  const stored = Buffer.from(hexHash, "hex");
  if (stored.length !== digest.length) {
    crypto.timingSafeEqual(digest, Buffer.alloc(digest.length));
    return false;
  }
  return crypto.timingSafeEqual(stored, digest);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : "\0", "utf8").digest();
}

function fixedEqual(left, right) {
  const a = sha256Buffer(typeof left === "string" ? left : "\0");
  const b = sha256Buffer(typeof right === "string" ? right : "\0");
  return crypto.timingSafeEqual(a, b) && typeof left === "string" && left.length > 0 && left === right;
}

function createLoginLimiter(windowMs) {
  const buckets = new Map();
  function bucket(key) {
    const now = Date.now();
    let entry = buckets.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }
    return entry;
  }
  return {
    blocked(key, limit) {
      return bucket(key).count >= limit;
    },
    fail(key, limit) {
      const entry = bucket(key);
      if (entry.count < limit) entry.count += 1;
    },
  };
}

function sweepPending(pending) {
  const now = Date.now();
  for (const [id, txn] of pending) {
    if (txn.expiresAt <= now) pending.delete(id);
  }
}

function csrfCookie(csrf, config) {
  const secure = config.publicOrigin?.startsWith("https://") ? "; Secure" : "";
  return `oauth_csrf=${csrf}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure}`;
}

function readCookie(header, name) {
  if (typeof header !== "string") return "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq > 0 && trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return "";
}

function sameOriginPost(origin) {
  return typeof origin === "string" && origin.trim() !== "" && origin !== "null";
}

async function readForm(ctx) {
  if (!isForm(ctx.req.headers["content-type"])) {
    sendJson(ctx.res, 400, { error: "invalid_request", error_description: "The request body must be a form." });
    ctx.logStatus(400);
    return null;
  }
  try {
    return new URLSearchParams((await readLimited(ctx.req, FORM_LIMIT)).toString("utf8"));
  } catch (error) {
    const status = error?.code === "payload_too_large" ? 413 : 400;
    sendJson(ctx.res, status, { error: "invalid_request", error_description: "The request body was not accepted." });
    ctx.logStatus(status);
    return null;
  }
}

function readLimited(req, limit) {
  const declared = req.headers["content-length"];
  if (declared != null && (!/^[0-9]+$/.test(String(declared)) || Number(declared) > limit)) {
    const error = new Error("payload_too_large");
    error.code = "payload_too_large";
    req.destroy();
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        const error = new Error("payload_too_large");
        error.code = "payload_too_large";
        req.destroy();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isJson(header) {
  return typeof header === "string" && /^application\/json(?:\s*;\s*charset="?utf-8"?)?$/i.test(header.trim());
}

function isForm(header) {
  return typeof header === "string" && /^application\/x-www-form-urlencoded(?:\s*;\s*charset="?utf-8"?)?$/i.test(header.trim());
}

function sendJson(res, status, payload, extra = {}) {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { ...SECURITY_HEADERS, ...extra, "Content-Type": "application/json; charset=utf-8", "Content-Length": String(body.length) });
  res.end(body);
}

function sendHtml(res, status, html, extra = {}) {
  if (res.headersSent) return;
  const body = Buffer.from(html);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extra,
    "Referrer-Policy": "same-origin",
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Content-Length": String(body.length),
  });
  res.end(body);
}

function sendRedirect(res, location) {
  if (res.headersSent || /[\r\n]/.test(location)) return;
  res.writeHead(302, { ...SECURITY_HEADERS, Location: location, "Content-Length": "0" });
  res.end();
}

function sendEmpty(res, status) {
  if (res.headersSent) return;
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Length": "0" });
  res.end();
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function positive(value, fallback) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

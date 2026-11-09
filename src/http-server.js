import crypto from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { envForAccount, ensureStateDir, loadTumToken, resolveStateDir, staticCallerState } from "./access.js";
import { createDownloadDesk, reviewDownloadUrl } from "./download-desk.js";
import { SafeError } from "./errors.js";
import { streamGet } from "./http.js";
import { createToolImpl } from "./impl.js";
import { createMcpHandler, SUPPORTED_PROTOCOL_VERSIONS } from "./mcp.js";
import { authenticateBearer, createOAuthRuntime, oauthCallerState, routeOAuth, wwwAuthenticate } from "./oauth.js";

export const MAX_HTTP_BODY_BYTES = 1024 * 1024;
export const DEFAULT_AUTH_FAILURE_LIMIT = 30;
export const DEFAULT_AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1000;

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_LIMIT = 200;
const KNOWN_PATHS = new Set([
  "/mcp",
  "/healthz",
  "/authorize",
  "/token",
  "/register",
  "/revoke",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
]);

export function loadHttpConfig(env, overrides = {}) {
  const host = parseHost(overrides.host ?? envString(env, "TUMONLINE_MCP_HOST") ?? "127.0.0.1");
  const port = parsePort(overrides.port ?? envString(env, "TUMONLINE_MCP_PORT") ?? "8080");
  const stateDir = resolveStateDir(env);
  const publicOrigin = parsePublicOrigin(envString(env, "TUMONLINE_MCP_PUBLIC_URL"));
  const extraOrigins = parseOriginList(envString(env, "TUMONLINE_MCP_ALLOWED_ORIGINS"));
  const allowedHosts = parseHostList(envString(env, "TUMONLINE_MCP_ALLOWED_HOSTS"));
  let publicHostname = null;
  let publicPort = null;
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    publicHostname = url.hostname.toLowerCase();
    publicPort = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  }
  return { host, port, stateDir, publicOrigin, publicHostname, publicPort, extraOrigins, allowedHosts };
}

export function formatListenAddress(server) {
  const address = server.address();
  if (!address || typeof address === "string") return "http://127.0.0.1";
  const host = address.address.includes(":") ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

export async function startHttpServer(options = {}) {
  const env = options.env ?? process.env;
  const config = {
    ...loadHttpConfig(env, options),
    env,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    maxBodyBytes: positiveInteger(options.maxBodyBytes, MAX_HTTP_BODY_BYTES),
    authFailureLimit: positiveInteger(options.authFailureLimit, DEFAULT_AUTH_FAILURE_LIMIT),
    authFailureWindowMs: positiveInteger(options.authFailureWindowMs, DEFAULT_AUTH_FAILURE_WINDOW_MS),
    log: options.log ?? ((line) => process.stderr.write(line.endsWith("\n") ? line : `${line}\n`)),
  };
  ensureStateDir(config.stateDir);
  const sessions = new Map();
  const tails = new Map();
  const limiter = createLimiter(config.authFailureLimit, config.authFailureWindowMs);
  const oauth = options.oauth ?? createOAuthRuntime(options);
  const downloads = options.downloads ?? createDownloadDesk({ now: options.now });
  const server = http.createServer((req, res) => {
    handleRequest(req, res, { config, sessions, tails, limiter, oauth, downloads, server }).catch(() => {
      if (!res.headersSent) {
        try {
          finish(req, res, 500, { error: "internal" }, { close: true });
        } catch {
          res.destroy();
        }
      }
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 75_000;
  server.maxHeadersCount = 40;
  await listen(server, config);
  return server;
}

async function handleRequest(req, res, ctx) {
  const { config, sessions, limiter } = ctx;
  const url = parseRequestUrl(req.url);
  if (!url) {
    finish(req, res, 400, { error: "bad_request" }, { close: true });
    config.log("400 /\n");
    return;
  }
  const pathname = url.pathname === "/mcp/" ? "/mcp" : url.pathname;
  const safePath = pathname.startsWith("/files/") ? "/files" : KNOWN_PATHS.has(pathname) ? pathname : "/";
  const reply = (status, payload, extra) => {
    finish(req, res, status, payload, extra);
    config.log(`${status} ${safePath}\n`);
  };
  reply.logOnly = (status) => config.log(`${status} ${safePath}\n`);
  const boundPort = listenPort(ctx.server);
  if (!hostAllowed(req.headers.host, config, boundPort) || !originAllowed(req.headers.origin, config, boundPort)) {
    reply(403, { error: "forbidden" }, { close: true });
    return;
  }
  const length = declaredLength(req.headers["content-length"]);
  if (length === "invalid") {
    reply(400, { error: "bad_request" }, { close: true });
    return;
  }
  if (typeof length === "number" && length > config.maxBodyBytes) {
    reply(413, { error: "payload_too_large" }, { close: true });
    return;
  }
  if (url.search && pathname !== "/authorize") {
    if (overAuthLimit(req, limiter, reply)) return;
    reply(400, { error: "query_rejected" }, { close: true });
    return;
  }
  if (pathname.startsWith("/files/")) {
    const token = pathname.slice("/files/".length);
    if (req.method !== "GET" && req.method !== "HEAD") {
      reply(405, { error: "method_not_allowed" }, { headers: { Allow: "GET, HEAD" } });
      return;
    }
    req.resume();
    await serveDownload(req, res, ctx, token, req.method === "HEAD");
    return;
  }
  if (pathname === "/healthz") {
    if (req.method !== "GET") {
      reply(405, { error: "method_not_allowed" }, { headers: { Allow: "GET" } });
      return;
    }
    req.resume();
    reply(200, { ok: true });
    return;
  }
  if (await routeOAuth({
    req,
    res,
    url,
    pathname,
    config,
    boundPort,
    fetchImpl: config.fetchImpl,
    oauth: ctx.oauth,
    clientAddress: clientKey(req),
    logStatus: (status) => config.log(`${status} ${safePath}\n`),
  })) {
    return;
  }
  if (pathname !== "/mcp") {
    req.resume();
    reply(404, { error: "not_found" }, { close: true });
    return;
  }
  const verdict = authenticateBearer(config.stateDir, bearerToken(req.headers.authorization));
  if (!verdict.account) {
    if (verdict.revokedUserId) dropUser(sessions, verdict.revokedUserId);
    if (verdict.known) {
      reply(401, { error: "invalid_token" }, { close: true, headers: { "WWW-Authenticate": wwwAuthenticate(config, boundPort, "invalid_token") } });
      return;
    }
    if (!overAuthLimit(req, limiter, reply)) {
      reply(401, { error: "unauthorized" }, { close: true, headers: { "WWW-Authenticate": wwwAuthenticate(config, boundPort) } });
    }
    return;
  }
  if (req.method === "GET") {
    req.resume();
    handleGet(req, reply, ctx, verdict.account);
    return;
  }
  if (req.method === "DELETE") {
    req.resume();
    handleDelete(req, reply, ctx, verdict.account);
    return;
  }
  if (req.method !== "POST") {
    req.resume();
    reply(405, { error: "method_not_allowed" }, { headers: { Allow: "GET, POST, DELETE" } });
    return;
  }
  const accept = acceptKinds(req.headers.accept);
  if (!accept.json && !accept.sse) {
    req.resume();
    reply(406, { error: "not_acceptable" }, { close: true });
    return;
  }
  if (!isJsonContent(req.headers["content-type"])) {
    req.resume();
    reply(415, { error: "unsupported_media_type" }, { close: true });
    return;
  }
  let raw;
  try {
    raw = await readBody(req, config.maxBodyBytes);
  } catch (error) {
    if (error && error.code === "payload_too_large") {
      reply(413, { error: "payload_too_large" }, { close: true });
      return;
    }
    if (res.writableEnded || req.destroyed) return;
    throw error;
  }
  let message;
  try {
    message = JSON.parse(raw.toString("utf8"));
  } catch {
    reply(400, rpcError(null, -32700, "Parse error"));
    return;
  }
  if (Array.isArray(message)) {
    reply(400, rpcError(null, -32600, "Invalid Request"));
    return;
  }
  const classified = classify(message);
  if (classified.kind === "invalid") {
    reply(400, rpcError(null, -32600, "Invalid Request"));
    return;
  }
  if (classified.message.method === "initialize") {
    await handleInitialize(req, res, reply, ctx, verdict.account, classified, accept);
    return;
  }
  const session = takeSession(req, reply, ctx, verdict.account, classified.message);
  if (!session) return;
  if (classified.kind === "response") {
    reply(202, null, { sessionId: session.id });
    return;
  }
  let response;
  try {
    response = await enqueue(ctx.tails, verdict.account.userId, () => session.handler(classified.message));
  } catch {
    reply(500, { error: "internal" }, { close: true });
    return;
  }
  if (classified.kind === "notification") {
    if (response) {
      reply(400, response, { sessionId: session.id });
      return;
    }
    reply(202, null, { sessionId: session.id });
    return;
  }
  if (!response) {
    reply(202, null, { sessionId: session.id });
    return;
  }
  sendRpc(res, reply, response, session.id, accept);
}

async function handleInitialize(req, res, reply, ctx, account, classified, accept) {
  if (classified.kind !== "request") {
    reply(400, rpcError(null, -32600, "Invalid Request"));
    return;
  }
  if (!supportedProtocolHeader(req.headers["mcp-protocol-version"])) {
    reply(400, rpcError(null, -32000, "Unsupported protocol version"));
    return;
  }
  const session = openSession(ctx, account.userId);
  let response;
  try {
    response = await enqueue(ctx.tails, account.userId, () => session.handler(classified.message));
  } catch {
    ctx.sessions.delete(session.id);
    reply(500, { error: "internal" }, { close: true });
    return;
  }
  if (!response?.result) {
    ctx.sessions.delete(session.id);
    sendRpc(res, reply, response ?? rpcError(null, -32600, "Invalid Request"), null, accept);
    return;
  }
  sendRpc(res, reply, response, session.id, accept);
}

function handleGet(req, reply, ctx, account) {
  const session = takeSession(req, reply, ctx, account, null);
  if (!session) return;
  const accept = acceptKinds(req.headers.accept);
  if (!accept.sse) {
    reply(406, { error: "not_acceptable" });
    return;
  }
  reply(405, { error: "method_not_allowed" }, { headers: { Allow: "GET, POST, DELETE" } });
}

function handleDelete(req, reply, ctx, account) {
  const session = takeSession(req, reply, ctx, account, null);
  if (!session) return;
  ctx.sessions.delete(session.id);
  reply(204, null);
}

function takeSession(req, reply, ctx, account, message) {
  if (!supportedProtocolHeader(req.headers["mcp-protocol-version"])) {
    reply(400, rpcError(rpcId(message), -32000, "Unsupported protocol version"));
    return null;
  }
  const header = sessionHeader(req.headers["mcp-session-id"]);
  if (header.missing || header.invalid) {
    reply(400, rpcError(rpcId(message), -32000, "Session required"));
    return null;
  }
  sweepSessions(ctx.sessions);
  const session = ctx.sessions.get(header.id);
  if (!session || session.userId !== account.userId) {
    reply(404, rpcError(rpcId(message), -32001, "Session not found"));
    return null;
  }
  session.lastUsed = Date.now();
  return session;
}

function overAuthLimit(req, limiter, reply) {
  const decision = limiter.fail(clientKey(req));
  if (decision.ok) return false;
  reply(429, { error: "rate_limited" }, { close: true, headers: { "Retry-After": String(decision.retryAfter) } });
  return true;
}

function openSession(ctx, userId) {
  sweepSessions(ctx.sessions);
  if (ctx.sessions.size >= SESSION_LIMIT) {
    let oldest = null;
    for (const session of ctx.sessions.values()) {
      if (!oldest || session.lastUsed < oldest.lastUsed) oldest = session;
    }
    if (oldest) ctx.sessions.delete(oldest.id);
  }
  const accountEnv = envForAccount(ctx.config.env, ctx.config.stateDir, userId);
  const session = {
    id: crypto.randomBytes(32).toString("hex"),
    userId,
    handler: createMcpHandler(createToolImpl(accountEnv, ctx.config.fetchImpl)),
    lastUsed: Date.now(),
  };
  ctx.sessions.set(session.id, session);
  return session;
}

async function serveDownload(req, res, ctx, token, head) {
  const record = head ? ctx.downloads.inspect(token) : ctx.downloads.take(token);
  if (!record) {
    finish(req, res, 404, { error: "not_found", message: "This download link is unknown, expired, or already used." });
    ctx.config.log("404 /files\n");
    return;
  }
  let target;
  try {
    target = reviewDownloadUrl(record.url);
  } catch {
    finish(req, res, 404, { error: "not_found", message: "This download link is not an allowed file." });
    ctx.config.log("404 /files\n");
    return;
  }
  const access = callerAccess(ctx.config.stateDir, record.userId);
  if (access === "revoked") {
    finish(req, res, 410, { error: "gone", message: "The sign-in for this download was revoked." });
    ctx.config.log("410 /files\n");
    return;
  }
  if (head) {
    res.writeHead(200, downloadHeaders(record, null));
    res.end();
    ctx.config.log("200 /files\n");
    return;
  }
  const accountEnv = envForAccount(ctx.config.env, ctx.config.stateDir, record.userId);
  let fetchUrl = target;
  try {
    const parsed = new URL(target);
    if (parsed.hostname === "campus.tum.de") {
      const stored = loadTumToken(ctx.config.stateDir, record.userId, accountEnv);
      if (stored?.token && !parsed.searchParams.has("pToken")) parsed.searchParams.set("pToken", stored.token);
      fetchUrl = parsed.toString();
    }
  } catch {
    fetchUrl = target;
  }
  let opened;
  try {
    opened = await streamGet(ctx.config.fetchImpl, fetchUrl, { service: "TUMonline" });
  } catch {
    finish(req, res, 502, { error: "bad_gateway", message: "The file could not be fetched." });
    ctx.config.log("502 /files\n");
    return;
  }
  if (opened.status !== 200) {
    await cancelBody(opened.body);
    opened.release?.();
    const mapped = opened.status === 404 ? 404 : opened.status === 429 ? 429 : 502;
    finish(req, res, mapped, { error: mapped === 404 ? "not_found" : mapped === 429 ? "rate_limited" : "bad_gateway", message: "The file could not be fetched." });
    ctx.config.log(`${mapped} /files\n`);
    return;
  }
  res.writeHead(200, downloadHeaders(record, opened.headers));
  ctx.config.log("200 /files\n");
  pipeBody(res, opened.body, opened.release);
}

function callerAccess(stateDir, userId) {
  const staticState = staticCallerState(stateDir, userId);
  const oauthState = oauthCallerState(stateDir, userId);
  if (staticState === "live" || oauthState === "live") return "live";
  if (staticState === "revoked" || oauthState === "revoked") return "revoked";
  return "unknown";
}

function downloadHeaders(record, upstream) {
  const headers = {
    "Content-Type": upstreamType(upstream) || record.mimeType || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${record.filename}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  const length = upstream?.get?.("content-length");
  if (typeof length === "string" && /^\d{1,12}$/.test(length)) headers["Content-Length"] = length;
  return headers;
}

function upstreamType(upstream) {
  const raw = upstream?.get?.("content-type");
  if (typeof raw !== "string") return null;
  const token = raw.split(";")[0].trim().toLowerCase();
  return /^[\w.+-]+\/[\w.+-]+$/.test(token) ? token : null;
}

function pipeBody(res, body, release) {
  if (!body) {
    release?.();
    res.end();
    return;
  }
  const stream = Readable.fromWeb(body);
  const done = () => release?.();
  stream.on("error", () => {
    done();
    res.destroy();
  });
  res.on("close", done);
  stream.pipe(res);
}

async function cancelBody(body) {
  try {
    await body?.cancel();
  } catch {
    // The unused body is discarded.
  }
}

function sendRpc(res, reply, payload, sessionId, accept) {
  if (accept.sse && !accept.json) {
    if (res.headersSent || res.writableEnded) return;
    const headers = baseHeaders();
    headers["Content-Type"] = "text/event-stream; charset=utf-8";
    headers["Cache-Control"] = "no-cache, no-store";
    headers["X-Accel-Buffering"] = "no";
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    res.writeHead(200, headers);
    res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    reply.logOnly?.(200);
    return;
  }
  reply(200, payload, { sessionId });
}

function finish(req, res, status, payload, extra = {}) {
  if (res.headersSent || res.writableEnded) return;
  const headers = { ...baseHeaders(), ...extra.headers };
  if (extra.sessionId) headers["Mcp-Session-Id"] = extra.sessionId;
  if (extra.close) headers.Connection = "close";
  if (payload == null) {
    res.writeHead(status, headers);
    res.end();
  } else {
    const body = Buffer.from(JSON.stringify(payload));
    headers["Content-Type"] = "application/json; charset=utf-8";
    headers["Content-Length"] = String(body.length);
    res.writeHead(status, headers);
    res.end(body);
  }
  if (extra.close) res.on("finish", () => req.destroy());
}

function baseHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  };
}

function enqueue(tails, key, fn) {
  const previous = tails.get(key) ?? Promise.resolve();
  const current = previous.then(() => fn(), () => fn());
  const settled = current.then(() => undefined, () => undefined);
  tails.set(key, settled);
  settled.then(() => {
    if (tails.get(key) === settled) tails.delete(key);
  });
  return current;
}

function sweepSessions(sessions) {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastUsed > SESSION_TTL_MS) sessions.delete(id);
  }
}

function dropUser(sessions, userId) {
  for (const [id, session] of sessions) {
    if (session.userId === userId) sessions.delete(id);
  }
}

function createLimiter(limit, windowMs) {
  const buckets = new Map();
  return {
    fail(key) {
      const now = Date.now();
      let bucket = buckets.get(key);
      if (!bucket || now >= bucket.resetAt) {
        if (!bucket && buckets.size >= 2048) buckets.delete(buckets.keys().next().value);
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      if (bucket.count >= limit) return { ok: false, retryAfter };
      bucket.count += 1;
      return { ok: true, retryAfter };
    },
  };
}

function bearerToken(header) {
  if (Array.isArray(header) || typeof header !== "string" || header.length > 400 || header.includes(",")) return null;
  const match = /^Bearer[ \t]+([!-~]+)$/i.exec(header.trim());
  if (!match || match[1].length > 256) return null;
  return match[1];
}

function acceptKinds(header) {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (typeof value !== "string" || value.length > 400) return { json: false, sse: false };
  const lower = value.toLowerCase();
  const any = lower.includes("*/*");
  return { json: any || lower.includes("application/json"), sse: any || lower.includes("text/event-stream") };
}

function isJsonContent(header) {
  return typeof header === "string" && /^application\/json(?:\s*;\s*charset="?utf-8"?)?$/i.test(header.trim());
}

function declaredLength(header) {
  if (header == null) return null;
  if (Array.isArray(header) || !/^[0-9]+$/.test(header)) return "invalid";
  return Number(header);
}

async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const error = new Error("payload_too_large");
      error.code = "payload_too_large";
      req.destroy();
      throw error;
    }
    chunks.push(chunk);
  }
  return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
}

function classify(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") return { kind: "invalid" };
  if (typeof message.method === "string") {
    if (message.method.length === 0 || message.method.length > 128 || /[\r\n]/.test(message.method)) return { kind: "invalid" };
    if (!acceptableId(message)) return { kind: "invalid" };
    if (!Object.prototype.hasOwnProperty.call(message, "id")) return { kind: "notification", message };
    return { kind: "request", message };
  }
  if (("result" in message || "error" in message) && acceptableId(message)) return { kind: "response", message };
  return { kind: "invalid" };
}

function acceptableId(message) {
  if (!Object.prototype.hasOwnProperty.call(message, "id")) return true;
  const id = message.id;
  if (id === null || (typeof id === "number" && Number.isSafeInteger(id))) return true;
  return typeof id === "string" && id.length <= 128 && !/[\r\n]/.test(id);
}

function sessionHeader(value) {
  if (value == null) return { missing: true };
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return { invalid: true };
  return { id: value };
}

function supportedProtocolHeader(value) {
  if (value == null) return true;
  return typeof value === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(value);
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcId(message) {
  if (message && Object.prototype.hasOwnProperty.call(message, "id") && acceptableId(message)) return message.id ?? null;
  return null;
}

function clientKey(req) {
  const address = req.socket?.remoteAddress || "unknown";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function parseRequestUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    return new URL(value, "http://127.0.0.1");
  } catch {
    return null;
  }
}

function listenPort(server) {
  const address = server?.address?.();
  return address && typeof address !== "string" ? address.port : null;
}

function hostAllowed(header, config, boundPort) {
  if (Array.isArray(header) || typeof header !== "string" || header.length > 255) return false;
  const parsed = splitHost(header.trim());
  if (!parsed) return false;
  const name = parsed.hostname.toLowerCase();
  const names = new Set(["127.0.0.1", "localhost", "::1", ...config.allowedHosts]);
  if (config.publicHostname) names.add(config.publicHostname);
  if (!names.has(name)) return false;
  if (parsed.port == null || parsed.port === boundPort) return true;
  return Boolean(config.publicHostname) && name === config.publicHostname && parsed.port === config.publicPort;
}

function originAllowed(header, config, boundPort) {
  if (header == null || (typeof header === "string" && header.trim() === "")) return true;
  if (Array.isArray(header) || typeof header !== "string" || header.length > 200) return false;
  let origin;
  try {
    const url = new URL(header);
    if (url.origin !== header || url.username || url.password) return false;
    origin = url.origin;
  } catch {
    return false;
  }
  return allowedOrigins(config, boundPort).has(origin);
}

function allowedOrigins(config, boundPort) {
  const origins = new Set(config.extraOrigins);
  if (config.publicOrigin) origins.add(config.publicOrigin);
  if (boundPort != null) {
    origins.add(`http://127.0.0.1:${boundPort}`);
    origins.add(`http://localhost:${boundPort}`);
    origins.add(`http://[::1]:${boundPort}`);
  }
  return origins;
}

function splitHost(value) {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 2) return null;
    const hostname = value.slice(1, end);
    const rest = value.slice(end + 1);
    if (rest === "") return { hostname, port: null };
    if (!/^:[0-9]+$/.test(rest)) return null;
    return { hostname, port: Number(rest.slice(1)) };
  }
  const colon = value.lastIndexOf(":");
  if (colon === -1) return { hostname: value, port: null };
  if (value.indexOf(":") !== colon) return null;
  const hostname = value.slice(0, colon);
  const portText = value.slice(colon + 1);
  if (hostname === "" || !/^[0-9]+$/.test(portText)) return null;
  const port = Number(portText);
  if (port > 65535) return null;
  return { hostname, port };
}

function parseHost(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 || !/^[A-Za-z0-9.:_-]+$/.test(value)) {
    throw new SafeError("usage", "The host is not a valid bind address.");
  }
  return value;
}

function parsePort(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value) && Number(value) <= 65535) return Number(value);
  throw new SafeError("usage", "The port must be an integer from 0 to 65535.");
}

function parsePublicOrigin(value) {
  if (value == null || value === "") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SafeError("invalid_public_url", "TUMONLINE_MCP_PUBLIC_URL must be an https origin.");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new SafeError("invalid_public_url", "TUMONLINE_MCP_PUBLIC_URL must be an origin without a path, query, or credentials.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new SafeError("invalid_public_url", "TUMONLINE_MCP_PUBLIC_URL must be an https origin.");
  }
  return url.origin;
}

function parseOriginList(value) {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    const origin = parsePublicOrigin(item);
    if (!origin) throw new SafeError("invalid_public_url", "TUMONLINE_MCP_ALLOWED_ORIGINS must be a comma-separated list of origins.");
    return origin;
  });
}

function parseHostList(value) {
  if (!value) return [];
  return value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean).map((item) => {
    if (!/^[a-z0-9.-]{1,255}$/.test(item) || item.startsWith(".") || item.includes("..")) {
      throw new SafeError("usage", "TUMONLINE_MCP_ALLOWED_HOSTS must be a comma-separated list of hostnames.");
    }
    return item;
  });
}

function envString(env, key) {
  const value = env[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function positiveInteger(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new SafeError("usage", "A numeric server limit was not a positive integer.");
}

function listen(server, config) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error?.code === "EADDRINUSE") {
        reject(new SafeError("listen", "The HTTP port is already in use."));
        return;
      }
      if (error?.code === "EACCES") {
        reject(new SafeError("listen", "The HTTP server could not bind that address."));
        return;
      }
      reject(new SafeError("listen", "The HTTP server could not start."));
    };
    server.once("error", onError);
    server.listen(config.port, config.host, () => {
      server.off("error", onError);
      server.on("error", () => config.log("500 /\n"));
      resolve();
    });
  });
}

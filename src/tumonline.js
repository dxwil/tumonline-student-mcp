import { hasTumToken, loadTumToken, saveTumToken } from "./access.js";
import { SafeError } from "./errors.js";
import { getText } from "./http.js";
import { childrenNamed, elementValue, errorMessage, findAll, findFirst, parseXml, rows, textOf } from "./xml.js";

export const DEFAULT_BASE = "https://campus.tum.de/tumonline";
export const DEFAULT_TOKEN_NAME = "tumonline-student-mcp";

const RIGHTS = {
  kalender: "calendar",
  veranstaltungenEigene: "lectures",
  veranstaltungenDetails: "lectures",
  veranstaltungenTermine: "lectures",
  veranstaltungenSuche: "lectures",
  noten: "grades",
  absNoten: "grades",
  pruefungenEigene: "exam results",
  studienbeitragsstatus: "tuition fees",
  id: "identity",
  personenSuche: "persons",
  personenDetails: "persons",
  isTokenConfirmed: "identity",
};

const lanes = new Map();
let inflight = 0;
const waiters = [];
const MAX_INFLIGHT = 2;

export function parseBase(value) {
  const raw = typeof value === "string" && value.trim() !== "" ? value.trim() : DEFAULT_BASE;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeError("usage", "TUMONLINE_MCP_BASE_URL must be the TUMonline prefix, such as https://campus.tum.de/tumonline.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.username || url.password || url.search || url.hash) {
    throw new SafeError("usage", "TUMONLINE_MCP_BASE_URL must not include credentials, a query, or a fragment.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new SafeError("usage", "TUMONLINE_MCP_BASE_URL must be https, or http on localhost.");
  }
  const pathName = url.pathname.replace(/\/$/, "");
  return `${url.origin}${pathName}`;
}

export function tokenNameFrom(env) {
  const raw = typeof env.TUMONLINE_MCP_TOKEN_NAME === "string" && env.TUMONLINE_MCP_TOKEN_NAME.trim() !== ""
    ? env.TUMONLINE_MCP_TOKEN_NAME.trim()
    : DEFAULT_TOKEN_NAME;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(raw)) {
    throw new SafeError("usage", "TUMONLINE_MCP_TOKEN_NAME must be 1 to 40 letters, digits, dots, underscores, or hyphens.");
  }
  return raw;
}

export function timeoutFrom(env) {
  return positiveEnv(env, "TUMONLINE_MCP_TIMEOUT_MS", 20_000, 60_000);
}

export function scrub(text, secret) {
  let out = String(text ?? "");
  if (secret) {
    out = out.split(secret).join("[redacted]");
  }
  out = out.replace(/pToken=[^&\s"'<>]+/gi, "pToken=[redacted]");
  return out.replace(/\s+/g, " ").trim();
}

export function mapTumonlineError(message, fn, secret) {
  const clean = scrub(message, secret).slice(0, 300);
  const right = RIGHTS[fn] ?? fn;
  if (/Request-Rate überschritten/i.test(clean)) {
    return new SafeError(
      "rate_limited",
      'TUMonline refused the request because its rate limit was reached ("Request-Rate überschritten"). Wait a few minutes and try again. This server will also pause calls for this user.',
    );
  }
  if (/Token-Limit/i.test(clean)) {
    return new SafeError(
      "token_limit",
      'TUMonline refused a new token because the token limit was reached ("Token-Limit"). Campus clients document this as about 10 active tokens. In TUMonline open Visitenkarte or Services, then Token-Management, delete an unused token, and request again.',
    );
  }
  if (/nicht bestätigt/i.test(clean)) {
    return new SafeError(
      "token_unconfirmed",
      'The TUMonline token is not activated yet ("Token ist nicht bestätigt!"). In TUMonline open Visitenkarte or Services, then Token-Management, activate this token, and enable calendar, lectures, grades, exam results, tuition fees, identity, and persons. Then use Check activation or get_token_status.',
    );
  }
  if (/Keine Rechte für Funktion|Funktion nicht erlaubt/i.test(clean)) {
    const named = /Keine Rechte für Funktion[:\s'"]*([A-Za-z][A-Za-z0-9_]{1,40})/i.exec(clean);
    const functionName = named?.[1] ?? fn;
    const needed = RIGHTS[functionName] ?? right;
    return new SafeError(
      "missing_right",
      `The TUMonline token is missing the ${needed} right. TUMonline said "${clean}". In TUMonline open Visitenkarte or Services, then Token-Management, select this token, and enable ${needed}.`,
    );
  }
  if (/Token ist ungültig|ungültiges Benutzertoken/i.test(clean)) {
    return new SafeError(
      "invalid_tum_token",
      "TUMonline rejected the stored token as invalid. Request a new token from the sign-in page, or paste an activated token again.",
    );
  }
  if (/Ungültige pIdentNr|Person ist nicht sichtbar/i.test(clean)) {
    return new SafeError("not_found", "TUMonline could not show that person. The id may be wrong, or the person is not visible.");
  }
  if (/Suchstring/i.test(clean)) {
    return new SafeError("invalid_arguments", "TUMonline did not accept that search. Use at least a few letters of a name.");
  }
  if (/kein Benutzer|konnte kein Benutzer|Benutzer wurde nicht gefunden|unbekannter Benutzer/i.test(clean)) {
    return new SafeError("unknown_user", "TUMonline did not find that TUM ID. Check the ID and try again.");
  }
  if (clean === "") {
    return new SafeError("tumonline", `TUMonline refused ${fn}.`);
  }
  return new SafeError("tumonline", `TUMonline refused ${fn}: ${clean}`);
}

export function activationSteps(name) {
  return [
    "Open TUMonline at campus.tum.de and sign in.",
    "Open Visitenkarte or Services, then Token-Management.",
    `Activate the token named "${name}". The token value stays on this server and is not shown.`,
    "Enable these rights: calendar, lectures, grades, exam results, tuition fees, identity, and persons.",
    "Return here and choose Check activation.",
  ];
}

export async function requestNewToken(env, fetchImpl, tumId) {
  assertTumId(tumId);
  const base = parseBase(env.TUMONLINE_MCP_BASE_URL);
  const name = tokenNameFrom(env);
  const url = new URL(`${base}/wbservicesbasic.requestToken`);
  url.searchParams.set("pUsername", tumId);
  url.searchParams.set("pTokenName", name);
  const root = await fetchXml(fetchImpl, url, env, null, "requestToken", env.TUMONLINE_MCP_USER_ID || `request:${tumId.toLowerCase()}`);
  const token = readToken(root);
  if (!token) {
    throw new SafeError("tumonline", "TUMonline did not return a token. No token was stored.");
  }
  return { token, tokenName: name };
}

export async function confirmToken(env, fetchImpl, token) {
  const root = await callWithToken(env, fetchImpl, token, "isTokenConfirmed", {});
  const value = textOf(root, "confirmed") ?? textOf(root, null);
  return value === "true";
}

export async function callFunction(env, fetchImpl, fn, params = {}) {
  const stateDir = env.TUMONLINE_MCP_STATE_DIR;
  const userId = env.TUMONLINE_MCP_USER_ID;
  if (!stateDir || !userId) {
    throw new SafeError("not_configured", "This session has no account directory.");
  }
  const stored = loadTumToken(stateDir, userId, env);
  if (!stored?.token) {
    throw new SafeError(
      "token_required",
      "No TUMonline token is stored for this user. Sign in again from the MCP client, or run tumonline-student-mcp connect for a local session.",
    );
  }
  try {
    return await callWithToken(env, fetchImpl, stored.token, fn, params);
  } catch (error) {
    if (error instanceof SafeError && error.code === "invalid_tum_token") {
      saveTumToken(stateDir, userId, env, { ...stored, confirmed: false });
    }
    if (error instanceof SafeError && error.code === "token_unconfirmed") {
      saveTumToken(stateDir, userId, env, { ...stored, confirmed: false });
    }
    throw error;
  }
}

export function requireConfirmed(env) {
  const stored = loadTumToken(env.TUMONLINE_MCP_STATE_DIR, env.TUMONLINE_MCP_USER_ID, env);
  if (!stored?.token) {
    throw new SafeError(
      "token_required",
      "No TUMonline token is stored for this user. Sign in again from the MCP client and activate the token.",
    );
  }
  if (stored.confirmed !== true) {
    throw new SafeError(
      "token_unconfirmed",
      `The TUMonline token is stored but not marked active. In TUMonline open Visitenkarte or Services, then Token-Management, activate "${stored.tokenName || tokenNameFrom(env)}", enable calendar, lectures, grades, exam results, tuition fees, identity, and persons, then run get_token_status.`,
    );
  }
  return stored;
}

export function markConfirmed(env, confirmed) {
  const stateDir = env.TUMONLINE_MCP_STATE_DIR;
  const userId = env.TUMONLINE_MCP_USER_ID;
  const stored = loadTumToken(stateDir, userId, env);
  if (!stored) {
    return;
  }
  saveTumToken(stateDir, userId, env, { ...stored, confirmed: confirmed === true });
}

export function tokenStatusView(env) {
  if (!hasTumToken(env.TUMONLINE_MCP_STATE_DIR, env.TUMONLINE_MCP_USER_ID)) {
    return null;
  }
  const stored = loadTumToken(env.TUMONLINE_MCP_STATE_DIR, env.TUMONLINE_MCP_USER_ID, env);
  return {
    stored: true,
    source: stored.source || "pasted",
    tokenName: stored.tokenName || tokenNameFrom(env),
    tumIdHint: hintTumId(stored.tumId),
    confirmed: stored.confirmed === true,
    createdAt: stored.createdAt || null,
  };
}

async function callWithToken(env, fetchImpl, token, fn, params) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(fn) || fn === "terminCreate" || fn === "terminDelete" || fn === "secretUpload") {
    throw new SafeError("invalid_arguments", "That TUMonline function is not available.");
  }
  const base = parseBase(env.TUMONLINE_MCP_BASE_URL);
  const url = new URL(`${base}/wbservicesbasic.${fn}`);
  for (const [key, value] of Object.entries(params)) {
    if (!/^p[A-Za-z][A-Za-z0-9]{0,40}$/.test(key) || /^ptoken$/i.test(key)) {
      throw new SafeError("invalid_arguments", "A TUMonline parameter was not accepted.");
    }
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set("pToken", token);
  return fetchXml(fetchImpl, url, env, token, fn, env.TUMONLINE_MCP_USER_ID || "anon");
}

async function fetchXml(fetchImpl, url, env, secret, fn, laneKey) {
  let result;
  let held = false;
  try {
    await pace(laneKey, env);
    await acquire();
    held = true;
    result = await getText(fetchImpl, url, {
      service: "TUMonline",
      timeoutMs: timeoutFrom(env),
      accept: "application/xml, text/xml",
    });
  } finally {
    if (held) {
      release();
    }
  }
  if (result.status === 429) {
    noteRateLimit(laneKey);
    throw mapTumonlineError("Request-Rate überschritten", fn, secret);
  }
  if (result.status === 404) {
    throw new SafeError("not_found", `TUMonline has no function ${fn}.`);
  }
  let root;
  try {
    root = parseXml(result.text);
  } catch (error) {
    if (error instanceof SafeError) {
      throw error;
    }
    throw new SafeError("malformed", "TUMonline returned a response that is not XML.");
  }
  const message = errorMessage(root);
  if (message) {
    const mapped = mapTumonlineError(message, fn, secret);
    if (mapped.code === "rate_limited") {
      noteRateLimit(laneKey);
    }
    throw mapped;
  }
  if (result.status >= 400) {
    throw new SafeError("tumonline", `TUMonline returned HTTP ${result.status} for ${fn}.`);
  }
  return root;
}

function readToken(root) {
  const named = findFirst(root, "token");
  const text = (named ? named.text : root.text).trim();
  if (!/^[0-9A-Fa-f]{16,128}$/.test(text)) {
    return null;
  }
  return text;
}

export function assertTumId(value) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9]{1,15}$/.test(value) || /^[0-9A-Fa-f]{16,}$/.test(value)) {
    throw new SafeError("invalid_arguments", "Enter a TUM ID, such as ab12cde. Do not paste a token into the TUM ID field.");
  }
  return value;
}

export function assertExistingToken(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9A-Fa-f]{16,128}$/.test(trimmed)) {
    throw new SafeError("invalid_arguments", "The existing token was not accepted. Paste the activated TUMonline token only.");
  }
  return trimmed;
}

function hintTumId(value) {
  if (typeof value !== "string" || value.length < 4) {
    return null;
  }
  return `${value.slice(0, 2)}••${value.slice(-2)}`;
}

function positiveEnv(env, key, fallback, max) {
  const raw = env?.[key];
  if (raw == null || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new SafeError("usage", `${key} must be an integer from 0 to ${max}.`);
  }
  return value;
}

async function pace(userId, env) {
  const minInterval = positiveEnv(env, "TUMONLINE_MCP_MIN_INTERVAL_MS", 250, 10_000);
  const limit = positiveEnv(env, "TUMONLINE_MCP_USER_LIMIT", 30, 10_000) || 30;
  const now = Date.now();
  let lane = lanes.get(userId);
  if (!lane) {
    lane = { nextAt: 0, stamps: [], blockedUntil: 0 };
    if (lanes.size > 5000) {
      lanes.delete(lanes.keys().next().value);
    }
    lanes.set(userId, lane);
  }
  if (lane.blockedUntil > now) {
    throw new SafeError(
      "rate_limited",
      "This server is pausing TUMonline calls for this user after a rate limit. Wait a minute and try again.",
    );
  }
  lane.stamps = lane.stamps.filter((stamp) => now - stamp < 60_000);
  if (lane.stamps.length >= limit) {
    throw new SafeError(
      "rate_limited",
      "This server is limiting TUMonline calls for this user. Wait a minute and try again.",
    );
  }
  const wait = Math.max(0, lane.nextAt - now);
  if (wait > 0) {
    if (wait > 5_000) {
      throw new SafeError("rate_limited", "This server is spacing out TUMonline calls. Try again in a few seconds.");
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  const stamped = Date.now();
  lane.nextAt = stamped + minInterval;
  lane.stamps.push(stamped);
}

function noteRateLimit(userId) {
  const lane = lanes.get(userId) ?? { nextAt: 0, stamps: [], blockedUntil: 0 };
  lane.blockedUntil = Date.now() + 60_000;
  lanes.set(userId, lane);
}

function acquire() {
  if (inflight < MAX_INFLIGHT) {
    inflight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(resolve);
  }).then(() => {
    inflight += 1;
  });
}

function release() {
  inflight = Math.max(0, inflight - 1);
  const next = waiters.shift();
  if (next) {
    next();
  }
}

export function projectRows(root) {
  return rows(root).map((row) => sanitizeRow(row));
}

export function averagesFrom(root) {
  const studies = findAll(root, "studium");
  if (studies.length > 0) {
    return studies.map((node) => sanitizeRow(elementValue(node) ?? {}));
  }
  return projectRows(root);
}

export function eventsFrom(root) {
  const events = findFirst(root, "events");
  const nodes = childrenNamed(events ?? root, "event");
  return nodes.map((node) => {
    const value = elementValue(node) ?? {};
    const location = Array.isArray(value.location) ? value.location.filter(Boolean).join("; ") : value.location ?? null;
    return {
      id: stringField(value.nr),
      title: stringField(value.title),
      start: stringField(value.dtstart),
      end: stringField(value.dtend),
      location: stringField(location),
      status: stringField(value.status),
      description: clip(stringField(value.description), 1000),
      url: stringField(value.url),
    };
  });
}

export function personFrom(root) {
  const person = findFirst(root, "person");
  if (!person) {
    return null;
  }
  const value = elementValue(person) ?? {};
  delete value.image_data;
  delete value.bild;
  return sanitizeRow(value);
}

function sanitizeRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return row;
  }
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (/image_data|bild_data|secret|token/i.test(key)) {
      continue;
    }
    if (typeof value === "string") {
      if (value.length > 4000) {
        out[key] = `${value.slice(0, 4000)}…`;
      } else {
        out[key] = value;
      }
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, 50).map((entry) => (entry && typeof entry === "object" ? sanitizeRow(entry) : entry));
    } else if (value && typeof value === "object") {
      out[key] = sanitizeRow(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function stringField(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join("; ");
  if (typeof value === "string") return value;
  return String(value);
}

function clip(value, max) {
  if (typeof value !== "string" || value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

export { RIGHTS };

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SafeError } from "./errors.js";
import { decryptJson, encryptJson, loadKey } from "./secret.js";

const TOKEN_ID = /^t_[a-f0-9]{16}$/;
const USER_ID = /^u_[a-f0-9]{32}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const ACTIVE_LIMIT = 100;

export const LOCAL_USER_ID = `u_${crypto.createHash("sha256").update("tumonline-student-mcp-local").digest("hex").slice(0, 32)}`;

const COPY_ENV = [
  "TUMONLINE_MCP_BASE_URL",
  "TUMONLINE_MCP_NAV_BASE",
  "TUMONLINE_MCP_TOKEN_NAME",
  "TUMONLINE_MCP_TOKEN_KEY",
  "TUMONLINE_MCP_TIMEOUT_MS",
  "TUMONLINE_MCP_MIN_INTERVAL_MS",
  "TUMONLINE_MCP_USER_LIMIT",
  "TUMONLINE_MCP_PUBLIC_URL",
  "PATH",
];

export function resolveStateDir(env) {
  const configured = typeof env.TUMONLINE_MCP_STATE_DIR === "string" ? env.TUMONLINE_MCP_STATE_DIR.trim() : "";
  const resolved = path.resolve(configured || "/var/lib/tumonline-student-mcp");
  if (resolved === path.parse(resolved).root) {
    throw new SafeError("state_dir", "The state directory must not be the filesystem root.");
  }
  return resolved;
}

export function ensureStateDir(dir) {
  const resolved = resolveStateDir({ TUMONLINE_MCP_STATE_DIR: dir });
  try {
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(resolved, "users"), { recursive: true, mode: 0o700 });
    fs.chmodSync(resolved, 0o700);
    fs.chmodSync(path.join(resolved, "users"), 0o700);
  } catch (error) {
    if (error instanceof SafeError) {
      throw error;
    }
    throw new SafeError("state_dir", "The state directory could not be created.");
  }
  assertMode(resolved, 0o700);
  assertMode(path.join(resolved, "users"), 0o700);
  return resolved;
}

export function userDirectory(stateDir, userId) {
  if (typeof userId !== "string" || !USER_ID.test(userId)) {
    throw new SafeError("invalid_arguments", "The account id is not valid.");
  }
  const root = path.resolve(stateDir, "users");
  const directory = path.resolve(root, userId);
  if (directory !== path.join(root, userId)) {
    throw new SafeError("invalid_arguments", "The account id is not valid.");
  }
  return directory;
}

export function envForAccount(baseEnv, stateDir, userId) {
  const directory = userDirectory(stateDir, userId);
  const next = {};
  for (const key of COPY_ENV) {
    if (typeof baseEnv[key] === "string") {
      next[key] = baseEnv[key];
    }
  }
  next.TUMONLINE_MCP_STATE_DIR = stateDir;
  next.TUMONLINE_MCP_USER_ID = userId;
  next.TUMONLINE_MCP_USER_DIR = directory;
  return next;
}

export function ensureUserDir(stateDir, userId) {
  const directory = userDirectory(stateDir, userId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  assertMode(directory, 0o700);
  return directory;
}

export function saveTumToken(stateDir, userId, env, record) {
  return withStateLock(stateDir, () => {
    const directory = ensureUserDir(stateDir, userId);
    const key = loadKey(env, stateDir);
    const envelope = encryptJson(key, userId, {
      token: record.token,
      tumId: record.tumId ?? "",
      tokenName: record.tokenName ?? "",
      source: record.source ?? "pasted",
      createdAt: record.createdAt ?? new Date().toISOString(),
      confirmed: record.confirmed === true,
    });
    writePrivate(path.join(directory, "tum-token.json"), `${JSON.stringify(envelope)}\n`);
    return { userId, confirmed: record.confirmed === true };
  });
}

export function loadTumToken(stateDir, userId, env) {
  const file = path.join(userDirectory(stateDir, userId), "tum-token.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new SafeError("token_unreadable", "The stored TUMonline token could not be read.");
  }
  const key = loadKey(env, stateDir);
  return decryptJson(key, userId, envelope);
}

export function hasTumToken(stateDir, userId) {
  try {
    return fs.existsSync(path.join(userDirectory(stateDir, userId), "tum-token.json"));
  } catch {
    return false;
  }
}

export function normalizeLabel(value) {
  if (value == null || value === "") {
    return "";
  }
  if (typeof value !== "string" || !LABEL.test(value)) {
    throw new SafeError("usage", "The label must be 1 to 40 letters, digits, dots, underscores, or hyphens.");
  }
  return value;
}

export function createAccessToken(stateDir, options = {}) {
  const label = normalizeLabel(options.label);
  return withStateLock(stateDir, () => {
    ensureStateDir(stateDir);
    const existing = readTokens(stateDir);
    if (existing.filter((entry) => !entry.revokedAt).length >= ACTIVE_LIMIT) {
      throw new SafeError("state_dir", "Too many access tokens. Revoke one before creating another.");
    }
    const secret = `tsm_${crypto.randomBytes(32).toString("base64url")}`;
    const record = {
      id: `t_${crypto.randomBytes(8).toString("hex")}`,
      label,
      hash: sha256(secret),
      userId: `u_${crypto.randomBytes(16).toString("hex")}`,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    ensureUserDir(stateDir, record.userId);
    writeTokens(stateDir, [...existing, record]);
    return { id: record.id, label: record.label, token: secret, userId: record.userId };
  });
}

export function revokeAccessToken(stateDir, tokenId) {
  assertTokenId(tokenId, "Usage: tumonline-student-mcp token revoke <id>");
  return withStateLock(stateDir, () => {
    const tokens = readTokens(stateDir);
    const index = tokens.findIndex((entry) => entry.id === tokenId && !entry.revokedAt);
    if (index < 0) {
      throw new SafeError("not_found", "No active access token has that id.");
    }
    const revoked = { ...tokens[index], revokedAt: new Date().toISOString() };
    tokens[index] = revoked;
    writeTokens(stateDir, tokens);
    return publicRecord(revoked);
  });
}

export function listAccessTokens(stateDir) {
  ensureStateDir(stateDir);
  return readTokens(stateDir).map(publicRecord);
}

export function findAccessToken(stateDir, tokenId) {
  assertTokenId(tokenId, "Usage: tumonline-student-mcp connect <id>");
  ensureStateDir(stateDir);
  const record = readTokens(stateDir).find((entry) => entry.id === tokenId);
  if (!record) {
    throw new SafeError("not_found", "No access token has that id.");
  }
  return publicRecord(record);
}

export function staticCallerState(stateDir, userId) {
  let records = [];
  try {
    records = readTokens(stateDir);
  } catch {
    return "none";
  }
  const mine = records.filter((entry) => entry.userId === userId);
  if (mine.length === 0) {
    return "none";
  }
  return mine.some((entry) => !entry.revokedAt) ? "live" : "revoked";
}

export function verifyBearer(stateDir, presented) {
  const material = typeof presented === "string" && presented.length > 0 && presented.length <= 256 ? presented : "\0";
  const digest = crypto.createHash("sha256").update(material, "utf8").digest();
  let records = [];
  try {
    records = readTokens(stateDir);
  } catch {
    records = [];
  }
  let found = null;
  let revokedUserId = null;
  let compared = false;
  for (const record of records) {
    const stored = /^[a-f0-9]{64}$/.test(record.hash) ? Buffer.from(record.hash, "hex") : null;
    if (!stored || stored.length !== digest.length) {
      crypto.timingSafeEqual(digest, Buffer.alloc(digest.length));
      compared = true;
      continue;
    }
    const same = crypto.timingSafeEqual(stored, digest);
    compared = true;
    if (!same) {
      continue;
    }
    if (record.revokedAt) {
      revokedUserId = record.userId;
      continue;
    }
    if (found) {
      continue;
    }
    try {
      userDirectory(stateDir, record.userId);
      found = publicRecord(record);
    } catch {
      found = null;
    }
  }
  if (!compared) {
    crypto.timingSafeEqual(digest, Buffer.alloc(digest.length));
  }
  return { account: found, revokedUserId: found ? null : revokedUserId };
}

function publicRecord(record) {
  return {
    id: record.id,
    label: record.label,
    userId: record.userId,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
  };
}

function readTokens(stateDir) {
  const file = tokenFile(stateDir);
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const tokens = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
    return tokens.filter(validRecord);
  } catch {
    return [];
  }
}

function writeTokens(stateDir, tokens) {
  writePrivate(tokenFile(stateDir), `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`);
}

function tokenFile(stateDir) {
  return path.join(stateDir, "access-tokens.json");
}

function validRecord(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (typeof entry.id !== "string" || !TOKEN_ID.test(entry.id)) return false;
  if (typeof entry.hash !== "string" || !/^[a-f0-9]{64}$/.test(entry.hash)) return false;
  if (typeof entry.userId !== "string" || !USER_ID.test(entry.userId)) return false;
  if (typeof entry.label !== "string" || (entry.label !== "" && !LABEL.test(entry.label))) return false;
  if (typeof entry.createdAt !== "string" || entry.createdAt.length > 40) return false;
  if (entry.revokedAt != null && (typeof entry.revokedAt !== "string" || entry.revokedAt.length > 40)) return false;
  return true;
}

function assertTokenId(tokenId, usage) {
  if (typeof tokenId !== "string" || !TOKEN_ID.test(tokenId)) {
    throw new SafeError("usage", usage);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function writePrivate(file, contents) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function assertMode(file, expected) {
  const mode = fs.statSync(file).mode & 0o777;
  if (mode !== expected) {
    throw new SafeError("state_dir", "The state directory could not be made private.");
  }
}

export function withStateLock(stateDir, fn) {
  const directory = ensureStateDir(stateDir);
  const lockPath = path.join(directory, ".lock");
  const started = Date.now();
  let fd;
  while (fd == null) {
    try {
      if (fs.existsSync(lockPath) && Date.now() - fs.statSync(lockPath).mtimeMs > 15_000) {
        fs.rmSync(lockPath, { force: true });
      }
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error && error.code === "EEXIST") {
        if (Date.now() - started > 5_000) {
          throw new SafeError("state_dir", "The state directory is busy.");
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        continue;
      }
      if (error instanceof SafeError) {
        throw error;
      }
      throw new SafeError("state_dir", "The state directory could not be locked.");
    }
  }
  try {
    fs.chmodSync(lockPath, 0o600);
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
}

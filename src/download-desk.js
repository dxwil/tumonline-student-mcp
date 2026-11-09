import crypto from "node:crypto";
import { SafeError } from "./errors.js";

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 200;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const ALLOWED_HOSTS = new Set(["campus.tum.de", "nav.tum.de"]);

export function reviewDownloadUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SafeError("invalid_arguments", "The download URL was not accepted.");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.username || url.password || url.hash || /pToken=/i.test(url.href)) {
    throw new SafeError("invalid_arguments", "The download URL was not accepted.");
  }
  if (!local && (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname))) {
    throw new SafeError("invalid_arguments", "Downloads are limited to campus.tum.de and nav.tum.de.");
  }
  if (local && url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeError("invalid_arguments", "The download URL was not accepted.");
  }
  return url.toString();
}

export function createDownloadDesk(options = {}) {
  const entries = new Map();
  const now = () => (typeof options.now === "function" ? options.now() : Date.now());
  return {
    issue({ userId, url, filename, mimeType, base }) {
      const safeUrl = reviewDownloadUrl(url);
      sweep(entries, now());
      if (entries.size >= MAX_ENTRIES) {
        throw new SafeError("rate_limited", "Too many download links are waiting. Use one before requesting more.");
      }
      const token = crypto.randomBytes(32).toString("base64url");
      const expiresAtMs = now() + TTL_MS;
      entries.set(hashToken(token), {
        userId,
        url: safeUrl,
        filename: sanitizeFilename(filename),
        mimeType: mimeType || "application/octet-stream",
        expiresAtMs,
      });
      const root = String(base).replace(/\/$/, "");
      return { downloadUrl: `${root}/files/${token}`, expiresAt: new Date(expiresAtMs).toISOString() };
    },
    inspect(token) {
      return lookup(entries, token, now(), false);
    },
    take(token) {
      return lookup(entries, token, now(), true);
    },
  };
}

function sanitizeFilename(filename) {
  const cleaned = String(filename ?? "download").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 150);
  return cleaned || "download";
}

function lookup(entries, token, nowMs, consume) {
  if (typeof token !== "string" || !TOKEN.test(token)) return null;
  const key = hashToken(token);
  const record = entries.get(key);
  if (!record) return null;
  if (record.expiresAtMs <= nowMs) {
    entries.delete(key);
    return null;
  }
  if (consume) entries.delete(key);
  return record;
}

function sweep(entries, nowMs) {
  for (const [key, record] of entries) {
    if (record.expiresAtMs <= nowMs) entries.delete(key);
  }
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

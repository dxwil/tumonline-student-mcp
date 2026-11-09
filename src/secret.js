import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SafeError } from "./errors.js";

const VERSION = 1;

export function decodeKey(value) {
  if (typeof value !== "string") {
    throw new SafeError("usage", "TUMONLINE_MCP_TOKEN_KEY must be 32 bytes, as base64 or hex.");
  }
  const trimmed = value.trim();
  const buffer = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (buffer.length !== 32) {
    throw new SafeError("usage", "TUMONLINE_MCP_TOKEN_KEY must be 32 bytes, as base64 or hex.");
  }
  return buffer;
}

export function loadKey(env, stateDir) {
  const configured = typeof env.TUMONLINE_MCP_TOKEN_KEY === "string" ? env.TUMONLINE_MCP_TOKEN_KEY.trim() : "";
  if (configured) {
    return decodeKey(configured);
  }
  const file = path.join(stateDir, "token.key");
  if (fs.existsSync(file)) {
    const stored = fs.readFileSync(file);
    if (stored.length !== 32) {
      throw new SafeError("state_dir", "The token encryption key could not be read.");
    }
    return stored;
  }
  const created = crypto.randomBytes(32);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, created, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return created;
}

export function encryptJson(key, userId, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(userId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: VERSION,
    alg: "A256GCM",
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

export function decryptJson(key, userId, envelope) {
  if (!envelope || envelope.version !== VERSION || envelope.alg !== "A256GCM") {
    throw new SafeError("token_unreadable", "The stored TUMonline token could not be read.");
  }
  try {
    const iv = Buffer.from(envelope.iv, "base64url");
    const tag = Buffer.from(envelope.tag, "base64url");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      throw new Error("shape");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(userId, "utf8"));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plain);
    if (!parsed || typeof parsed.token !== "string") {
      throw new Error("shape");
    }
    return parsed;
  } catch (error) {
    if (error instanceof SafeError) {
      throw error;
    }
    throw new SafeError("token_unreadable", "The stored TUMonline token could not be read.");
  }
}

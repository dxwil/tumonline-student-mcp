import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadTumToken, saveTumToken, userDirectory } from "../src/access.js";
import { decryptJson, encryptJson } from "../src/secret.js";
import { KEY_B64, tempDir, testEnv, TOKEN } from "./support.js";

test("AES-256-GCM ciphertext is bound to the MCP user and hides the token", () => {
  const key = Buffer.from(KEY_B64, "base64");
  const userA = "u_" + "a".repeat(32);
  const userB = "u_" + "b".repeat(32);
  const envelope = encryptJson(key, userA, { token: TOKEN, tumId: "ab12cde" });
  const raw = JSON.stringify(envelope);
  assert.equal(raw.includes(TOKEN), false);
  assert.equal(raw.includes("ab12cde"), false);
  assert.equal(decryptJson(key, userA, envelope).token, TOKEN);
  assert.throws(() => decryptJson(key, userB, envelope), /could not be read/);
  assert.throws(() => decryptJson(Buffer.alloc(32, 1), userA, envelope), /could not be read/);
});

test("a stored token file does not contain the token and cannot be read as another user", () => {
  const stateDir = tempDir();
  const env = testEnv(stateDir);
  const userA = "u_" + "c".repeat(32);
  const userB = "u_" + "d".repeat(32);
  saveTumToken(stateDir, userA, env, { token: TOKEN, tumId: "ab12cde", tokenName: "tumonline-student-mcp", source: "requested", confirmed: false });
  const file = path.join(userDirectory(stateDir, userA), "tum-token.json");
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(raw.includes(TOKEN), false);
  assert.equal(raw.includes("ab12cde"), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(loadTumToken(stateDir, userA, env).token, TOKEN);
  fs.mkdirSync(userDirectory(stateDir, userB), { recursive: true });
  fs.copyFileSync(file, path.join(userDirectory(stateDir, userB), "tum-token.json"));
  assert.throws(() => loadTumToken(stateDir, userB, env), /could not be read/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateSchema } from "./json-schema.js";

const root = path.resolve(".");
const pluginSchema = JSON.parse(fs.readFileSync(path.join(root, "vendor/agent-plugins/1.0.0/plugin.schema.json"), "utf8"));
const mcpSchema = JSON.parse(fs.readFileSync(path.join(root, "vendor/agent-plugins/1.0.0/mcp.schema.json"), "utf8"));

test("plugin.json and mcp.json match the vendored Agent Plugins 1.0.0 schemas", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
  const mcp = JSON.parse(fs.readFileSync(path.join(root, "mcp.json"), "utf8"));
  assert.deepEqual(validateSchema(pluginSchema, plugin), []);
  assert.deepEqual(validateSchema(mcpSchema, mcp), []);
  assert.equal(plugin.name, "tumonline-student-mcp");
  assert.equal(mcp.mcpServers["tumonline-student-mcp"].command, "./bin/tumonline-student-mcp");
  assert.equal(Object.hasOwn(mcp.mcpServers["tumonline-student-mcp"], "cwd"), false);
  assert.equal(JSON.stringify(mcp).includes("CURSOR_PLUGIN_ROOT"), false);
});

test("Cursor cwd placeholder is only in cursor-mcp.json", () => {
  const cursorMcp = JSON.parse(fs.readFileSync(path.join(root, "cursor-mcp.json"), "utf8"));
  const cursorManifest = JSON.parse(fs.readFileSync(path.join(root, ".cursor-plugin/plugin.json"), "utf8"));
  assert.equal(cursorManifest.mcpServers, "./cursor-mcp.json");
  assert.equal(cursorMcp.mcpServers["tumonline-student-mcp"].cwd, "${CURSOR_PLUGIN_ROOT}");
  const asStandard = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { "tumonline-student-mcp": { type: "stdio", command: "./bin/tumonline-student-mcp", cwd: "${CURSOR_PLUGIN_ROOT}" } },
  };
  assert.equal(validateSchema(mcpSchema, asStandard).length > 0, true);
});

test("the skill names the token flow and the tree does not embed the fixture token", () => {
  const skill = fs.readFileSync(path.join(root, "skills/tumonline-student-mcp/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: tumonline-student-mcp\n/);
  assert.match(skill, /get_token_status/);
  assert.match(skill, /Moodle/);
  const scanned = [];
  for (const relative of ["src", "bin", "skills", "README.md", "plugin.json", "mcp.json", "docs"]) walk(path.join(root, relative), scanned);
  const text = scanned.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.equal(text.includes("0123456789abcdef0123456789abcdef"), false);
});

function walk(target, files) {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) walk(path.join(target, entry), files);
    return;
  }
  files.push(target);
}

import assert from "node:assert/strict";
import test from "node:test";
import { mapTumonlineError } from "../src/tumonline.js";
import { errorMessage, parseXml, rows } from "../src/xml.js";
import { FIXTURES, TOKEN } from "./support.js";

test("parses a TUMonline rowset and nested obfuscated ids", () => {
  const root = parseXml(FIXTURES.identity);
  const row = rows(root)[0];
  assert.equal(row.kennung, "ab12cde");
  assert.equal(row.vorname, "Ada");
  assert.equal(row.obfuscated_ids.studierende, "studierende*99");
});

test("parses a token element, confirmed flag, and calendar events", () => {
  assert.equal(parseXml(FIXTURES.token).text.trim(), TOKEN);
  assert.equal(parseXml(FIXTURES.confirmed).text.trim(), "true");
  const events = parseXml(FIXTURES.calendar);
  assert.equal(events.children[0].children.find((child) => child.name === "title").text.trim(), "Info1");
});

test("decodes entities and rejects a doctype", () => {
  const root = parseXml("<rowset><row><titel>A &amp; B</titel></row></rowset>");
  assert.equal(rows(root)[0].titel, "A & B");
  assert.throws(() => parseXml("<!DOCTYPE foo [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]><foo>&xxe;</foo>"), /document type/);
});

test("reads the error message element", () => {
  assert.equal(errorMessage(parseXml(FIXTURES.noRightLectures)), "Keine Rechte für Funktion veranstaltungenEigene");
});

test("maps rate limit, token limit, unconfirmed token, and a missing right", () => {
  assert.equal(mapTumonlineError("Request-Rate überschritten", "kalender").code, "rate_limited");
  assert.match(mapTumonlineError("Request-Rate überschritten", "kalender").message, /Request-Rate überschritten/);
  assert.equal(mapTumonlineError("Token-Limit erreicht", "requestToken").code, "token_limit");
  assert.match(mapTumonlineError("Token-Limit erreicht", "requestToken").message, /Token-Management/);
  assert.equal(mapTumonlineError("Token ist nicht bestätigt!", "noten").code, "token_unconfirmed");
  const missing = mapTumonlineError("Keine Rechte für Funktion veranstaltungenEigene", "veranstaltungenEigene");
  assert.equal(missing.code, "missing_right");
  assert.match(missing.message, /lectures/);
  assert.match(missing.message, /Token-Management/);
  assert.equal(mapTumonlineError("Token ist ungültig!", "id", TOKEN).code, "invalid_tum_token");
  assert.equal(mapTumonlineError(TOKEN, "id", TOKEN).message.includes(TOKEN), false);
});

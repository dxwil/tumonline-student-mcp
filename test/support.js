import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TOKEN = "0123456789abcdef0123456789abcdef";
export const TOKEN_B = "fedcba9876543210fedcba9876543210";
export const TUM_ID = "ab12cde";
export const KEY_B64 = Buffer.alloc(32, 7).toString("base64");

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tumonline-mcp-"));
}

export function testEnv(stateDir, extra = {}) {
  return {
    TUMONLINE_MCP_STATE_DIR: stateDir,
    TUMONLINE_MCP_MIN_INTERVAL_MS: "0",
    TUMONLINE_MCP_USER_LIMIT: "1000",
    TUMONLINE_MCP_TOKEN_KEY: KEY_B64,
    TUMONLINE_MCP_TOKEN_NAME: "tumonline-student-mcp",
    ...extra,
  };
}

export function assertClean(text, secrets) {
  for (const secret of secrets) {
    if (secret && text.includes(secret)) {
      throw new Error("a secret appeared in output");
    }
  }
}

export const FIXTURES = {
  token: `<?xml version="1.0" encoding="UTF-8"?><token>${TOKEN}</token>`,
  tokenB: `<token>${TOKEN_B}</token>`,
  confirmed: "<confirmed>true</confirmed>",
  unconfirmed: "<confirmed>false</confirmed>",
  rate: "<error><message>Request-Rate überschritten</message></error>",
  tokenLimit: "<error><message>Token-Limit erreicht</message></error>",
  unconfirmedError: "<error><message>Token ist nicht bestätigt!</message></error>",
  invalid: "<error><message>Token ist ungültig!</message></error>",
  noRightLectures: "<error><message>Keine Rechte für Funktion veranstaltungenEigene</message></error>",
  noUser: "<error><message>Es konnte kein Benutzer mit dem Namen gefunden werden.</message></error>",
  identity: `<?xml version="1.0"?><rowset><row>
    <vorname>Ada</vorname><familienname>Lovelace</familienname><kennung>ab12cde</kennung>
    <obfuscated_id>studierende*99</obfuscated_id>
    <obfuscated_ids><studierende>studierende*99</studierende><bedienstete></bedienstete><extern></extern></obfuscated_ids>
  </row></rowset>`,
  calendar: `<events>
    <event><nr>11</nr><title>Info1</title><dtstart>2026-11-09T10:00:00</dtstart><dtend>2026-11-09T12:00:00</dtend><location>MI HS1</location><status>OK</status><description>Vorlesung</description></event>
    <event><nr>12</nr><title>Later</title><dtstart>2026-12-01T10:00:00</dtstart><dtend>2026-12-01T11:00:00</dtend><location>Galerie</location><status>OK</status></event>
  </events>`,
  courses: `<rowset><row>
    <stp_lv_nr>95001</stp_lv_nr><stp_sp_nr>123</stp_sp_nr><stp_sp_titel>Einführung</stp_sp_titel>
    <stp_lv_art_name>Vorlesung</stp_lv_art_name><stp_sp_sst>4</stp_sp_sst><semester_name>Wintersemester 2026/27</semester_name>
    <vortragende_mitwirkende>Hopper</vortragende_mitwirkende><org_name_betreut>Informatik</org_name_betreut>
  </row></rowset>`,
  details: `<rowset><row>
    <stp_lv_nr>95001</stp_lv_nr><stp_sp_titel>Einführung</stp_sp_titel><lehrinhalt>Algorithmen</lehrinhalt>
    <haupt_unterrichtssprache>Deutsch</haupt_unterrichtssprache><ersttermin>2026-10-13</ersttermin>
  </row></rowset>`,
  dates: `<rowset><row>
    <beginn_datum_zeitpunkt>2026-11-09T10:00:00</beginn_datum_zeitpunkt>
    <ende_datum_zeitpunkt>2026-11-09T12:00:00</ende_datum_zeitpunkt>
    <art>Vorlesung</art><ort>MI HS1</ort><raum_nr>5602.EG.001</raum_nr><lv_grp_name>Gruppe 1</lv_grp_name>
  </row></rowset>`,
  grades: `<rowset><row>
    <lv_titel>Diskrete Strukturen</lv_titel><lv_nummer>IN0015</lv_nummer><lv_semester>2025W</lv_semester>
    <datum>2026-02-20</datum><uninotenamekurz>1,3</uninotenamekurz><pruefer_nachname>Noether</pruefer_nachname>
    <modus>Schriftlich</modus><exam_typ_name>Klausur</exam_typ_name><studienbezeichnung>Informatik B.Sc.</studienbezeichnung>
  </row></rowset>`,
  averages: `<rowset><studium><studidf>42</studidf><studbez>Informatik B.Sc.</studbez><avg_grade_weighted_by_credits>1.7</avg_grade_weighted_by_credits></studium></rowset>`,
  exams: `<rowset><row><pv_term_nr>77</pv_term_nr><lv_titel>Info1</lv_titel><lv_nummer>IN0001</lv_nummer><stp_sp_nr>95001</stp_sp_nr><datum>2027-02-10</datum></row></rowset>`,
  fees: `<rowset><row><semester_bezeichnung>WS 2026/27</semester_bezeichnung><semester_id>242</semester_id><soll>0</soll><frist>2026-11-15</frist></row></rowset>`,
  persons: `<rowset><row><obfuscated_id>bedienstete*7</obfuscated_id><vorname>Grace</vorname><familienname>Hopper</familienname><geschlecht>W</geschlecht><titel>Prof.</titel></row></rowset>`,
  person: `<person><vorname>Grace</vorname><familienname>Hopper</familienname><obfuscated_id>bedienstete*7</obfuscated_id><email>grace@example.edu</email><image_data>SECRETIMAGE</image_data><sprechstunde>Tue 10</sprechstunde><raeume><raum><kurz>01.07.014</kurz><ortsbeschreibung>MI</ortsbeschreibung></raum></raeume></person>`,
  lectures: `<rowset><row><stp_lv_nr>95002</stp_lv_nr><stp_sp_titel>Datenbanken</stp_sp_titel><stp_lv_art_name>Vorlesung</stp_lv_art_name><semester_name>Wintersemester 2026/27</semester_name></row></rowset>`,
};

export function mockTum(handlers) {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    const token = parsed.searchParams.get("pToken");
    calls.push({ pathname: parsed.pathname, token, username: parsed.searchParams.get("pUsername"), href: parsed.href });
    const handler = handlers.find((entry) => entry.match(parsed));
    if (!handler) return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    const body = typeof handler.body === "function" ? handler.body(parsed) : handler.body;
    return new Response(body, { status: handler.status ?? 200, headers: { "content-type": handler.type ?? "text/xml; charset=utf-8" } });
  };
  return { calls, fetchImpl };
}

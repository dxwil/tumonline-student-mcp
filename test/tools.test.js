import assert from "node:assert/strict";
import test from "node:test";
import { saveTumToken } from "../src/access.js";
import { createToolImpl } from "../src/impl.js";
import { createMcpHandler, TOOLS } from "../src/mcp.js";
import { envForAccount } from "../src/access.js";
import { FIXTURES, mockTum, tempDir, testEnv, TOKEN } from "./support.js";

function account(stateDir) {
  const env = testEnv(stateDir);
  const userId = `u_${"e".repeat(32)}`;
  saveTumToken(stateDir, userId, env, { token: TOKEN, tumId: "ab12cde", tokenName: "tumonline-student-mcp", source: "pasted", confirmed: true });
  return envForAccount(env, stateDir, userId);
}

function routes(extra = []) {
  const xml = {
    "/tumonline/wbservicesbasic.id": FIXTURES.identity,
    "/tumonline/wbservicesbasic.isTokenConfirmed": FIXTURES.confirmed,
    "/tumonline/wbservicesbasic.kalender": FIXTURES.calendar,
    "/tumonline/wbservicesbasic.veranstaltungenEigene": FIXTURES.courses,
    "/tumonline/wbservicesbasic.veranstaltungenDetails": FIXTURES.details,
    "/tumonline/wbservicesbasic.veranstaltungenTermine": FIXTURES.dates,
    "/tumonline/wbservicesbasic.noten": FIXTURES.grades,
    "/tumonline/wbservicesbasic.absNoten": FIXTURES.averages,
    "/tumonline/wbservicesbasic.pruefungenEigene": FIXTURES.exams,
    "/tumonline/wbservicesbasic.studienbeitragsstatus": FIXTURES.fees,
    "/tumonline/wbservicesbasic.personenSuche": FIXTURES.persons,
    "/tumonline/wbservicesbasic.personenDetails": FIXTURES.person,
    "/tumonline/wbservicesbasic.veranstaltungenSuche": FIXTURES.lectures,
  };
  return [
    ...extra,
    ...Object.entries(xml).map(([pathname, body]) => ({ match: (url) => url.pathname === pathname, body })),
    {
      match: (url) => url.pathname === "/tumonline/ee/rest/slc.lib.tm/semesters/student",
      type: "application/json",
      body: JSON.stringify({ semesters: [{ id: 242, key: "26W", semesterDesignation: { value: "Wintersemester 2026/27" }, isSelected: true, startOfAcademicSemester: { value: "2026-10-01" }, endOfAcademicSemester: { value: "2027-03-31" } }] }),
    },
    {
      match: (url) => url.pathname === "/tumonline/ee/rest/slc.tm.cp/student/courses",
      type: "application/json",
      body: JSON.stringify({ totalCount: 1, courses: [{ id: 95001, courseNumber: { courseNumber: "IN0001" }, courseTitle: { value: "Einführung", translations: { translation: [{ lang: "en", value: "Introduction" }] } }, courseTypeDto: { courseTypeName: { value: "Vorlesung" } }, semesterDto: { key: "26W" }, lectureships: [{ identityLibDto: { firstName: "Grace", lastName: "Hopper" } }] }] }),
    },
    {
      match: (url) => url.pathname === "/tumonline/ee/rest/slc.tm.cp/student/courses/95001",
      type: "application/json",
      body: JSON.stringify({ resource: [{ content: { cpCourseDetailDto: { cpCourseDto: { id: 95001, courseTitle: { value: "Einführung" }, courseNumber: { courseNumber: "IN0001" }, semesterDto: { key: "26W" } }, cpCourseDescriptionDto: { courseContent: { value: "Algorithmen" } } } } }] }),
    },
    {
      match: (url) => url.pathname.includes("/courseGroups/"),
      type: "application/json",
      body: JSON.stringify({ courseGroupDtos: [{ id: 5, name: "Vorlesung", standardgroupFlag: "J", lectureshipDtos: [], appointmentSeriesDtos: [], appointmentDtos: [{ timestampFrom: { value: "2026-11-09T10:00:00" }, timestampTo: { value: "2026-11-09T12:00:00" }, resourceName: "MI HS1", weekday: { key: "MO" } }] }] }),
    },
    {
      match: (url) => url.pathname.includes("/exExamOffer"),
      type: "application/json",
      body: JSON.stringify({ totalCount: 1, examOffers: [{ id: 77, courseId: 95001, displayCourseNumber: "IN0001", courseName: { value: "Einführung", translations: { translation: [{ lang: "en", value: "Introduction" }] } }, examDate: { value: "2027-02-10" }, examStart: { value: "08:00:00" }, examEnd: { value: "09:30:00" }, examType: { value: "Klausur" }, examPersons: [{ identities: [{ firstName: "Ada", lastName: "Lovelace" }] }] }] }),
    },
    {
      match: (url) => url.pathname === "/api/search",
      type: "application/json",
      body: JSON.stringify({ sections: [{ entries: [{ id: "hn.100", name: "Heilbronn Hörsaal", type: "room", subtext: "Bildungscampus", subtext_bold: "HN" }, { id: "5602.EG.001", name: "MI HS1", type: "room", subtext: "Garching" }] }], time_ms: 4 }),
    },
    {
      match: (url) => url.pathname === "/api/locations/hn.100",
      type: "application/json",
      body: JSON.stringify({ id: "hn.100", name: "Heilbronn Hörsaal", type: "room", type_common_name: "Room", aliases: [], parents: ["root", "heilbronn"], parent_names: ["Root", "Heilbronn"], parent_types: ["root", "campus"], props: { computed: [{ name: "Adresse", text: "Bildungscampus 2" }] }, coords: { lat: 49.14, lon: 9.21, source: "manual" }, maps: {}, ranking_factors: {}, sources: {} }),
    },
  ];
}

test("personal tools parse the Campus XML fixtures and do not return the token or image", async () => {
  const stateDir = tempDir();
  const env = account(stateDir);
  const { calls, fetchImpl } = mockTum(routes());
  const impl = createToolImpl(env, fetchImpl);
  const identity = await impl.getIdentity();
  assert.equal(identity.tumId, "ab12cde");
  assert.equal(identity.firstName, "Ada");
  const calendar = await impl.getCalendar("2026-11-01", "2026-11-30");
  assert.deepEqual(calendar.events.map((event) => event.title), ["Info1"]);
  const courses = await impl.listMyCourses();
  assert.equal(courses.courses[0].lvNumber, "95001");
  const details = await impl.getCourseDetails("95001", true);
  assert.equal(details.content, "Algorithmen");
  assert.equal(details.dates[0].room, "MI HS1");
  const grades = await impl.getGrades(true);
  assert.equal(grades.grades[0].grade, "1,3");
  assert.equal(grades.averages[0].average, "1.7");
  const exams = await impl.listMyExams();
  assert.equal(exams.exams[0].pv_term_nr, "77");
  const fees = await impl.getFeeStatus();
  assert.equal(fees.fees[0].openAmountEur, "0");
  const persons = await impl.searchPersons("Hop");
  assert.equal(persons.persons[0].lastName, "Hopper");
  const person = await impl.getPerson("bedienstete*7");
  assert.equal(person.person.email, "grace@example.edu");
  assert.equal(JSON.stringify(person).includes("SECRETIMAGE"), false);
  const lectures = await impl.searchLectures("Daten");
  assert.equal(lectures.lectures[0].title, "Datenbanken");
  const status = await impl.getTokenStatus(true, true);
  assert.equal(status.confirmed, true);
  assert.equal(status.rights.calendar, "ok");
  assert.equal(status.rights.lectures, "ok");
  assert.equal(JSON.stringify({ identity, status, person }).includes(TOKEN), false);
  assert.ok(calls.every((call) => call.pathname.startsWith("/tumonline/") || call.pathname.startsWith("/api/")));
  assert.equal(calls.some((call) => call.token === TOKEN && call.pathname.endsWith(".id")), true);
});

test("a missing lectures right names the right to enable", async () => {
  const stateDir = tempDir();
  const env = account(stateDir);
  const { fetchImpl } = mockTum([{ match: (url) => url.pathname.endsWith(".veranstaltungenEigene"), body: FIXTURES.noRightLectures }]);
  await assert.rejects(createToolImpl(env, fetchImpl).listMyCourses(), (error) => {
    assert.equal(error.code, "missing_right");
    assert.match(error.message, /lectures/);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
});

test("an unconfirmed token and a rate limit become tool errors", async () => {
  const stateDir = tempDir();
  const env = account(stateDir);
  const unconfirmed = mockTum([{ match: (url) => url.pathname.endsWith(".id"), body: FIXTURES.unconfirmedError }]);
  await assert.rejects(createToolImpl(env, unconfirmed.fetchImpl).getIdentity(), /not activated/);
  const limited = mockTum([{ match: (url) => url.pathname.endsWith(".noten"), body: FIXTURES.rate }]);
  const other = envForAccount(testEnv(stateDir), stateDir, `u_${"f".repeat(32)}`);
  saveTumToken(stateDir, other.TUMONLINE_MCP_USER_ID, testEnv(stateDir), { token: TOKEN, source: "pasted", confirmed: true, tokenName: "tumonline-student-mcp" });
  await assert.rejects(createToolImpl(other, limited.fetchImpl).getGrades(false), (error) => error.code === "rate_limited");
});

test("public catalogue, public exams, and NavigaTUM including Heilbronn need no token", async () => {
  const stateDir = tempDir();
  const env = envForAccount(testEnv(stateDir), stateDir, `u_${"1".repeat(32)}`);
  const { calls, fetchImpl } = mockTum(routes());
  const impl = createToolImpl(env, fetchImpl);
  const semesters = await impl.listSemesters("en");
  assert.equal(semesters.semesters[0].key, "26W");
  const found = await impl.searchCourses({ query: "Info", semester: "26W", limit: 5, offset: 0, language: "en" });
  assert.equal(found.courses[0].title, "Introduction");
  assert.match(calls.at(-1).href, /\$filter=/);
  assert.match(calls.at(-1).href, /26W|termId-eq=242/);
  const course = await impl.getCourse("95001", "en");
  assert.equal(course.course.content, "Algorithmen");
  const groups = await impl.getCourseGroups("95001", "en");
  assert.equal(groups.groups[0].name, "Vorlesung");
  const dates = await impl.getCourseDates({ courseId: "95001", language: "en", includePast: true, limit: 10 });
  assert.equal(dates.dates[0].room, "MI HS1");
  const exams = await impl.listPublicExams({ from: "2026-11-01", to: "2027-03-01", courseNumbers: ["IN0001"], limit: 10 });
  assert.equal(exams.exams[0].courseName, "Einführung");
  assert.equal(exams.exams[0].examiners[0], "Ada Lovelace");
  const rooms = await impl.searchRooms({ query: "hörsaal", campus: null, limit: 10 });
  assert.equal(rooms.includesHeilbronn, true);
  assert.equal(rooms.rooms.some((room) => room.id === "hn.100"), true);
  const filtered = await impl.searchRooms({ query: "hörsaal", campus: "heilbronn", limit: 5 });
  assert.match(calls.at(-1).href, /in=heilbronn/);
  assert.equal(filtered.campus, "heilbronn");
  const room = await impl.getRoom("hn.100", "de");
  assert.equal(room.room.includesHeilbronn, true);
  assert.equal(room.room.campuses.includes("Heilbronn"), true);
  assert.equal(calls.some((call) => call.token), false);
});

test("the protocol lists every read-only tool and states what is unsupported", async () => {
  const handler = createMcpHandler(createToolImpl(envForAccount(testEnv(tempDir()), tempDir(), `u_${"2".repeat(32)}`), async () => new Response("")));
  const init = await handler({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  assert.equal(init.result.serverInfo.name, "tumonline-student-mcp");
  assert.match(init.result.instructions, /Moodle/);
  assert.match(init.result.instructions, /terminCreate/);
  assert.match(init.result.instructions, /enrollment certificate/);
  const listed = await handler({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
  assert.equal(TOOLS.length, 19);
  assert.equal(TOOLS.every((tool) => tool.annotations.readOnlyHint === true), true);
  const rejected = await handler({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_identity", arguments: { token: "nope" } } });
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.content[0].text, /invalid_arguments/);
});

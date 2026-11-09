import { SafeError } from "./errors.js";
import { getRoom, searchRooms } from "./navigatum.js";
import { courseGroups, getCourse, listPublicExams, listSemesters, publicDates, searchCourses, summarizeGroups } from "./public-api.js";
import {
  averagesFrom,
  callFunction,
  eventsFrom,
  markConfirmed,
  personFrom,
  projectRows,
  requireConfirmed,
  tokenStatusView,
} from "./tumonline.js";

const RIGHT_PROBES = [
  ["identity", "id", {}],
  ["calendar", "kalender", { pMonateVor: 0, pMonateNach: 0 }],
  ["lectures", "veranstaltungenEigene", {}],
  ["grades", "noten", {}],
  ["exam_results", "pruefungenEigene", {}],
  ["tuition_fees", "studienbeitragsstatus", {}],
  ["persons", "personenSuche", { pSuche: "Test" }],
];

export function createToolImpl(env, fetchImpl) {
  return {
    async getTokenStatus(probe, refresh) {
      const view = tokenStatusView(env);
      if (!view) {
        return {
          stored: false,
          confirmed: false,
          rights: {},
          next: "Sign in from the MCP client. Enter a TUM ID to request a token, or paste an activated token. The token is stored encrypted for this user and is never shown.",
        };
      }
      let confirmed = view.confirmed;
      try {
        const root = await callFunction(env, fetchImpl, "isTokenConfirmed", {});
        confirmed = confirmedText(root) === "true";
        markConfirmed(env, confirmed);
      } catch (error) {
        if (error instanceof SafeError && error.code === "token_unconfirmed") {
          confirmed = false;
          markConfirmed(env, false);
        } else {
          throw error;
        }
      }
      const rights = probe ? await probeRights(env, fetchImpl, refresh) : {};
      return { ...view, confirmed, rights, probed: probe === true };
    },
    async getIdentity() {
      requireConfirmed(env);
      const row = projectRows(await callFunction(env, fetchImpl, "id", {}))[0] ?? {};
      return {
        tumId: row.kennung ?? null,
        firstName: row.vorname ?? null,
        lastName: row.familienname ?? null,
        obfuscatedId: row.obfuscated_id ?? null,
        obfuscatedIds: row.obfuscated_ids ?? null,
      };
    },
    async getCalendar(from, to) {
      requireConfirmed(env);
      const range = dateRange(from, to, 14, 400);
      const months = monthWindow(range.from, range.to);
      const root = await callFunction(env, fetchImpl, "kalender", { pMonateVor: months.before, pMonateNach: months.after });
      const events = eventsFrom(root)
        .filter((event) => {
          const day = String(event.start ?? "").slice(0, 10);
          return day >= range.from && day <= range.to;
        })
        .sort((left, right) => String(left.start).localeCompare(String(right.start)));
      return { from: range.from, to: range.to, timezone: "Europe/Berlin", count: events.length, events: events.slice(0, 500) };
    },
    async listMyCourses() {
      requireConfirmed(env);
      const courses = projectRows(await callFunction(env, fetchImpl, "veranstaltungenEigene", {})).slice(0, 200).map(courseRow);
      return { count: courses.length, courses };
    },
    async getCourseDetails(lvNumber, includeDates) {
      requireConfirmed(env);
      const row = projectRows(await callFunction(env, fetchImpl, "veranstaltungenDetails", { pLVNr: lvNumber }))[0];
      if (!row) {
        throw new SafeError("not_found", "TUMonline has no course with that LV number.");
      }
      let dates;
      if (includeDates) {
        dates = projectRows(await callFunction(env, fetchImpl, "veranstaltungenTermine", { pLVNr: lvNumber })).slice(0, 400).map((entry) => ({
          start: entry.beginn_datum_zeitpunkt ?? null,
          end: entry.ende_datum_zeitpunkt ?? null,
          type: entry.art ?? null,
          room: entry.ort ?? entry.raum_nr ?? null,
          roomCode: entry.raum_nr ?? null,
          group: entry.lv_grp_name ?? null,
          subject: entry.termin_betreff ?? null,
        }));
      }
      return { course: courseRow(row), content: clip(row.lehrinhalt), objectives: clip(row.lehrziel), methods: clip(row.lehrmethode), prerequisites: clip(row.voraussetzung_lv), language: row.haupt_unterrichtssprache ?? null, firstDate: row.ersttermin ?? null, dates };
    },
    async getGrades(includeAverages) {
      requireConfirmed(env);
      const grades = projectRows(await callFunction(env, fetchImpl, "noten", {})).slice(0, 500).map((row) => ({
        course: row.lv_titel ?? null,
        courseNumber: row.lv_nummer ?? null,
        semester: row.lv_semester ?? null,
        date: row.datum ?? null,
        grade: row.uninotenamekurz ?? null,
        examiner: row.pruefer_nachname ?? null,
        mode: row.modus ?? null,
        examType: row.exam_typ_name ?? null,
        degreeProgram: row.studienbezeichnung ?? null,
        studyId: row.studienidentifikator ?? null,
        degree: row.abschluss_name ?? null,
      }));
      let averages = null;
      let averagesError = null;
      if (includeAverages) {
        try {
          averages = averagesFrom(await callFunction(env, fetchImpl, "absNoten", {})).slice(0, 20).map((row) => ({
            studyId: row.studidf ?? row.studienidentifikator ?? null,
            program: row.studbez ?? row.studienbezeichnung ?? null,
            average: row.avg_grade_weighted_by_credits ?? null,
          }));
        } catch (error) {
          if (error instanceof SafeError && (error.code === "missing_right" || error.code === "not_found")) {
            averagesError = { error: error.code, message: error.message };
          } else {
            throw error;
          }
        }
      }
      return { count: grades.length, grades, averages, averagesError };
    },
    async listMyExams() {
      requireConfirmed(env);
      const exams = projectRows(await callFunction(env, fetchImpl, "pruefungenEigene", {})).slice(0, 400);
      return { count: exams.length, exams };
    },
    async getFeeStatus() {
      requireConfirmed(env);
      const fees = projectRows(await callFunction(env, fetchImpl, "studienbeitragsstatus", {})).slice(0, 20).map((row) => ({
        semester: row.semester_bezeichnung ?? null,
        semesterId: row.semester_id ?? null,
        openAmountEur: row.soll ?? null,
        deadline: row.frist ?? null,
      }));
      return { fees };
    },
    async searchPersons(query) {
      requireConfirmed(env);
      const persons = projectRows(await callFunction(env, fetchImpl, "personenSuche", { pSuche: query })).slice(0, 50).map((row) => ({
        id: row.obfuscated_id ?? row.nr ?? null,
        title: row.titel ?? null,
        firstName: row.vorname ?? null,
        lastName: row.familienname ?? null,
        gender: row.geschlecht ?? null,
      }));
      return { count: persons.length, persons };
    },
    async getPerson(personId) {
      requireConfirmed(env);
      const person = personFrom(await callFunction(env, fetchImpl, "personenDetails", { pIdentNr: personId }));
      if (!person) {
        throw new SafeError("not_found", "TUMonline could not find that person.");
      }
      return { person };
    },
    async searchLectures(query) {
      requireConfirmed(env);
      const lectures = projectRows(await callFunction(env, fetchImpl, "veranstaltungenSuche", { pSuche: query })).slice(0, 50).map(courseRow);
      return { source: "wbservicesbasic.veranstaltungenSuche", count: lectures.length, lectures };
    },
    async listSemesters(language) {
      return { semesters: await listSemesters(env, fetchImpl, language) };
    },
    async searchCourses(args) {
      return searchCourses(env, fetchImpl, args);
    },
    async getCourse(courseId, language) {
      return { course: await getCourse(env, fetchImpl, courseId, language) };
    },
    async getCourseGroups(courseId, language) {
      const groups = await courseGroups(env, fetchImpl, courseId);
      return { courseId, groups: summarizeGroups(groups, language) };
    },
    async getCourseDates(args) {
      if (args.lvNumber) {
        requireConfirmed(env);
        const dates = projectRows(await callFunction(env, fetchImpl, "veranstaltungenTermine", { pLVNr: args.lvNumber })).slice(0, args.limit).map((entry) => ({
          start: entry.beginn_datum_zeitpunkt ?? null,
          end: entry.ende_datum_zeitpunkt ?? null,
          type: entry.art ?? null,
          room: entry.ort ?? entry.raum_nr ?? null,
          group: entry.lv_grp_name ?? null,
          subject: entry.termin_betreff ?? null,
        }));
        return { source: "wbservicesbasic.veranstaltungenTermine", lvNumber: args.lvNumber, count: dates.length, dates };
      }
      const groups = await courseGroups(env, fetchImpl, args.courseId);
      return { source: "ee/rest/slc.tm.cp/student/courseGroups", courseId: args.courseId, ...publicDates(groups, args.language, args) };
    },
    async listPublicExams(args) {
      return listPublicExams(env, fetchImpl, args);
    },
    async searchRooms(args) {
      return searchRooms(env, fetchImpl, args);
    },
    async getRoom(id, language) {
      return { room: await getRoom(env, fetchImpl, id, language) };
    },
  };
}

async function probeRights(env, fetchImpl, refresh) {
  void refresh;
  const rights = {};
  for (const [name, fn, params] of RIGHT_PROBES) {
    try {
      await callFunction(env, fetchImpl, fn, params);
      rights[name] = "ok";
    } catch (error) {
      if (!(error instanceof SafeError)) {
        rights[name] = "unknown";
        break;
      }
      if (error.code === "missing_right") {
        rights[name] = "missing";
        continue;
      }
      if (error.code === "rate_limited") {
        rights[name] = "rate_limited";
        break;
      }
      if (error.code === "invalid_arguments" || error.code === "not_found") {
        rights[name] = "ok";
        continue;
      }
      rights[name] = error.code;
      if (error.code === "token_unconfirmed" || error.code === "invalid_tum_token") {
        break;
      }
    }
  }
  return rights;
}

function confirmedText(root) {
  if (!root) return "";
  if (root.name === "confirmed") return root.text.trim();
  const nested = root.children?.find((entry) => entry.name === "confirmed");
  return nested ? nested.text.trim() : "";
}

function courseRow(row) {
  return {
    lvNumber: row.stp_lv_nr ?? null,
    courseId: row.stp_sp_nr ?? null,
    title: row.stp_sp_titel ?? null,
    type: row.stp_lv_art_name ?? null,
    typeShort: row.stp_lv_art_kurz ?? null,
    sws: row.stp_sp_sst ?? null,
    semester: row.semester_name ?? row.semester ?? null,
    semesterId: row.semester_id ?? null,
    lecturers: row.vortragende_mitwirkende ?? null,
    organisation: row.org_name_betreut ?? null,
  };
}

function dateRange(from, to, defaultDays, maxDays) {
  const start = from ?? berlinToday();
  const end = to ?? addDays(start, defaultDays);
  assertDate(start);
  assertDate(end);
  if (end < start) {
    throw new SafeError("invalid_arguments", "The end date is before the start date.");
  }
  if (daysBetween(start, end) > maxDays) {
    throw new SafeError("invalid_arguments", `The date range must be ${maxDays} days or shorter.`);
  }
  return { from: start, to: end };
}

function monthWindow(from, to) {
  const now = berlinToday();
  const before = from < now ? monthsBetween(from, now) : 0;
  const after = to > now ? monthsBetween(now, to) : 0;
  if (before > 18 || after > 18) {
    throw new SafeError("invalid_arguments", "The calendar window must stay within 18 months before and after today.");
  }
  return { before, after };
}

function monthsBetween(from, to) {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return Math.max(0, (ty - fy) * 12 + (tm - fm) + 1);
}

function berlinToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function addDays(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86400000);
}

function assertDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new SafeError("invalid_arguments", "Dates must be YYYY-MM-DD.");
  }
}

function clip(value) {
  if (typeof value !== "string" || value.length <= 4000) return value ?? null;
  return `${value.slice(0, 4000)}…`;
}

export { dateRange };

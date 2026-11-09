import { SafeError } from "./errors.js";
import { getText } from "./http.js";
import { parseBase, timeoutFrom } from "./tumonline.js";

export function lang(value, language) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  const translations = value.translations?.translation;
  const list = Array.isArray(translations) ? translations : translations ? [translations] : [];
  const match = list.find((entry) => entry?.lang === language)?.value;
  return match ?? value.value ?? null;
}

export async function publicGet(env, fetchImpl, pathAndQuery) {
  const base = parseBase(env.TUMONLINE_MCP_BASE_URL);
  const url = new URL(`${base}/ee/rest${pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`}`);
  if (url.origin !== new URL(base).origin) {
    throw new SafeError("origin", "Refusing to call a different origin.");
  }
  const result = await getText(fetchImpl, url, {
    service: "TUMonline",
    timeoutMs: timeoutFrom(env),
    accept: "application/json",
    headers: { "Accept-Language": "de" },
  });
  if (result.status === 404) {
    throw new SafeError("not_found", "TUMonline could not find that public record.");
  }
  if (result.status === 429) {
    throw new SafeError("rate_limited", "TUMonline rate-limited the public catalogue. Wait and try again.");
  }
  if (result.status >= 400) {
    throw new SafeError("tumonline", `TUMonline returned HTTP ${result.status} for the public catalogue.`);
  }
  try {
    return JSON.parse(result.text);
  } catch {
    throw new SafeError("malformed", "TUMonline returned a public catalogue response that is not JSON.");
  }
}

export async function listSemesters(env, fetchImpl, language) {
  const body = await publicGet(env, fetchImpl, "/slc.lib.tm/semesters/student");
  const semesters = (body.semesters ?? []).slice(0, 40).map((semester) => ({
    id: semester.id ?? null,
    key: semester.key ?? null,
    name: lang(semester.semesterDesignation, language) ?? semester.key ?? null,
    start: semester.startOfAcademicSemester?.value ?? null,
    end: semester.endOfAcademicSemester?.value ?? null,
    selected: semester.isSelected === true,
  }));
  return semesters;
}

export async function resolveSemesterId(env, fetchImpl, input) {
  if (input == null || input === "") return null;
  if (/^\d{1,12}$/.test(input)) return Number(input);
  const semesters = await listSemesters(env, fetchImpl, "en");
  const hit = semesters.find((semester) => String(semester.key).toUpperCase() === input.toUpperCase());
  if (!hit) {
    throw new SafeError("invalid_arguments", `Unknown semester "${input}". Use a key such as 26W or 27S, or a semester id from list_semesters.`);
  }
  return hit.id;
}

export async function searchCourses(env, fetchImpl, { query, semester, limit, offset, language }) {
  const termId = await resolveSemesterId(env, fetchImpl, semester);
  const filter = ["courseNormKey-eq=LVEAB", "orgId-eq=1", termId ? `termId-eq=${termId}` : null, `filterTerm-like=${query.replace(/[;&]/g, " ")}`]
    .filter(Boolean)
    .join(";");
  const qs = odataQuery([
    ["$filter", filter],
    ["$orderBy", "title=ascnf"],
    ["$skip", offset],
    ["$top", limit],
  ]);
  const body = await publicGet(env, fetchImpl, `/slc.tm.cp/student/courses?${qs}`);
  const courses = (body.courses ?? []).slice(0, limit).map((course) => courseSummary(course, language));
  return { total: body.totalCount ?? courses.length, offset, courses };
}

export async function getCourse(env, fetchImpl, courseId, language) {
  const body = await publicGet(env, fetchImpl, `/slc.tm.cp/student/courses/${courseId}`);
  const detail = body.resource?.[0]?.content?.cpCourseDetailDto;
  if (!detail?.cpCourseDto) {
    throw new SafeError("not_found", "TUMonline could not find that course.");
  }
  const course = detail.cpCourseDto;
  const description = detail.cpCourseDescriptionDto ?? {};
  const info = description.additionalInformation ?? {};
  return {
    ...courseSummary(course, language),
    lecturers: persons(course.lectureships),
    semesterName: lang(course.semesterDto?.semesterDesignation, language),
    organisation: lang(course.organisationResponsibleDto?.name, language),
    languages: (course.courseLanguageDtos ?? []).map((entry) => lang(entry.languageDto?.name, language)).filter(Boolean),
    examinationMethod: lang(course.examinationMethodName, language),
    content: clip(lang(description.courseContent, language)),
    objectives: clip(lang(description.courseObjective, language)),
    prerequisites: clip(lang(description.previousKnowledge, language)),
    teachingMethod: clip(lang(description.teachingMethod, language)),
    assessment: clip(lang(description.assessmentScheme, language)),
    literature: clip(lang(info.recommendedLiterature, language)),
    registrationStatus: course.registrationInfoStatus ?? null,
  };
}

export async function courseGroups(env, fetchImpl, courseId) {
  const [first, remaining] = await Promise.all([
    publicGet(env, fetchImpl, `/slc.tm.cp/student/courseGroups/firstGroups/${courseId}`),
    publicGet(env, fetchImpl, `/slc.tm.cp/student/courseGroups/remainingGroups/${courseId}`).catch((error) => {
      if (error instanceof SafeError && (error.code === "not_found" || error.code === "tumonline")) {
        return { courseGroupDtos: [] };
      }
      throw error;
    }),
  ]);
  const seen = new Set();
  const groups = [];
  for (const group of [...(first.courseGroupDtos ?? []), ...(remaining.courseGroupDtos ?? [])]) {
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    groups.push(group);
  }
  return groups;
}

export function summarizeGroups(groups, language) {
  return groups.slice(0, 80).map((group) => ({
    id: group.id ?? null,
    name: group.name ?? null,
    standardGroup: group.standardgroupFlag === "J",
    confirmedPlaces: group.confirmedPlaces ?? null,
    limitedParticipation: group.limitedParticipationFlag === "J",
    lecturers: persons(group.lectureshipDtos),
    series: (group.appointmentSeriesDtos ?? []).slice(0, 20).map((series) => ({
      weekdays: (series.weekday ?? []).map((day) => day.key ?? lang(day.name, language)).filter(Boolean),
      time: `${series.seriesBeginTime ?? ""}-${series.seriesEndTime ?? ""}`,
      from: series.seriesBegin?.value ?? null,
      until: series.seriesEnd?.value ?? null,
      room: series.resourceName ?? null,
    })),
    appointmentCount: (group.appointmentDtos ?? []).length,
  }));
}

export function publicDates(groups, language, { groupId, includePast, limit }) {
  const selected = groups.filter((group) => groupId == null || String(group.id) === String(groupId));
  const now = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Berlin" }).replace(" ", "T");
  const dates = selected
    .flatMap((group) => (group.appointmentDtos ?? []).map((appointment) => ({
      start: appointment.timestampFrom?.value ?? null,
      end: appointment.timestampTo?.value ?? null,
      weekday: appointment.weekday?.key ?? null,
      room: appointment.resourceName ?? null,
      type: appointment.appointmentEventTypeDto?.key ?? null,
      status: appointment.appointmentStatusType ?? null,
      group: group.name ?? null,
      groupId: group.id ?? null,
      note: clip(lang(appointment.appointmentDescription, language), 500),
    })))
    .filter((appointment) => includePast || !appointment.end || appointment.end >= now)
    .sort((left, right) => String(left.start ?? "").localeCompare(String(right.start ?? "")));
  return { timezone: "Europe/Berlin", total: dates.length, dates: dates.slice(0, limit), truncated: dates.length > limit };
}

export async function listPublicExams(env, fetchImpl, { from, to, courseNumbers, limit }) {
  const wanted = new Set((courseNumbers ?? []).map((value) => value.trim().toUpperCase()));
  const pageSize = 50;
  const maxPages = 3;
  const exams = [];
  let total = null;
  let scanned = 0;
  let pages = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const filter = [`exExamDateFrom-gte=${from}`, to ? `exExamDateTo-lte=${to}` : ""].filter(Boolean).join(";");
    const query = `${odataQuery([
      ["$filter", filter],
      ["$orderBy", "exExamDate=ascnl"],
      ["$skip", page * pageSize],
      ["$top", pageSize],
    ])}&orgId=-1`;
    const body = await publicGet(env, fetchImpl, `/slc.xm.exd/exExamOffer?${query}`);
    pages += 1;
    const offers = body.examOffers ?? [];
    total = typeof body.totalCount === "number" ? body.totalCount : total;
    scanned += offers.length;
    for (const offer of offers) {
      const number = String(offer.displayCourseNumber ?? "");
      const courseId = String(offer.courseId ?? "");
      if (wanted.size > 0 && !wanted.has(number.toUpperCase()) && !wanted.has(courseId)) {
        continue;
      }
      exams.push(examSummary(offer));
      if (wanted.size === 0 && exams.length >= limit) {
        break;
      }
    }
    if (offers.length < pageSize || scanned >= (total ?? scanned) || (wanted.size === 0 && exams.length >= limit)) {
      break;
    }
  }
  const truncated = total != null && scanned < total;
  return {
    source: "GET ee/rest/slc.xm.exd/exExamOffer",
    from,
    to: to ?? null,
    total,
    scanned,
    pages,
    truncated,
    count: Math.min(exams.length, limit),
    exams: exams.slice(0, limit),
  };
}

function courseSummary(course, language) {
  return {
    id: course.id ?? null,
    number: course.courseNumber?.courseNumber ?? course.courseNumber ?? null,
    title: lang(course.courseTitle, language),
    type: lang(course.courseTypeDto?.courseTypeName, language),
    semester: course.semesterDto?.key ?? null,
    sws: (course.courseNormConfigs ?? []).find((entry) => entry.key === "SST")?.value ?? null,
    lecturers: persons(course.lectureships).map((person) => person.name),
    registration: lang(course.registrationInfo, language),
  };
}

function persons(lectureships) {
  return (lectureships ?? []).slice(0, 30).map((entry) => ({
    name: [entry.identityLibDto?.firstName, entry.identityLibDto?.lastName].filter(Boolean).join(" ") || null,
    function: entry.teachingFunction?.name ?? null,
  })).filter((entry) => entry.name);
}

function examSummary(offer) {
  const names = langStrings(offer.courseName);
  const examiners = (offer.examPersons ?? []).flatMap((person) => person.identities ?? []).map((identity) => [identity.firstName, identity.lastName].filter(Boolean).join(" ")).filter(Boolean);
  return {
    id: offer.id ?? null,
    courseId: offer.courseId ?? null,
    courseNumber: offer.displayCourseNumber ?? null,
    courseName: names[0] ?? null,
    courseNames: names,
    semester: lang(offer.courseSemesterShortName, "en"),
    date: offer.examDate?.value ?? null,
    start: offer.examStart?.value ?? null,
    end: offer.examEnd?.value ?? null,
    type: lang(offer.examType, "en"),
    registrationStart: offer.registrationDateStart?.value ?? null,
    registrationEnd: offer.registrationDateEnd?.value ?? null,
    deregistrationEnd: offer.deRegistrationEnd?.value ?? null,
    examiners: examiners.slice(0, 10),
    note: clip(typeof offer.examDateInformation === "string" ? offer.examDateInformation : null, 300),
  };
}

function langStrings(value) {
  if (value == null) return [];
  if (typeof value === "string") return [value];
  const translations = value.translations?.translation ?? [];
  const list = [value.value, ...translations.map((entry) => entry.value)].filter((entry) => typeof entry === "string" && entry.trim() !== "");
  return [...new Set(list)];
}

function odataQuery(pairs) {
  return pairs.map(([key, value]) => `${key}=${encodeURIComponent(String(value)).replace(/%3D/g, "=").replace(/%3B/g, ";")}`).join("&");
}

function clip(value, max = 2000) {
  if (typeof value !== "string" || value.length <= max) return value ?? null;
  return `${value.slice(0, max)}…`;
}

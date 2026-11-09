# Coverage

What v1 reads, which tool calls it, and what is intentionally absent. Shapes come from the clients named below. They were not captured from a live TUM session.

## Personal token API

Base `https://campus.tum.de/tumonline/wbservicesbasic.<function>`. The server adds `pToken`. Sources: [TUM-Dev/campus_flutter `tum_online_api.dart`](https://github.com/TUM-Dev/campus_flutter/blob/main/lib/base/networking/apis/tumOnlineApi/tum_online_api.dart), [Campus-Android `TUMOnlineAPIService.kt`](https://github.com/TUM-Dev/Campus-Android/blob/main/app/src/main/java/de/tum/in/tumcampusapp/api/tumonline/TUMOnlineAPIService.kt), [tum-mcp `tumonline-personal.ts`](https://github.com/mxmichels17/tum-mcp/blob/main/src/platforms/tumonline-personal.ts).

| Feature | Tool | Function | Notes |
| --- | --- | --- | --- |
| Request a Campus token | sign-in page and `connect request`, not an MCP tool | `requestToken` (`pUsername`, `pTokenName`) | Token is encrypted and not returned to the model |
| Activation check | `get_token_status`, Check activation | `isTokenConfirmed` | `confirmed` text `true` / `false` |
| Identity | `get_identity` | `id` | `kennung`, `vorname`, `familienname`, `obfuscated_id`, `obfuscated_ids` |
| Timetable | `get_calendar` | `kalender` (`pMonateVor`, `pMonateNach`) | Events filtered to the requested dates |
| My courses | `list_my_courses` | `veranstaltungenEigene` | LV number is `stp_lv_nr` |
| Course details | `get_course_details` | `veranstaltungenDetails` (`pLVNr`) | |
| My course dates | `get_course_details`, `get_course_dates` with `lvNumber` | `veranstaltungenTermine` (`pLVNr`) | |
| Grades | `get_grades` | `noten` | `lv_titel`, `uninotenamekurz`, `pruefer_nachname`, and related columns |
| Averages | `get_grades` (`includeAverages`, default true) | `absNoten` | `studium` / `avg_grade_weighted_by_credits` from campus_flutter |
| My exams | `list_my_exams` | `pruefungenEigene` | Includes `pv_term_nr` when TUMonline sends it |
| Tuition | `get_fee_status` | `studienbeitragsstatus` | `soll`, `frist`, `semester_bezeichnung` |
| Person search | `search_persons` | `personenSuche` (`pSuche`) | |
| Person details | `get_person` | `personenDetails` (`pIdentNr`) | `image_data` is removed |
| Lecture search | `search_lectures` | `veranstaltungenSuche` (`pSuche`) | Token search. The public catalogue is `search_courses` |
| Rights report | `get_token_status` with `probe` | one call to each row above | Stops early on a rate limit |

Error strings matched from Campus-Android `Error.kt` and campus_flutter `tum_online_api_exception.dart`:

| TUMonline text | Tool error | What to do |
| --- | --- | --- |
| `Request-Rate überschritten` | `rate_limited` | Wait. This server also pauses that user |
| `Token-Limit` | `token_limit` | Delete an unused token. Campus-Android describes the cap as about 10 active tokens |
| `Token ist nicht bestätigt!` | `token_unconfirmed` | Activate it under Token-Management |
| `Keine Rechte für Funktion <name>` or `Funktion nicht erlaubt` | `missing_right` | Enable the mapped right: calendar, lectures, grades, exam results, tuition fees, identity, or persons |
| `Token ist ungültig!` or `ungültiges Benutzertoken` | `invalid_tum_token` | Request or paste a token again |

The English right names are this server's map from the function name. The exact German checkbox labels in Token-Management were not read from a live page.

## Public REST

Base `https://campus.tum.de/tumonline/ee/rest`. No token. Source: [tum-mcp `tumonline.ts`](https://github.com/mxmichels17/tum-mcp/blob/main/src/platforms/tumonline.ts) and [`tumonline-exams.ts`](https://github.com/mxmichels17/tum-mcp/blob/main/src/platforms/tumonline-exams.ts). tum-mcp notes these paths are taken from the TUMonline web app and are not an official document.

| Feature | Tool | Path |
| --- | --- | --- |
| Semesters | `list_semesters` | `GET /slc.lib.tm/semesters/student` |
| Course search | `search_courses` | `GET /slc.tm.cp/student/courses` with `$filter` |
| Course | `get_course` | `GET /slc.tm.cp/student/courses/{id}` |
| Groups | `get_course_groups` | `GET /slc.tm.cp/student/courseGroups/firstGroups/{id}` and `remainingGroups/{id}` |
| Public dates | `get_course_dates` with `courseId` | appointments on those groups |
| Public exams | `list_public_exams` | `GET /slc.xm.exd/exExamOffer` |

`list_public_exams` requests at most three pages of 50 rows. tum-mcp can scan the full list (up to 40 pages). This server stops early so one question does not pull the catalogue.

`$` query names are sent literally. tum-mcp records that encoding them as `%24` makes TUMonline ignore the parameter.

## NavigaTUM

Base `https://nav.tum.de`. No TUM account. Source: the public OpenAPI document at `https://nav.tum.de/api/openapi.json`, and the site key `heilbronn` in [NavigaTUM `data/sources/01_areas-extended.yaml`](https://github.com/TUM-Dev/navigatum/blob/main/data/sources/01_areas-extended.yaml).

| Feature | Tool | Path |
| --- | --- | --- |
| Search rooms, buildings, and sites | `search_rooms` | `GET /api/search?q=&type=room&type=building&type=site` |
| Heilbronn only | `search_rooms` with `campus: "heilbronn"` | same, plus `in=heilbronn` |
| One location | `get_room` | `GET /api/locations/{id}` |

The default search does not set `in`, so Munich, Garching, Weihenstephan, and Heilbronn are all eligible. `get_room` copies parent names and types. A parent of type `campus` whose name contains Heilbronn is reported as `includesHeilbronn`.

## Unsupported

| Feature | Why |
| --- | --- |
| Exam registration and course registration | Not a read. The public exam list and `pruefungenEigene` are reads only |
| Enrollment certificate (Immatrikulationsbescheinigung) | A file download. Not implemented. A future file would use `/files/<token>`, not an embedded blob |
| Curriculum | Not in the v1 function list |
| Room booking | Not a read, and not a NavigaTUM search |
| Moodle | Out of scope |
| `terminCreate`, `terminDelete`, `secretUpload` | Writes. The client refuses those function names |
| TUM SSO / 2FA automation, HTML scraping | The only TUMonline credential is a Campus token the person activates themselves |
| Profile photos | `image_data` is dropped. It is not turned into a download |

## Politeness

Each MCP user is limited to 30 TUMonline calls per minute and at least 250 ms between calls, unless the environment overrides those numbers. At most two TUMonline requests are in flight for the whole process. A rate-limit response pauses that user for 60 seconds. Public catalogue and NavigaTUM calls use the same timeout (20 seconds) and do not attach `pToken`.

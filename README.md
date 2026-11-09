# TUMonline student MCP server

Self-hosted Model Context Protocol server for a [TUMonline](https://campus.tum.de) student. It reads identity, the personal calendar, registered courses, grades, exams, tuition status, and the person directory through the Campus token API (`wbservicesbasic`). It also reads the public course catalogue, public exam dates, and [NavigaTUM](https://nav.tum.de) rooms, including Heilbronn. NavigaTUM and the public catalogue do not use the token.

It does not register for exams or courses, download an enrollment certificate, open a curriculum, book a room, or talk to Moodle. It does not scrape pages, automate TUM single sign-on, or call `terminCreate` / `terminDelete`.

This is an unofficial server. It is not affiliated with, endorsed by, or maintained by the Technical University of Munich.

Automated tests use in-process mocks of the TUMonline XML and JSON APIs and of NavigaTUM. They do not sign in with a TUM account.

## Requirements

Node.js 22 or newer. The server has no runtime dependencies.

## Install

```bash
git clone https://github.com/dxwil/tumonline-student-mcp.git
cd tumonline-student-mcp
chmod +x ./bin/tumonline-student-mcp
node --version
```

`plugin.json`, `.cursor-plugin/plugin.json`, `mcp.json`, and `cursor-mcp.json` sit next to `src/` and `bin/`.

### Cursor

Cursor loads `.cursor-plugin/plugin.json`, which points at `cursor-mcp.json`. That file starts `./bin/tumonline-student-mcp` with `cwd` set to `${CURSOR_PLUGIN_ROOT}`.

### Agent Plugins

An Agent Plugins 1.0.0 host loads root `plugin.json` and `mcp.json`. `mcp.json` starts `./bin/tumonline-student-mcp` and does not set `cwd`. Do not point that host at `cursor-mcp.json`. `${CURSOR_PLUGIN_ROOT}` is only valid in the Cursor file.

A client that loads neither manifest can start the same process:

```bash
export TUMONLINE_MCP_STATE_DIR="$HOME/.local/share/tumonline-student-mcp"
./bin/tumonline-student-mcp
```

Stdout is MCP JSON-RPC only. Diagnostics go to stderr and do not include tokens.

## Tools

Personal tools need the Campus token stored for this MCP user. They never take a token as an argument. Public tools do not send one.

| Tool | Source | Token |
| --- | --- | --- |
| `get_token_status` | `wbservicesbasic.isTokenConfirmed`, then one call per right when `probe` is true | yes |
| `get_identity` | `wbservicesbasic.id` | yes |
| `get_calendar` | `wbservicesbasic.kalender`, filtered to `from`/`to` | yes |
| `list_my_courses` | `wbservicesbasic.veranstaltungenEigene` | yes |
| `get_course_details` | `wbservicesbasic.veranstaltungenDetails` and, by default, `veranstaltungenTermine` | yes |
| `get_course_dates` | `veranstaltungenTermine` when `lvNumber` is set; public course groups when `courseId` is set | only for `lvNumber` |
| `get_grades` | `wbservicesbasic.noten` and, by default, `absNoten` | yes |
| `list_my_exams` | `wbservicesbasic.pruefungenEigene` | yes |
| `get_fee_status` | `wbservicesbasic.studienbeitragsstatus` | yes |
| `search_persons` / `get_person` | `personenSuche` / `personenDetails` | yes |
| `search_lectures` | `wbservicesbasic.veranstaltungenSuche` | yes |
| `list_semesters` | `ee/rest/slc.lib.tm/semesters/student` | no |
| `search_courses` / `get_course` / `get_course_groups` | `ee/rest/slc.tm.cp/student/...` | no |
| `list_public_exams` | `ee/rest/slc.xm.exd/exExamOffer` (at most three pages) | no |
| `search_rooms` / `get_room` | `https://nav.tum.de/api` | no |

`search_rooms` searches every NavigaTUM campus unless `campus` is set. `heilbronn` is the Heilbronn site id. `get_room` reports parent campuses, so a Heilbronn room stays visible as one.

`get_token_status` reports whether a token is stored and whether TUMonline says it is active. It never returns the token. With `probe: true` (the default) it tries calendar, lectures, grades, exam results, tuition fees, identity, and persons, and records `ok` or `missing`.

If TUMonline says `Keine Rechte für Funktion ...`, the tool error names the right to enable. `Request-Rate überschritten` and `Token-Limit` are returned as their own errors with the next step. A token that is not activated says so and points at Token-Management.

Profile images are omitted. No tool returns a file body. If a later tool needs a file, the HTTP server mints a one-time `downloadUrl` at `/files/<token>` and streams the bytes when that URL is opened. The link is not written into an MCP resource.

## Sign-in

Stdio is the default and uses one local account under `TUMONLINE_MCP_STATE_DIR` (default `/var/lib/tumonline-student-mcp`).

```bash
export TUMONLINE_MCP_STATE_DIR="$HOME/.local/share/tumonline-student-mcp"
./bin/tumonline-student-mcp connect request ab12cde
./bin/tumonline-student-mcp connect status
```

`connect request` calls `wbservicesbasic.requestToken` and stores the token encrypted. It prints activation steps and does not print the token. `connect paste` reads one token from stdin. The token name defaults to `tumonline-student-mcp` (`TUMONLINE_MCP_TOKEN_NAME`).

HTTP mode is the multi-user server. Each MCP client opens `https://<your-domain>/mcp`, discovers this server's OAuth 2.1 authorization server, and sends the person to `/authorize`. The page accepts a TUM ID (the server requests a token) or an existing activated token. The token is encrypted with AES-256-GCM, bound to that MCP user, and never shown. The page then asks them to activate it in TUMonline under Visitenkarte or Services, then Token-Management, and to enable calendar, lectures, grades, exam results, tuition fees, identity, and persons. **Check activation** calls `isTokenConfirmed`.

Access tokens last 15 minutes. Refresh tokens last 30 days, are stored as SHA-256 hashes, and rotate on use. Reusing an old refresh token revokes that grant. Scope is `mcp:tools`. The authorize page is sent with `Referrer-Policy: same-origin`, and a form POST must come from this origin.

There is no TUM password and no SSO redirect.

Setup for a Debian 12 unprivileged Proxmox LXC is in [docs/self-hosting.md](docs/self-hosting.md). A map of features to tools is in [docs/coverage.md](docs/coverage.md).

## Configure

| Variable | Default |
| --- | --- |
| `TUMONLINE_MCP_TRANSPORT` | `stdio` (`http` or `--http` to listen) |
| `TUMONLINE_MCP_HOST` | `127.0.0.1` |
| `TUMONLINE_MCP_PORT` | `8080` |
| `TUMONLINE_MCP_STATE_DIR` | `/var/lib/tumonline-student-mcp` |
| `TUMONLINE_MCP_PUBLIC_URL` | unset; required for a public HTTPS issuer |
| `TUMONLINE_MCP_BASE_URL` | `https://campus.tum.de/tumonline` |
| `TUMONLINE_MCP_NAV_BASE` | `https://nav.tum.de` |
| `TUMONLINE_MCP_TOKEN_NAME` | `tumonline-student-mcp` |
| `TUMONLINE_MCP_TOKEN_KEY` | unset; a 32-byte key is created in the state directory |
| `TUMONLINE_MCP_MIN_INTERVAL_MS` | `250` between TUMonline calls for one user |
| `TUMONLINE_MCP_USER_LIMIT` | `30` TUMonline calls per user per minute |
| `TUMONLINE_MCP_TIMEOUT_MS` | `20000` |

`TUMONLINE_MCP_ALLOWED_HOSTS` and `TUMONLINE_MCP_ALLOWED_ORIGINS` extend the loopback and public-origin allowlists. Requests with no `Origin` are allowed so native clients work. A browser form post to `/authorize` must send this site's `Origin`.

An optional static bearer (`tumonline-student-mcp token create`) is for an admin client that cannot run OAuth. The secret is printed once. Personal tools still need a Campus token on that account (`connect request` or `connect paste --user <id>`).

## Tests

```bash
npm test
```

`npm test` runs Node's built-in test runner. It covers XML fixtures shaped like the Campus clients, error mapping, AES-256-GCM binding, the OAuth code flow with PKCE S256, refresh rotation, allowlists, NavigaTUM including Heilbronn, and the one-time file stream. Nothing in the suite contacts campus.tum.de with a real account.

## Limits

- TUMonline's token web service is not a documented public API. Field names follow TUM-Dev Campus-Android, campus_flutter, and the tum-mcp client. A live response can contain extra columns; string fields are passed through with image and token-like values removed.
- The German labels in the Token-Management screen are not fetched. A missing-right error names the right this server maps from the function (`calendar`, `lectures`, `grades`, `exam results`, `tuition fees`, `identity`, `persons`).
- `list_public_exams` reads at most three pages of 50. It does not scan the whole catalogue.
- Calls to TUMonline are spaced per user, capped per minute, and limited to two at a time. A `Request-Rate überschritten` response pauses that user for a minute.
- Logs are status and path only. Tokens and TUM IDs are not written to the journal.

## License

MIT. Copyright 2026 dxwil. See [LICENSE](LICENSE).

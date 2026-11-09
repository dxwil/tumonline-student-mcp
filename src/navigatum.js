import { SafeError } from "./errors.js";
import { getText } from "./http.js";
import { timeoutFrom } from "./tumonline.js";

const DEFAULT_NAV = "https://nav.tum.de";

export function parseNavBase(value) {
  const raw = typeof value === "string" && value.trim() !== "" ? value.trim() : DEFAULT_NAV;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeError("usage", "TUMONLINE_MCP_NAV_BASE must be an https origin such as https://nav.tum.de.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new SafeError("usage", "TUMONLINE_MCP_NAV_BASE must be an origin without a path, query, or credentials.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new SafeError("usage", "TUMONLINE_MCP_NAV_BASE must be https, or http on localhost.");
  }
  return url.origin;
}

export async function searchRooms(env, fetchImpl, { query, campus, limit }) {
  const url = new URL("/api/search", parseNavBase(env.TUMONLINE_MCP_NAV_BASE));
  url.searchParams.set("q", query);
  url.searchParams.append("type", "room");
  url.searchParams.append("type", "building");
  url.searchParams.append("type", "site");
  if (campus) {
    url.searchParams.append("in", campus);
  }
  const body = await navGet(env, fetchImpl, url);
  const rooms = [];
  for (const section of body.sections ?? []) {
    for (const entry of section.entries ?? []) {
      if (!entry?.id) continue;
      rooms.push({
        id: String(entry.id),
        name: stripMarks(entry.name),
        type: entry.type ?? section.facet ?? null,
        subtext: stripMarks(entry.subtext),
        subtextBold: stripMarks(entry.subtext_bold),
      });
      if (rooms.length >= limit) break;
    }
    if (rooms.length >= limit) break;
  }
  return {
    source: "https://nav.tum.de/api/search",
    campus: campus ?? null,
    includesHeilbronn: campus == null || campus.toLowerCase() === "heilbronn",
    count: rooms.length,
    rooms,
  };
}

export async function getRoom(env, fetchImpl, id, language) {
  const url = new URL(`/api/locations/${encodeURIComponent(id)}`, parseNavBase(env.TUMONLINE_MCP_NAV_BASE));
  if (language) {
    url.searchParams.set("lang", language);
  }
  const body = await navGet(env, fetchImpl, url);
  const parents = (body.parents ?? []).map((parent, index) => ({
    id: parent?.id ?? parent ?? null,
    name: body.parent_names?.[index] ?? null,
    type: body.parent_types?.[index] ?? null,
  }));
  const computed = (body.props?.computed ?? []).slice(0, 40).map((prop) => ({
    name: prop.name ?? null,
    text: typeof prop.text === "string" ? prop.text.slice(0, 500) : null,
  }));
  const campuses = parents.filter((parent) => parent.type === "campus" || parent.type === "site").map((parent) => parent.name || parent.id).filter(Boolean);
  return {
    source: "https://nav.tum.de/api/locations/{id}",
    id: body.id ?? id,
    name: body.name ?? null,
    type: body.type ?? null,
    typeCommonName: body.type_common_name ?? null,
    aliases: (body.aliases ?? []).slice(0, 20),
    parents,
    campuses,
    includesHeilbronn: campuses.some((name) => /heilbronn/i.test(String(name))) || /heilbronn/i.test(String(body.id ?? "")),
    coordinates: body.coords ? { lat: body.coords.lat ?? null, lon: body.coords.lon ?? null, source: body.coords.source ?? null } : null,
    props: computed,
    maps: body.maps ? { available: true } : null,
  };
}

async function navGet(env, fetchImpl, url) {
  const result = await getText(fetchImpl, url, {
    service: "NavigaTUM",
    timeoutMs: timeoutFrom(env),
    accept: "application/json",
  });
  if (result.status === 404) {
    throw new SafeError("not_found", "NavigaTUM could not find that room or building.");
  }
  if (result.status === 429) {
    throw new SafeError("rate_limited", "NavigaTUM rate-limited the request. Wait and try again.");
  }
  if (result.status >= 400) {
    throw new SafeError("navigatum", `NavigaTUM returned HTTP ${result.status}.`);
  }
  try {
    return JSON.parse(result.text);
  } catch {
    throw new SafeError("malformed", "NavigaTUM returned a response that is not JSON.");
  }
}

function stripMarks(value) {
  if (typeof value !== "string") return value ?? null;
  return value.replace(/[\u0017\u0019]/g, "").slice(0, 300);
}

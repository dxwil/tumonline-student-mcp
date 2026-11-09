import { SafeError } from "./errors.js";

export const USER_AGENT = "tumonline-student-mcp/0.1.0";
export const MAX_BYTES = 3 * 1024 * 1024;

const REDIRECT = new Set([301, 302, 303, 307, 308]);

export async function getText(fetchImpl, target, options = {}) {
  const service = options.service ?? "TUMonline";
  const timeoutMs = options.timeoutMs ?? 20_000;
  let current;
  try {
    current = new URL(target);
  } catch {
    throw new SafeError("origin", `${service} address was not accepted.`);
  }
  if (current.username || current.password) {
    throw new SafeError("origin", `${service} address was not accepted.`);
  }
  const headers = {
    Accept: options.accept ?? "application/xml, text/xml, */*",
    "User-Agent": USER_AGENT,
    ...options.headers,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof SafeError) {
        throw error;
      }
      if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
        throw new SafeError("timeout", `${service} did not answer in time.`);
      }
      throw new SafeError("network", `${service} could not be reached.`);
    }
    if (REDIRECT.has(response.status)) {
      await cancel(response.body);
      throw new SafeError("redirect", `${service} redirected the request. It was not followed.`);
    }
    const text = await readLimited(response, service);
    return { status: response.status, headers: response.headers, text };
  } finally {
    clearTimeout(timer);
  }
}

async function readLimited(response, service) {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The oversized body is discarded either way.
      }
      throw new SafeError("response_too_large", `${service} returned a response that is too large to accept.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function cancel(body) {
  try {
    await body?.cancel();
  } catch {
    // The unused body is discarded.
  }
}

export async function streamGet(fetchImpl, target, options = {}) {
  const service = options.service ?? "TUMonline";
  const timeoutMs = options.timeoutMs ?? 20_000;
  let current;
  try {
    current = new URL(target);
  } catch {
    throw new SafeError("origin", `${service} address was not accepted.`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(current, {
      method: "GET",
      headers: {
        Accept: "*/*",
        "User-Agent": USER_AGENT,
        ...options.headers,
      },
      redirect: "manual",
      signal: controller.signal,
    });
    if (REDIRECT.has(response.status)) {
      await cancel(response.body);
      throw new SafeError("redirect", `${service} redirected the request. It was not followed.`);
    }
    return { status: response.status, headers: response.headers, body: response.body, release: () => clearTimeout(timer) };
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof SafeError) {
      throw error;
    }
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
      throw new SafeError("timeout", `${service} did not answer in time.`);
    }
    throw new SafeError("network", `${service} could not be reached.`);
  }
}

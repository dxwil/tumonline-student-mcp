import { pathToFileURL } from "node:url";
import { createAccessToken, ensureStateDir, ensureUserDir, envForAccount, findAccessToken, listAccessTokens, loadTumToken, LOCAL_USER_ID, resolveStateDir, revokeAccessToken, saveTumToken } from "./access.js";
import { SafeError } from "./errors.js";
import { formatListenAddress, startHttpServer } from "./http-server.js";
import { createToolImpl } from "./impl.js";
import { createMcpHandler, parseRpcLine } from "./mcp.js";
import { activationSteps, assertExistingToken, assertTumId, confirmToken, requestNewToken, tokenNameFrom, tokenStatusView } from "./tumonline.js";

const USAGE = `Usage:
  tumonline-student-mcp [--stdio]
  tumonline-student-mcp --http [--host 127.0.0.1] [--port 8080]
  tumonline-student-mcp token create [--label NAME]
  tumonline-student-mcp token list
  tumonline-student-mcp token revoke <id>
  tumonline-student-mcp connect request <tum-id> [--user <id>]
  tumonline-student-mcp connect paste [--user <id>]
  tumonline-student-mcp connect status [--user <id>]
`;

const defaultIo = {
  stdout(text) {
    process.stdout.write(text);
  },
  stderr(text) {
    process.stderr.write(text);
  },
  stdin: process.stdin,
};

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch, io = defaultIo) {
  let parsed;
  try {
    parsed = parseInvocation(argv);
  } catch (error) {
    const safe = error instanceof SafeError ? error : new SafeError("usage", "Unknown option.");
    io.stderr(`${safe.message}\n${USAGE}`);
    return 1;
  }
  if (parsed.flags.help) {
    io.stdout(USAGE);
    return 0;
  }
  try {
    if (parsed.positionals.length === 0) {
      const mode = resolveMode(parsed.flags, env);
      if (mode === "http") {
        assertFlags(parsed.flags, ["http", "host", "port"]);
        await runHttp(parsed.flags, env, fetchImpl, io);
        return 0;
      }
      assertFlags(parsed.flags, ["stdio"]);
      await runStdio(env, fetchImpl);
      return 0;
    }
    return await runManagement(parsed.positionals, parsed.flags, env, fetchImpl, io);
  } catch (error) {
    if (error instanceof SafeError) {
      io.stderr(`${error.message}\n`);
      if (error.code === "usage") io.stderr(USAGE);
      return 1;
    }
    io.stderr("tumonline-student-mcp failed\n");
    return 1;
  }
}

export async function runStdio(env = process.env, fetchImpl = globalThis.fetch) {
  const stateDir = ensureStateDir(resolveStateDir(env));
  ensureUserDir(stateDir, LOCAL_USER_ID);
  const handle = createMcpHandler(createToolImpl(envForAccount(env, stateDir, LOCAL_USER_ID), fetchImpl));
  let buffer = "";
  let chain = Promise.resolve();
  const onLine = (line) => {
    chain = chain.then(async () => {
      const message = parseRpcLine(line);
      const response = message.invalid
        ? { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }
        : await handle(message);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
    return chain;
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.trim() !== "") onLine(line);
      index = buffer.indexOf("\n");
    }
  });
  await new Promise((resolve) => {
    process.stdin.on("end", () => {
      chain.then(resolve, resolve);
    });
  });
}

async function runHttp(flags, env, fetchImpl, io) {
  const server = await startHttpServer({
    env,
    fetchImpl,
    host: flags.host,
    port: flags.port,
    log: (line) => io.stderr(line.endsWith("\n") ? line : `${line}\n`),
  });
  io.stderr(`tumonline-student-mcp listening on ${formatListenAddress(server)}\n`);
  await new Promise((resolve) => {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      server.close(() => resolve());
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function runManagement(positionals, flags, env, fetchImpl, io) {
  const stateDir = ensureStateDir(resolveStateDir(env));
  const [command, sub, extra] = positionals;
  if (command === "token" && sub === "create") {
    assertFlags(flags, ["label"]);
    rejectExtra(positionals.slice(2));
    const created = createAccessToken(stateDir, { label: flags.label });
    io.stdout(`${created.token}\n`);
    io.stderr(`id: ${created.id}\n`);
    return 0;
  }
  if (command === "token" && sub === "list") {
    assertFlags(flags, []);
    rejectExtra(positionals.slice(2));
    for (const record of listAccessTokens(stateDir)) {
      io.stdout(`${record.id}\t${record.label}\t${record.revokedAt ? "revoked" : "active"}\n`);
    }
    return 0;
  }
  if (command === "token" && sub === "revoke") {
    assertFlags(flags, []);
    const revoked = revokeAccessToken(stateDir, extra);
    rejectExtra(positionals.slice(3));
    io.stdout(`${revoked.id}\n`);
    return 0;
  }
  if (command === "connect" && (sub === "request" || sub === "paste" || sub === "status")) {
    assertFlags(flags, ["user"]);
    const userId = resolveConnectUser(stateDir, flags.user);
    ensureUserDir(stateDir, userId);
    const accountEnv = envForAccount(env, stateDir, userId);
    if (sub === "request") {
      const tumId = assertTumId(extra ?? "");
      rejectExtra(positionals.slice(3));
      const issued = await requestNewToken(accountEnv, fetchImpl, tumId);
      saveTumToken(stateDir, userId, accountEnv, {
        token: issued.token,
        tumId,
        tokenName: issued.tokenName,
        source: "requested",
        createdAt: new Date().toISOString(),
        confirmed: false,
      });
      io.stdout(`stored\n`);
      for (const step of activationSteps(issued.tokenName)) io.stdout(`${step}\n`);
      return 0;
    }
    if (sub === "paste") {
      rejectExtra(positionals.slice(2));
      const pasted = assertExistingToken(await readSecretLine(io));
      let confirmed = false;
      try {
        confirmed = await confirmToken(accountEnv, fetchImpl, pasted);
      } catch (error) {
        if (!(error instanceof SafeError) || error.code !== "token_unconfirmed") throw error;
      }
      saveTumToken(stateDir, userId, accountEnv, {
        token: pasted,
        tumId: "",
        tokenName: tokenNameFrom(accountEnv),
        source: "pasted",
        createdAt: new Date().toISOString(),
        confirmed,
      });
      io.stdout(`confirmed: ${confirmed}\n`);
      return 0;
    }
    rejectExtra(positionals.slice(2));
    const view = tokenStatusView(accountEnv);
    if (!view) {
      io.stdout("stored: false\n");
      return 0;
    }
    let confirmed = view.confirmed;
    try {
      const token = loadTumToken(stateDir, userId, accountEnv);
      confirmed = await confirmToken(accountEnv, fetchImpl, token.token);
      saveTumToken(stateDir, userId, accountEnv, { ...token, confirmed });
    } catch (error) {
      if (!(error instanceof SafeError) || (error.code !== "token_unconfirmed" && error.code !== "invalid_tum_token")) throw error;
      confirmed = false;
    }
    io.stdout(`stored: true\nconfirmed: ${confirmed}\nname: ${view.tokenName}\n`);
    return 0;
  }
  throw new SafeError("usage", "Unknown command.");
}

function resolveConnectUser(stateDir, userFlag) {
  if (userFlag == null || userFlag === "" || userFlag === "local") return LOCAL_USER_ID;
  return findAccessToken(stateDir, userFlag).userId;
}

function readSecretLine(io) {
  return new Promise((resolve, reject) => {
    let data = "";
    const input = io.stdin ?? process.stdin;
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      data += chunk;
      const nl = data.indexOf("\n");
      if (nl >= 0) {
        input.pause?.();
        resolve(data.slice(0, nl).trim());
      }
    });
    input.on("end", () => resolve(data.trim()));
    input.on("error", reject);
  });
}

function resolveMode(flags, env) {
  if (flags.http && flags.stdio) throw new SafeError("usage", "Choose either --http or --stdio.");
  if (flags.stdio) return "stdio";
  if (flags.http) return "http";
  const configured = typeof env.TUMONLINE_MCP_TRANSPORT === "string" ? env.TUMONLINE_MCP_TRANSPORT.trim().toLowerCase() : "";
  if (configured === "" || configured === "stdio") return "stdio";
  if (configured === "http") return "http";
  throw new SafeError("usage", "TUMONLINE_MCP_TRANSPORT must be stdio or http.");
}

function parseInvocation(argv) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--http" || arg === "--stdio") {
      flags[arg.slice(2)] = true;
      continue;
    }
    if (arg === "--host" || arg === "--port" || arg === "--label" || arg === "--user") {
      const value = argv[index + 1];
      if (value == null || value.startsWith("-")) throw new SafeError("usage", `Missing value for ${arg}.`);
      flags[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new SafeError("usage", "Unknown option.");
    positionals.push(arg);
  }
  return { flags, positionals };
}

function assertFlags(flags, allowed) {
  for (const key of Object.keys(flags)) {
    if (!allowed.includes(key)) throw new SafeError("usage", "That option does not apply to this command.");
  }
}

function rejectExtra(argv) {
  if (argv.length > 0) throw new SafeError("usage", "Too many arguments.");
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then((code) => {
    if (typeof code === "number") process.exitCode = code;
  }).catch(() => {
    process.stderr.write("tumonline-student-mcp failed\n");
    process.exitCode = 1;
  });
}

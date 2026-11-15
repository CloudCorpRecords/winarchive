import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  WinarchiveClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real KalshiSpy endpoint is
 * never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/kalshispy-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 25 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const SEARCH_MARKETS = "search_markets";
const SEARCH_WINS = "search_settled_wins";
const GET_WIN = "get_settled_win";
const CATEGORIES = "list_categories";
const STATS = "get_stats";
const ALL_TOOLS = [SEARCH_MARKETS, SEARCH_WINS, GET_WIN, CATEGORIES, STATS];

const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"ticker\":\"KXFED-26SEP\",\"outcome\":\"yes\"}" }],
  structuredContent: { ticker: "KXFED-26SEP", outcome: "yes" },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-xyz" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "kalshispy", version: "2.1.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new WinarchiveClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 5 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 5);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 5 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on each tool", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries the fixture's tool titles verbatim", () => {
    assert.deepEqual(
      TOOL_DEFS.map((t) => t.title),
      [
        "Search Kalshi markets by title or keywords",
        "Search settled wins (comparable past markets this roster won)",
        "Get one settled win by ticker",
        "List categories with settled wins",
        "Get archive stats",
      ],
    );
  });

  it("carries no required key on search_settled_wins, list_categories or get_stats", () => {
    for (const idx of [1, 3, 4]) {
      assert.equal("required" in schemaOf(TOOL_DEFS[idx]), false);
      assert.equal(schemaOf(TOOL_DEFS[idx]).required, undefined);
    }
  });

  it("requires exactly the fixture's fields on the other two tools", () => {
    assert.deepEqual(schemaOf(TOOL_DEFS[0]).required, ["query"]);
    assert.deepEqual(schemaOf(TOOL_DEFS[2]).required, ["ticker"]);
  });

  it("carries type object and additionalProperties false on every inputSchema, with no $schema marker", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).type, "object");
      assert.equal(schemaOf(tool).additionalProperties, false);
      assert.equal("$schema" in schemaOf(tool), false);
    }
  });

  it("carries every fixture property, in order, for all five tools", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < 5; i += 1) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[0]).properties), [
      "query",
      "limit",
    ]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[1]).properties), [
      "query",
      "category",
      "series_ticker",
      "event_ticker",
      "from",
      "to",
      "sort",
      "min_whales",
      "limit",
      "cursor",
    ]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[2]).properties), ["ticker"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[3]).properties), []);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[4]).properties), []);
  });

  it("carries search_markets' argument shapes verbatim", () => {
    const props = schemaOf(TOOL_DEFS[0]).properties;
    assert.equal(props.query.type, "string");
    assert.equal(props.query.maxLength, 80);
    assert.equal(props.query.pattern, "^[\\w .,'&:/()-]+$");
    assert.equal(props.limit.type, "integer");
    assert.equal(props.limit.minimum, 1);
    assert.equal(props.limit.maximum, 25);
    assert.equal(props.limit.default, 10);
  });

  it("carries search_settled_wins' category enum verbatim", () => {
    const props = schemaOf(TOOL_DEFS[1]).properties;
    assert.deepEqual(props.category.enum, [
      "politics",
      "elections",
      "sports",
      "entertainment",
      "economics",
      "financials",
      "crypto",
      "weather",
      "world",
      "scitech",
      "companies",
      "health",
      "social",
      "transportation",
      "mentions",
      "exotics",
      "other",
    ]);
  });

  it("carries search_settled_wins' ticker patterns, sort enum and paging bounds verbatim", () => {
    const props = schemaOf(TOOL_DEFS[1]).properties;
    assert.equal(props.series_ticker.pattern, "^[A-Za-z0-9_-]{1,40}$");
    assert.equal(props.event_ticker.pattern, "^[A-Za-z0-9_-]{1,60}$");
    assert.deepEqual(props.sort.enum, ["recent", "profit", "whales"]);
    assert.equal(props.sort.default, "recent");
    assert.equal(props.min_whales.minimum, 1);
    assert.equal(props.min_whales.maximum, 40);
    assert.equal(props.limit.minimum, 1);
    assert.equal(props.limit.maximum, 50);
    assert.equal(props.limit.default, 20);
    assert.equal(props.cursor.maxLength, 200);
    assert.equal(props.query.maxLength, 80);
  });

  it("carries get_settled_win's ticker pattern verbatim", () => {
    const props = schemaOf(TOOL_DEFS[2]).properties;
    assert.equal(props.ticker.type, "string");
    assert.equal(props.ticker.pattern, "^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$");
  });

  it("isKnownTool recognises the 5 built tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("search"), false);
    assert.equal(isKnownTool("get_market"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(SEARCH_MARKETS, { query: "super bowl" });
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://kalshispy.com/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-xyz");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-xyz");
  });

  it("sends clientInfo name winarchive and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(STATS, {});
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "winarchive", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CATEGORIES, {});
    await c.callTool(GET_WIN, { ticker: "KXFED-26SEP" });
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-xyz");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(STATS, {});
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the KALSHISPY_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new WinarchiveClient({
      fetchFn: upstream.fetchFn,
      env: { KALSHISPY_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(SEARCH_MARKETS, { query: "fed rate" });
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(SEARCH_WINS, { category: "sports" });
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { KALSHISPY_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(CATEGORIES, {});
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new WinarchiveClient({
      fetchFn: upstream.fetchFn,
      env: { KALSHISPY_MCP_URL: "   " },
    });
    await c.callTool(STATS, {});
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("upstream key header", () => {
  it("sends X-Api-Key on every request when KALSHISPY_API_KEY is set", async () => {
    const upstream = makeUpstream();
    const c = new WinarchiveClient({
      fetchFn: upstream.fetchFn,
      env: { KALSHISPY_API_KEY: "spy-key-42" },
    });
    await c.callTool(SEARCH_MARKETS, { query: "fed rate" });
    assert.equal(upstream.calls.length, 3);
    assert.ok(
      upstream.calls.every((call) => call.headers["X-Api-Key"] === "spy-key-42"),
    );
  });

  it("sends no X-Api-Key header when KALSHISPY_API_KEY is unset", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH_MARKETS, { query: "fed rate" });
    assert.ok(calls.every((call) => call.headers["X-Api-Key"] === undefined));
  });

  it("sends no X-Api-Key header when KALSHISPY_API_KEY is blank", async () => {
    const upstream = makeUpstream();
    const c = new WinarchiveClient({
      fetchFn: upstream.fetchFn,
      env: { KALSHISPY_API_KEY: "   " },
    });
    await c.callTool(STATS, {});
    assert.ok(
      upstream.calls.every((call) => call.headers["X-Api-Key"] === undefined),
    );
  });

  it("never sends an Authorization header, with or without a key", async () => {
    const withKey = makeUpstream();
    const c1 = new WinarchiveClient({
      fetchFn: withKey.fetchFn,
      env: { KALSHISPY_API_KEY: "spy-key-42" },
    });
    await c1.callTool(CATEGORIES, {});
    assert.ok(withKey.calls.every((call) => call.headers["Authorization"] === undefined));
    const { client: c2, calls } = stubClient();
    await c2.callTool(CATEGORIES, {});
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a search_markets call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { query: "super bowl", limit: 5 };
    await c.callTool(SEARCH_MARKETS, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, SEARCH_MARKETS);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a search_settled_wins call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { series_ticker: "KXFED", category: "economics", sort: "profit", min_whales: 3 };
    await c.callTool(SEARCH_WINS, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, SEARCH_WINS);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a get_settled_win call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { ticker: "KXFED-26SEP" };
    await c.callTool(GET_WIN, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, GET_WIN);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards list_categories and get_stats calls verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CATEGORIES, {});
    await c.callTool(STATS, {});
    const first = calls[2].body.params as Record<string, unknown>;
    const second = calls[3].body.params as Record<string, unknown>;
    assert.equal(first.name, CATEGORIES);
    assert.deepEqual(first.arguments, {});
    assert.equal(second.name, STATS);
    assert.deepEqual(second.arguments, {});
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(GET_WIN, { ticker: "KXFED-26SEP" });
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "no such win" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(GET_WIN, { ticker: "nope" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(CATEGORIES, {});
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      SEARCH_WINS,
      { query: "lakers" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, SEARCH_WINS);
    assert.deepEqual(params.arguments, { query: "lakers" });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as winarchive error text", () => {
  it("maps a JSON-RPC error to `winarchive error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "lookup failed upstream" },
    });
    const out = await c.callTool(GET_WIN, { ticker: "KXFED-26SEP" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "winarchive error: lookup failed upstream");
  });

  it("maps an initialize JSON-RPC error to winarchive error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(STATS, {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "winarchive error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(CATEGORIES, {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "winarchive error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(CATEGORIES, {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "winarchive error: malformed response");
  });

  it("maps a non-2xx upstream status to winarchive error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(STATS, {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "winarchive error: HTTP 500");
  });

  it("maps a throwing fetch to winarchive error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(SEARCH_MARKETS, { query: "fed rate" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^winarchive error: /);
  });

  it("maps a throwing initialize fetch to winarchive error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(SEARCH_MARKETS, { query: "fed rate" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "winarchive error: socket hang up");
  });

  it("maps a timed-out call to winarchive error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(GET_WIN, { ticker: "KXFED-26SEP" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^winarchive error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, SEARCH_MARKETS, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, GET_WIN, "ticker=KXFED-26SEP"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid search_markets call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, SEARCH_MARKETS, { query: "fed rate" });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, { query: "fed rate" });
  });

  it("forwards a valid get_settled_win call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, GET_WIN, { ticker: "KXFED-26SEP" });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, GET_WIN);
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, STATS, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([SEARCH_MARKETS, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([SEARCH_MARKETS, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});

/**
 * winarchive core: a forwarding client for the hosted
 * KalshiSpy MCP server.
 *
 * No archive data lives on this machine. tools/list is
 * answered from the literal definitions below, which
 * reproduce a live capture of the upstream server word
 * for word (name, title, description and inputSchema
 * exactly as captured; only `search_markets` and
 * `get_settled_win` declare a `required` field). A
 * tools/call travels upstream over a streamable-HTTP
 * JSON-RPC session: an initialize POST, a
 * notifications/initialized POST, then the tools/call
 * POST, carrying the Mcp-Session-Id response header on
 * later requests when the upstream issues one. The
 * session opens lazily on the first forwarded call and
 * is reused for the client's lifetime.
 *
 * The endpoint is pinned to https://kalshispy.com/mcp
 * and may be replaced with the KALSHISPY_MCP_URL
 * environment variable (that override is a labelled
 * reconstruction). The registry record pins a secret
 * `X-Api-Key` header on its remote; when
 * KALSHISPY_API_KEY is set, every upstream request
 * carries an `X-Api-Key: <value>` header (the header
 * name is pinned by the record; the env forwarding is
 * a labelled reconstruction — the captures were taken
 * keyless). When it is unset, no key header goes out.
 *
 * A successful upstream result is returned exactly as
 * received, isError flag and extra fields included.
 * Failures — an upstream JSON-RPC error, a non-2xx
 * status, a body that cannot be parsed, or a fetch
 * that throws or times out — become an isError result
 * whose text begins with `winarchive error:` (that
 * rendering is a labelled reconstruction). Replies may
 * be plain JSON or SSE (`data:` lines); the JSON-RPC
 * message whose id matches the request wins.
 */
import type {
  FetchFn,
  FetchResponseLike,
  ForwardDeps,
  ToolArgs,
  ToolDef,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ENDPOINT_URL = "https://kalshispy.com/mcp";

export const DEFAULT_TIMEOUT_MS = 30000;

export const PROTOCOL_VERSION = "2025-03-26";

/* ------------------------------------------------------------------ */
/* Tool definitions (tools/list literals, verbatim from the live       */
/* capture in harness/fixtures/kalshispy-tools-original.json;         */
/* generated programmatically by parsing and re-serialising the        */
/* fixture JSON, never retyped)                                        */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS: ToolDef[] = [
  {
    "name": "search_markets",
    "title": "Search Kalshi markets by title or keywords",
    "description": "Find Kalshi markets by title or keywords, the way the KalshiSpy app's search works: fuzzy title matching finds the market series (so a team, a nickname or an approximate title works), and keyword matching runs against market titles. WITHOUT an API key it returns SETTLED WINS ONLY: settled markets where KalshiSpy's roster of ID-verified, high-profit Kalshi traders held the winning side (wins only, never a hit rate). WITH an Elite or Lifetime API key the same call also returns OPEN markets in `open_markets`: roster positions from the live feed and named traders' recent trades on still-open markets, and it costs 1 unit of the daily quota. Always read `data.access`: it says which answer you got and, when a key was refused, why; relay that sentence rather than guessing. Call this first whenever the user names a market in words, send the words under the argument name this tool's own schema gives, and cite each market's kalshi_url. An empty list is never evidence that Kalshi has no such market. For more wins, follow `settled_wins.more`, which carries ready-made search_settled_wins arguments.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "maxLength": 80,
          "pattern": "^[\\w .,'&:/()-]+$",
          "description": "Market title or keywords, e.g. \"super bowl\", \"fed rate\" or \"bitcoin\". Terms of 2+ characters, at most 8. Keyword matching ANDs them as substrings of the title, outcome and tickers (settled wins also match the event title); the full text is also fuzzy-matched to market series."
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 25,
          "default": 10,
          "description": "Maximum items in each list (settled wins, roster markets, recently traded markets)."
        }
      },
      "additionalProperties": false,
      "required": [
        "query"
      ]
    }
  },
  {
    "name": "search_settled_wins",
    "title": "Search settled wins (comparable past markets this roster won)",
    "description": "Search KalshiSpy's archive of settled Kalshi markets where its roster of ID-verified, high-profit Kalshi traders held the WINNING side with positive net realized profit. Parameter and field names call these traders \"whales\" (whale_count, min_whales, sort=whales); in prose, call them the roster or the verified traders. Wins only: losses are not archived, so present results as \"what this roster got right on markets like this\", never as a hit rate. Use this BEFORE answering about any current or upcoming Kalshi market: search the same series_ticker (e.g. KXFED, KXNBA) or category and cite the comparable past wins — titles, settlement dates, trader counts and realized profit. Each result carries the Kalshi URL and a kalshispy.com detail URL you can cite. Default window is the last 90 days; widen with `from`/`to` (max 366 days). No API key needed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "maxLength": 80,
          "pattern": "^[\\w .,'&:/()-]+$",
          "description": "Free-text search. Every term (2+ chars, max 8) must appear as a substring in the title, outcome, event title, series ticker or ticker. Example: \"fed rate\" or \"lakers\"."
        },
        "category": {
          "type": "string",
          "enum": [
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
            "other"
          ],
          "description": "Category key from listCategories (e.g. sports, politics, economics)."
        },
        "series_ticker": {
          "type": "string",
          "pattern": "^[A-Za-z0-9_-]{1,40}$",
          "description": "Kalshi series ticker, e.g. KXFED, KXNBA. The best way to find \"markets like this one\"."
        },
        "event_ticker": {
          "type": "string",
          "pattern": "^[A-Za-z0-9_-]{1,60}$",
          "description": "Kalshi event ticker, e.g. KXFED-26SEP."
        },
        "from": {
          "type": "string",
          "description": "Start of the settlement window. Default: 90 days before `to`. Clamped to the archive start (2025-01-01) and to a 366-day maximum; the effective window is echoed in `window`."
        },
        "to": {
          "type": "string",
          "description": "End of the settlement window (inclusive). Default: now."
        },
        "sort": {
          "type": "string",
          "enum": [
            "recent",
            "profit",
            "whales"
          ],
          "default": "recent",
          "description": "recent = newest settlement first; profit = largest net profit first; whales = most whales on the winning side first."
        },
        "min_whales": {
          "type": "integer",
          "minimum": 1,
          "maximum": 40,
          "description": "Only wins with at least this many roster traders on the winning side."
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50,
          "default": 20,
          "description": "Page size."
        },
        "cursor": {
          "type": "string",
          "maxLength": 200,
          "description": "Opaque cursor from a previous response (`page.next_cursor`). Send it with the SAME filters; changing the query invalidates it."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "get_settled_win",
    "title": "Get one settled win by ticker",
    "description": "Full record of one settled Kalshi market this roster won: outcome, consensus, every roster trader on the winning side with their realized profit and picture, close and expiration times, keywords, and `hints.similar` — comparable wins in the same series to judge it against. Returns 404 when the ticker is not an archived win (the roster was not on it, or was on the losing side); the 404 carries a hint to search the series instead. No API key needed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "ticker": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$",
          "description": "Kalshi market ticker."
        }
      },
      "additionalProperties": false,
      "required": [
        "ticker"
      ]
    }
  },
  {
    "name": "list_categories",
    "title": "List categories with settled wins",
    "description": "Every category that has at least one archived win, with win count, net profit and the last settlement time. Use the `key` value as the `category` filter of searchSettledWins. No API key needed.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "get_stats",
    "title": "Get archive stats",
    "description": "Aggregate figures for the settled-wins archive: markets won, net and winners' realized profit, first and last settlement, a per-category breakdown and the highest-profit traders in the archive. Use it for \"how has this roster done overall\" context, always with the wins-only caveat. `available:false` means the archive has not been published yet. No API key needed.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  }
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/** Whether `name` belongs to the captured surface. */
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

/* ------------------------------------------------------------------ */
/* Forwarding client                                                   */
/* ------------------------------------------------------------------ */

function errorResult(detail: string): ToolResult {
  return {
    content: [{ type: "text", text: `winarchive error: ${detail}` }],
    isError: true,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Read a JSON-RPC response body, tolerating SSE framing.
 * Returns the message whose id matches `expectedId` when
 * present, otherwise the last parseable message, otherwise
 * null when nothing in the body parses.
 */
export function parseRpcBody(
  text: string,
  expectedId?: number,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: Record<string, unknown>[] = [];
  const tryPush = (payload: string): void => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not a JSON payload; skip this candidate.
    }
  };
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice("data:".length).trim();
      if (payload !== "" && payload !== "[DONE]") tryPush(payload);
    }
  } else {
    tryPush(trimmed);
  }
  if (candidates.length === 0) return null;
  if (expectedId !== undefined) {
    const match = candidates.find((c) => c.id === expectedId);
    if (match !== undefined) return match;
  }
  return candidates[candidates.length - 1];
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

/**
 * A forwarding client holding a single upstream session,
 * opened lazily on first use and reused from then on
 * (for the process lifetime in the MCP server, or for a
 * single invocation in the CLI).
 */
export class WinarchiveClient {
  private readonly deps: ForwardDeps;
  private sessionId: string | null = null;
  private ready = false;
  private sessionPromise: Promise<void> | null = null;
  private idCounter = 0;

  constructor(deps: ForwardDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private endpointUrl(): string {
    if (this.deps.url && this.deps.url.trim() !== "") return this.deps.url.trim();
    const raw = (this.deps.env ?? process.env).KALSHISPY_MCP_URL;
    if (raw && raw.trim() !== "") return raw.trim();
    return DEFAULT_ENDPOINT_URL;
  }

  private apiKey(): string | null {
    const raw = (this.deps.env ?? process.env).KALSHISPY_API_KEY;
    if (raw && raw.trim() !== "") return raw.trim();
    return null;
  }

  private timeoutMs(): number {
    if (typeof this.deps.timeoutMs === "number" && this.deps.timeoutMs > 0) {
      return this.deps.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    withSession: boolean,
  ): Promise<FetchResponseLike> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const key = this.apiKey();
    if (key !== null) headers["X-Api-Key"] = key;
    if (withSession && this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.fetchFn()(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ready) return;
    if (this.sessionPromise === null) {
      this.sessionPromise = (async () => {
        const initId = this.nextId();
        const initRes = await this.post(
          {
            jsonrpc: "2.0",
            id: initId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "winarchive", version: VERSION },
            },
          },
          false,
        );
        const sessionId = initRes.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        const initText = await initRes.text();
        const initParsed = parseRpcBody(initText, initId);
        if (initParsed !== null && initParsed.error) {
          throw new Error(rpcErrorMessage(initParsed.error));
        }
        if (initRes.status < 200 || initRes.status >= 300) {
          throw new Error(`HTTP ${initRes.status}`);
        }
        if (initParsed === null && initText.trim() !== "") {
          throw new Error("malformed response");
        }
        const initializedRes = await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
        try {
          await initializedRes.text();
        } catch {
          // Nothing needed from the notification response body.
        }
        this.ready = true;
      })();
    }
    try {
      await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      this.sessionId = null;
      throw err;
    }
  }

  /** Forward one tool call; upstream failures come back as isError results. */
  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    try {
      await this.ensureSession();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    const callId = this.nextId();
    let callRes: FetchResponseLike;
    try {
      callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name, arguments: args ?? {} },
        },
        true,
      );
    } catch (err) {
      return errorResult(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseRpcBody(await callRes.text(), callId);
    if (parsed !== null && parsed.error) {
      return errorResult(rpcErrorMessage(parsed.error));
    }
    if (callRes.status < 200 || callRes.status >= 300) {
      return errorResult(`HTTP ${callRes.status}`);
    }
    if (parsed === null) return errorResult("malformed response");
    const result = parsed.result as ToolResult | undefined;
    if (result === undefined || result === null || typeof result !== "object") {
      return errorResult("malformed response");
    }
    // Hand the upstream result back exactly as received.
    return result;
  }
}

/** Build a forwarding client; tests inject a fake fetch and env through deps. */
export function createClient(deps: ForwardDeps = {}): WinarchiveClient {
  return new WinarchiveClient(deps);
}

/** One-shot helper: a fresh client for a single call (the CLI path). */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: ForwardDeps = {},
): Promise<ToolResult> {
  return new WinarchiveClient(deps).callTool(name, args);
}

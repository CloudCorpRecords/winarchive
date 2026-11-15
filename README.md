# winarchive

Kalshi results are hard to learn from after the fact: the markets settle, the tickers scroll away, and what the best traders actually got right disappears with them. winarchive is a small local bridge to the hosted KalshiSpy MCP service: you can search the archive of settled Kalshi markets where KalshiSpy's roster of ID-verified, high-profit traders held the winning side, pull the full record for one win, browse the categories that have archived wins, and read the archive's aggregate stats.

Nothing is stored or computed on your own machine. This package answers `tools/list` locally from the captured tool definitions and forwards every `tools/call` to the hosted service over a streamable-HTTP JSON-RPC session, returning whatever the service sends back unchanged. The archive holds wins only — losses are not archived — so results say what this roster got right on markets like the one you asked about, never a hit rate.

## The tools

Every tool in this surface reads the vendor's settled-win archive. None of them places a trade, opens a position, buys anything, starts a subscription, or creates an API key.

- **`search_markets`** — Finds Kalshi markets by title or keywords the way the KalshiSpy app's search works: fuzzy title matching finds the market series and keyword matching runs against market titles. Without an API key it returns settled wins only; with an Elite or Lifetime key the same call can also return open markets and costs 1 unit of that key's daily quota. The `data.access` field in the answer says which answer you got.
- **`search_settled_wins`** — Searches the settled-win archive itself, by free text, category, series ticker or event ticker, within a settlement window (the last 90 days by default). Results can be sorted by recency, profit or trader count and filtered to wins with at least a given number of roster traders on the winning side.
- **`get_settled_win`** — The full record of one settled win by market ticker: outcome, consensus, every roster trader on the winning side with their realized profit, close and expiration times, keywords, and hints pointing at comparable wins in the same series.
- **`list_categories`** — Every category that has at least one archived win, with its win count, net profit and last settlement time. The `key` values are the `category` filter values for `search_settled_wins`.
- **`get_stats`** — Aggregate figures for the archive: markets won, net and winners' realized profit, first and last settlement, a per-category breakdown and the highest-profit traders in the archive.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/winarchive mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "winarchive": {
      "command": "npx",
      "args": ["-y", "@reneturcios/winarchive", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/winarchive
docker run --rm ghcr.io/cloudcorprecords/winarchive get_settled_win '{"ticker":"KXFED-26SEP"}'
```

## CLI

One binary serves both the command line and the MCP server. Each tool is a subcommand taking a single JSON string with that tool's arguments:

```bash
winarchive search_markets '{"query":"super bowl"}'
winarchive search_settled_wins '{"series_ticker":"KXFED","sort":"profit"}'
winarchive get_settled_win '{"ticker":"KXFED-26SEP"}'
winarchive list_categories '{}'
winarchive get_stats '{}'
winarchive --version
```

Exit codes: `0` when the forwarded call succeeds, `1` when the upstream result is an error, and `2` for usage problems such as an unknown subcommand or a malformed JSON argument.

## Configuration

- `KALSHISPY_MCP_URL` — Overrides the upstream endpoint. The default is the pinned hosted endpoint, `https://kalshispy.com/mcp`. (The override variable is a reconstruction added by this rebuild.)
- `KALSHISPY_API_KEY` — When set, its value is sent to the upstream on every request as an `X-Api-Key: <value>` header; the header name is pinned by the service's registry record. When it is not set, no key header is sent at all, matching the keyless behaviour the tool surface was captured with. (The environment-variable forwarding is a reconstruction added by this rebuild; the captures were taken keyless.)

Upstream failures — a JSON-RPC error from the service, a non-2xx response, an unreadable body, or a request that fails outright — are reported to the caller as an error result whose text starts with `winarchive error:`.

## How forwarding works

The first forwarded call opens a session: an `initialize` request (protocol version `2025-03-26`), followed by a `notifications/initialized` notification, then the `tools/call` itself. If the service answers the initialize request with an `Mcp-Session-Id` header, that value is carried on every later request, and the open session is reused for the rest of the process. Replies are accepted either as plain JSON or as server-sent events. Successful results pass through verbatim, including any `isError` flag and any extra fields the service includes.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The test suite checks the served tool list against the captured surface tool by tool, exercises the session handshake and its reuse, covers both key-header branches, and verifies that arguments go upstream untouched and results come back untouched.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.

# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted KalshiSpy MCP server. The five captured tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `search_markets`, `search_settled_wins`, `get_settled_win`, `list_categories` and `get_stats`. The surface is read-only: it searches and reads the vendor's settled-win archive — markets where a roster of verified traders held the winning side, by market, category and trader. No tool places a trade, opens a position, buys data or mints a key.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `winarchive error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `KALSHISPY_MCP_URL`; when `KALSHISPY_API_KEY` is set it is sent as an `X-Api-Key` header on every upstream request.

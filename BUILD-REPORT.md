# BUILD REPORT — winarchive

Clean-room rebuild of `com.kalshispy/kalshispy` v2.1.0 (remote-only MCP
server at `https://kalshispy.com/mcp`), built 2026-10-28 as a
forwarding client. Package: `@reneturcios/winarchive` 0.1.0,
registry name `io.github.CloudCorpRecords/winarchive`.

## Surface built

Full surface built: **5/5 tools**, no omissions.

| Tool | Title (as served) | Required fields as served |
|------|-------------------|-----------------------------|
| `search_markets` | Search Kalshi markets by title or keywords | `query` |
| `search_settled_wins` | Search settled wins (comparable past markets this roster won) | *(no `required` key in schema)* |
| `get_settled_win` | Get one settled win by ticker | `ticker` |
| `list_categories` | List categories with settled wins | *(no `required` key in schema)* |
| `get_stats` | Get archive stats | *(no `required` key in schema)* |

Every tool's inputSchema carries `type: "object"` and
`additionalProperties: false` exactly as captured; no tool's schema
carries a `$schema` marker in the capture, and none is served. Tool
literals were generated programmatically from
`harness/fixtures/kalshispy-tools-original.json` by the script at
`/tmp/b41-winarchive-gen.py` (parse + re-serialise, substitution into
`src/forward.ts`) — never retyped — and a post-generation check (the
registration-integrity test suite, plus the parity harness) confirmed
the served literals deep-equal the fixture's 5 tool objects in order.
Tools are registered via the MCP SDK low-level Server API
(`ListToolsRequestSchema` / `CallToolRequestSchema` handlers), not
McpServer+zod, per the task instruction.

## Fixture conflicts

**None.** The spec and the fixture agree on tool names, order, titles,
required fields (present on exactly the two tools listed above, absent
on the other three), and descriptions.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://kalshispy.com/mcp`.
- Env override `KALSHISPY_MCP_URL` — labelled reconstruction.
- Header name `X-Api-Key` — pinned by the registry record (secret
  header). Env name `KALSHISPY_API_KEY` and its forwarding are labelled
  reconstructions (the captures were taken keyless). When set,
  `X-Api-Key: <value>` is sent on every upstream request. When unset,
  no key header is sent. Both branches are tested, as is the guarantee
  that no `Authorization` header is ever sent.
- Error rendering `winarchive error:` text for upstream failures —
  labelled reconstruction.
- Upstream results pass through verbatim, including `isError` and extra
  fields. tools/call is forwarded as streamable-HTTP JSON-RPC:
  initialize (protocolVersion `2025-03-26`) → notifications/initialized →
  tools/call, honouring `Mcp-Session-Id` when issued; plain-JSON and SSE
  replies are both parsed. The forwarding core takes an injectable fetch;
  tests stub the upstream — no live network calls in tests.

## Deviations

**None.** The parity harness was invoked with the absolute rebuild path
(as instructed in the task), so no tilde-expansion issue arose.

## Lockfile

- Route: **Route 3** — generated clean from birth in the build dir with
  no `node_modules` and no pre-existing lockfile:
  `npm install --package-lock-only --ignore-scripts --offline`.
- Parses as JSON; `name` == `@reneturcios/winarchive`.
- Package entries: **128**.
- sha256: `6f924da58358cc63d1bca0efa65090c301e8e6818d49be3b627a25111bea7601`
  (re-verified unchanged after the subsequent offline `npm install`).

## server.json

- Description exactly: "Settled Kalshi win archive: what verified top
  traders won, by market, category and trader." — **90 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/winarchive:0.1.0`) carries **no** `version`
  field. Dockerfile (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/winarchive"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/winarchive` and
  its smoke test asserts the server name `winarchive`.

## Verification (all run 2026-10-28, read from disk in the foreground)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → exit 0; real `dist/` produced (cli, forward, index,
   mcp, types — .js, .d.ts, .js.map each).
3. `node dist/cli.js --version` → `0.1.0`; unknown subcommand → Usage on
   stderr, exit 2 (also covered in the test suite).
4. `npm test` → **58 tests, 58 pass, 0 fail** (registration-integrity
   suite deep-equals the served tools/list against the fixture's 5
   tools in order, plus session handling/reuse, env override, key-header
   present/absent/blank branches, verbatim argument forwarding and
   result pass-through including upstream isError, SSE parsing, error
   rendering, MCP-layer validation, and CLI behaviour).
5. Parity: `python3 harness/parity.py --original
   harness/fixtures/kalshispy-tools-original.json --rebuild
   "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/winarchive/dist/cli.js mcp"
   --out builds/winarchive/parity-out` → **verdict PASS, parity 100.0**
   (5/5 identical, 0 missing, 0 extra, no schema diffs). Output in
   `parity-out/`, read directly from `parity-out/parity.json`.

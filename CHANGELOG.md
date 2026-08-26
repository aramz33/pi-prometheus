# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-26

### Added

- **Per-source context attribution.** New metric families that answer "which extension,
  skill, or MCP server is eating my context window":
  `pi_context_footprint_tokens{kind,name,source}`, `pi_context_static_tokens`,
  `pi_source_tokens_total{kind,name,source}`. `kind` is one of `tool`, `skill`,
  `context_file`, `prompt_section`; `source` is the installed package
  (`builtin`, `npm:<package>`, `git:<repo>`, `local`), or `auto` for a resource Pi
  discovered in a conventional directory rather than one that arrived in a package.
- **Nested-token accounting** for sub-agent tool calls:
  `pi_tool_nested_tokens_total{tool,type}` and `pi_tool_nested_cost_usd_total{tool}`.
  Emitted only when the host Pi reports `usage` on `tool_result`, so older hosts simply
  produce no series.
- `pi_compaction_failures_total{reason}` and `pi_prometheus_build_info{version,pi_version}`.
- **Two terminal commands, usable with no Prometheus at all.** `/context-budget` prints
  the per-source footprint table with the total and its share of the window;
  `/metrics` prints the current session's numbers plus the scrape URL.
- **Status line control** via `PI_PROMETHEUS_STATUS` (`off`, `port` default, `full`).
- **Cardinality guards** for the attribution series: `PI_PROMETHEUS_ATTRIBUTION`
  (`off`, `rollup`, `full` default) and `PI_PROMETHEUS_ATTRIBUTION_TOP_N` (default 100,
  the tail collapses per kind and source into `name="_other"`, so `sum by (source)` and
  `sum by (kind)` stay exact). `pi_context_static_tokens` always reports the true total,
  unaffected by the cap.
- New examples: `examples/grafana-dashboard-attribution.json`, `examples/alerts.yml`,
  `examples/docker-compose.yml`, and a generated `examples/media/context-budget.png`.
- Packaging metadata: explicit `files`, `engines.node`, `bugs`, `homepage`, and `pi.image`
  for the pi.dev gallery card.
- CI on GitHub Actions (Linux, macOS, Windows; Node 22.19 and 24), `promtool` validation
  of the exposition format, the alert rules and the scrape config, and a packaging check
  that the published tarball carries `extensions/` and no `test/`.
- Releases are published with npm provenance attestation.

### Fixed

- **Counters no longer carry over between sessions.** See the behaviour-change note below.
- `pi_session_start_time_seconds` reported the moment the module was first evaluated,
  not the moment the session began. It is now set in the `session_start` handler, so it
  moves forward on `/new`, resume and fork.
- Orphaned `.tmp` target files were never collected. They are now subject to the same
  liveness rule as regular target files, guarded by a 60 second age threshold so a file
  being written right now is never removed.
- A target file whose owning process returned `EPERM` from `process.kill(pid, 0)` was
  treated as dead and deleted. `EPERM` means the process is alive but owned by another
  user, so the file is now kept. The full decision table is: no error means alive, keep;
  `ESRCH` means dead, delete; `EPERM` means alive, keep; anything else means unknown,
  keep.
- `examples/grafana-dashboard.json` hard-coded `job="pi"` and `[5m]` rate windows. The
  job is now a dashboard variable and the windows use `$__rate_interval`.

### Changed

- `description` and `keywords` in the manifest now lead with the outcome (what the
  session costs, per source) rather than the mechanism (file-based service discovery).
- `npm test` is now plain `node test/check.ts`. The test creates its own temporary
  directory when `PI_PROMETHEUS_DIR` is unset, which makes the suite run on Windows.
  The previous command used `$(mktemp -d)` inline and only worked on a POSIX shell.
- `engines.node` is declared as `>=22.19.0`, the first version that runs
  `node test/check.ts` without a type-stripping flag.
- `peerDependencies` on `@earendil-works/pi-coding-agent` moved from `*` to `>=0.80.0`.
- The published tarball no longer contains `test/`.

### Behaviour change: counters reset at the start of every session

**Your dashboards will show a discontinuity at the moment you upgrade to this version.
This is the fix, not a regression.**

Before this release, `pi_tokens_total`, `pi_cost_usd_total`, `pi_turns_total`,
`pi_tool_calls_total`, `pi_tool_errors_total` and `pi_compactions_total` kept the
previous session's totals when you ran `/new`, resumed a session, or forked one in the
same directory. Pi caches extension modules by `{cwd, generation}`, so a cache hit
returns the already-imported factory without re-evaluating the module, and the
module-level counter state survived. Only a full `reload()` cleared it.

The README claimed the opposite: it stated that counters reset when a session restarts
or reloads. That statement was wrong, and it has been removed.

From this release, the counter state lives inside the extension factory and is reset in
the `session_start` handler, so `/new`, resume and fork all start from zero, and
`pi_session_start_time_seconds` moves with them. Any dashboard panel that read a raw
counter value across sessions will step down once. Panels built on `rate()` or
`increase()` handle counter resets natively and need no change.

<!--
Release ordering, which must not be inverted: `pi.image` in package.json is pinned to
the `v0.2.0` tag, not to `main`, so that a later commit cannot silently change the
pi.dev gallery card. `examples/media/context-budget.png` therefore has to be committed
and the `v0.2.0` tag pushed BEFORE `npm publish` runs. Publishing first leaves a broken
thumbnail in the gallery until the tag lands.
-->

## [0.1.0] - 2026-07-17

First public release, published to npm as `pi-prometheus`.

### Added

- Prometheus exporter extension for the Pi coding agent. Every session binds a
  `/metrics` endpoint on an ephemeral `127.0.0.1` port, so parallel sessions never clash
  over a port and nothing is reachable from the network.
- Per-session registration through
  [Prometheus file-based service discovery](https://prometheus.io/docs/guides/file-sd/):
  the extension writes `~/.pi/metrics/targets/<pid>.json` carrying `session_id`, `cwd`
  and `pid` as target labels, and removes it on shutdown. Stale files left by crashed
  sessions are cleaned up on the next session start. Any number of parallel sessions are
  scraped with no reconfiguration.
- Metric families: `pi_session_info{model,cwd}`, `pi_session_start_time_seconds`,
  `pi_tokens_total{type}`, `pi_cost_usd_total`, `pi_turns_total`,
  `pi_tool_calls_total{tool}`, `pi_tool_errors_total{tool}`,
  `pi_compactions_total{reason}`, `pi_context_tokens`, `pi_context_window_tokens`,
  `pi_turn_duration_seconds` (histogram, 5s to 600s buckets, sized for local models).
- Configuration through `PI_PROMETHEUS_DIR`, defaulting to `~/.pi/metrics/targets`.
- Examples: `examples/grafana-dashboard.json` (sessions online, cost, context-usage
  gauge, token rate, tool calls and errors, turn-duration percentiles, filterable per
  session), `examples/prometheus-scrape.yml`, `examples/victoriametrics-scrape.yml`.
  The same scrape file works with VictoriaMetrics via `-promscrape.config`.
- Self-check suite (`npm test`) driving the extension with a fake event stream and
  asserting on the `/metrics` body and the target-file lifecycle.
- No runtime dependencies, no daemon, no push gateway. Works with Prometheus,
  VictoriaMetrics, Grafana Mimir, or anything else that scrapes the Prometheus text
  format, and in every Pi run mode (TUI, `--print`, RPC, JSON).

[Unreleased]: https://github.com/aramz33/pi-prometheus/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aramz33/pi-prometheus/releases/tag/v0.1.0

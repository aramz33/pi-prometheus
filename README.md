# pi-prometheus

Prometheus exporter for the [Pi coding agent](https://github.com/earendil-works/pi).

Every Pi session exposes its own `/metrics` endpoint and registers itself through
[Prometheus file-based service discovery](https://prometheus.io/docs/guides/file-sd/) —
run 1 session or 10 in parallel, they all show up in Grafana with zero re-configuration.

Works with **Prometheus**, **VictoriaMetrics**, **Grafana Mimir**, or anything else that
scrapes the Prometheus text format. No runtime dependencies, no daemon, no push gateway.

## How it works

1. On session start the extension binds `/metrics` on an **ephemeral localhost port**
   (no port clashes, ever).
2. It writes a target file to `~/.pi/metrics/targets/<pid>.json`:

   ```json
   [{ "targets": ["127.0.0.1:54321"],
      "labels": { "session_id": "…", "cwd": "/path/to/project", "pid": "…" } }]
   ```

3. Your scraper watches that directory via `file_sd_configs`. Sessions appear when they
   start and disappear when they exit. Stale files from crashed sessions are cleaned up
   automatically on the next session start.

## Install

```bash
pi install git:github.com/aramz33/pi-prometheus
```

## Scrape config

Prometheus ([full example](examples/prometheus-scrape.yml)) — VictoriaMetrics accepts
the same file via `-promscrape.config` ([example](examples/victoriametrics-scrape.yml)):

```yaml
scrape_configs:
  - job_name: pi
    scrape_interval: 15s
    file_sd_configs:
      - files: ["/Users/<you>/.pi/metrics/targets/*.json"]
        refresh_interval: 15s
```

## Metrics

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `pi_session_info` | gauge | `model`, `cwd` | Static session info (always 1) |
| `pi_session_start_time_seconds` | gauge | | Exporter start time |
| `pi_tokens_total` | counter | `type` = `input` \| `output` \| `cache_read` \| `cache_write` | Tokens consumed |
| `pi_cost_usd_total` | counter | | Cumulative cost (provider cost model) |
| `pi_turns_total` | counter | | Agent turns completed |
| `pi_tool_calls_total` | counter | `tool` | Tool executions |
| `pi_tool_errors_total` | counter | `tool` | Tool executions that errored |
| `pi_compactions_total` | counter | `reason` = `manual` \| `threshold` \| `overflow` | Context compactions |
| `pi_context_tokens` | gauge | | Estimated tokens in context |
| `pi_context_window_tokens` | gauge | | Context window of active model |
| `pi_turn_duration_seconds` | histogram | | Turn duration (buckets 5s–600s, sized for local models) |

`session_id`, `cwd`, and `pid` arrive as target labels from service discovery, so every
series is automatically attributable to its session.

## Grafana

Import [`examples/grafana-dashboard.json`](examples/grafana-dashboard.json): sessions
online, cost, context-usage gauge, token rate, tool calls/errors, turn-duration
percentiles — filterable per session.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PI_PROMETHEUS_DIR` | `~/.pi/metrics/targets` | Directory for service-discovery target files |

## Notes

- The endpoint binds `127.0.0.1` only — nothing is exposed on the network.
- Counters reset when a session restarts or reloads; `rate()` handles counter resets
  natively, so dashboards are unaffected.
- Works in all Pi run modes (TUI, `--print`, RPC, JSON).

## Development

```bash
npm test   # self-check: fake event stream → asserts /metrics output + target-file lifecycle
```

## License

MIT

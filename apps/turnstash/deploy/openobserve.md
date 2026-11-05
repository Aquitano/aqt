# Quota alerts in OpenObserve

Turnstash exports quota gauges through its existing OTLP metrics pipeline. OpenObserve can evaluate them and notify your configured destinations even when the Turnstash dashboard is closed. The server and the agents collecting quota readings must keep running.

Browser alerts remain optional. Their switches and dismissals apply only to that browser. Enable or disable server-side notifications through OpenObserve alert rules.

## Connect the existing collector

On the Turnstash server, configure the existing OTLP settings:

```dotenv
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_METRICS_EXPORTER=otlp
```

Use the address of your collector. Keep any existing OTLP headers and resource attributes. No OpenObserve credentials belong in the browser.

If the collector already forwards metrics to OpenObserve, no new exporter is needed. Otherwise, merge an exporter and metrics pipeline into its configuration:

```yaml
exporters:
  otlphttp/openobserve:
    endpoint: ${env:OPENOBSERVE_OTLP_ENDPOINT}
    headers:
      Authorization: ${env:OPENOBSERVE_AUTHORIZATION}

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/openobserve]
```

This fragment assumes the collector already defines its `otlp` receiver and `batch` processor. Preserve its other pipelines and exporters. Set `OPENOBSERVE_OTLP_ENDPOINT` to `https://<host>/api/<organization>` without a trailing slash. Set `OPENOBSERVE_AUTHORIZATION` through the collector's secret configuration to the ingestion authorization header provided by your OpenObserve instance. See [OpenObserve's OTLP configuration](https://openobserve.ai/docs/ingestion/logs/otlp/).

## Quota metrics

The server samples once a minute, independently of dashboard visits. All gauges carry `provider` and `window_minutes` labels, such as `claude` and `300`. Reset timestamps and conversation identifiers are not labels. The service resource name is `turnstash-server`.

| Metric                                        | Value                                                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `turnstash_quota_remaining_percent`           | Last observed quota remaining, from 0 to 100.                                                                                           |
| `turnstash_quota_projected_remaining_percent` | Estimated remaining quota at reset, using the last hour's pace. Use only when `forecast_available` is 1.                                |
| `turnstash_quota_forecast_available`          | 1 when a fresh window has more than 15 minutes of observations; otherwise 0.                                                            |
| `turnstash_quota_resets_at_seconds`           | Reset time as Unix seconds.                                                                                                             |
| `turnstash_quota_observed_at_seconds`         | Latest quota observation time as Unix seconds.                                                                                          |
| `turnstash_quota_fresh`                       | 1 for an unexpired window with an observation no older than 30 minutes; otherwise 0.                                                    |
| `turnstash_quota_low`                         | 1 at 10% remaining or less, or projected exhaustion within an hour before reset. Requires fresh data.                                   |
| `turnstash_quota_unused`                      | 1 when at least 20% is projected to expire within an hour. Requires fresh data and usable quota in every open window for that provider. |
| `turnstash_quota_sampled_at_seconds`          | Time of the last successful database sample as Unix seconds.                                                                            |

`low` and `unused` share the browser's evaluation rules. Removed or expired windows clear their gauges to zero, except for the sample timestamp. Missing providers do not invent a 100% quota reading. Stale readings set the alert states to zero.

A failed sampling pass leaves its last sample timestamp unchanged. The exporter may continue publishing the previous gauge values, so alert queries must check the sample timestamp rather than relying only on ingestion time.

## Create OpenObserve alerts

Create scheduled metrics alerts using PromQL. Evaluate every minute, use a short lookback such as three minutes, and choose your existing notification destination. Start with a 30-minute cooldown and preview the query before enabling the rule. OpenObserve controls repeat notifications; browser notification receipts do not suppress them. See the [alert query modes and destinations](https://openobserve.ai/docs/user-guide/analytics/alerts/).

For low quota, trigger when this query returns a matching series:

```promql
(turnstash_quota_low == 1)
and (time() - turnstash_quota_sampled_at_seconds < 180)
```

For quota expiring unused:

```promql
(turnstash_quota_unused == 1)
and (time() - turnstash_quota_sampled_at_seconds < 180)
```

The comparisons filter out healthy or stale series. Configure the rule to alert on a returned value greater than zero. If several Turnstash deployments share one OpenObserve organization, add your deployment's resource-label selector to both metrics in each query.

For a custom threshold, such as less than 25% remaining in Claude's 5-hour window:

```promql
(turnstash_quota_remaining_percent{provider="claude",window_minutes="300"} < 25)
and (turnstash_quota_fresh == 1)
and (time() - turnstash_quota_sampled_at_seconds < 180)
```

For this custom query, trigger on the presence of a series, including a zero value, or wrap the whole expression in `count(...) > 0`. Zero remaining is an exhausted quota, not a healthy result.

## Verify the connection

After deployment, find `turnstash_quota_sampled_at_seconds` in OpenObserve. It should advance about once a minute. Then inspect `remaining_percent`, `resets_at_seconds` and `observed_at_seconds` for the provider and window you expect. No series appear until Turnstash has collected quota readings.

The alert preview should match the Limits page when its burn mode is the last hour. A quota that reset without a new reading should have `fresh`, `low` and `unused` set to zero. Closing the dashboard does not stop these server metrics.

These instructions prepare the integration. They do not install alert rules or change an existing OpenObserve deployment.

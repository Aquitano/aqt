@file:OptIn(ExperimentalKtorApi::class)

package me.aquitano.health.api

import io.ktor.openapi.*
import io.ktor.utils.io.*
import me.aquitano.external.withings.WITHINGS_PROVIDER_CODE
import me.aquitano.health.domain.RecordTypes

internal fun Operation.Builder.providerCodePath() {
    parameters {
        path("providerCode") {
            description =
                "Provider code. Current examples are `google-health` and `withings`."
            schema = stringSchema(
                enumValues = listOf(
                    "google-health",
                    WITHINGS_PROVIDER_CODE
                ), example = WITHINGS_PROVIDER_CODE
            )
        }
    }
}

internal fun Operation.Builder.idempotencyKeyHeader() {
    parameters {
        header("Idempotency-Key") {
            description =
                "Optional client-generated key that makes the request idempotent. Repeating a request with the same key returns the result of the first request instead of performing the work again."
            schema = stringSchema(example = "9b2f4a1e-manual-sync-2026-07-07")
        }
    }
}

internal fun Operation.Builder.readQueryParameters(
    includeLatest: Boolean = false,
    sortValues: List<String>,
    defaultSort: String,
    sortExample: String = defaultSort,
) {
    parameters {
        query("from") {
            description =
                "Inclusive start timestamp or date. Date-only values are interpreted by the endpoint's query service."
            schema = stringSchema(
                format = JsonFormatDateTime,
                example = ExampleFromAt
            )
        }
        query("to") {
            description =
                "Exclusive end timestamp or date. Date-only values are interpreted by the endpoint's query service."
            schema =
                stringSchema(format = JsonFormatDateTime, example = ExampleToAt)
        }
        query("provider") {
            description = "Source provider filter."
            schema = stringSchema(example = WITHINGS_PROVIDER_CODE)
        }
        query("providerInstanceId") {
            description = "Source provider account or instance filter."
            schema = stringSchema(example = ExampleProviderInstanceId)
        }
        query("includeSource") {
            description =
                "Include source provider metadata in each item. Defaults to false."
            schema = booleanSchema(default = false, example = false)
        }
        if (includeLatest) {
            query("latest") {
                description =
                    "Return the latest matching item when true. Defaults to false. Cannot be combined with limit, sort, or order."
                schema = booleanSchema(default = false, example = true)
            }
        }
        query("sort") {
            description =
                "Sort field for this endpoint. Each metric endpoint supports its documented default temporal or date field."
            schema = stringSchema(
                enumValues = sortValues,
                default = defaultSort,
                example = sortExample,
            )
        }
        query("order") {
            description =
                "Sort direction. Defaults to asc. Use desc for newest-first reads."
            schema = stringSchema(
                enumValues = listOf("asc", "desc"),
                default = "asc",
                example = "desc",
            )
        }
        query("limit") {
            description =
                "Maximum number of items. Defaults to 500 and cannot exceed 5000."
            schema = integerSchema(
                default = 500,
                minimum = 1.0,
                maximum = 5000.0,
                example = 100
            )
        }
        query("cursor") {
            description =
                "Opaque cursor from `meta.nextCursor` for the next page. Must be used with the same sort and order."
            schema = stringSchema(example = "eyJzIjoiMjAyNi0wNC0wMlQwODowNTowMFoiLCJpZCI6MTIzLCJvIjoiYXNjIiwiZiI6Im1lYXN1cmVkQXQifQ")
        }
    }
}

internal fun Operation.Builder.scalarMetricQueryParameters() {
    parameters {
        path("metricType") {
            description = "Scalar metric type from the metric catalog."
            schema = stringSchema(example = RecordTypes.HEART_RATE)
        }
    }
    readQueryParameters(
        includeLatest = true,
        sortValues = listOf("measuredAt"),
        defaultSort = "measuredAt",
    )
    parameters {
        query("raw") {
            description =
                "Return raw stored samples instead of canonical cross-provider samples. Defaults to false."
            schema = booleanSchema(default = false, example = false)
        }
    }
}

internal fun Operation.Builder.scalarSummaryQueryParameters() {
    parameters {
        path("metricType") {
            description = "Scalar metric type from the metric catalog."
            schema = stringSchema(example = RecordTypes.HEART_RATE)
        }
        query("from") {
            description = "Inclusive start timestamp."
            schema = stringSchema(
                format = JsonFormatDateTime,
                example = ExampleFromAt
            )
        }
        query("to") {
            description = "Exclusive end timestamp."
            schema =
                stringSchema(format = JsonFormatDateTime, example = ExampleToAt)
        }
        query("provider") {
            description = "Source provider filter."
            schema = stringSchema(example = WITHINGS_PROVIDER_CODE)
        }
        query("providerInstanceId") {
            description = "Source provider account or instance filter."
            schema = stringSchema(example = ExampleProviderInstanceId)
        }
        query("includeSource") {
            description =
                "Include source provider metadata in the nested latest item. Defaults to false."
            schema = booleanSchema(default = false, example = false)
        }
    }
}

internal fun Operation.Builder.dailyStepQueryParameters() {
    dailyReadQueryParameters()
    dateRangeQueryParameters("UTC date")
}
private fun Operation.Builder.dailyReadQueryParameters(includeListControls: Boolean = true) {
    parameters {
        query("provider") {
            description = "Source provider filter."
            schema = stringSchema(example = WITHINGS_PROVIDER_CODE)
        }
        query("providerInstanceId") {
            description = "Source provider account or instance filter."
            schema = stringSchema(example = ExampleProviderInstanceId)
        }
        query("includeSource") {
            description =
                "Include source provider metadata in each item. Defaults to false."
            schema = booleanSchema(default = false, example = false)
        }
        if (includeListControls) {
            query("sort") {
                description = "Sort field. Daily endpoints support date."
                schema = stringSchema(
                    enumValues = listOf("date"),
                    default = "date",
                    example = "date",
                )
            }
            query("order") {
                description =
                    "Sort direction. Defaults to asc. Use desc for newest-first reads."
                schema = stringSchema(
                    enumValues = listOf("asc", "desc"),
                    default = "asc",
                    example = "desc",
                )
            }
            query("limit") {
                description =
                    "Maximum number of items. Defaults to 500 and cannot exceed 5000."
                schema = integerSchema(
                    default = 500,
                    minimum = 1.0,
                    maximum = 5000.0,
                    example = 100
                )
            }
            query("cursor") {
                description =
                    "Opaque cursor from `meta.nextCursor` for the next page. Must be used with the same sort and order."
                schema = stringSchema(example = "eyJzIjoiMjAyNi0wNC0wMiIsImlkIjoxMjMsIm8iOiJhc2MiLCJmIjoiZGF0ZSJ9")
            }
        }
    }
}
internal fun Operation.Builder.sleepNightQueryParameters() {
    parameters {
        query("date") {
            description =
                "Exact sleep night date or `today`. Matches the localized date of session endAt and cannot be combined with fromDate or toDate."
            schema =
                stringSchema(format = JsonFormatDate, example = ExampleDate)
        }
        query("fromDate") {
            description =
                "Inclusive local sleep-night start date based on session endAt."
            schema =
                stringSchema(format = JsonFormatDate, example = ExampleFromDate)
        }
        query("toDate") {
            description =
                "Inclusive local sleep-night end date based on session endAt."
            schema =
                stringSchema(format = JsonFormatDate, example = ExampleToDate)
        }
        query("timezone") {
            description =
                "IANA timezone used to classify endAt dates. Defaults to UTC."
            schema = stringSchema(example = "Europe/Berlin")
        }
        query("provider") {
            description = "Source provider filter."
            schema = stringSchema(example = WITHINGS_PROVIDER_CODE)
        }
        query("providerInstanceId") {
            description = "Source provider account or instance filter."
            schema = stringSchema(example = ExampleProviderInstanceId)
        }
        query("includeSource") {
            description =
                "Include source provider metadata in each item. Defaults to false."
            schema = booleanSchema(default = false, example = false)
        }
        query("limit") {
            description =
                "Maximum number of items. Defaults to 500, cannot exceed 5000, and is ignored as 1 when date is provided."
            schema = integerSchema(
                default = 500,
                minimum = 1.0,
                maximum = 5000.0,
                example = 7
            )
        }
        query("sort") {
            description = "Sort field. Sleep night reads support `date`."
            schema = stringSchema(
                enumValues = listOf("date"),
                default = "date",
                example = "date",
            )
        }
        query("order") {
            description =
                "Sort direction. Defaults to asc. Use desc for most recent sleep nights first."
            schema = stringSchema(
                enumValues = listOf("asc", "desc"),
                default = "asc",
                example = "desc",
            )
        }
        query("cursor") {
            description =
                "Opaque cursor from `meta.nextCursor` for the next page. Must be used with the same sort and order."
            schema = stringSchema(example = "eyJzIjoiMjAyNi0wNC0wMiIsImlkIjoxMjMsIm8iOiJhc2MiLCJmIjoiZGF0ZSJ9")
        }
    }
}
internal fun Operation.Builder.dashboardQueryParameters() {
    parameters {
        query("fromDate") {
            description = "Inclusive UTC start date for dashboard summaries."
            required = true
            schema =
                stringSchema(format = JsonFormatDate, example = ExampleFromDate)
        }
        query("toDate") {
            description = "Inclusive UTC end date for dashboard summaries."
            required = true
            schema =
                stringSchema(format = JsonFormatDate, example = ExampleToDate)
        }
        query("provider") {
            description =
                "Source provider filter applied to summary metric lookups."
            schema = stringSchema(example = WITHINGS_PROVIDER_CODE)
        }
        query("providerInstanceId") {
            description =
                "Source provider account or instance filter applied to summary metric lookups."
            schema = stringSchema(example = ExampleProviderInstanceId)
        }
        query("includeSource") {
            description =
                "Include source provider metadata for nested latest items. Defaults to false."
            schema = booleanSchema(default = false, example = false)
        }
    }
}

internal fun Operation.Builder.healthDayQueryParameters() {
    parameters {
        query("date") {
            description = "Required local date in YYYY-MM-DD format or `today`."
            required = true
            schema = stringSchema(format = JsonFormatDate, example = ExampleDate)
        }
        query("timezone") {
            description = "IANA timezone used to convert the local day into UTC boundaries. Defaults to UTC."
            schema = stringSchema(default = "UTC", example = "Europe/Berlin")
        }
        query("modules") {
            description = "Required comma-separated module list. Supported values: steps, heartRate, weight, sleep."
            required = true
            schema = stringSchema(example = "steps,heartRate,weight,sleep")
        }
        query("provider") {
            description = "Source provider filter."
            schema = stringSchema(example = WITHINGS_PROVIDER_CODE)
        }
        query("providerInstanceId") {
            description = "Source provider account or instance filter."
            schema = stringSchema(example = ExampleProviderInstanceId)
        }
        query("includeSource") {
            description = "Include source provider metadata on point-level objects where available. Defaults to false."
            schema = booleanSchema(default = false, example = false)
        }
    }
}

internal fun Operation.Builder.adminQueryParameters() {
    parameters {
        query("status") {
            description = "Batch status filter."
            schema = stringSchema(
                enumValues = listOf(
                    "received",
                    "processed",
                    "failed",
                ), example = "failed"
            )
        }
        query("from") {
            description = "Inclusive received-at start timestamp."
            schema = stringSchema(
                format = JsonFormatDateTime,
                example = ExampleFromAt
            )
        }
        query("to") {
            description = "Exclusive received-at end timestamp."
            schema =
                stringSchema(format = JsonFormatDateTime, example = ExampleToAt)
        }
        query("limit") {
            description =
                "Maximum number of items. Defaults to 100 and cannot exceed 1000 for admin list endpoints."
            schema = integerSchema(
                default = 100,
                minimum = 1.0,
                maximum = 1000.0,
                example = 50
            )
        }
        query("cursor") {
            description =
                "Opaque cursor from `meta.nextCursor` for the next page. Admin batch lists are sorted by receivedAt desc."
            schema = stringSchema(example = "eyJzIjoiMjAyNi0wNC0wMlQwODoxNTozMFoiLCJpZCI6MTIzLCJvIjoiZGVzYyIsImYiOiJyZWNlaXZlZEF0In0")
        }
    }
}

private fun Operation.Builder.dateRangeQueryParameters(label: String) {
    parameters {
        query("date") {
            description =
                "Exact $label or `today`. Cannot be combined with fromDate or toDate."
            schema =
                stringSchema(format = JsonFormatDate, example = ExampleDate)
        }
        query("fromDate") {
            description = "Inclusive $label start date."
            schema =
                stringSchema(format = JsonFormatDate, example = ExampleFromDate)
        }
        query("toDate") {
            description = "Inclusive $label end date."
            schema =
                stringSchema(format = JsonFormatDate, example = ExampleToDate)
        }
    }
}

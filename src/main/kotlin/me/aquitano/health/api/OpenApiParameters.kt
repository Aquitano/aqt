@file:OptIn(ExperimentalKtorApi::class)

package me.aquitano.health.api

import io.ktor.openapi.*
import io.ktor.utils.io.*
import me.aquitano.external.withings.WITHINGS_PROVIDER_CODE
import me.aquitano.health.domain.BatchStatus
import me.aquitano.health.api.dto.HealthDayModuleName
import me.aquitano.health.application.metric.common.EnumParamSpec
import me.aquitano.health.application.metric.common.LimitParamSpec
import me.aquitano.health.application.metric.common.QueryParamSpecs
import me.aquitano.health.domain.RecordTypes

private const val ReadCursorExample =
    "eyJzIjoiMjAyNi0wNC0wMlQwODowNTowMFoiLCJpZCI6MTIzLCJvIjoiYXNjIiwiZiI6Im1lYXN1cmVkQXQifQ"
private const val DateCursorExample =
    "eyJzIjoiMjAyNi0wNC0wMiIsImlkIjoxMjMsIm8iOiJhc2MiLCJmIjoiZGF0ZSJ9"
private const val AdminCursorExample =
    "eyJzIjoiMjAyNi0wNC0wMlQwODoxNTozMFoiLCJpZCI6MTIzLCJvIjoiZGVzYyIsImYiOiJyZWNlaXZlZEF0In0"
private const val CursorDescription =
    "Opaque cursor from `meta.nextCursor` for the next page. Must be used with the same sort and order."

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
    sortSpec: EnumParamSpec,
    sortExample: String = sortSpec.default,
) {
    instantRangeParameters(
        fromDescription =
            "Inclusive start timestamp or date. Date-only values are interpreted by the endpoint's query service.",
        toDescription =
            "Exclusive end timestamp or date. Date-only values are interpreted by the endpoint's query service.",
    )
    providerFilterParameters()
    if (includeLatest) {
        latestParameter(
            "Return the latest matching item when true. Defaults to false. Cannot be combined with limit, sort, or order."
        )
    }
    sortParameter(
        spec = sortSpec,
        description =
            "Sort field for this endpoint. Each metric endpoint supports its documented default temporal or date field.",
        example = sortExample,
    )
    orderParameter("Sort direction. Defaults to ${QueryParamSpecs.order.default}. Use desc for newest-first reads.")
    limitParameter(
        spec = QueryParamSpecs.readLimit,
        description = defaultLimitDescription(QueryParamSpecs.readLimit),
        example = 100,
    )
    cursorParameter(CursorDescription, example = ReadCursorExample)
}

internal fun Operation.Builder.scalarMetricQueryParameters() {
    metricTypePathParameter()
    readQueryParameters(
        includeLatest = true,
        sortSpec = QueryParamSpecs.sortByMeasuredAt,
    )
    parameters {
        query(QueryParamSpecs.raw.name) {
            description =
                "Return raw stored samples instead of canonical cross-provider samples. Defaults to false."
            schema = booleanSchema(default = QueryParamSpecs.raw.default, example = false)
        }
    }
}

internal fun Operation.Builder.scalarSummaryQueryParameters() {
    metricTypePathParameter()
    instantRangeParameters(
        fromDescription = "Inclusive start timestamp.",
        toDescription = "Exclusive end timestamp.",
    )
    providerFilterParameters(
        includeSourceDescription =
            "Include source provider metadata in the nested latest item. Defaults to false.",
    )
}

internal fun Operation.Builder.dailyStepQueryParameters() {
    dailyReadQueryParameters()
    dateRangeQueryParameters("UTC date")
}

private fun Operation.Builder.dailyReadQueryParameters(includeListControls: Boolean = true) {
    providerFilterParameters()
    if (includeListControls) {
        sortParameter(
            spec = QueryParamSpecs.sortByDate,
            description = "Sort field. Daily endpoints support date.",
        )
        orderParameter("Sort direction. Defaults to ${QueryParamSpecs.order.default}. Use desc for newest-first reads.")
        limitParameter(
            spec = QueryParamSpecs.readLimit,
            description = defaultLimitDescription(QueryParamSpecs.readLimit),
            example = 100,
        )
        cursorParameter(CursorDescription, example = DateCursorExample)
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
    }
    timezoneParameter("IANA timezone used to classify endAt dates. Defaults to UTC.")
    providerFilterParameters()
    limitParameter(
        spec = QueryParamSpecs.readLimit,
        description =
            "Maximum number of items. Defaults to ${QueryParamSpecs.readLimit.default}, cannot exceed " +
                "${QueryParamSpecs.readLimit.max}, and is ignored as 1 when date is provided.",
        example = 7,
    )
    sortParameter(
        spec = QueryParamSpecs.sortByDate,
        description = "Sort field. Sleep night reads support `date`.",
    )
    orderParameter(
        "Sort direction. Defaults to ${QueryParamSpecs.order.default}. Use desc for most recent sleep nights first."
    )
    cursorParameter(CursorDescription, example = DateCursorExample)
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
    }
    providerFilterParameters(
        providerDescription =
            "Source provider filter applied to summary metric lookups.",
        providerInstanceDescription =
            "Source provider account or instance filter applied to summary metric lookups.",
        includeSourceDescription =
            "Include source provider metadata for nested latest items. Defaults to false.",
    )
}

internal fun Operation.Builder.healthDayQueryParameters() {
    parameters {
        query("date") {
            description = "Required local date in YYYY-MM-DD format or `today`."
            required = true
            schema = stringSchema(format = JsonFormatDate, example = ExampleDate)
        }
    }
    timezoneParameter(
        description = "IANA timezone used to convert the local day into UTC boundaries. Defaults to UTC.",
        default = "UTC",
    )
    parameters {
        query("modules") {
            val moduleNames = HealthDayModuleName.entries.map { it.wireName }
            description =
                "Required comma-separated module list. Supported values: ${moduleNames.joinToString(", ")}."
            required = true
            schema = stringSchema(example = moduleNames.joinToString(","))
        }
    }
    providerFilterParameters(
        includeSourceDescription =
            "Include source provider metadata on point-level objects where available. Defaults to false.",
    )
}

internal fun Operation.Builder.adminQueryParameters() {
    parameters {
        query("status") {
            description = "Batch status filter."
            schema = stringSchema(
                enumValues = BatchStatus.entries.map { it.stored },
                example = BatchStatus.Failed.stored,
            )
        }
    }
    instantRangeParameters(
        fromDescription = "Inclusive received-at start timestamp.",
        toDescription = "Exclusive received-at end timestamp.",
    )
    limitParameter(
        spec = QueryParamSpecs.adminLimit,
        description =
            "Maximum number of items. Defaults to ${QueryParamSpecs.adminLimit.default} and cannot exceed " +
                "${QueryParamSpecs.adminLimit.max} for admin list endpoints.",
        example = 50,
    )
    cursorParameter(
        "Opaque cursor from `meta.nextCursor` for the next page. Admin batch lists are sorted by receivedAt desc.",
        example = AdminCursorExample,
    )
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

private fun Operation.Builder.metricTypePathParameter() {
    parameters {
        path("metricType") {
            description = "Scalar metric type from the metric catalog."
            schema = stringSchema(example = RecordTypes.HEART_RATE)
        }
    }
}

private fun Operation.Builder.instantRangeParameters(
    fromDescription: String,
    toDescription: String,
) {
    parameters {
        query("from") {
            description = fromDescription
            schema = stringSchema(
                format = JsonFormatDateTime,
                example = ExampleFromAt
            )
        }
        query("to") {
            description = toDescription
            schema =
                stringSchema(format = JsonFormatDateTime, example = ExampleToAt)
        }
    }
}

private fun Operation.Builder.providerFilterParameters(
    providerDescription: String = "Source provider filter.",
    providerInstanceDescription: String = "Source provider account or instance filter.",
    includeSourceDescription: String =
        "Include source provider metadata in each item. Defaults to false.",
) {
    parameters {
        query("provider") {
            description = providerDescription
            schema = stringSchema(example = WITHINGS_PROVIDER_CODE)
        }
        query("providerInstanceId") {
            description = providerInstanceDescription
            schema = stringSchema(example = ExampleProviderInstanceId)
        }
        query(QueryParamSpecs.includeSource.name) {
            description = includeSourceDescription
            schema = booleanSchema(
                default = QueryParamSpecs.includeSource.default,
                example = false
            )
        }
    }
}

private fun Operation.Builder.latestParameter(latestDescription: String) {
    parameters {
        query(QueryParamSpecs.latest.name) {
            description = latestDescription
            schema = booleanSchema(default = QueryParamSpecs.latest.default, example = true)
        }
    }
}

private fun Operation.Builder.sortParameter(
    spec: EnumParamSpec,
    description: String,
    example: String = spec.default,
) {
    val sortDescription = description
    parameters {
        query(spec.name) {
            this.description = sortDescription
            schema = stringSchema(
                enumValues = spec.values,
                default = spec.default,
                example = example,
            )
        }
    }
}

private fun Operation.Builder.orderParameter(orderDescription: String) {
    parameters {
        query(QueryParamSpecs.order.name) {
            description = orderDescription
            schema = stringSchema(
                enumValues = QueryParamSpecs.order.values,
                default = QueryParamSpecs.order.default,
                example = "desc",
            )
        }
    }
}

private fun Operation.Builder.limitParameter(
    spec: LimitParamSpec,
    description: String,
    example: Int,
) {
    val limitDescription = description
    parameters {
        query(spec.name) {
            this.description = limitDescription
            schema = integerSchema(
                default = spec.default,
                minimum = spec.min.toDouble(),
                maximum = spec.max.toDouble(),
                example = example,
            )
        }
    }
}

private fun Operation.Builder.cursorParameter(
    cursorDescription: String,
    example: String,
) {
    parameters {
        query("cursor") {
            description = cursorDescription
            schema = stringSchema(example = example)
        }
    }
}

private fun Operation.Builder.timezoneParameter(
    description: String,
    default: String? = null,
) {
    val timezoneDescription = description
    parameters {
        query("timezone") {
            this.description = timezoneDescription
            schema = stringSchema(default = default, example = "Europe/Berlin")
        }
    }
}

private fun defaultLimitDescription(spec: LimitParamSpec): String =
    "Maximum number of items. Defaults to ${spec.default} and cannot exceed ${spec.max}."

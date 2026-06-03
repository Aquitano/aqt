package me.aquitano.health.application.metric.common

import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import me.aquitano.health.application.metric.common.repository.DailyReadFilters
import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.repository.SleepNightReadFilters
import java.time.Instant
import java.time.LocalDate

internal fun QueryParams.readFilters(
    defaultSort: String,
    allowedSorts: Set<String>,
    latestSupported: Boolean,
): ReadFilters {
    val latest = boolean("latest", default = false)
    if (latest && !latestSupported) {
        throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = "latest",
                    code = ValidationIssueCodes.UnsupportedValue,
                    message = "latest is not supported for this endpoint",
                )
            )
        )
    }
    if (latest) {
        validateLatestOverrides()
    }
    val from = instant("from")
    val to = instant("to")
    validateRange(from, to, "from", "to")
    return ReadFilters(
        from = from,
        to = to,
        provider = optional("provider"),
        providerInstanceId = optional("providerInstanceId"),
        includeSource = boolean("includeSource", default = false),
        limit = if (latest) 1 else limit(default = 500, max = 5000),
        sort = if (latest) defaultSort else sort(allowedSorts, defaultSort),
        order = if (latest) Orders.DESC else order(),
    )
}

internal fun QueryParams.summaryFilters(defaultSort: String): ReadFilters {
    val from = instant("from")
    val to = instant("to")
    validateRange(from, to, "from", "to")
    return ReadFilters(
        from = from,
        to = to,
        provider = optional("provider"),
        providerInstanceId = optional("providerInstanceId"),
        includeSource = boolean("includeSource", default = false),
        limit = 1,
        sort = defaultSort,
        order = Orders.DESC,
    )
}

internal fun QueryParams.dailyReadFilters(now: Instant): DailyReadFilters {
    val (fromDate, toDate) = dailyDateRange(now)
    return DailyReadFilters(
        fromDate = fromDate,
        toDate = toDate,
        provider = optional("provider"),
        providerInstanceId = optional("providerInstanceId"),
        includeSource = boolean("includeSource", default = false),
        limit = if (optional("date") != null) 1 else limit(
            default = 500,
            max = 5000,
        ),
        sort = sort(setOf(SortFields.DATE), SortFields.DATE),
        order = order(),
    )
}

internal fun QueryParams.dailyLatestReadFilters(now: Instant): DailyReadFilters {
    rejectLatestEndpointOverrides()
    val (fromDate, toDate) = dailyDateRange(now)
    return DailyReadFilters(
        fromDate = fromDate,
        toDate = toDate,
        provider = optional("provider"),
        providerInstanceId = optional("providerInstanceId"),
        includeSource = boolean("includeSource", default = false),
        limit = 1,
        sort = SortFields.DATE,
        order = Orders.DESC,
    )
}

internal fun QueryParams.sleepNightReadFilters(now: Instant): SleepNightReadFilters {
    val timezone = timezone()
    val exactDate = dateOrToday("date", now, timezone)
    if (exactDate != null && (optional("fromDate") != null || optional("toDate") != null)) {
        throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = "date",
                    code = ValidationIssueCodes.InvalidState,
                    message = "cannot be combined with fromDate or toDate",
                )
            )
        )
    }
    val fromDate = exactDate ?: date("fromDate")
    val toDate = exactDate ?: date("toDate")
    validateDateRange(fromDate, toDate)
    return SleepNightReadFilters(
        fromDate = fromDate,
        toDate = toDate,
        timezone = timezone,
        provider = optional("provider"),
        providerInstanceId = optional("providerInstanceId"),
        includeSource = boolean("includeSource", default = false),
        limit = if (exactDate != null) 1 else limit(
            default = 500,
            max = 5000,
        ),
        sort = sort(setOf(SortFields.DATE), SortFields.DATE),
        order = order(),
    )
}

private fun QueryParams.dailyDateRange(now: Instant): Pair<LocalDate?, LocalDate?> {
    val exactDate = dateOrToday("date", now)
    if (exactDate != null && (optional("fromDate") != null || optional("toDate") != null)) {
        throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = "date",
                    code = ValidationIssueCodes.InvalidState,
                    message = "cannot be combined with fromDate or toDate",
                )
            )
        )
    }
    val fromDate = exactDate ?: date("fromDate")
    val toDate = exactDate ?: date("toDate")
    validateDateRange(fromDate, toDate)
    return fromDate to toDate
}

internal fun validateRange(
    from: Instant?,
    to: Instant?,
    fromField: String,
    toField: String,
) {
    if (from != null && to != null && !from.isBefore(to)) {
        throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = fromField,
                    code = ValidationIssueCodes.InvalidRange,
                    message = "must be before $toField",
                )
            )
        )
    }
}

internal fun validateDateRange(
    fromDate: LocalDate?,
    toDate: LocalDate?,
) {
    if (fromDate != null && toDate != null && fromDate.isAfter(toDate)) {
        throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = "fromDate",
                    code = ValidationIssueCodes.InvalidRange,
                    message = "must be on or before toDate",
                )
            )
        )
    }
}

internal object SortFields {
    const val START_AT = "startAt"
    const val END_AT = "endAt"
    const val DATE = "date"
    const val MEASURED_AT = "measuredAt"
}

internal object Orders {
    const val ASC = "asc"
    const val DESC = "desc"
}


package me.aquitano.health.application.metric.common

import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import me.aquitano.health.shared.Cursor
import me.aquitano.health.shared.utcDate
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

class QueryParams(
    private val values: Map<String, String?>,
) {
    fun optional(name: String): String? =
        values[name]?.takeIf { it.isNotBlank() }

    fun required(name: String): String =
        optional(name) ?: throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = name,
                    code = ValidationIssueCodes.Required,
                    message = "is required",
                )
            )
        )

    fun instant(name: String): Instant? {
        val value = optional(name) ?: return null
        return runCatching { Instant.parse(value) }.getOrElse {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = name,
                        code = ValidationIssueCodes.InvalidFormat,
                        message = "must be an ISO-8601 instant",
                    )
                )
            )
        }
    }

    fun date(name: String): LocalDate? {
        val value = optional(name) ?: return null
        return runCatching { LocalDate.parse(value) }.getOrElse {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = name,
                        code = ValidationIssueCodes.InvalidFormat,
                        message = "must be an ISO-8601 date",
                    )
                )
            )
        }
    }

    fun dateOrToday(name: String, now: Instant): LocalDate? {
        val value = optional(name) ?: return null
        if (value == "today") return now.utcDate()
        return runCatching { LocalDate.parse(value) }.getOrElse {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = name,
                        code = ValidationIssueCodes.InvalidFormat,
                        message = "must be an ISO-8601 date or today",
                    )
                )
            )
        }
    }

    fun dateOrToday(name: String, now: Instant, timezone: ZoneId): LocalDate? {
        val value = optional(name) ?: return null
        if (value == "today") return now.atZone(timezone).toLocalDate()
        return runCatching { LocalDate.parse(value) }.getOrElse {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = name,
                        code = ValidationIssueCodes.InvalidFormat,
                        message = "must be an ISO-8601 date or today",
                    )
                )
            )
        }
    }

    fun timezone(name: String = "timezone"): ZoneId {
        val value = optional(name) ?: return ZoneOffset.UTC
        return runCatching { ZoneId.of(value) }.getOrElse {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = name,
                        code = ValidationIssueCodes.InvalidFormat,
                        message = "must be an IANA timezone",
                    )
                )
            )
        }
    }

    fun requiredDate(name: String): LocalDate =
        date(name) ?: throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = name,
                    code = ValidationIssueCodes.Required,
                    message = "is required",
                )
            )
        )

    internal fun boolean(spec: BooleanParamSpec): Boolean =
        boolean(spec.name, spec.default)

    fun boolean(name: String, default: Boolean): Boolean {
        val value = optional(name) ?: return default
        return when (value.lowercase()) {
            "true" -> true
            "false" -> false
            else -> throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = name,
                        code = ValidationIssueCodes.InvalidFormat,
                        message = "must be true or false",
                    )
                )
            )
        }
    }

    internal fun limit(spec: LimitParamSpec): Int {
        val value = optional(spec.name) ?: return spec.default
        val parsed = value.toIntOrNull()
            ?: throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = spec.name,
                        code = ValidationIssueCodes.InvalidFormat,
                        message = "must be an integer",
                    )
                )
            )
        if (parsed !in spec.min..spec.max) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = spec.name,
                        code = ValidationIssueCodes.OutOfRange,
                        message = "must be between ${spec.min} and ${spec.max}",
                    )
                )
            )
        }
        return parsed
    }

    fun order(default: String = Orders.ASC): String {
        val value = optional("order") ?: return default
        val normalized = value.lowercase()
        if (normalized != Orders.ASC && normalized != Orders.DESC) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "order",
                        code = ValidationIssueCodes.UnsupportedValue,
                        message = "must be asc or desc",
                    )
                )
            )
        }
        return normalized
    }

    internal fun sort(spec: EnumParamSpec): String =
        sort(spec.allowed, spec.default)

    fun sort(allowedValues: Set<String>, default: String): String {
        val value = optional("sort") ?: return default
        if (value !in allowedValues) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "sort",
                        code = ValidationIssueCodes.UnsupportedValue,
                        message = "must be one of ${allowedValues.sorted().joinToString(", ")}",
                    )
                )
            )
        }
        return value
    }

    /** Decodes the cursor parameter, rejecting cursors issued under a different sort/order. */
    fun cursor(sort: String, order: String): Cursor? =
        optional("cursor")?.let { Cursor.decode(it, expectedField = sort, expectedOrder = order) }

    fun rejectLatest() {
        if (boolean("latest", default = false)) {
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
    }

    fun validateLatestOverrides() {
        val invalidFields = listOf("limit", "sort", "order", "cursor")
            .filter { optional(it) != null }
        if (invalidFields.isNotEmpty()) {
            throw RequestValidationException(
                invalidFields.map {
                    ValidationIssue(
                        field = it,
                        code = ValidationIssueCodes.InvalidState,
                        message = "cannot be combined with latest=true",
                    )
                }
            )
        }
    }

    fun rejectLatestEndpointOverrides() {
        val invalidFields = listOf("limit", "sort", "order", "cursor")
            .filter { optional(it) != null }
        if (invalidFields.isNotEmpty()) {
            throw RequestValidationException(
                invalidFields.map {
                    ValidationIssue(
                        field = it,
                        code = ValidationIssueCodes.InvalidState,
                        message = "is not supported for latest endpoints",
                    )
                }
            )
        }
    }
}


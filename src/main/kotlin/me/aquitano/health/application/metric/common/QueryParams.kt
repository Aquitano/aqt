package me.aquitano.health.application.metric.common

import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
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

    fun limit(default: Int, max: Int): Int {
        val value = optional("limit") ?: return default
        val parsed = value.toIntOrNull()
            ?: throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "limit",
                        code = ValidationIssueCodes.InvalidFormat,
                        message = "must be an integer",
                    )
                )
            )
        if (parsed !in 1..max) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "limit",
                        code = ValidationIssueCodes.OutOfRange,
                        message = "must be between 1 and $max",
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
        val invalidFields = listOf("limit", "sort", "order")
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
        val invalidFields = listOf("limit", "sort", "order")
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


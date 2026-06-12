package me.aquitano.health.application

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import me.aquitano.health.api.dto.IngestionRecordDto
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import me.aquitano.health.shared.AppJson
import java.time.Instant
import java.time.LocalDate
import java.util.Locale

/**
 * Field-level validation helpers shared by the ingestion batch validator and the
 * per-record mappers. Each helper records issues on the shared list and returns
 * null (or nothing) for invalid input so the caller can keep collecting issues.
 */

internal fun IngestionRecordDto.toNormalizedJsonObject(): JsonObject =
    AppJson.encodeToJsonElement(IngestionRecordDto.serializer(), this).jsonObject

internal fun normalizeProvider(
    value: String?,
    issues: MutableList<ValidationIssue>
): String? {
    val normalized = requiredNonBlank(value, "provider", issues)
        ?.lowercase(Locale.US)
        ?.replace('-', '_')
    if (normalized != null && !normalized.matches(Regex("[a-z0-9_]+"))) {
        issues.add(
            ValidationIssue(
                field = "provider",
                code = ValidationIssueCodes.InvalidFormat,
                message = "must contain only lowercase letters, numbers, or underscores",
            )
        )
    }
    return normalized
}

internal fun requiredNonBlank(
    value: String?,
    field: String,
    issues: MutableList<ValidationIssue>
): String? {
    if (value == null) {
        issues.add(ValidationIssue(field))
        return null
    }
    if (value.isBlank()) {
        issues.add(
            ValidationIssue(
                field = field,
                code = ValidationIssueCodes.InvalidFormat,
                message = "must not be blank",
            )
        )
        return null
    }
    return value.trim()
}

internal fun optionalNonBlank(
    value: String?,
    field: String,
    issues: MutableList<ValidationIssue>
): String? {
    if (value == null) return null
    if (value.isBlank()) {
        issues.add(
            ValidationIssue(
                field = field,
                code = ValidationIssueCodes.InvalidFormat,
                message = "must not be blank when present",
            )
        )
        return null
    }
    return value.trim()
}

internal fun parseInstant(
    value: String?,
    field: String,
    issues: MutableList<ValidationIssue>
): Instant? {
    if (value == null) {
        issues.add(ValidationIssue(field))
        return null
    }
    return runCatching { Instant.parse(value) }.getOrElse {
        issues.add(
            ValidationIssue(
                field = field,
                code = ValidationIssueCodes.InvalidFormat,
                message = "must be an ISO-8601 instant",
            )
        )
        null
    }
}

internal fun parseDate(
    value: String?,
    field: String,
    issues: MutableList<ValidationIssue>
): LocalDate? {
    if (value == null) {
        issues.add(ValidationIssue(field))
        return null
    }
    return runCatching { LocalDate.parse(value) }.getOrElse {
        issues.add(
            ValidationIssue(
                field = field,
                code = ValidationIssueCodes.InvalidFormat,
                message = "must be an ISO-8601 date",
            )
        )
        null
    }
}

internal fun validateNonNegativeInt(
    value: Int?,
    field: String,
    issues: MutableList<ValidationIssue>
) {
    if (value != null && value < 0) {
        issues.add(
            ValidationIssue(
                field = field,
                code = ValidationIssueCodes.OutOfRange,
                message = "must be greater than or equal to 0",
            )
        )
    }
}

internal fun validateNonNegativeLong(
    value: Long?,
    field: String,
    issues: MutableList<ValidationIssue>
) {
    if (value != null && value < 0) {
        issues.add(
            ValidationIssue(
                field = field,
                code = ValidationIssueCodes.OutOfRange,
                message = "must be greater than or equal to 0",
            )
        )
    }
}

internal fun validateNonNegativeDouble(
    value: Double?,
    field: String,
    issues: MutableList<ValidationIssue>
) {
    if (value != null && value < 0.0) {
        issues.add(
            ValidationIssue(
                field = field,
                code = ValidationIssueCodes.OutOfRange,
                message = "must be greater than or equal to 0",
            )
        )
    }
}

internal fun validateOptionalHeartRate(
    value: Int?,
    field: String,
    issues: MutableList<ValidationIssue>
) {
    if (value != null && value !in 25..250) {
        issues.add(
            ValidationIssue(
                field = field,
                code = ValidationIssueCodes.OutOfRange,
                message = "must be between 25 and 250",
            )
        )
    }
}

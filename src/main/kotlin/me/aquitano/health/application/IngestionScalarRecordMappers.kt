package me.aquitano.health.application

import me.aquitano.health.api.dto.BodyMeasurementDto
import me.aquitano.health.api.dto.CardiovascularDto
import me.aquitano.health.api.dto.ExtendedBodyMeasurementDto
import me.aquitano.health.api.dto.HeartRateDto
import me.aquitano.health.api.dto.HrvDto
import me.aquitano.health.api.dto.RespiratoryRateDto
import me.aquitano.health.api.dto.ScalarSampleDto
import me.aquitano.health.domain.BodyMetricTypes
import me.aquitano.health.domain.BodySegments
import me.aquitano.health.domain.CardiovascularMetricTypes
import me.aquitano.health.domain.HeartRateContexts
import me.aquitano.health.domain.HrvContexts
import me.aquitano.health.domain.HrvMetricTypes
import me.aquitano.health.domain.RecordTypes
import me.aquitano.health.domain.RespiratoryRateContexts
import me.aquitano.health.domain.ScalarMetricRegistry
import me.aquitano.health.domain.ScalarMetricTypes
import me.aquitano.health.domain.ScalarSampleRecord
import me.aquitano.health.domain.ScalarValue
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes

/** Mappers for records stored as scalar samples (single timestamped values). */

internal fun mapBodyMeasurement(
    field: String,
    dto: BodyMeasurementDto,
    issues: MutableList<ValidationIssue>
): ScalarSampleRecord? {
    val measuredAt =
        parseInstant(dto.measuredAt, "$field.measuredAt", issues)
    val values = buildList {
        dto.weightKg?.let {
            if (it <= 0) issues.add(
                ValidationIssue(
                    field = "$field.weightKg",
                    code = ValidationIssueCodes.OutOfRange,
                    message = "must be greater than 0",
                )
            )
            else add(ScalarValue(BodyMetricTypes.WEIGHT, it, "kg"))
        }
        dto.bodyFatPercent?.let {
            if (it !in 0.0..100.0) issues.add(
                ValidationIssue(
                    field = "$field.bodyFatPercent",
                    code = ValidationIssueCodes.OutOfRange,
                    message = "must be between 0 and 100",
                )
            )
            else add(
                ScalarValue(
                    BodyMetricTypes.BODY_FAT,
                    it,
                    "percent"
                )
            )
        }
        dto.muscleKg?.let {
            if (it <= 0) issues.add(
                ValidationIssue(
                    field = "$field.muscleKg",
                    code = ValidationIssueCodes.OutOfRange,
                    message = "must be greater than 0",
                )
            )
            else add(ScalarValue(BodyMetricTypes.MUSCLE, it, "kg"))
        }
        dto.bodyWaterPercent?.let {
            if (it !in 0.0..100.0) issues.add(
                ValidationIssue(
                    field = "$field.bodyWaterPercent",
                    code = ValidationIssueCodes.OutOfRange,
                    message = "must be between 0 and 100",
                )
            )
            else add(
                ScalarValue(
                    BodyMetricTypes.WATER,
                    it,
                    "percent"
                )
            )
        }
        dto.visceralFatRating?.let {
            if (it <= 0) issues.add(
                ValidationIssue(
                    field = "$field.visceralFatRating",
                    code = ValidationIssueCodes.OutOfRange,
                    message = "must be greater than 0",
                )
            )
            else add(
                ScalarValue(
                    BodyMetricTypes.VISCERAL_FAT,
                    it,
                    "rating"
                )
            )
        }
    }

    if (values.isEmpty()) {
        issues.add(
            ValidationIssue(
                field = field,
                code = ValidationIssueCodes.Required,
                message = "at least one body metric value is required",
            )
        )
    }

    return if (measuredAt != null && values.isNotEmpty()) {
        ScalarSampleRecord(
            providerRecordId = dto.providerRecordId,
            normalizedRecordJson = dto.toNormalizedJsonObject(),
            recordType = RecordTypes.BODY_MEASUREMENT,
            measuredAt = measuredAt,
            values = values
        )
    } else {
        null
    }
}

internal fun mapHeartRate(
    field: String,
    dto: HeartRateDto,
    issues: MutableList<ValidationIssue>
): ScalarSampleRecord? {
    val measuredAt =
        parseInstant(dto.measuredAt, "$field.measuredAt", issues)
    val bpm = dto.bpm
    val context = dto.context ?: "unknown"

    if (bpm !in 25..250) {
        issues.add(
            ValidationIssue(
                field = "$field.bpm",
                code = ValidationIssueCodes.OutOfRange,
                message = "must be between 25 and 250",
            )
        )
    }
    if (context !in HeartRateContexts.supported) {
        issues.add(
            ValidationIssue(
                field = "$field.context",
                code = ValidationIssueCodes.UnsupportedValue,
                message = "unsupported heart-rate context",
            )
        )
    }

    return if (measuredAt != null && bpm in 25..250 && context in HeartRateContexts.supported) {
        ScalarSampleRecord(
            providerRecordId = dto.providerRecordId,
            normalizedRecordJson = dto.toNormalizedJsonObject(),
            recordType = RecordTypes.HEART_RATE,
            measuredAt = measuredAt,
            values = listOf(
                ScalarValue(
                    metricType = ScalarMetricTypes.HEART_RATE,
                    value = bpm.toDouble(),
                    unit = "bpm",
                    context = context,
                )
            )
        )
    } else {
        null
    }
}

internal fun mapRespiratoryRate(
    field: String,
    dto: RespiratoryRateDto,
    issues: MutableList<ValidationIssue>
): ScalarSampleRecord? {
    val measuredAt =
        parseInstant(dto.measuredAt, "$field.measuredAt", issues)
    val context = dto.context ?: "unknown"
    if (dto.breathsPerMinute !in 5..80) {
        issues.add(
            ValidationIssue(
                field = "$field.breathsPerMinute",
                code = ValidationIssueCodes.OutOfRange,
                message = "must be between 5 and 80",
            )
        )
    }
    if (context !in RespiratoryRateContexts.supported) {
        issues.add(
            ValidationIssue(
                field = "$field.context",
                code = ValidationIssueCodes.UnsupportedValue,
                message = "unsupported respiratory-rate context",
            )
        )
    }

    return if (measuredAt != null && dto.breathsPerMinute in 5..80 && context in RespiratoryRateContexts.supported) {
        ScalarSampleRecord(
            providerRecordId = dto.providerRecordId,
            normalizedRecordJson = dto.toNormalizedJsonObject(),
            recordType = RecordTypes.RESPIRATORY_RATE,
            measuredAt = measuredAt,
            values = listOf(
                ScalarValue(
                    metricType = ScalarMetricTypes.RESPIRATORY_RATE,
                    value = dto.breathsPerMinute.toDouble(),
                    unit = "breaths_per_minute",
                    context = context,
                )
            )
        )
    } else {
        null
    }
}

internal fun mapHrv(
    field: String,
    dto: HrvDto,
    issues: MutableList<ValidationIssue>
): ScalarSampleRecord? {
    val measuredAt =
        parseInstant(dto.measuredAt, "$field.measuredAt", issues)
    val context = dto.context ?: "unknown"
    if (dto.metricType !in HrvMetricTypes.supported) {
        issues.add(
            ValidationIssue(
                field = "$field.metricType",
                code = ValidationIssueCodes.UnsupportedValue,
                message = "unsupported hrv metric type",
            )
        )
    }
    if (dto.unit != "ms") {
        issues.add(
            ValidationIssue(
                field = "$field.unit",
                code = ValidationIssueCodes.UnsupportedValue,
                message = "must be ms",
            )
        )
    }
    if (dto.value <= 0.0 || dto.value > 500.0) {
        issues.add(
            ValidationIssue(
                field = "$field.value",
                code = ValidationIssueCodes.OutOfRange,
                message = "must be greater than 0 and less than or equal to 500",
            )
        )
    }
    if (context !in HrvContexts.supported) {
        issues.add(
            ValidationIssue(
                field = "$field.context",
                code = ValidationIssueCodes.UnsupportedValue,
                message = "unsupported hrv context",
            )
        )
    }

    return if (measuredAt != null && dto.metricType in HrvMetricTypes.supported && dto.unit == "ms" && dto.value > 0.0 && dto.value <= 500.0 && context in HrvContexts.supported) {
        ScalarSampleRecord(
            providerRecordId = dto.providerRecordId,
            normalizedRecordJson = dto.toNormalizedJsonObject(),
            recordType = RecordTypes.HRV,
            measuredAt = measuredAt,
            values = listOf(
                ScalarValue(
                    metricType = "hrv_${dto.metricType}",
                    value = dto.value,
                    unit = dto.unit,
                    context = context,
                )
            )
        )
    } else {
        null
    }
}

internal fun mapCardiovascular(
    field: String,
    dto: CardiovascularDto,
    issues: MutableList<ValidationIssue>
): ScalarSampleRecord? {
    val measuredAt =
        parseInstant(dto.measuredAt, "$field.measuredAt", issues)
    if (dto.metricType !in CardiovascularMetricTypes.supported) {
        issues.add(
            ValidationIssue(
                field = "$field.metricType",
                code = ValidationIssueCodes.UnsupportedValue,
                message = "unsupported cardiovascular metric type",
            )
        )
    }
    if (dto.value <= 0.0) {
        issues.add(
            ValidationIssue(
                field = "$field.value",
                code = ValidationIssueCodes.OutOfRange,
                message = "must be greater than 0",
            )
        )
    }
    if (dto.metricType == CardiovascularMetricTypes.PULSE_WAVE_VELOCITY && dto.unit != "m/s") {
        issues.add(ValidationIssue("$field.unit", code = ValidationIssueCodes.UnsupportedValue, message = "must be m/s"))
    }
    if (dto.metricType == CardiovascularMetricTypes.VASCULAR_AGE && dto.unit != "years") {
        issues.add(ValidationIssue("$field.unit", code = ValidationIssueCodes.UnsupportedValue, message = "must be years"))
    }
    if (dto.metricType == CardiovascularMetricTypes.STANDING_HEART_RATE && dto.unit != "bpm") {
        issues.add(ValidationIssue("$field.unit", code = ValidationIssueCodes.UnsupportedValue, message = "must be bpm"))
    }

    return if (measuredAt != null && dto.metricType in CardiovascularMetricTypes.supported && dto.value > 0.0) {
        ScalarSampleRecord(
            providerRecordId = dto.providerRecordId,
            normalizedRecordJson = dto.toNormalizedJsonObject(),
            recordType = RecordTypes.CARDIOVASCULAR,
            measuredAt = measuredAt,
            values = listOf(
                ScalarValue(
                    metricType = dto.metricType,
                    value = dto.value,
                    unit = dto.unit,
                )
            ),
        )
    } else {
        null
    }
}

internal fun mapExtendedBodyMeasurement(
    field: String,
    dto: ExtendedBodyMeasurementDto,
    issues: MutableList<ValidationIssue>
): ScalarSampleRecord? {
    val measuredAt =
        parseInstant(dto.measuredAt, "$field.measuredAt", issues)
    if (dto.metricType !in BodyMetricTypes.supported) {
        issues.add(
            ValidationIssue(
                field = "$field.metricType",
                code = ValidationIssueCodes.UnsupportedValue,
                message = "unsupported extended body metric type",
            )
        )
    }
    if (dto.segment != null && dto.segment !in BodySegments.supported) {
        issues.add(
            ValidationIssue(
                field = "$field.segment",
                code = ValidationIssueCodes.UnsupportedValue,
                message = "unsupported body segment",
            )
        )
    }
    if (dto.value <= 0.0 && dto.metricType != BodyMetricTypes.INTRACELLULAR_WATER && dto.metricType != BodyMetricTypes.EXTRACELLULAR_WATER) {
        issues.add(
            ValidationIssue(
                field = "$field.value",
                code = ValidationIssueCodes.OutOfRange,
                message = "must be greater than 0",
            )
        )
    }
    if ((dto.metricType == BodyMetricTypes.INTRACELLULAR_WATER || dto.metricType == BodyMetricTypes.EXTRACELLULAR_WATER) && dto.value < 0.0) {
        issues.add(
            ValidationIssue(
                field = "$field.value",
                code = ValidationIssueCodes.OutOfRange,
                message = "must be greater than or equal to 0",
            )
        )
    }

    return if (measuredAt != null && dto.metricType in BodyMetricTypes.supported) {
        ScalarSampleRecord(
            providerRecordId = dto.providerRecordId,
            normalizedRecordJson = dto.toNormalizedJsonObject(),
            recordType = RecordTypes.EXTENDED_BODY_MEASUREMENT,
            measuredAt = measuredAt,
            values = listOf(
                ScalarValue(
                    metricType = dto.metricType,
                    value = dto.value,
                    unit = dto.unit,
                    segment = dto.segment,
                )
            ),
        )
    } else {
        null
    }
}

internal fun mapScalar(
    field: String,
    dto: ScalarSampleDto,
    issues: MutableList<ValidationIssue>
): ScalarSampleRecord? {
    val measuredAt =
        parseInstant(dto.measuredAt, "$field.measuredAt", issues)
    val descriptor = ScalarMetricRegistry.find(dto.metricType)
    if (descriptor == null) {
        issues.add(
            ValidationIssue(
                field = "$field.metricType",
                code = ValidationIssueCodes.UnsupportedValue,
                message = "unsupported scalar metric type",
            )
        )
        return null
    }
    if (dto.unit != descriptor.unit) {
        issues.add(
            ValidationIssue(
                field = "$field.unit",
                code = ValidationIssueCodes.UnsupportedValue,
                message = "must be ${descriptor.unit}",
            )
        )
    }
    if (!descriptor.valueIsValid(dto.value)) {
        issues.add(
            ValidationIssue(
                field = "$field.value",
                code = ValidationIssueCodes.OutOfRange,
                message = "out of range for ${descriptor.metricType}",
            )
        )
    }
    val allowedContexts = descriptor.allowedContexts
    val context = dto.context ?: if (allowedContexts != null) "unknown" else null
    if (allowedContexts != null && context !in allowedContexts) {
        issues.add(
            ValidationIssue(
                field = "$field.context",
                code = ValidationIssueCodes.UnsupportedValue,
                message = "unsupported context for ${descriptor.metricType}",
            )
        )
    }
    if (allowedContexts == null && dto.context != null) {
        issues.add(
            ValidationIssue(
                field = "$field.context",
                code = ValidationIssueCodes.UnsupportedValue,
                message = "${descriptor.metricType} does not support a context",
            )
        )
    }
    if (dto.segment != null && !descriptor.supportsSegment) {
        issues.add(
            ValidationIssue(
                field = "$field.segment",
                code = ValidationIssueCodes.UnsupportedValue,
                message = "${descriptor.metricType} does not support a segment",
            )
        )
    }
    if (dto.segment != null && dto.segment !in BodySegments.supported) {
        issues.add(
            ValidationIssue(
                field = "$field.segment",
                code = ValidationIssueCodes.UnsupportedValue,
                message = "unsupported body segment",
            )
        )
    }

    val valid = measuredAt != null &&
        dto.unit == descriptor.unit &&
        descriptor.valueIsValid(dto.value) &&
        (allowedContexts == null && dto.context == null || allowedContexts != null && context in allowedContexts) &&
        (dto.segment == null || descriptor.supportsSegment && dto.segment in BodySegments.supported)
    return if (valid) {
        ScalarSampleRecord(
            providerRecordId = dto.providerRecordId,
            normalizedRecordJson = dto.toNormalizedJsonObject(),
            recordType = RecordTypes.SCALAR,
            measuredAt = measuredAt!!,
            values = listOf(
                ScalarValue(
                    metricType = descriptor.metricType,
                    value = dto.value,
                    unit = dto.unit,
                    context = context,
                    segment = dto.segment,
                )
            ),
        )
    } else {
        null
    }
}

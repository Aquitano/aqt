package me.aquitano.health.application

import kotlinx.serialization.json.JsonObject
import me.aquitano.health.api.dto.BodyMeasurement
import me.aquitano.health.api.dto.Cardiovascular
import me.aquitano.health.api.dto.ExtendedBodyMeasurement
import me.aquitano.health.api.dto.HeartRate
import me.aquitano.health.api.dto.Hrv
import me.aquitano.health.api.dto.RespiratoryRate
import me.aquitano.health.api.dto.ScalarSample
import me.aquitano.health.domain.BodyMetricTypes
import me.aquitano.health.domain.BodySegments
import me.aquitano.health.domain.RecordTypes
import me.aquitano.health.domain.ScalarMetricRegistry
import me.aquitano.health.domain.ScalarMetricTypes
import me.aquitano.health.domain.ScalarSampleRecord
import me.aquitano.health.domain.ScalarValue
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes

/**
 * Mappers for records stored as scalar samples (single timestamped values).
 *
 * The legacy per-family record types (heart_rate, hrv, body_measurement, ...) are
 * wire-compatible aliases for scalar samples: each adapter converts its DTO to the
 * equivalent [ScalarSample] and delegates validation to the [ScalarMetricRegistry]
 * descriptors, keeping the legacy record type and normalized JSON on the stored record.
 */

internal fun mapBodyMeasurement(
    field: String,
    dto: BodyMeasurement,
    issues: MutableList<ValidationIssue>
): ScalarSampleRecord? {
    val measuredAt =
        parseInstant(dto.measuredAt, "$field.measuredAt", issues)
    val values = buildList {
        fun scalar(metricType: String, value: Double?, valueField: String) {
            if (value == null) return
            val descriptor = ScalarMetricRegistry.get(metricType)
            if (descriptor.valueIsValid(value)) {
                add(ScalarValue(metricType, value, descriptor.unit))
            } else {
                issues.add(outOfRangeIssue("$field.$valueField", metricType))
            }
        }
        scalar(BodyMetricTypes.WEIGHT, dto.weightKg, "weightKg")
        scalar(BodyMetricTypes.BODY_FAT, dto.bodyFatPercent, "bodyFatPercent")
        scalar(BodyMetricTypes.MUSCLE, dto.muscleKg, "muscleKg")
        scalar(BodyMetricTypes.WATER, dto.bodyWaterPercent, "bodyWaterPercent")
        scalar(BodyMetricTypes.VISCERAL_FAT, dto.visceralFatRating, "visceralFatRating")
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
    dto: HeartRate,
    issues: MutableList<ValidationIssue>
): ScalarSampleRecord? = mapScalarViaRegistry(
    field = field,
    dto = ScalarSample(
        providerRecordId = dto.providerRecordId,
        measuredAt = dto.measuredAt,
        metricType = ScalarMetricTypes.HEART_RATE,
        value = dto.bpm.toDouble(),
        unit = ScalarMetricRegistry.get(ScalarMetricTypes.HEART_RATE).unit,
        context = dto.context,
    ),
    issues = issues,
    recordType = RecordTypes.HEART_RATE,
    normalizedRecordJson = dto.toNormalizedJsonObject(),
    valueField = "bpm",
)

internal fun mapRespiratoryRate(
    field: String,
    dto: RespiratoryRate,
    issues: MutableList<ValidationIssue>
): ScalarSampleRecord? = mapScalarViaRegistry(
    field = field,
    dto = ScalarSample(
        providerRecordId = dto.providerRecordId,
        measuredAt = dto.measuredAt,
        metricType = ScalarMetricTypes.RESPIRATORY_RATE,
        value = dto.breathsPerMinute.toDouble(),
        unit = ScalarMetricRegistry.get(ScalarMetricTypes.RESPIRATORY_RATE).unit,
        context = dto.context,
    ),
    issues = issues,
    recordType = RecordTypes.RESPIRATORY_RATE,
    normalizedRecordJson = dto.toNormalizedJsonObject(),
    valueField = "breathsPerMinute",
)

internal fun mapHrv(
    field: String,
    dto: Hrv,
    issues: MutableList<ValidationIssue>
): ScalarSampleRecord? = mapScalarViaRegistry(
    field = field,
    dto = ScalarSample(
        providerRecordId = dto.providerRecordId,
        measuredAt = dto.measuredAt,
        // Legacy hrv records carry the unprefixed metric type ("rmssd"); scalar metric
        // types are family-prefixed ("hrv_rmssd").
        metricType = "hrv_${dto.metricType}",
        value = dto.value,
        unit = dto.unit,
        context = dto.context,
    ),
    issues = issues,
    recordType = RecordTypes.HRV,
    normalizedRecordJson = dto.toNormalizedJsonObject(),
    unknownMetricTypeMessage = "unsupported hrv metric type",
)

internal fun mapCardiovascular(
    field: String,
    dto: Cardiovascular,
    issues: MutableList<ValidationIssue>
): ScalarSampleRecord? = mapScalarViaRegistry(
    field = field,
    dto = ScalarSample(
        providerRecordId = dto.providerRecordId,
        measuredAt = dto.measuredAt,
        metricType = dto.metricType,
        value = dto.value,
        unit = dto.unit,
    ),
    issues = issues,
    recordType = RecordTypes.CARDIOVASCULAR,
    normalizedRecordJson = dto.toNormalizedJsonObject(),
    unknownMetricTypeMessage = "unsupported cardiovascular metric type",
)

internal fun mapExtendedBodyMeasurement(
    field: String,
    dto: ExtendedBodyMeasurement,
    issues: MutableList<ValidationIssue>
): ScalarSampleRecord? = mapScalarViaRegistry(
    field = field,
    dto = ScalarSample(
        providerRecordId = dto.providerRecordId,
        measuredAt = dto.measuredAt,
        metricType = dto.metricType,
        value = dto.value,
        unit = dto.unit,
        segment = dto.segment,
    ),
    issues = issues,
    recordType = RecordTypes.EXTENDED_BODY_MEASUREMENT,
    normalizedRecordJson = dto.toNormalizedJsonObject(),
    unknownMetricTypeMessage = "unsupported extended body metric type",
)

internal fun mapScalar(
    field: String,
    dto: ScalarSample,
    issues: MutableList<ValidationIssue>
): ScalarSampleRecord? = mapScalarViaRegistry(field, dto, issues)

/**
 * Registry-driven validation shared by the generic scalar record and the legacy
 * per-family adapters. A legacy [recordType] only accepts metric types its family owns;
 * the stored record keeps the caller's record type and normalized JSON so legacy wire
 * shapes are preserved.
 */
private fun mapScalarViaRegistry(
    field: String,
    dto: ScalarSample,
    issues: MutableList<ValidationIssue>,
    recordType: String = RecordTypes.SCALAR,
    normalizedRecordJson: JsonObject = dto.toNormalizedJsonObject(),
    valueField: String = "value",
    unknownMetricTypeMessage: String = "unsupported scalar metric type",
): ScalarSampleRecord? {
    val measuredAt =
        parseInstant(dto.measuredAt, "$field.measuredAt", issues)
    val descriptor = ScalarMetricRegistry.find(dto.metricType)
        ?.takeIf { recordType == RecordTypes.SCALAR || it.recordType == recordType }
    if (descriptor == null) {
        issues.add(
            ValidationIssue(
                field = "$field.metricType",
                code = ValidationIssueCodes.UnsupportedValue,
                message = unknownMetricTypeMessage,
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
        issues.add(outOfRangeIssue("$field.$valueField", descriptor.metricType))
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
            normalizedRecordJson = normalizedRecordJson,
            recordType = recordType,
            measuredAt = measuredAt,
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

private fun outOfRangeIssue(field: String, metricType: String) = ValidationIssue(
    field = field,
    code = ValidationIssueCodes.OutOfRange,
    message = "out of range for $metricType",
)

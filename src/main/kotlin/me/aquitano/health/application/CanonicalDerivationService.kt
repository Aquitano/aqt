package me.aquitano.health.application

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import me.aquitano.health.api.dto.IngestionBatchRequest
import me.aquitano.health.domain.BodyMeasurementRecord
import me.aquitano.health.domain.BodyMeasurementValue
import me.aquitano.health.domain.BodyMetricTypes
import me.aquitano.health.domain.CanonicalRecord
import me.aquitano.health.domain.HeartRateContexts
import me.aquitano.health.domain.HeartRateRecord
import me.aquitano.health.domain.RecordTypes
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.SleepSessionRecord
import me.aquitano.health.domain.SleepStageRecord
import me.aquitano.health.domain.SleepStages
import me.aquitano.health.domain.StepIntervalRecord
import me.aquitano.health.domain.ValidatedIngestionBatch
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.shared.AppJson
import java.time.Instant
import java.util.Locale

class CanonicalDerivationService {
    fun validateAndMap(request: IngestionBatchRequest): ValidatedIngestionBatch {
        val issues = mutableListOf<ValidationIssue>()
        val provider = normalizeProvider(request.provider, issues)
        val providerInstanceId = requiredNonBlank(request.providerInstanceId, "providerInstanceId", issues)
        val batchExternalId = optionalNonBlank(request.batchExternalId, "batchExternalId", issues)
        val ingestedAt = parseInstant(request.ingestedAt, "ingestedAt", issues)
        val rawPayload = request.rawPayload ?: JsonNull.also {
            issues.add(ValidationIssue("rawPayload", "is required"))
        }
        val inputRecords = request.records
        if (inputRecords == null) {
            issues.add(ValidationIssue("records", "is required"))
        } else if (inputRecords.isEmpty()) {
            issues.add(ValidationIssue("records", "must not be empty"))
        }

        val records = inputRecords?.mapIndexedNotNull { index, record ->
            parseRecord(index, record, issues)
        }.orEmpty()

        val duplicateProviderIds = records
            .mapNotNull { it.providerRecordId }
            .groupingBy { it }
            .eachCount()
            .filterValues { it > 1 }
            .keys
        duplicateProviderIds.forEach {
            issues.add(ValidationIssue("records", "providerRecordId '$it' is duplicated in this batch"))
        }

        if (issues.isNotEmpty()) throw RequestValidationException(issues)

        val mappedPayloadJson = AppJson.encodeToString(
            buildJsonObject {
                put("provider", provider)
                put("providerInstanceId", providerInstanceId)
                batchExternalId?.let { put("batchExternalId", it) }
                put("ingestedAt", ingestedAt!!.toString())
                put("records", JsonArray(records.map { it.recordJson }))
            },
        )

        return ValidatedIngestionBatch(
            provider = provider!!,
            providerInstanceId = providerInstanceId!!,
            batchExternalId = batchExternalId,
            ingestedAt = ingestedAt!!,
            rawPayload = rawPayload,
            mappedPayloadJson = mappedPayloadJson,
            records = records,
        )
    }

    private fun parseRecord(index: Int, record: JsonObject, issues: MutableList<ValidationIssue>): CanonicalRecord? {
        val field = "records[$index]"
        val type = string(record, "type", "$field.type", issues) ?: return null
        return when (type) {
            RecordTypes.STEP_INTERVAL -> parseStepInterval(field, record, issues)
            RecordTypes.SLEEP_SESSION -> parseSleepSession(field, record, issues)
            RecordTypes.BODY_MEASUREMENT -> parseBodyMeasurement(field, record, issues)
            RecordTypes.HEART_RATE -> parseHeartRate(field, record, issues)
            else -> {
                issues.add(ValidationIssue("$field.type", "unsupported record type"))
                null
            }
        }
    }

    private fun parseStepInterval(field: String, record: JsonObject, issues: MutableList<ValidationIssue>): StepIntervalRecord? {
        rejectUnknownFields(field, record, setOf("type", "providerRecordId", "startAt", "endAt", "steps"), issues)
        val providerRecordId = optionalString(record, "providerRecordId", "$field.providerRecordId", issues)
        val startAt = instant(record, "startAt", "$field.startAt", issues)
        val endAt = instant(record, "endAt", "$field.endAt", issues)
        val steps = int(record, "steps", "$field.steps", issues)
        if (startAt != null && endAt != null && !startAt.isBefore(endAt)) {
            issues.add(ValidationIssue("$field.startAt", "must be before endAt"))
        }
        if (steps != null && steps <= 0) {
            issues.add(ValidationIssue("$field.steps", "must be greater than 0"))
        }
        return if (startAt != null && endAt != null && steps != null && steps > 0 && startAt.isBefore(endAt)) {
            StepIntervalRecord(providerRecordId, record, startAt, endAt, steps)
        } else {
            null
        }
    }

    private fun parseSleepSession(field: String, record: JsonObject, issues: MutableList<ValidationIssue>): SleepSessionRecord? {
        rejectUnknownFields(field, record, setOf("type", "providerRecordId", "startAt", "endAt", "stages"), issues)
        val providerRecordId = optionalString(record, "providerRecordId", "$field.providerRecordId", issues)
        val startAt = instant(record, "startAt", "$field.startAt", issues)
        val endAt = instant(record, "endAt", "$field.endAt", issues)
        if (startAt != null && endAt != null && !startAt.isBefore(endAt)) {
            issues.add(ValidationIssue("$field.startAt", "must be before endAt"))
        }

        val stages = mutableListOf<SleepStageRecord>()
        val stagesElement = record["stages"]
        if (stagesElement != null && stagesElement !is JsonNull) {
            val array = runCatching { stagesElement.jsonArray }.getOrNull()
            if (array == null) {
                issues.add(ValidationIssue("$field.stages", "must be an array"))
            } else {
                array.forEachIndexed { stageIndex, stageElement ->
                    val stageObject = stageElement as? JsonObject
                    if (stageObject == null) {
                        issues.add(ValidationIssue("$field.stages[$stageIndex]", "must be an object"))
                    } else {
                        parseSleepStage("$field.stages[$stageIndex]", stageObject, startAt, endAt, issues)?.let(stages::add)
                    }
                }
            }
        }

        return if (startAt != null && endAt != null && startAt.isBefore(endAt)) {
            SleepSessionRecord(providerRecordId, record, startAt, endAt, stages)
        } else {
            null
        }
    }

    private fun parseSleepStage(
        field: String,
        record: JsonObject,
        sessionStart: Instant?,
        sessionEnd: Instant?,
        issues: MutableList<ValidationIssue>,
    ): SleepStageRecord? {
        rejectUnknownFields(field, record, setOf("stage", "startAt", "endAt"), issues)
        val stage = string(record, "stage", "$field.stage", issues)
        val startAt = instant(record, "startAt", "$field.startAt", issues)
        val endAt = instant(record, "endAt", "$field.endAt", issues)
        if (stage != null && stage !in SleepStages.supported) {
            issues.add(ValidationIssue("$field.stage", "unsupported sleep stage"))
        }
        if (startAt != null && endAt != null && !startAt.isBefore(endAt)) {
            issues.add(ValidationIssue("$field.startAt", "must be before endAt"))
        }
        if (startAt != null && endAt != null && sessionStart != null && sessionEnd != null) {
            if (startAt.isBefore(sessionStart) || endAt.isAfter(sessionEnd)) {
                issues.add(ValidationIssue(field, "must be within the sleep session"))
            }
        }
        return if (stage != null && stage in SleepStages.supported && startAt != null && endAt != null && startAt.isBefore(endAt)) {
            SleepStageRecord(stage, startAt, endAt)
        } else {
            null
        }
    }

    private fun parseBodyMeasurement(field: String, record: JsonObject, issues: MutableList<ValidationIssue>): BodyMeasurementRecord? {
        rejectUnknownFields(
            field,
            record,
            setOf(
                "type",
                "providerRecordId",
                "measuredAt",
                "weightKg",
                "bodyFatPercent",
                "muscleKg",
                "waterPercent",
                "visceralFatRating",
            ),
            issues,
        )
        val providerRecordId = optionalString(record, "providerRecordId", "$field.providerRecordId", issues)
        val measuredAt = instant(record, "measuredAt", "$field.measuredAt", issues)
        val values = buildList {
            optionalPositiveDouble(record, "weightKg", "$field.weightKg", issues)?.let {
                add(BodyMeasurementValue(BodyMetricTypes.WEIGHT, it, "kg"))
            }
            optionalPercent(record, "bodyFatPercent", "$field.bodyFatPercent", issues)?.let {
                add(BodyMeasurementValue(BodyMetricTypes.BODY_FAT, it, "percent"))
            }
            optionalPositiveDouble(record, "muscleKg", "$field.muscleKg", issues)?.let {
                add(BodyMeasurementValue(BodyMetricTypes.MUSCLE, it, "kg"))
            }
            optionalPercent(record, "waterPercent", "$field.waterPercent", issues)?.let {
                add(BodyMeasurementValue(BodyMetricTypes.WATER, it, "percent"))
            }
            optionalPositiveDouble(record, "visceralFatRating", "$field.visceralFatRating", issues)?.let {
                add(BodyMeasurementValue(BodyMetricTypes.VISCERAL_FAT, it, "rating"))
            }
        }
        if (values.isEmpty()) {
            issues.add(ValidationIssue(field, "at least one body metric value is required"))
        }
        return if (measuredAt != null && values.isNotEmpty()) {
            BodyMeasurementRecord(providerRecordId, record, measuredAt, values)
        } else {
            null
        }
    }

    private fun parseHeartRate(field: String, record: JsonObject, issues: MutableList<ValidationIssue>): HeartRateRecord? {
        rejectUnknownFields(field, record, setOf("type", "providerRecordId", "measuredAt", "bpm", "context"), issues)
        val providerRecordId = optionalString(record, "providerRecordId", "$field.providerRecordId", issues)
        val measuredAt = instant(record, "measuredAt", "$field.measuredAt", issues)
        val bpm = int(record, "bpm", "$field.bpm", issues)
        val context = optionalString(record, "context", "$field.context", issues) ?: "unknown"
        if (bpm != null && bpm !in 25..250) {
            issues.add(ValidationIssue("$field.bpm", "must be between 25 and 250"))
        }
        if (context !in HeartRateContexts.supported) {
            issues.add(ValidationIssue("$field.context", "unsupported heart-rate context"))
        }
        return if (measuredAt != null && bpm != null && bpm in 25..250 && context in HeartRateContexts.supported) {
            HeartRateRecord(providerRecordId, record, measuredAt, bpm, context)
        } else {
            null
        }
    }

    private fun normalizeProvider(value: String?, issues: MutableList<ValidationIssue>): String? {
        val normalized = requiredNonBlank(value, "provider", issues)
            ?.lowercase(Locale.US)
            ?.replace('-', '_')
        if (normalized != null && !normalized.matches(Regex("[a-z0-9_]+"))) {
            issues.add(ValidationIssue("provider", "must contain only lowercase letters, numbers, or underscores"))
        }
        return normalized
    }

    private fun requiredNonBlank(value: String?, field: String, issues: MutableList<ValidationIssue>): String? {
        if (value == null) {
            issues.add(ValidationIssue(field, "is required"))
            return null
        }
        if (value.isBlank()) {
            issues.add(ValidationIssue(field, "must not be blank"))
            return null
        }
        return value.trim()
    }

    private fun optionalNonBlank(value: String?, field: String, issues: MutableList<ValidationIssue>): String? {
        if (value == null) return null
        if (value.isBlank()) {
            issues.add(ValidationIssue(field, "must not be blank when present"))
            return null
        }
        return value.trim()
    }

    private fun parseInstant(value: String?, field: String, issues: MutableList<ValidationIssue>): Instant? {
        val raw = requiredNonBlank(value, field, issues) ?: return null
        return runCatching { Instant.parse(raw) }.getOrElse {
            issues.add(ValidationIssue(field, "must be an ISO-8601 instant"))
            null
        }
    }

    private fun instant(record: JsonObject, key: String, field: String, issues: MutableList<ValidationIssue>): Instant? =
        parseInstant(string(record, key, field, issues), field, issues)

    private fun string(record: JsonObject, key: String, field: String, issues: MutableList<ValidationIssue>): String? {
        val element = record[key]
        if (element == null || element is JsonNull) {
            issues.add(ValidationIssue(field, "is required"))
            return null
        }
        return runCatching { element.jsonPrimitive.contentOrNull }.getOrNull()?.takeIf { it.isNotBlank() }
            ?: run {
                issues.add(ValidationIssue(field, "must be a non-blank string"))
                null
            }
    }

    private fun optionalString(record: JsonObject, key: String, field: String, issues: MutableList<ValidationIssue>): String? {
        val element = record[key] ?: return null
        if (element is JsonNull) return null
        val value = runCatching { element.jsonPrimitive.contentOrNull }.getOrNull()
        if (value == null || value.isBlank()) {
            issues.add(ValidationIssue(field, "must be a non-blank string when present"))
            return null
        }
        return value
    }

    private fun int(record: JsonObject, key: String, field: String, issues: MutableList<ValidationIssue>): Int? {
        val element = record[key]
        if (element == null || element is JsonNull) {
            issues.add(ValidationIssue(field, "is required"))
            return null
        }
        return runCatching { element.jsonPrimitive.intOrNull }.getOrNull() ?: run {
            issues.add(ValidationIssue(field, "must be an integer"))
            null
        }
    }

    private fun optionalPositiveDouble(record: JsonObject, key: String, field: String, issues: MutableList<ValidationIssue>): Double? {
        val value = optionalDouble(record, key, field, issues) ?: return null
        if (value <= 0.0) {
            issues.add(ValidationIssue(field, "must be greater than 0"))
            return null
        }
        return value
    }

    private fun optionalPercent(record: JsonObject, key: String, field: String, issues: MutableList<ValidationIssue>): Double? {
        val value = optionalDouble(record, key, field, issues) ?: return null
        if (value !in 0.0..100.0) {
            issues.add(ValidationIssue(field, "must be between 0 and 100"))
            return null
        }
        return value
    }

    private fun optionalDouble(record: JsonObject, key: String, field: String, issues: MutableList<ValidationIssue>): Double? {
        val element = record[key] ?: return null
        if (element is JsonNull) return null
        return runCatching { element.jsonPrimitive.doubleOrNull }.getOrNull() ?: run {
            issues.add(ValidationIssue(field, "must be a number"))
            null
        }
    }

    private fun rejectUnknownFields(
        field: String,
        record: JsonObject,
        allowed: Set<String>,
        issues: MutableList<ValidationIssue>,
    ) {
        (record.keys - allowed).forEach {
            issues.add(ValidationIssue("$field.$it", "is not allowed"))
        }
    }
}

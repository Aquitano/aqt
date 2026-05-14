package me.aquitano.health.application

import kotlinx.serialization.json.*
import me.aquitano.health.api.dto.*
import me.aquitano.health.domain.*
import me.aquitano.health.shared.AppJson
import java.time.Instant
import java.util.*

class IngestionMappingService {
    fun validateAndMap(request: IngestionBatchRequest): ValidatedIngestionBatch {
        val issues = mutableListOf<ValidationIssue>()
        val provider = normalizeProvider(request.provider, issues)
        val providerInstanceId = requiredNonBlank(
            request.providerInstanceId,
            "providerInstanceId",
            issues
        )
        val batchExternalId =
            optionalNonBlank(request.batchExternalId, "batchExternalId", issues)
        val ingestedAt = parseInstant(request.ingestedAt, "ingestedAt", issues)
        val sourcePayload = request.sourcePayload ?: JsonNull.also {
            issues.add(ValidationIssue("sourcePayload"))
        }
        val inputRecords = request.records
        if (inputRecords == null) {
            issues.add(ValidationIssue("records"))
        } else if (inputRecords.isEmpty()) {
            issues.add(
                ValidationIssue(
                    field = "records",
                    code = ValidationIssueCodes.InvalidState,
                    message = "must not be empty",
                )
            )
        }

        val records = inputRecords?.mapIndexedNotNull { index, dto ->
            mapRecord(index, dto, issues)
        }.orEmpty()

        val duplicateProviderIds = records
            .mapNotNull { it.providerRecordId }
            .groupingBy { it }
            .eachCount()
            .filterValues { it > 1 }
            .keys
        duplicateProviderIds.forEach {
            issues.add(
                ValidationIssue(
                    field = "records",
                    code = ValidationIssueCodes.InvalidState,
                    message = "providerRecordId '$it' is duplicated in this batch",
                )
            )
        }

        if (issues.isNotEmpty()) throw RequestValidationException(issues)

        val normalizedPayloadJson = AppJson.encodeToString(
            buildJsonObject {
                put("provider", provider)
                put("providerInstanceId", providerInstanceId)
                batchExternalId?.let { put("batchExternalId", it) }
                put("ingestedAt", ingestedAt!!.toString())
                put("records", JsonArray(records.map { it.normalizedRecordJson }))
            },
        )

        return ValidatedIngestionBatch(
            provider = provider!!,
            providerInstanceId = providerInstanceId!!,
            batchExternalId = batchExternalId,
            ingestedAt = ingestedAt!!,
            sourcePayload = sourcePayload,
            normalizedPayloadJson = normalizedPayloadJson,
            records = records,
        )
    }

    private fun mapRecord(
        index: Int,
        dto: IngestionRecordDto,
        issues: MutableList<ValidationIssue>
    ): HealthRecord? {
        val field = "records[$index]"
        return when (dto) {
            is StepIntervalDto -> mapStepInterval(field, dto, issues)
            is SleepSessionDto -> mapSleepSession(field, dto, issues)
            is BodyMeasurementDto -> mapBodyMeasurement(field, dto, issues)
            is HeartRateDto -> mapHeartRate(field, dto, issues)
        }
    }

    private fun mapStepInterval(
        field: String,
        dto: StepIntervalDto,
        issues: MutableList<ValidationIssue>
    ): StepIntervalRecord? {
        val startAt = parseInstant(dto.startAt, "$field.startAt", issues)
        val endAt = parseInstant(dto.endAt, "$field.endAt", issues)
        val steps = dto.steps

        if (startAt != null && endAt != null && !startAt.isBefore(endAt)) {
            issues.add(
                ValidationIssue(
                    field = "$field.startAt",
                    code = ValidationIssueCodes.InvalidRange,
                    message = "must be before endAt",
                )
            )
        }
        if (steps <= 0) {
            issues.add(
                ValidationIssue(
                    field = "$field.steps",
                    code = ValidationIssueCodes.OutOfRange,
                    message = "must be greater than 0",
                )
            )
        }

        return if (startAt != null && endAt != null && steps > 0 && startAt.isBefore(endAt)) {
            StepIntervalRecord(
                providerRecordId = dto.providerRecordId,
                normalizedRecordJson = AppJson.encodeToJsonElement(IngestionRecordDto.serializer(), dto).jsonObject,
                startAt = startAt,
                endAt = endAt,
                steps = steps
            )
        } else {
            null
        }
    }

    private fun mapSleepSession(
        field: String,
        dto: SleepSessionDto,
        issues: MutableList<ValidationIssue>
    ): SleepSessionRecord? {
        val startAt = parseInstant(dto.startAt, "$field.startAt", issues)
        val endAt = parseInstant(dto.endAt, "$field.endAt", issues)

        if (startAt != null && endAt != null && !startAt.isBefore(endAt)) {
            issues.add(
                ValidationIssue(
                    field = "$field.startAt",
                    code = ValidationIssueCodes.InvalidRange,
                    message = "must be before endAt",
                )
            )
        }

        val stages = dto.stages.mapIndexedNotNull { stageIndex, stageDto ->
            mapSleepStage("$field.stages[$stageIndex]", stageDto, startAt, endAt, issues)
        }

        return if (startAt != null && endAt != null && startAt.isBefore(endAt)) {
            SleepSessionRecord(
                providerRecordId = dto.providerRecordId,
                normalizedRecordJson = AppJson.encodeToJsonElement(IngestionRecordDto.serializer(), dto).jsonObject,
                startAt = startAt,
                endAt = endAt,
                stages = stages
            )
        } else {
            null
        }
    }

    private fun mapSleepStage(
        field: String,
        dto: SleepStageDto,
        sessionStart: Instant?,
        sessionEnd: Instant?,
        issues: MutableList<ValidationIssue>,
    ): SleepStageRecord? {
        val stage = dto.stage
        val startAt = parseInstant(dto.startAt, "$field.startAt", issues)
        val endAt = parseInstant(dto.endAt, "$field.endAt", issues)

        if (stage !in SleepStages.supported) {
            issues.add(
                ValidationIssue(
                    field = "$field.stage",
                    code = ValidationIssueCodes.UnsupportedValue,
                    message = "unsupported sleep stage",
                )
            )
        }
        if (startAt != null && endAt != null && !startAt.isBefore(endAt)) {
            issues.add(
                ValidationIssue(
                    field = "$field.startAt",
                    code = ValidationIssueCodes.InvalidRange,
                    message = "must be before endAt",
                )
            )
        }
        if (startAt != null && endAt != null && sessionStart != null && sessionEnd != null) {
            if (startAt.isBefore(sessionStart) || endAt.isAfter(sessionEnd)) {
                issues.add(
                    ValidationIssue(
                        field = field,
                        code = ValidationIssueCodes.InvalidRange,
                        message = "must be within the sleep session",
                    )
                )
            }
        }

        return if (stage in SleepStages.supported && startAt != null && endAt != null && startAt.isBefore(endAt)) {
            SleepStageRecord(stage, startAt, endAt)
        } else {
            null
        }
    }

    private fun mapBodyMeasurement(
        field: String,
        dto: BodyMeasurementDto,
        issues: MutableList<ValidationIssue>
    ): BodyMeasurementRecord? {
        val measuredAt = parseInstant(dto.measuredAt, "$field.measuredAt", issues)
        val values = buildList {
            dto.weightKg?.let {
                if (it <= 0) issues.add(
                    ValidationIssue(
                        field = "$field.weightKg",
                        code = ValidationIssueCodes.OutOfRange,
                        message = "must be greater than 0",
                    )
                )
                else add(BodyMeasurementValue(BodyMetricTypes.WEIGHT, it, "kg"))
            }
            dto.bodyFatPercent?.let {
                if (it !in 0.0..100.0) issues.add(
                    ValidationIssue(
                        field = "$field.bodyFatPercent",
                        code = ValidationIssueCodes.OutOfRange,
                        message = "must be between 0 and 100",
                    )
                )
                else add(BodyMeasurementValue(BodyMetricTypes.BODY_FAT, it, "percent"))
            }
            dto.muscleKg?.let {
                if (it <= 0) issues.add(
                    ValidationIssue(
                        field = "$field.muscleKg",
                        code = ValidationIssueCodes.OutOfRange,
                        message = "must be greater than 0",
                    )
                )
                else add(BodyMeasurementValue(BodyMetricTypes.MUSCLE, it, "kg"))
            }
            dto.waterPercent?.let {
                if (it !in 0.0..100.0) issues.add(
                    ValidationIssue(
                        field = "$field.waterPercent",
                        code = ValidationIssueCodes.OutOfRange,
                        message = "must be between 0 and 100",
                    )
                )
                else add(BodyMeasurementValue(BodyMetricTypes.WATER, it, "percent"))
            }
            dto.visceralFatRating?.let {
                if (it <= 0) issues.add(
                    ValidationIssue(
                        field = "$field.visceralFatRating",
                        code = ValidationIssueCodes.OutOfRange,
                        message = "must be greater than 0",
                    )
                )
                else add(BodyMeasurementValue(BodyMetricTypes.VISCERAL_FAT, it, "rating"))
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
            BodyMeasurementRecord(
                providerRecordId = dto.providerRecordId,
                normalizedRecordJson = AppJson.encodeToJsonElement(IngestionRecordDto.serializer(), dto).jsonObject,
                measuredAt = measuredAt,
                measurements = values
            )
        } else {
            null
        }
    }

    private fun mapHeartRate(
        field: String,
        dto: HeartRateDto,
        issues: MutableList<ValidationIssue>
    ): HeartRateRecord? {
        val measuredAt = parseInstant(dto.measuredAt, "$field.measuredAt", issues)
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
            HeartRateRecord(
                providerRecordId = dto.providerRecordId,
                normalizedRecordJson = AppJson.encodeToJsonElement(IngestionRecordDto.serializer(), dto).jsonObject,
                measuredAt = measuredAt,
                bpm = bpm,
                context = context
            )
        } else {
            null
        }
    }

    private fun normalizeProvider(
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

    private fun requiredNonBlank(
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

    private fun optionalNonBlank(
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

    private fun parseInstant(
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
}

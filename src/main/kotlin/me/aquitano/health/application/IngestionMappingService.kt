package me.aquitano.health.application

import kotlinx.serialization.json.*
import me.aquitano.health.api.dto.*
import me.aquitano.health.domain.*
import me.aquitano.health.shared.AppJson
import java.time.Instant
import java.time.LocalDate
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
                put(
                    "records",
                    JsonArray(records.map { it.normalizedRecordJson })
                )
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
            is ActivitySummaryDto -> mapActivitySummary(field, dto, issues)
            is SleepSummaryDto -> mapSleepSummary(field, dto, issues)
            is RespiratoryRateDto -> mapRespiratoryRate(field, dto, issues)
            is HrvDto -> mapHrv(field, dto, issues)
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

        return if (startAt != null && endAt != null && steps > 0 && startAt.isBefore(
                endAt
            )
        ) {
            StepIntervalRecord(
                providerRecordId = dto.providerRecordId,
                normalizedRecordJson = AppJson.encodeToJsonElement(
                    IngestionRecordDto.serializer(),
                    dto
                ).jsonObject,
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
            mapSleepStage(
                "$field.stages[$stageIndex]",
                stageDto,
                startAt,
                endAt,
                issues
            )
        }

        return if (startAt != null && endAt != null && startAt.isBefore(endAt)) {
            SleepSessionRecord(
                providerRecordId = dto.providerRecordId,
                normalizedRecordJson = AppJson.encodeToJsonElement(
                    IngestionRecordDto.serializer(),
                    dto
                ).jsonObject,
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

        return if (stage in SleepStages.supported && startAt != null && endAt != null && startAt.isBefore(
                endAt
            )
        ) {
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
                else add(
                    BodyMeasurementValue(
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
                else add(BodyMeasurementValue(BodyMetricTypes.MUSCLE, it, "kg"))
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
                    BodyMeasurementValue(
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
                    BodyMeasurementValue(
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
            BodyMeasurementRecord(
                providerRecordId = dto.providerRecordId,
                normalizedRecordJson = AppJson.encodeToJsonElement(
                    IngestionRecordDto.serializer(),
                    dto
                ).jsonObject,
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
            HeartRateRecord(
                providerRecordId = dto.providerRecordId,
                normalizedRecordJson = AppJson.encodeToJsonElement(
                    IngestionRecordDto.serializer(),
                    dto
                ).jsonObject,
                measuredAt = measuredAt,
                bpm = bpm,
                context = context
            )
        } else {
            null
        }
    }

    private fun mapActivitySummary(
        field: String,
        dto: ActivitySummaryDto,
        issues: MutableList<ValidationIssue>
    ): ActivitySummaryRecord? {
        val date = parseDate(dto.date, "$field.date", issues)
        validateNonNegativeDouble(
            dto.distanceMeters,
            "$field.distanceMeters",
            issues
        )
        validateNonNegativeDouble(
            dto.activeEnergyKcal,
            "$field.activeEnergyKcal",
            issues
        )
        validateNonNegativeDouble(
            dto.totalEnergyKcal,
            "$field.totalEnergyKcal",
            issues
        )
        validateNonNegativeDouble(
            dto.elevationMeters,
            "$field.elevationMeters",
            issues
        )
        validateNonNegativeInt(dto.softMinutes, "$field.softMinutes", issues)
        validateNonNegativeInt(
            dto.moderateMinutes,
            "$field.moderateMinutes",
            issues
        )
        validateNonNegativeInt(
            dto.intenseMinutes,
            "$field.intenseMinutes",
            issues
        )
        validateNonNegativeInt(dto.activeMinutes, "$field.activeMinutes", issues)
        validateOptionalHeartRate(
            dto.averageHeartRateBpm,
            "$field.averageHeartRateBpm",
            issues
        )
        validateOptionalHeartRate(
            dto.minHeartRateBpm,
            "$field.minHeartRateBpm",
            issues
        )
        validateOptionalHeartRate(
            dto.maxHeartRateBpm,
            "$field.maxHeartRateBpm",
            issues
        )
        if (dto.minHeartRateBpm != null && dto.averageHeartRateBpm != null && dto.minHeartRateBpm > dto.averageHeartRateBpm) {
            issues.add(
                ValidationIssue(
                    field = "$field.minHeartRateBpm",
                    code = ValidationIssueCodes.InvalidRange,
                    message = "must be less than or equal to averageHeartRateBpm",
                )
            )
        }
        if (dto.averageHeartRateBpm != null && dto.maxHeartRateBpm != null && dto.averageHeartRateBpm > dto.maxHeartRateBpm) {
            issues.add(
                ValidationIssue(
                    field = "$field.averageHeartRateBpm",
                    code = ValidationIssueCodes.InvalidRange,
                    message = "must be less than or equal to maxHeartRateBpm",
                )
            )
        }

        val hasAnyMetric = listOfNotNull(
            dto.distanceMeters,
            dto.activeEnergyKcal,
            dto.totalEnergyKcal,
            dto.elevationMeters,
            dto.softMinutes,
            dto.moderateMinutes,
            dto.intenseMinutes,
            dto.activeMinutes,
            dto.averageHeartRateBpm,
            dto.minHeartRateBpm,
            dto.maxHeartRateBpm,
        ).isNotEmpty()
        if (!hasAnyMetric) {
            issues.add(
                ValidationIssue(
                    field = field,
                    code = ValidationIssueCodes.Required,
                    message = "at least one activity summary metric is required",
                )
            )
        }

        return if (date != null && hasAnyMetric) {
            ActivitySummaryRecord(
                providerRecordId = dto.providerRecordId,
                normalizedRecordJson = AppJson.encodeToJsonElement(
                    IngestionRecordDto.serializer(),
                    dto
                ).jsonObject,
                date = date,
                distanceMeters = dto.distanceMeters,
                activeEnergyKcal = dto.activeEnergyKcal,
                totalEnergyKcal = dto.totalEnergyKcal,
                elevationMeters = dto.elevationMeters,
                softMinutes = dto.softMinutes,
                moderateMinutes = dto.moderateMinutes,
                intenseMinutes = dto.intenseMinutes,
                activeMinutes = dto.activeMinutes,
                averageHeartRateBpm = dto.averageHeartRateBpm,
                minHeartRateBpm = dto.minHeartRateBpm,
                maxHeartRateBpm = dto.maxHeartRateBpm,
            )
        } else {
            null
        }
    }

    private fun mapSleepSummary(
        field: String,
        dto: SleepSummaryDto,
        issues: MutableList<ValidationIssue>
    ): SleepSummaryRecord? {
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
        validateNonNegativeLong(
            dto.timeInBedSeconds,
            "$field.timeInBedSeconds",
            issues
        )
        validateNonNegativeLong(
            dto.totalSleepSeconds,
            "$field.totalSleepSeconds",
            issues
        )
        validateNonNegativeLong(
            dto.lightSleepSeconds,
            "$field.lightSleepSeconds",
            issues
        )
        validateNonNegativeLong(
            dto.deepSleepSeconds,
            "$field.deepSleepSeconds",
            issues
        )
        validateNonNegativeLong(
            dto.remSleepSeconds,
            "$field.remSleepSeconds",
            issues
        )
        validateNonNegativeLong(
            dto.sleepLatencySeconds,
            "$field.sleepLatencySeconds",
            issues
        )
        validateNonNegativeLong(
            dto.wakeupLatencySeconds,
            "$field.wakeupLatencySeconds",
            issues
        )
        validateNonNegativeLong(
            dto.wakeupDurationSeconds,
            "$field.wakeupDurationSeconds",
            issues
        )
        validateNonNegativeInt(dto.wakeupCount, "$field.wakeupCount", issues)
        validateNonNegativeLong(dto.wasoSeconds, "$field.wasoSeconds", issues)
        if (dto.sleepEfficiencyPercent != null && dto.sleepEfficiencyPercent !in 0.0..100.0) {
            issues.add(
                ValidationIssue(
                    field = "$field.sleepEfficiencyPercent",
                    code = ValidationIssueCodes.OutOfRange,
                    message = "must be between 0 and 100",
                )
            )
        }
        if (dto.sleepScore != null && dto.sleepScore !in 0..100) {
            issues.add(
                ValidationIssue(
                    field = "$field.sleepScore",
                    code = ValidationIssueCodes.OutOfRange,
                    message = "must be between 0 and 100",
                )
            )
        }

        val hasAnyMetric = listOfNotNull(
            dto.timeInBedSeconds,
            dto.totalSleepSeconds,
            dto.lightSleepSeconds,
            dto.deepSleepSeconds,
            dto.remSleepSeconds,
            dto.sleepEfficiencyPercent,
            dto.sleepLatencySeconds,
            dto.wakeupLatencySeconds,
            dto.wakeupDurationSeconds,
            dto.wakeupCount,
            dto.wasoSeconds,
            dto.sleepScore,
        ).isNotEmpty()
        if (!hasAnyMetric) {
            issues.add(
                ValidationIssue(
                    field = field,
                    code = ValidationIssueCodes.Required,
                    message = "at least one sleep summary metric is required",
                )
            )
        }

        return if (startAt != null && endAt != null && startAt.isBefore(endAt) && hasAnyMetric) {
            SleepSummaryRecord(
                providerRecordId = dto.providerRecordId,
                normalizedRecordJson = AppJson.encodeToJsonElement(
                    IngestionRecordDto.serializer(),
                    dto
                ).jsonObject,
                startAt = startAt,
                endAt = endAt,
                timeInBedSeconds = dto.timeInBedSeconds,
                totalSleepSeconds = dto.totalSleepSeconds,
                lightSleepSeconds = dto.lightSleepSeconds,
                deepSleepSeconds = dto.deepSleepSeconds,
                remSleepSeconds = dto.remSleepSeconds,
                sleepEfficiencyPercent = dto.sleepEfficiencyPercent,
                sleepLatencySeconds = dto.sleepLatencySeconds,
                wakeupLatencySeconds = dto.wakeupLatencySeconds,
                wakeupDurationSeconds = dto.wakeupDurationSeconds,
                wakeupCount = dto.wakeupCount,
                wasoSeconds = dto.wasoSeconds,
                sleepScore = dto.sleepScore,
            )
        } else {
            null
        }
    }

    private fun mapRespiratoryRate(
        field: String,
        dto: RespiratoryRateDto,
        issues: MutableList<ValidationIssue>
    ): RespiratoryRateRecord? {
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
            RespiratoryRateRecord(
                providerRecordId = dto.providerRecordId,
                normalizedRecordJson = AppJson.encodeToJsonElement(
                    IngestionRecordDto.serializer(),
                    dto
                ).jsonObject,
                measuredAt = measuredAt,
                breathsPerMinute = dto.breathsPerMinute,
                context = context,
            )
        } else {
            null
        }
    }

    private fun mapHrv(
        field: String,
        dto: HrvDto,
        issues: MutableList<ValidationIssue>
    ): HrvRecord? {
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
            HrvRecord(
                providerRecordId = dto.providerRecordId,
                normalizedRecordJson = AppJson.encodeToJsonElement(
                    IngestionRecordDto.serializer(),
                    dto
                ).jsonObject,
                measuredAt = measuredAt,
                metricType = dto.metricType,
                value = dto.value,
                unit = dto.unit,
                context = context,
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

    private fun parseDate(
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

    private fun validateNonNegativeInt(
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

    private fun validateNonNegativeLong(
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

    private fun validateNonNegativeDouble(
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

    private fun validateOptionalHeartRate(
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
}

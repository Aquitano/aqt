package me.aquitano.health.application

import me.aquitano.health.api.dto.ActivitySummary
import me.aquitano.health.api.dto.BloodPressure
import me.aquitano.health.api.dto.SleepSession
import me.aquitano.health.api.dto.SleepStage
import me.aquitano.health.api.dto.SleepSummary
import me.aquitano.health.api.dto.StepInterval
import me.aquitano.health.domain.ActivitySummaryRecord
import me.aquitano.health.domain.BloodPressureRecord
import me.aquitano.health.domain.SleepSessionRecord
import me.aquitano.health.domain.SleepStageRecord
import me.aquitano.health.domain.SleepStages
import me.aquitano.health.domain.SleepSummaryRecord
import me.aquitano.health.domain.StepIntervalRecord
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import java.time.Instant

/** Mappers for structural records (intervals, sessions, summaries, paired measurements). */

internal fun mapStepInterval(
    field: String,
    dto: StepInterval,
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
            normalizedRecordJson = dto.toNormalizedJsonObject(),
            startAt = startAt,
            endAt = endAt,
            steps = steps
        )
    } else {
        null
    }
}

internal fun mapSleepSession(
    field: String,
    dto: SleepSession,
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
            normalizedRecordJson = dto.toNormalizedJsonObject(),
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
    dto: SleepStage,
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

internal fun mapActivitySummary(
    field: String,
    dto: ActivitySummary,
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
            normalizedRecordJson = dto.toNormalizedJsonObject(),
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

internal fun mapSleepSummary(
    field: String,
    dto: SleepSummary,
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
    validateNonNegativeInt(dto.remEpisodesCount, "$field.remEpisodesCount", issues)
    validateNonNegativeInt(dto.outOfBedCount, "$field.outOfBedCount", issues)
    validateNonNegativeLong(dto.awakeDurationSeconds, "$field.awakeDurationSeconds", issues)
    if (dto.overnightHrvRmssd != null && dto.overnightHrvRmssd <= 0.0) {
        issues.add(ValidationIssue("$field.overnightHrvRmssd", code = ValidationIssueCodes.OutOfRange, message = "must be greater than 0"))
    }
    validateNonNegativeDouble(dto.respiratoryRhythm, "$field.respiratoryRhythm", issues)
    if (dto.breathingQuality != null && dto.breathingQuality !in 0..100) {
        issues.add(ValidationIssue("$field.breathingQuality", code = ValidationIssueCodes.OutOfRange, message = "must be between 0 and 100"))
    }
    validateNonNegativeLong(dto.snoringDurationSeconds, "$field.snoringDurationSeconds", issues)
    validateNonNegativeDouble(dto.apneaHypopneaIndex, "$field.apneaHypopneaIndex", issues)
    validateNonNegativeDouble(dto.movementScore, "$field.movementScore", issues)
    validateNonNegativeInt(dto.snoringEpisodeCount, "$field.snoringEpisodeCount", issues)
    validateOptionalHeartRate(dto.hrAverageBpm, "$field.hrAverageBpm", issues)
    validateOptionalHeartRate(dto.hrMinBpm, "$field.hrMinBpm", issues)
    validateOptionalHeartRate(dto.hrMaxBpm, "$field.hrMaxBpm", issues)
    if (dto.rrAverage != null && dto.rrAverage !in 5.0..40.0) {
        issues.add(ValidationIssue("$field.rrAverage", code = ValidationIssueCodes.OutOfRange, message = "must be between 5 and 40"))
    }
    if (dto.rrMin != null && dto.rrMin !in 5.0..40.0) {
        issues.add(ValidationIssue("$field.rrMin", code = ValidationIssueCodes.OutOfRange, message = "must be between 5 and 40"))
    }
    if (dto.rrMax != null && dto.rrMax !in 5.0..40.0) {
        issues.add(ValidationIssue("$field.rrMax", code = ValidationIssueCodes.OutOfRange, message = "must be between 5 and 40"))
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
        dto.remEpisodesCount,
        dto.outOfBedCount,
        dto.awakeDurationSeconds,
        dto.overnightHrvRmssd,
        dto.respiratoryRhythm,
        dto.breathingQuality,
        dto.snoringDurationSeconds,
        dto.apneaHypopneaIndex,
        dto.movementScore,
        dto.snoringEpisodeCount,
        dto.hrAverageBpm,
        dto.hrMinBpm,
        dto.hrMaxBpm,
        dto.rrAverage,
        dto.rrMin,
        dto.rrMax,
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
            normalizedRecordJson = dto.toNormalizedJsonObject(),
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
            remEpisodesCount = dto.remEpisodesCount,
            outOfBedCount = dto.outOfBedCount,
            awakeDurationSeconds = dto.awakeDurationSeconds,
            overnightHrvRmssd = dto.overnightHrvRmssd,
            respiratoryRhythm = dto.respiratoryRhythm,
            breathingQuality = dto.breathingQuality,
            snoringDurationSeconds = dto.snoringDurationSeconds,
            apneaHypopneaIndex = dto.apneaHypopneaIndex,
            movementScore = dto.movementScore,
            snoringEpisodeCount = dto.snoringEpisodeCount,
            hrAverageBpm = dto.hrAverageBpm,
            hrMinBpm = dto.hrMinBpm,
            hrMaxBpm = dto.hrMaxBpm,
            rrAverage = dto.rrAverage,
            rrMin = dto.rrMin,
            rrMax = dto.rrMax,
        )
    } else {
        null
    }
}

internal fun mapBloodPressure(
    field: String,
    dto: BloodPressure,
    issues: MutableList<ValidationIssue>
): BloodPressureRecord? {
    val measuredAt =
        parseInstant(dto.measuredAt, "$field.measuredAt", issues)
    if (dto.systolicMmhg !in 60..300) {
        issues.add(
            ValidationIssue(
                field = "$field.systolicMmhg",
                code = ValidationIssueCodes.OutOfRange,
                message = "must be between 60 and 300",
            )
        )
    }
    if (dto.diastolicMmhg !in 30..200) {
        issues.add(
            ValidationIssue(
                field = "$field.diastolicMmhg",
                code = ValidationIssueCodes.OutOfRange,
                message = "must be between 30 and 200",
            )
        )
    }
    if (dto.systolicMmhg <= dto.diastolicMmhg) {
        issues.add(
            ValidationIssue(
                field = "$field.systolicMmhg",
                code = ValidationIssueCodes.InvalidRange,
                message = "must be greater than diastolicMmhg",
            )
        )
    }
    validateOptionalHeartRate(dto.heartRateBpm, "$field.heartRateBpm", issues)

    return if (measuredAt != null && dto.systolicMmhg in 60..300 && dto.diastolicMmhg in 30..200 && dto.systolicMmhg > dto.diastolicMmhg) {
        BloodPressureRecord(
            providerRecordId = dto.providerRecordId,
            normalizedRecordJson = dto.toNormalizedJsonObject(),
            measuredAt = measuredAt,
            systolicMmhg = dto.systolicMmhg,
            diastolicMmhg = dto.diastolicMmhg,
            heartRateBpm = dto.heartRateBpm,
        )
    } else {
        null
    }
}

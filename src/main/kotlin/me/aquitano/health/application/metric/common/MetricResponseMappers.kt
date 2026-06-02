package me.aquitano.health.application.metric.common

import me.aquitano.health.api.dto.*
import me.aquitano.health.infrastructure.repositories.*

internal fun SourceMetadata?.toResponse(): SourceMetadataResponse? =
    this?.let {
        SourceMetadataResponse(
            provider = it.provider,
            providerInstanceId = it.providerInstanceId,
        )
    }

internal fun BodyMeasurementRow.toResponse(
    sourceMetadata: Map<Int, SourceMetadata>,
): BodyMeasurementResponse =
    BodyMeasurementResponse(
        id = id,
        measuredAt = measuredAt,
        metricType = metricType,
        value = value,
        unit = unit,
        source = sourceMetadata[sourceInstanceId].toResponse(),
    )

internal fun ActivitySummaryRow.toResponse(
    sourceMetadata: Map<Int, SourceMetadata>,
): ActivitySummaryResponse =
    ActivitySummaryResponse(
        id = id,
        date = date,
        distanceMeters = distanceMeters,
        activeEnergyKcal = activeEnergyKcal,
        totalEnergyKcal = totalEnergyKcal,
        elevationMeters = elevationMeters,
        softMinutes = softMinutes,
        moderateMinutes = moderateMinutes,
        intenseMinutes = intenseMinutes,
        activeMinutes = activeMinutes,
        averageHeartRateBpm = averageHeartRateBpm,
        minHeartRateBpm = minHeartRateBpm,
        maxHeartRateBpm = maxHeartRateBpm,
        source = sourceMetadata[sourceInstanceId].toResponse(),
    )

internal fun SleepSummaryRow.toResponse(
    sourceMetadata: Map<Int, SourceMetadata>,
): SleepSummaryResponse =
    SleepSummaryResponse(
        id = id,
        startAt = startAt,
        endAt = endAt,
        timeInBedSeconds = timeInBedSeconds,
        totalSleepSeconds = totalSleepSeconds,
        lightSleepSeconds = lightSleepSeconds,
        deepSleepSeconds = deepSleepSeconds,
        remSleepSeconds = remSleepSeconds,
        sleepEfficiencyPercent = sleepEfficiencyPercent,
        sleepLatencySeconds = sleepLatencySeconds,
        wakeupLatencySeconds = wakeupLatencySeconds,
        wakeupDurationSeconds = wakeupDurationSeconds,
        wakeupCount = wakeupCount,
        wasoSeconds = wasoSeconds,
        sleepScore = sleepScore,
        remEpisodesCount = remEpisodesCount,
        outOfBedCount = outOfBedCount,
        awakeDurationSeconds = awakeDurationSeconds,
        overnightHrvRmssd = overnightHrvRmssd,
        respiratoryRhythm = respiratoryRhythm,
        breathingQuality = breathingQuality,
        snoringDurationSeconds = snoringDurationSeconds,
        apneaHypopneaIndex = apneaHypopneaIndex,
        movementScore = movementScore,
        snoringEpisodeCount = snoringEpisodeCount,
        hrAverageBpm = hrAverageBpm,
        hrMinBpm = hrMinBpm,
        hrMaxBpm = hrMaxBpm,
        rrAverage = rrAverage,
        rrMin = rrMin,
        rrMax = rrMax,
        source = sourceMetadata[sourceInstanceId].toResponse(),
    )

internal fun HeartRateSampleRow.toResponse(
    sourceMetadata: Map<Int, SourceMetadata>,
): HeartRateSampleResponse =
    HeartRateSampleResponse(
        id = id,
        measuredAt = measuredAt,
        bpm = bpm,
        context = context,
        source = sourceMetadata[sourceInstanceId].toResponse(),
    )

internal fun RespiratoryRateSampleRow.toResponse(
    sourceMetadata: Map<Int, SourceMetadata>,
): RespiratoryRateSampleResponse =
    RespiratoryRateSampleResponse(
        id = id,
        measuredAt = measuredAt,
        breathsPerMinute = breathsPerMinute,
        context = context,
        source = sourceMetadata[sourceInstanceId].toResponse(),
    )

internal fun HrvSampleRow.toResponse(
    sourceMetadata: Map<Int, SourceMetadata>,
): HrvSampleResponse =
    HrvSampleResponse(
        id = id,
        measuredAt = measuredAt,
        metricType = metricType,
        value = value,
        unit = unit,
        context = context,
        source = sourceMetadata[sourceInstanceId].toResponse(),
    )

internal fun BloodPressureMeasurementRow.toResponse(
    sourceMetadata: Map<Int, SourceMetadata>,
): BloodPressureMeasurementResponse =
    BloodPressureMeasurementResponse(
        id = id,
        measuredAt = measuredAt,
        systolicMmhg = systolicMmhg,
        diastolicMmhg = diastolicMmhg,
        heartRateBpm = heartRateBpm,
        source = sourceMetadata[sourceInstanceId].toResponse(),
    )

internal fun CardiovascularMeasurementRow.toResponse(
    sourceMetadata: Map<Int, SourceMetadata>,
): CardiovascularMeasurementResponse =
    CardiovascularMeasurementResponse(
        id = id,
        measuredAt = measuredAt,
        metricType = metricType,
        value = value,
        unit = unit,
        source = sourceMetadata[sourceInstanceId].toResponse(),
    )

internal fun ExtendedBodyMeasurementRow.toResponse(
    sourceMetadata: Map<Int, SourceMetadata>,
): ExtendedBodyMeasurementResponse =
    ExtendedBodyMeasurementResponse(
        id = id,
        measuredAt = measuredAt,
        metricType = metricType,
        value = value,
        unit = unit,
        segment = segment,
        source = sourceMetadata[sourceInstanceId].toResponse(),
    )

internal fun SleepSessionRow.toResponse(
    stagesBySession: Map<Int, List<SleepStageRow>>,
    sourceMetadata: Map<Int, SourceMetadata>,
): SleepSessionResponse =
    SleepSessionResponse(
        id = id,
        startAt = startAt,
        endAt = endAt,
        durationSeconds = durationSeconds,
        stages = stagesBySession[id].orEmpty().map {
            SleepStageResponse(
                stage = it.stage,
                startAt = it.startAt,
                endAt = it.endAt,
                durationSeconds = it.durationSeconds,
            )
        },
        source = sourceMetadata[sourceInstanceId].toResponse(),
    )

internal fun SleepNightRow.toResponse(
    stagesBySession: Map<Int, List<SleepStageRow>>,
    sourceMetadata: Map<Int, SourceMetadata>,
): SleepNightResponse =
    SleepNightResponse(
        date = date,
        timezone = timezone,
        session = session.toResponse(stagesBySession, sourceMetadata),
    )

internal fun <T> List<T>.meta(filters: ReadFilters): ReadResponseMeta =
    ReadResponseMeta(
        count = size,
        limit = filters.limit,
        sort = filters.sort,
        order = filters.order,
    )

internal fun <T> List<T>.meta(filters: DailyReadFilters): ReadResponseMeta =
    ReadResponseMeta(
        count = size,
        limit = filters.limit,
        sort = filters.sort,
        order = filters.order,
    )

internal fun <T> List<T>.meta(filters: SleepNightReadFilters): ReadResponseMeta =
    ReadResponseMeta(
        count = size,
        limit = filters.limit,
        sort = filters.sort,
        order = filters.order,
    )


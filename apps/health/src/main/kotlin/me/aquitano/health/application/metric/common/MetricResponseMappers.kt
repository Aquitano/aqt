package me.aquitano.health.application.metric.common

import me.aquitano.health.api.dto.*
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.repository.DailyReadFilters
import me.aquitano.health.application.metric.common.repository.SleepNightReadFilters
import me.aquitano.health.application.metric.activity.repository.ActivitySummaryRow
import me.aquitano.health.application.metric.sleep.repository.SleepSummaryRow
import me.aquitano.health.application.metric.cardiovascular.repository.BloodPressureMeasurementRow
import me.aquitano.health.application.metric.sleep.repository.SleepSessionRow
import me.aquitano.health.application.metric.sleep.repository.SleepStageRow
import me.aquitano.health.application.metric.sleep.repository.SleepNightRow
import me.aquitano.health.shared.Cursor

internal fun SourceMetadata?.toResponse(): SourceMetadataResponse? =
    this?.let {
        SourceMetadataResponse(
            provider = it.provider,
            providerInstanceId = it.providerInstanceId,
        )
    }

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

internal fun <T> List<T>.meta(filters: ReadFilters, nextCursor: String? = null): ReadResponseMeta =
    ReadResponseMeta(
        count = size,
        limit = filters.limit,
        sort = filters.sort,
        order = filters.order,
        nextCursor = nextCursor,
    )

internal fun <T> List<T>.meta(filters: DailyReadFilters, nextCursor: String? = null): ReadResponseMeta =
    ReadResponseMeta(
        count = size,
        limit = filters.limit,
        sort = filters.sort,
        order = filters.order,
        nextCursor = nextCursor,
    )

internal fun <T> List<T>.meta(filters: SleepNightReadFilters, nextCursor: String? = null): ReadResponseMeta =
    ReadResponseMeta(
        count = size,
        limit = filters.limit,
        sort = filters.sort,
        order = filters.order,
        nextCursor = nextCursor,
    )

/**
 * One page of a keyset-paginated list. Repositories fetch limit+1 rows; the extra row only
 * signals that a next page exists and is dropped from [items].
 */
internal data class KeysetPage<T>(val items: List<T>, val nextCursor: String?)

internal fun keysetFetchLimit(limit: Int): Int =
    if (limit == Int.MAX_VALUE) Int.MAX_VALUE else limit + 1

internal fun <T> List<T>.keysetPage(
    limit: Int,
    sort: String,
    order: String,
    sortValue: (T) -> String,
    id: (T) -> Long,
): KeysetPage<T> =
    if (size > limit) {
        val items = take(limit)
        val last = items.last()
        KeysetPage(items, Cursor.encode(sortValue(last), id(last), order = order, field = sort))
    } else {
        KeysetPage(this, null)
    }

package me.aquitano.health.application.metric.scalar

import me.aquitano.health.api.dto.BodyMeasurementResponse
import me.aquitano.health.api.dto.CardiovascularMeasurementResponse
import me.aquitano.health.api.dto.ExtendedBodyMeasurementResponse
import me.aquitano.health.api.dto.HeartRateSampleResponse
import me.aquitano.health.api.dto.HrvSampleResponse
import me.aquitano.health.api.dto.RespiratoryRateSampleResponse
import me.aquitano.health.api.dto.SourceMetadataResponse
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import kotlin.math.roundToInt

private fun Map<Int, SourceMetadata>.responseFor(sourceInstanceId: Int): SourceMetadataResponse? =
    this[sourceInstanceId]?.let {
        SourceMetadataResponse(
            provider = it.provider,
            providerInstanceId = it.providerInstanceId,
        )
    }

internal fun ScalarSampleRow.toHeartRateResponse(
    sourceMetadata: Map<Int, SourceMetadata>,
): HeartRateSampleResponse =
    HeartRateSampleResponse(
        id = id.toInt(),
        measuredAt = measuredAt.toString(),
        bpm = value.roundToInt(),
        context = context ?: "unknown",
        source = sourceMetadata.responseFor(sourceInstanceId),
    )

internal fun ScalarSampleRow.toRespiratoryRateResponse(
    sourceMetadata: Map<Int, SourceMetadata>,
): RespiratoryRateSampleResponse =
    RespiratoryRateSampleResponse(
        id = id.toInt(),
        measuredAt = measuredAt.toString(),
        breathsPerMinute = value.roundToInt(),
        context = context ?: "unknown",
        source = sourceMetadata.responseFor(sourceInstanceId),
    )

internal fun ScalarSampleRow.toHrvResponse(
    sourceMetadata: Map<Int, SourceMetadata>,
): HrvSampleResponse =
    HrvSampleResponse(
        id = id.toInt(),
        measuredAt = measuredAt.toString(),
        metricType = metricType.removePrefix("hrv_"),
        value = value,
        unit = unit,
        context = context ?: "unknown",
        source = sourceMetadata.responseFor(sourceInstanceId),
    )

internal fun ScalarSampleRow.toBodyMeasurementResponse(
    sourceMetadata: Map<Int, SourceMetadata>,
): BodyMeasurementResponse =
    BodyMeasurementResponse(
        id = id.toInt(),
        measuredAt = measuredAt.toString(),
        metricType = metricType,
        value = value,
        unit = unit,
        source = sourceMetadata.responseFor(sourceInstanceId),
    )

internal fun ScalarSampleRow.toCardiovascularResponse(
    sourceMetadata: Map<Int, SourceMetadata>,
): CardiovascularMeasurementResponse =
    CardiovascularMeasurementResponse(
        id = id.toInt(),
        measuredAt = measuredAt.toString(),
        metricType = metricType,
        value = value,
        unit = unit,
        source = sourceMetadata.responseFor(sourceInstanceId),
    )

internal fun ScalarSampleRow.toExtendedBodyMeasurementResponse(
    sourceMetadata: Map<Int, SourceMetadata>,
): ExtendedBodyMeasurementResponse =
    ExtendedBodyMeasurementResponse(
        id = id.toInt(),
        measuredAt = measuredAt.toString(),
        metricType = metricType,
        value = value,
        unit = unit,
        segment = segment,
        source = sourceMetadata.responseFor(sourceInstanceId),
    )

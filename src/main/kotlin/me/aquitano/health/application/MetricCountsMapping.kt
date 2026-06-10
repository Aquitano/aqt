package me.aquitano.health.application

import me.aquitano.health.api.dto.MetricCreatedCountsResponse
import me.aquitano.health.domain.MetricCreatedCounts
import me.aquitano.health.domain.MetricKind

fun MetricCreatedCounts.toResponse(): MetricCreatedCountsResponse =
    MetricCreatedCountsResponse(
        stepSamples = this[MetricKind.STEP_SAMPLES],
        sleepSessions = this[MetricKind.SLEEP_SESSIONS],
        sleepStages = this[MetricKind.SLEEP_STAGES],
        bodyMeasurements = this[MetricKind.BODY_MEASUREMENTS],
        heartRateSamples = this[MetricKind.HEART_RATE_SAMPLES],
        activitySummaries = this[MetricKind.ACTIVITY_SUMMARIES],
        sleepSummaries = this[MetricKind.SLEEP_SUMMARIES],
        respiratoryRateSamples = this[MetricKind.RESPIRATORY_RATE_SAMPLES],
        hrvSamples = this[MetricKind.HRV_SAMPLES],
        bloodPressureMeasurements = this[MetricKind.BLOOD_PRESSURE_MEASUREMENTS],
        cardiovascularMeasurements = this[MetricKind.CARDIOVASCULAR_MEASUREMENTS],
        extendedBodyMeasurements = this[MetricKind.EXTENDED_BODY_MEASUREMENTS],
    )

fun MetricCreatedCountsResponse.toDomain(): MetricCreatedCounts =
    MetricCreatedCounts.of(
        MetricKind.STEP_SAMPLES to stepSamples,
        MetricKind.SLEEP_SESSIONS to sleepSessions,
        MetricKind.SLEEP_STAGES to sleepStages,
        MetricKind.BODY_MEASUREMENTS to bodyMeasurements,
        MetricKind.HEART_RATE_SAMPLES to heartRateSamples,
        MetricKind.ACTIVITY_SUMMARIES to activitySummaries,
        MetricKind.SLEEP_SUMMARIES to sleepSummaries,
        MetricKind.RESPIRATORY_RATE_SAMPLES to respiratoryRateSamples,
        MetricKind.HRV_SAMPLES to hrvSamples,
        MetricKind.BLOOD_PRESSURE_MEASUREMENTS to bloodPressureMeasurements,
        MetricKind.CARDIOVASCULAR_MEASUREMENTS to cardiovascularMeasurements,
        MetricKind.EXTENDED_BODY_MEASUREMENTS to extendedBodyMeasurements,
    )

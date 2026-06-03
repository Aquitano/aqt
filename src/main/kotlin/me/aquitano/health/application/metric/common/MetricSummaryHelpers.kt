package me.aquitano.health.application.metric.common

import me.aquitano.health.application.metric.hrv.repository.HrvSampleRow
import me.aquitano.health.application.metric.hrv.repository.HrvSummaryRow
import me.aquitano.health.application.metric.respiratory.repository.RespiratoryRateSampleRow
import me.aquitano.health.application.metric.respiratory.repository.RespiratoryRateSummaryRow

internal fun List<RespiratoryRateSampleRow>.respiratoryRateSummary(): RespiratoryRateSummaryRow =
    RespiratoryRateSummaryRow(
        count = size,
        minBreathsPerMinute = minOfOrNull { it.breathsPerMinute },
        maxBreathsPerMinute = maxOfOrNull { it.breathsPerMinute },
        avgBreathsPerMinute = if (isEmpty()) null else sumOf { it.breathsPerMinute }.toDouble() / size.toDouble(),
    )

internal fun List<HrvSampleRow>.hrvSummary(): HrvSummaryRow =
    HrvSummaryRow(
        count = size,
        minValue = minOfOrNull { it.value },
        maxValue = maxOfOrNull { it.value },
        avgValue = if (isEmpty()) null else sumOf { it.value } / size.toDouble(),
    )


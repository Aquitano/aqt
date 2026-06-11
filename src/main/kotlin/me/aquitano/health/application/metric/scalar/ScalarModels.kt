package me.aquitano.health.application.metric.scalar

import java.time.Instant

data class ScalarSampleRow(
    val id: Long,
    val sourceInstanceId: Int,
    val measuredAt: Instant,
    val metricType: String,
    val value: Double,
    val unit: String,
    val context: String?,
    val segment: String?,
)

data class ScalarSummaryRow(
    val count: Int,
    val minValue: Double?,
    val maxValue: Double?,
    val avgValue: Double?,
)

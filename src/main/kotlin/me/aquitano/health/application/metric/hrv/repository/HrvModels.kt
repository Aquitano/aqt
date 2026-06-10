package me.aquitano.health.application.metric.hrv.repository

import java.time.Instant

data class HrvSampleRow(
    val id: Int,
    val sourceInstanceId: Int,
    val measuredAt: Instant,
    val metricType: String,
    val value: Double,
    val unit: String,
    val context: String,
)

data class HrvSummaryRow(
    val count: Int,
    val minValue: Double?,
    val maxValue: Double?,
    val avgValue: Double?,
)

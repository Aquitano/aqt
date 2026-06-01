package me.aquitano.health.application.metric.respiratory.repository

data class RespiratoryRateSampleRow(
    val id: Int,
    val sourceInstanceId: Int,
    val measuredAt: String,
    val breathsPerMinute: Int,
    val context: String,
)

data class RespiratoryRateSummaryRow(
    val count: Int,
    val minBreathsPerMinute: Int?,
    val maxBreathsPerMinute: Int?,
    val avgBreathsPerMinute: Double?,
)


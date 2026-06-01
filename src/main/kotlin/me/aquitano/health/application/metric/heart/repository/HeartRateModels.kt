package me.aquitano.health.application.metric.heart.repository

data class HeartRateSampleRow(
    val id: Int,
    val sourceInstanceId: Int,
    val measuredAt: String,
    val bpm: Int,
    val context: String,
)

data class HeartRateSummaryRow(
    val count: Int,
    val minBpm: Int?,
    val maxBpm: Int?,
    val avgBpm: Double?,
)


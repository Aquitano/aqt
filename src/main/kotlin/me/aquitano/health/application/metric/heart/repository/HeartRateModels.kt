package me.aquitano.health.application.metric.heart.repository

import java.time.Instant

data class HeartRateSampleRow(
    val id: Int,
    val sourceInstanceId: Int,
    val measuredAt: Instant,
    val bpm: Int,
    val context: String,
)

data class HeartRateSummaryRow(
    val count: Int,
    val minBpm: Int?,
    val maxBpm: Int?,
    val avgBpm: Double?,
)

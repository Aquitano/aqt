package me.aquitano.health.api.dto

import kotlinx.serialization.Serializable

@Serializable
data class DashboardTrendsResponse(
    val periodDays: Int,
    val steps: StepsTrend? = null,
    val heartRate: HeartRateTrend? = null,
    val sleep: SleepTrend? = null,
    val weight: WeightTrend? = null,
)

@Serializable
data class StepsTrend(
    val currentTotal: Int,
    val previousTotal: Int,
    val percentChange: Double,
    val dailyAverage: Int,
)

@Serializable
data class HeartRateTrend(
    val currentAvg: Double,
    val previousAvg: Double,
    val percentChange: Double,
)

@Serializable
data class SleepTrend(
    val currentAvgSeconds: Long,
    val previousAvgSeconds: Long,
    val percentChange: Double,
)

@Serializable
data class WeightTrend(
    val latest: ScalarSampleResponse? = null,
    val previous: ScalarSampleResponse? = null,
    val delta: Double? = null,
    val percentChange: Double? = null,
)

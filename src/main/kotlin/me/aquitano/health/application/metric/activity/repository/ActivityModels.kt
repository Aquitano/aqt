package me.aquitano.health.application.metric.activity.repository

data class ActivitySummaryRow(
    val id: Int,
    val sourceInstanceId: Int,
    val date: String,
    val distanceMeters: Double?,
    val activeEnergyKcal: Double?,
    val totalEnergyKcal: Double?,
    val elevationMeters: Double?,
    val softMinutes: Int?,
    val moderateMinutes: Int?,
    val intenseMinutes: Int?,
    val activeMinutes: Int?,
    val averageHeartRateBpm: Int?,
    val minHeartRateBpm: Int?,
    val maxHeartRateBpm: Int?,
)


package me.aquitano.health.application.metric.cardiovascular.repository

data class BloodPressureMeasurementRow(
    val id: Int,
    val sourceInstanceId: Int,
    val measuredAt: String,
    val systolicMmhg: Int,
    val diastolicMmhg: Int,
    val heartRateBpm: Int?,
)


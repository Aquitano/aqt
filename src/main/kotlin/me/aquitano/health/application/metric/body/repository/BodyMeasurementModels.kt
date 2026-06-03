package me.aquitano.health.application.metric.body.repository

data class BodyMeasurementRow(
    val id: Int,
    val sourceInstanceId: Int,
    val measuredAt: String,
    val metricType: String,
    val value: Double,
    val unit: String,
)

data class ExtendedBodyMeasurementRow(
    val id: Int,
    val sourceInstanceId: Int,
    val measuredAt: String,
    val metricType: String,
    val value: Double,
    val unit: String,
    val segment: String?,
)


package me.aquitano.health.application.metric.steps.repository

data class StepSampleRow(
    val id: Int,
    val sourceInstanceId: Int,
    val startAt: String,
    val endAt: String,
    val steps: Int
)

data class StepDailySummaryRow(
    val sourceInstanceId: Int,
    val date: String,
    val steps: Int,
    val sampleCount: Int
)

data class DashboardStepsSummaryRow(
    val steps: Int,
    val sampleCount: Int,
)


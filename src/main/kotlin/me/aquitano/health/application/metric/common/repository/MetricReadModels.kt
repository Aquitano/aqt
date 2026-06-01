package me.aquitano.health.application.metric.common.repository

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

data class SourceMetadata(
    val provider: String,
    val providerInstanceId: String,
)

data class ReadFilters(
    val from: Instant?,
    val to: Instant?,
    val provider: String?,
    val providerInstanceId: String?,
    val includeSource: Boolean,
    val limit: Int,
    val sort: String,
    val order: String,
)

data class DailyReadFilters(
    val fromDate: LocalDate?,
    val toDate: LocalDate?,
    val provider: String?,
    val providerInstanceId: String?,
    val includeSource: Boolean,
    val limit: Int,
    val sort: String,
    val order: String,
)

data class SleepNightReadFilters(
    val fromDate: LocalDate?,
    val toDate: LocalDate?,
    val timezone: ZoneId,
    val provider: String?,
    val providerInstanceId: String?,
    val includeSource: Boolean,
    val limit: Int,
    val sort: String,
    val order: String,
)

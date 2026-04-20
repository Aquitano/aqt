package me.aquitano.health.api.dto

import kotlinx.serialization.Serializable

@Serializable
data class GoogleHealthOAuthStartResponse(
    val authorizationUrl: String,
    val expiresAt: String,
)

@Serializable
data class GoogleHealthOAuthCallbackResponse(
    val provider: String,
    val providerInstanceId: String,
    val connected: Boolean,
)

@Serializable
data class GoogleHealthSyncRequest(
    val from: String? = null,
    val to: String? = null,
    val dataTypes: List<String>? = null,
    val pageSize: Int? = null,
)

@Serializable
data class GoogleHealthSyncResponse(
    val provider: String,
    val providerInstanceId: String,
    val requestedRange: GoogleHealthRequestedRangeResponse,
    val batches: List<GoogleHealthSyncBatchResponse>,
    val errors: List<GoogleHealthSyncErrorResponse>,
)

@Serializable
data class GoogleHealthRequestedRangeResponse(
    val from: String,
    val to: String,
)

@Serializable
data class GoogleHealthSyncBatchResponse(
    val dataType: String,
    val batchId: Int,
    val duplicateBatch: Boolean,
    val recordsReceived: Int,
    val ingestionRecordsStored: Int,
    val metricsCreated: MetricCreatedCountsResponse,
    val metricsSkipped: MetricSkippedCountsResponse,
    val affectedStepSummaryDates: List<String>,
)

@Serializable
data class GoogleHealthSyncErrorResponse(
    val dataType: String,
    val code: String,
    val message: String,
)

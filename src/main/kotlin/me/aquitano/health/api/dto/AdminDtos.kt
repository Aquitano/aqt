package me.aquitano.health.api.dto

import kotlinx.serialization.Serializable

@Serializable
data class IngestionBatchesResponse(
    val items: List<IngestionBatchAdminResponse>,
)

@Serializable
data class IngestionBatchAdminResponse(
    val id: Int,
    val provider: String,
    val providerInstanceId: String,
    val batchExternalId: String?,
    val status: String,
    val ingestedAt: String,
    val receivedAt: String,
    val processedAt: String?,
    val errorMessage: String?,
    val recordCount: Int,
)

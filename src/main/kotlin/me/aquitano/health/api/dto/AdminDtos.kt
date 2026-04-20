package me.aquitano.health.api.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

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

@Serializable
data class IngestionBatchDetailResponse(
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
    val records: List<IngestionRecordAdminResponse>,
    val sourcePayload: JsonElement? = null,
    val normalizedPayload: JsonElement? = null,
)

@Serializable
data class IngestionRecordAdminResponse(
    val id: Int,
    val recordType: String,
    val providerRecordId: String?,
    val recordStartAt: String?,
    val recordEndAt: String?,
    val createdAt: String,
    val normalizedRecord: JsonElement? = null,
)

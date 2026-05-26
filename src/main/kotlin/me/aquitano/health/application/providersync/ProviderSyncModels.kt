package me.aquitano.health.application.providersync

import kotlinx.serialization.json.JsonObject
import me.aquitano.health.api.dto.IngestionRecordDto
import java.time.Instant

data class ProviderSyncPlan(
    val providerInstanceId: String?,
    val requestedFrom: Instant,
    val requestedTo: Instant,
    val items: List<ProviderSyncItem>,
)

data class ProviderSyncItem(
    val dataType: String,
    val from: Instant,
    val to: Instant,
    val pageSize: Int? = null,
)

data class SyncAccount(
    val id: Int,
    val providerCode: String,
    val providerUserId: String,
    val providerInstanceId: String,
    val encryptedAccessToken: String,
    val encryptedRefreshToken: String,
    val expiresAt: Instant,
    val accountStatus: String,
)

data class ProviderAccessToken(
    val accessToken: String,
    val refreshToken: String,
)

data class RefreshedTokenSet(
    val accessToken: String,
    val refreshToken: String?,
    val tokenType: String,
    val expiresAt: Instant,
    val scope: String?,
)

data class ProviderFetchedBatch(
    val dataType: String,
    val pagesFetched: Int,
    val sourceRecordsReceived: Int,
    val sourcePayload: JsonObject,
    val records: List<IngestionRecordDto>,
)

data class ProviderSourcePayloadContext(
    val providerCode: String,
    val providerInstanceId: String,
    val item: ProviderSyncItem,
    val fetched: ProviderFetchedBatch,
    val now: Instant,
)

data class ExistingProviderBatch(
    val id: Int,
    val status: String,
)

data class ProviderIngestionCommand(
    val providerCode: String,
    val providerInstanceId: String,
    val batchExternalId: String,
    val dataType: String,
    val ingestedAt: Instant,
    val sourcePayload: JsonObject,
    val records: List<IngestionRecordDto>,
)

package me.aquitano.health.application.providersync

import kotlinx.serialization.json.JsonObject
import me.aquitano.health.domain.ProviderSyncRequest
import java.time.Duration
import java.time.Instant

interface ProviderSyncAdapter {
    val providerCode: String
    val defaultSyncFailureMessage: String
    val tokenRefreshFailureCode: String
    val tokenRefreshFailureMessage: String
    val needsReauthCode: String
    val needsReauthMessage: String
    val recordEmptyDataTypes: Boolean
        get() = false
    val providerRequestInterval: Duration
        get() = Duration.ZERO

    fun validate(request: ProviderSyncRequest): ProviderSyncPlan

    fun accountUnavailable(
        providerInstanceId: String?,
        statusHint: SyncAccount?,
    ): Throwable

    suspend fun refreshAccessToken(
        refreshToken: String,
        account: SyncAccount,
        now: Instant,
    ): RefreshedTokenSet

    suspend fun fetch(
        accessToken: String,
        account: SyncAccount,
        item: ProviderSyncItem,
        now: Instant,
    ): ProviderFetchedBatch

    fun sourcePayload(context: ProviderSourcePayloadContext): JsonObject =
        context.fetched.sourcePayload

    fun batchExternalId(
        providerInstanceId: String,
        item: ProviderSyncItem,
    ): String

    fun isUnauthorized(error: Throwable): Boolean

    fun isInvalidRefreshToken(error: Throwable): Boolean

    fun errorCode(error: Throwable): String
}

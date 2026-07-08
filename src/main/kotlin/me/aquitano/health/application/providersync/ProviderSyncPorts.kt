package me.aquitano.health.application.providersync

import me.aquitano.health.domain.ProviderSyncBatch
import me.aquitano.health.domain.SyncStatus
import java.time.Instant

interface ProviderSyncAccountPort {
    suspend fun selectForSync(
        providerCode: String,
        providerInstanceId: String?,
    ): SyncAccount?

    suspend fun findAnyForStatusHint(
        providerCode: String,
        providerInstanceId: String?,
    ): SyncAccount?

    suspend fun decryptAccessToken(account: SyncAccount): String

    suspend fun decryptRefreshToken(account: SyncAccount): String

    suspend fun saveRefreshedToken(
        accountId: Int,
        tokens: RefreshedTokenSet,
        previousRefreshToken: String,
        now: Instant,
    )

    suspend fun markNeedsReauth(
        accountId: Int,
        code: String,
        message: String,
        now: Instant,
    )

    suspend fun markTokenRefreshFailed(
        accountId: Int,
        code: String,
        message: String,
        now: Instant,
    )
}

interface ProviderSyncRunPort {
    suspend fun start(
        providerCode: String,
        providerInstanceId: String,
        requestedFrom: Instant,
        requestedTo: Instant,
        startedAt: Instant,
    ): Int

    suspend fun finish(
        runId: Int,
        status: SyncStatus,
        finishedAt: Instant,
        errorMessage: String?,
    )
}

interface ProviderSyncIngestionPort {
    suspend fun findExistingBatch(
        providerCode: String,
        providerInstanceId: String,
        batchExternalId: String,
        now: Instant,
    ): ExistingProviderBatch?

    suspend fun ingest(
        command: ProviderIngestionCommand,
        now: Instant,
    ): ProviderSyncBatch
}

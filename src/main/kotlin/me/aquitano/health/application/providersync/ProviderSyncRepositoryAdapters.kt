package me.aquitano.health.application.providersync

import me.aquitano.health.api.dto.IngestionBatchRequest
import me.aquitano.health.application.IngestionService
import me.aquitano.health.domain.MetricCreatedCounts
import me.aquitano.health.domain.ProviderSyncBatch
import me.aquitano.health.infrastructure.repositories.ACCOUNT_STATUS_NEEDS_REAUTH
import me.aquitano.health.infrastructure.repositories.ProviderOAuthAccount
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.security.TokenCipher
import java.time.Instant

class ProviderOAuthSyncAccountPort(
    private val repository: ProviderOAuthRepository,
    tokenEncryptionKey: String,
) : ProviderSyncAccountPort {
    private val cipher by lazy { TokenCipher(tokenEncryptionKey) }

    override suspend fun selectForSync(
        providerCode: String,
        providerInstanceId: String?,
    ): SyncAccount? =
        if (providerInstanceId == null) {
            repository.latestAccount(providerCode)
        } else {
            repository.accountByProviderInstance(providerCode, providerInstanceId)
        }?.toSyncAccount()

    override suspend fun findAnyForStatusHint(
        providerCode: String,
        providerInstanceId: String?,
    ): SyncAccount? {
        val account = providerInstanceId
            ?.let { repository.accountByProviderInstanceForStatus(providerCode, it) }
            ?: repository.accountsByProvider(providerCode)
                .firstOrNull { it.accountStatus == ACCOUNT_STATUS_NEEDS_REAUTH }
        return account?.toSyncAccount()
    }

    override suspend fun decryptAccessToken(account: SyncAccount): String =
        cipher.decrypt(account.encryptedAccessToken)

    override suspend fun decryptRefreshToken(account: SyncAccount): String =
        cipher.decrypt(account.encryptedRefreshToken)

    override suspend fun saveRefreshedToken(
        accountId: Int,
        tokens: RefreshedTokenSet,
        previousRefreshToken: String,
        now: Instant,
    ) {
        repository.updateAccessToken(
            accountId = accountId,
            accessTokenCiphertext = cipher.encrypt(tokens.accessToken),
            refreshTokenCiphertext = tokens.refreshToken?.let(cipher::encrypt),
            tokenType = tokens.tokenType,
            expiresAt = tokens.expiresAt,
            scope = tokens.scope,
            now = now,
        )
    }

    override suspend fun markNeedsReauth(
        accountId: Int,
        code: String,
        message: String,
        now: Instant,
    ) {
        repository.markNeedsReauth(accountId, code, message, now)
    }

    override suspend fun markTokenRefreshFailed(
        accountId: Int,
        code: String,
        message: String,
        now: Instant,
    ) {
        repository.markTokenRefreshFailed(accountId, code, message, now)
    }
}

class ProviderOAuthSyncRunPort(
    private val repository: ProviderOAuthRepository,
) : ProviderSyncRunPort {
    override suspend fun start(
        providerCode: String,
        providerInstanceId: String,
        requestedFrom: Instant,
        requestedTo: Instant,
        startedAt: Instant,
    ): Int =
        repository.startSyncRun(
            providerCode = providerCode,
            providerInstanceId = providerInstanceId,
            requestedFrom = requestedFrom,
            requestedTo = requestedTo,
            startedAt = startedAt,
        )

    override suspend fun finish(
        runId: Int,
        status: String,
        finishedAt: Instant,
        errorMessage: String?,
    ) {
        repository.finishSyncRun(runId, status, finishedAt, errorMessage)
    }
}

class IngestionProviderSyncPort(
    private val ingestionService: IngestionService,
) : ProviderSyncIngestionPort {
    override suspend fun findExistingBatch(
        providerCode: String,
        providerInstanceId: String,
        batchExternalId: String,
        now: Instant,
    ): ExistingProviderBatch? =
        ingestionService.findExistingBatch(
            provider = providerCode,
            providerInstanceId = providerInstanceId,
            batchExternalId = batchExternalId,
            now = now,
        )?.let { ExistingProviderBatch(it.id, it.status) }

    override suspend fun ingest(
        command: ProviderIngestionCommand,
        now: Instant,
    ): ProviderSyncBatch {
        val summary = ingestionService.ingestBatch(
            IngestionBatchRequest(
                provider = command.providerCode,
                providerInstanceId = command.providerInstanceId,
                batchExternalId = command.batchExternalId,
                ingestedAt = command.ingestedAt.toString(),
                sourcePayload = command.sourcePayload,
                records = command.records,
            ),
            now = now,
        )
        return ProviderSyncBatch(
            dataType = command.dataType,
            batchId = summary.batchId,
            duplicateBatch = summary.duplicateBatch,
            recordsReceived = summary.recordsReceived,
            ingestionRecordsStored = summary.ingestionRecordsStored,
            metricsCreated = MetricCreatedCounts(summary.metricsCreated),
            duplicateMetricsSkipped = summary.metricsSkipped.duplicates,
            affectedStepSummaryDates = summary.affectedStepSummaryDates,
        )
    }
}

private fun ProviderOAuthAccount.toSyncAccount(): SyncAccount =
    SyncAccount(
        id = id,
        providerCode = providerCode,
        providerUserId = providerUserId,
        providerInstanceId = providerInstanceId,
        encryptedAccessToken = accessTokenCiphertext,
        encryptedRefreshToken = refreshTokenCiphertext,
        expiresAt = expiresAt,
        accountStatus = accountStatus,
    )

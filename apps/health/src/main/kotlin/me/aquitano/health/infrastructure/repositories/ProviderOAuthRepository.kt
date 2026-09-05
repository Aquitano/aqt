package me.aquitano.health.infrastructure.repositories

import me.aquitano.health.infrastructure.database.toDbTimestamp
import me.aquitano.health.infrastructure.database.tables.ProviderOAuthAccountsTable
import me.aquitano.health.infrastructure.database.tables.ProviderOAuthStatesTable
import me.aquitano.health.infrastructure.database.tables.ProviderSyncRunsTable
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.*
import me.aquitano.health.infrastructure.database.suspendDbTransaction
import java.time.Instant

data class ProviderOAuthAccount(
    val id: Int,
    val providerCode: String,
    val providerUserId: String,
    val providerInstanceId: String,
    val accessTokenCiphertext: String,
    val refreshTokenCiphertext: String,
    val tokenType: String,
    val expiresAt: Instant,
    val scope: String,
    val accountStatus: String,
    val connectedAt: Instant?,
    val disconnectedAt: Instant?,
    val lastTokenRefreshAt: Instant?,
    val lastTokenRefreshStatus: String?,
    val lastAuthErrorCode: String?,
    val lastAuthErrorMessage: String?,
    val createdAt: Instant,
    val updatedAt: Instant,
) {
    fun isConnectedForSync(): Boolean =
        accountStatus == ACCOUNT_STATUS_CONNECTED &&
                accessTokenCiphertext.isNotBlank() &&
                refreshTokenCiphertext.isNotBlank()
}

const val ACCOUNT_STATUS_CONNECTED = "connected"
const val ACCOUNT_STATUS_NEEDS_REAUTH = "needs_reauth"
const val ACCOUNT_STATUS_DISCONNECTED = "disconnected"

const val TOKEN_REFRESH_STATUS_SUCCESS = "success"
const val TOKEN_REFRESH_STATUS_FAILED = "failed"

data class ProviderOAuthState(
    val state: String,
    val providerCode: String,
    val expiresAt: Instant,
    val consumedAt: Instant?,
)

sealed class ProviderOAuthStateConsumeResult {
    data class Consumed(val state: ProviderOAuthState) :
        ProviderOAuthStateConsumeResult()

    data class AlreadyUsed(val state: ProviderOAuthState) :
        ProviderOAuthStateConsumeResult()

    data class Expired(val state: ProviderOAuthState) :
        ProviderOAuthStateConsumeResult()

    data object NotFound : ProviderOAuthStateConsumeResult()
}

class ProviderOAuthRepository(private val database: Database) {
    suspend fun insertState(
        state: String,
        providerCode: String,
        createdAt: Instant,
        expiresAt: Instant,
    ) {
        suspendDbTransaction(db = database) {
            ProviderOAuthStatesTable.insert {
                it[this.state] = state
                it[this.providerCode] = providerCode
                it[this.createdAt] = createdAt.toDbTimestamp()
                it[this.expiresAt] = expiresAt.toDbTimestamp()
                it[consumedAt] = null
            }
        }
    }

    suspend fun consumeState(
        state: String,
        providerCode: String,
        now: Instant,
    ): ProviderOAuthStateConsumeResult =
        suspendDbTransaction(db = database) {
            val nowTimestamp = now.toDbTimestamp()
            val updated = ProviderOAuthStatesTable.update({
                (ProviderOAuthStatesTable.state eq state) and
                        (ProviderOAuthStatesTable.providerCode eq providerCode) and
                        ProviderOAuthStatesTable.consumedAt.isNull() and
                        (ProviderOAuthStatesTable.expiresAt greater nowTimestamp)
            }) {
                it[consumedAt] = nowTimestamp
            }

            if (updated == 1) {
                val consumedRow = ProviderOAuthStatesTable
                    .selectAll()
                    .where {
                        (ProviderOAuthStatesTable.state eq state) and
                                (ProviderOAuthStatesTable.providerCode eq providerCode)
                    }
                    .limit(1)
                    .singleOrNull()
                    ?: return@suspendDbTransaction ProviderOAuthStateConsumeResult.NotFound
                return@suspendDbTransaction ProviderOAuthStateConsumeResult.Consumed(
                    consumedRow.toOAuthState()
                )
            }

            val existingRow = ProviderOAuthStatesTable
                .selectAll()
                .where {
                    (ProviderOAuthStatesTable.state eq state) and
                            (ProviderOAuthStatesTable.providerCode eq providerCode)
                }
                .limit(1)
                .singleOrNull()
                ?: return@suspendDbTransaction ProviderOAuthStateConsumeResult.NotFound

            val existing = existingRow.toOAuthState()
            return@suspendDbTransaction when {
                existing.consumedAt != null -> ProviderOAuthStateConsumeResult.AlreadyUsed(
                    existing
                )

                !now.isBefore(existing.expiresAt) -> ProviderOAuthStateConsumeResult.Expired(
                    existing
                )

                else -> ProviderOAuthStateConsumeResult.AlreadyUsed(existing)
            }
        }

    suspend fun upsertAccount(
        providerCode: String,
        providerUserId: String,
        providerInstanceId: String,
        accessTokenCiphertext: String,
        refreshTokenCiphertext: String,
        tokenType: String,
        expiresAt: Instant,
        scope: String,
        now: Instant,
    ) {
        suspendDbTransaction(db = database) {
            val nowTimestamp = now.toDbTimestamp()
            val existing = ProviderOAuthAccountsTable
                .selectAll()
                .where {
                    (ProviderOAuthAccountsTable.providerCode eq providerCode) and
                            (ProviderOAuthAccountsTable.providerUserId eq providerUserId)
                }
                .limit(1)
                .singleOrNull()

            if (existing == null) {
                ProviderOAuthAccountsTable.insert {
                    it[this.providerCode] = providerCode
                    it[this.providerUserId] = providerUserId
                    it[this.providerInstanceId] = providerInstanceId
                    it[this.accessTokenCiphertext] = accessTokenCiphertext
                    it[this.refreshTokenCiphertext] = refreshTokenCiphertext
                    it[this.tokenType] = tokenType
                    it[this.expiresAt] = expiresAt.toDbTimestamp()
                    it[this.scope] = scope
                    it[accountStatus] = ACCOUNT_STATUS_CONNECTED
                    it[connectedAt] = nowTimestamp
                    it[disconnectedAt] = null
                    it[lastTokenRefreshAt] = null
                    it[lastTokenRefreshStatus] = null
                    it[lastAuthErrorCode] = null
                    it[lastAuthErrorMessage] = null
                    it[createdAt] = nowTimestamp
                    it[updatedAt] = nowTimestamp
                }
            } else {
                val previousStatus = existing[ProviderOAuthAccountsTable.accountStatus]
                val previousConnectedAt = existing[ProviderOAuthAccountsTable.connectedAt]
                val nextConnectedAt =
                    if (previousStatus == ACCOUNT_STATUS_DISCONNECTED || previousStatus == ACCOUNT_STATUS_NEEDS_REAUTH) {
                        nowTimestamp
                    } else {
                        previousConnectedAt ?: nowTimestamp
                    }
                ProviderOAuthAccountsTable.update({
                    ProviderOAuthAccountsTable.id eq existing[ProviderOAuthAccountsTable.id]
                }) {
                    it[this.providerInstanceId] = providerInstanceId
                    it[this.accessTokenCiphertext] = accessTokenCiphertext
                    it[this.refreshTokenCiphertext] = refreshTokenCiphertext
                    it[this.tokenType] = tokenType
                    it[this.expiresAt] = expiresAt.toDbTimestamp()
                    it[this.scope] = scope
                    it[accountStatus] = ACCOUNT_STATUS_CONNECTED
                    it[connectedAt] = nextConnectedAt
                    it[disconnectedAt] = null
                    it[lastTokenRefreshAt] = null
                    it[lastTokenRefreshStatus] = null
                    it[lastAuthErrorCode] = null
                    it[lastAuthErrorMessage] = null
                    it[updatedAt] = nowTimestamp
                }
            }
        }
    }

    suspend fun updateAccessToken(
        accountId: Int,
        accessTokenCiphertext: String,
        refreshTokenCiphertext: String?,
        tokenType: String,
        expiresAt: Instant,
        scope: String?,
        now: Instant,
    ) {
        suspendDbTransaction(db = database) {
            ProviderOAuthAccountsTable.update({ ProviderOAuthAccountsTable.id eq accountId }) {
                it[this.accessTokenCiphertext] = accessTokenCiphertext
                refreshTokenCiphertext?.let { value ->
                    it[this.refreshTokenCiphertext] = value
                }
                it[this.tokenType] = tokenType
                it[this.expiresAt] = expiresAt.toDbTimestamp()
                scope?.let { value -> it[this.scope] = value }
                it[accountStatus] = ACCOUNT_STATUS_CONNECTED
                it[lastTokenRefreshAt] = now.toDbTimestamp()
                it[lastTokenRefreshStatus] = TOKEN_REFRESH_STATUS_SUCCESS
                it[lastAuthErrorCode] = null
                it[lastAuthErrorMessage] = null
                it[updatedAt] = now.toDbTimestamp()
            }
        }
    }

    suspend fun markNeedsReauth(
        accountId: Int,
        errorCode: String,
        errorMessage: String,
        now: Instant,
    ) {
        suspendDbTransaction(db = database) {
            ProviderOAuthAccountsTable.update({ ProviderOAuthAccountsTable.id eq accountId }) {
                it[accountStatus] = ACCOUNT_STATUS_NEEDS_REAUTH
                it[lastTokenRefreshAt] = now.toDbTimestamp()
                it[lastTokenRefreshStatus] = TOKEN_REFRESH_STATUS_FAILED
                it[lastAuthErrorCode] = errorCode.take(200)
                it[lastAuthErrorMessage] = errorMessage.take(1000)
                it[updatedAt] = now.toDbTimestamp()
            }
        }
    }

    suspend fun markTokenRefreshFailed(
        accountId: Int,
        errorCode: String,
        errorMessage: String,
        now: Instant,
    ) {
        suspendDbTransaction(db = database) {
            ProviderOAuthAccountsTable.update({ ProviderOAuthAccountsTable.id eq accountId }) {
                it[lastTokenRefreshAt] = now.toDbTimestamp()
                it[lastTokenRefreshStatus] = TOKEN_REFRESH_STATUS_FAILED
                it[lastAuthErrorCode] = errorCode.take(200)
                it[lastAuthErrorMessage] = errorMessage.take(1000)
                it[updatedAt] = now.toDbTimestamp()
            }
        }
    }

    suspend fun disconnectAccount(
        providerCode: String,
        providerInstanceId: String,
        now: Instant,
    ): Boolean =
        suspendDbTransaction(db = database) {
            val updated = ProviderOAuthAccountsTable.update({
                (ProviderOAuthAccountsTable.providerCode eq providerCode) and
                        (ProviderOAuthAccountsTable.providerInstanceId eq providerInstanceId)
            }) {
                it[accessTokenCiphertext] = ""
                it[refreshTokenCiphertext] = ""
                it[accountStatus] = ACCOUNT_STATUS_DISCONNECTED
                it[disconnectedAt] = now.toDbTimestamp()
                it[lastTokenRefreshAt] = null
                it[lastTokenRefreshStatus] = null
                it[lastAuthErrorCode] = null
                it[lastAuthErrorMessage] = null
                it[updatedAt] = now.toDbTimestamp()
            }
            updated > 0
        }

    suspend fun latestAccount(providerCode: String): ProviderOAuthAccount? =
        suspendDbTransaction(db = database) {
            ProviderOAuthAccountsTable
                .selectAll()
                .where {
                    (ProviderOAuthAccountsTable.providerCode eq providerCode) and
                            (ProviderOAuthAccountsTable.accountStatus eq ACCOUNT_STATUS_CONNECTED) and
                            (ProviderOAuthAccountsTable.accessTokenCiphertext neq "") and
                            (ProviderOAuthAccountsTable.refreshTokenCiphertext neq "")
                }
                .orderBy(ProviderOAuthAccountsTable.updatedAt to SortOrder.DESC)
                .limit(1)
                .map { it.toOAuthAccount() }
                .singleOrNull()
        }

    suspend fun accountsByProvider(
        providerCode: String,
        includeDisconnected: Boolean = true,
    ): List<ProviderOAuthAccount> =
        suspendDbTransaction(db = database) {
            ProviderOAuthAccountsTable
                .selectAll()
                .where {
                    if (includeDisconnected) {
                        ProviderOAuthAccountsTable.providerCode eq providerCode
                    } else {
                        (ProviderOAuthAccountsTable.providerCode eq providerCode) and
                                (ProviderOAuthAccountsTable.accountStatus neq ACCOUNT_STATUS_DISCONNECTED)
                    }
                }
                .orderBy(ProviderOAuthAccountsTable.updatedAt to SortOrder.DESC)
                .map { it.toOAuthAccount() }
        }

    suspend fun accountByProviderInstance(
        providerCode: String,
        providerInstanceId: String,
    ): ProviderOAuthAccount? =
        suspendDbTransaction(db = database) {
            ProviderOAuthAccountsTable
                .selectAll()
                .where {
                    (ProviderOAuthAccountsTable.providerCode eq providerCode) and
                            (ProviderOAuthAccountsTable.providerInstanceId eq providerInstanceId) and
                            (ProviderOAuthAccountsTable.accountStatus eq ACCOUNT_STATUS_CONNECTED) and
                            (ProviderOAuthAccountsTable.accessTokenCiphertext neq "") and
                            (ProviderOAuthAccountsTable.refreshTokenCiphertext neq "")
                }
                .limit(1)
                .map { it.toOAuthAccount() }
                .singleOrNull()
        }

    suspend fun accountByProviderInstanceForStatus(
        providerCode: String,
        providerInstanceId: String,
    ): ProviderOAuthAccount? =
        suspendDbTransaction(db = database) {
            ProviderOAuthAccountsTable
                .selectAll()
                .where {
                    (ProviderOAuthAccountsTable.providerCode eq providerCode) and
                            (ProviderOAuthAccountsTable.providerInstanceId eq providerInstanceId)
                }
                .limit(1)
                .map { it.toOAuthAccount() }
                .singleOrNull()
        }

    suspend fun latestFinishedSyncAt(
        providerCode: String,
        providerInstanceId: String
    ): Instant? =
        suspendDbTransaction(db = database) {
            ProviderSyncRunsTable
                .select(ProviderSyncRunsTable.finishedAt)
                .where {
                    (ProviderSyncRunsTable.providerCode eq providerCode) and
                            (ProviderSyncRunsTable.providerInstanceId eq providerInstanceId) and
                            ProviderSyncRunsTable.finishedAt.isNotNull()
                }
                .orderBy(ProviderSyncRunsTable.finishedAt to SortOrder.DESC)
                .limit(1)
                .singleOrNull()
                ?.get(ProviderSyncRunsTable.finishedAt)
                ?.toInstant()
        }

    suspend fun startSyncRun(
        providerCode: String,
        providerInstanceId: String,
        requestedFrom: Instant,
        requestedTo: Instant,
        startedAt: Instant,
    ): Int =
        suspendDbTransaction(db = database) {
            ProviderSyncRunsTable.insertAndGetId {
                it[this.providerCode] = providerCode
                it[this.providerInstanceId] = providerInstanceId
                it[this.requestedFrom] = requestedFrom.toDbTimestamp()
                it[this.requestedTo] = requestedTo.toDbTimestamp()
                it[status] = "running"
                it[this.startedAt] = startedAt.toDbTimestamp()
                it[finishedAt] = null
                it[errorMessage] = null
            }.value
        }

    suspend fun finishSyncRun(
        runId: Int,
        status: String,
        finishedAt: Instant,
        errorMessage: String?,
    ) {
        suspendDbTransaction(db = database) {
            ProviderSyncRunsTable.update({ ProviderSyncRunsTable.id eq runId }) {
                it[this.status] = status
                it[this.finishedAt] = finishedAt.toDbTimestamp()
                it[this.errorMessage] = errorMessage?.take(2000)
            }
        }
    }

    private fun ResultRow.toOAuthState(): ProviderOAuthState =
        ProviderOAuthState(
            state = this[ProviderOAuthStatesTable.state],
            providerCode = this[ProviderOAuthStatesTable.providerCode],
            expiresAt = this[ProviderOAuthStatesTable.expiresAt].toInstant(),
            consumedAt = this[ProviderOAuthStatesTable.consumedAt]?.toInstant(),
        )

    private fun ResultRow.toOAuthAccount(): ProviderOAuthAccount =
        ProviderOAuthAccount(
            id = this[ProviderOAuthAccountsTable.id].value,
            providerCode = this[ProviderOAuthAccountsTable.providerCode],
            providerUserId = this[ProviderOAuthAccountsTable.providerUserId],
            providerInstanceId = this[ProviderOAuthAccountsTable.providerInstanceId],
            accessTokenCiphertext = this[ProviderOAuthAccountsTable.accessTokenCiphertext],
            refreshTokenCiphertext = this[ProviderOAuthAccountsTable.refreshTokenCiphertext],
            tokenType = this[ProviderOAuthAccountsTable.tokenType],
            expiresAt = this[ProviderOAuthAccountsTable.expiresAt].toInstant(),
            scope = this[ProviderOAuthAccountsTable.scope],
            accountStatus = this[ProviderOAuthAccountsTable.accountStatus],
            connectedAt = this[ProviderOAuthAccountsTable.connectedAt]?.toInstant(),
            disconnectedAt = this[ProviderOAuthAccountsTable.disconnectedAt]?.toInstant(),
            lastTokenRefreshAt = this[ProviderOAuthAccountsTable.lastTokenRefreshAt]?.toInstant(),
            lastTokenRefreshStatus = this[ProviderOAuthAccountsTable.lastTokenRefreshStatus],
            lastAuthErrorCode = this[ProviderOAuthAccountsTable.lastAuthErrorCode],
            lastAuthErrorMessage = this[ProviderOAuthAccountsTable.lastAuthErrorMessage],
            createdAt = this[ProviderOAuthAccountsTable.createdAt].toInstant(),
            updatedAt = this[ProviderOAuthAccountsTable.updatedAt].toInstant(),
        )
}

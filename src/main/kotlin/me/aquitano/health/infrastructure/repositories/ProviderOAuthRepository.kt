package me.aquitano.health.infrastructure.repositories

import kotlinx.coroutines.Dispatchers
import me.aquitano.health.infrastructure.database.tables.ProviderOAuthAccountsTable
import me.aquitano.health.infrastructure.database.tables.ProviderOAuthStatesTable
import me.aquitano.health.infrastructure.database.tables.ProviderSyncRunsTable
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.transactions.experimental.newSuspendedTransaction
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
)

data class ProviderOAuthState(
    val state: String,
    val providerCode: String,
    val expiresAt: Instant,
    val consumedAt: Instant?,
)

sealed class ProviderOAuthStateConsumeResult {
    data class Consumed(val state: ProviderOAuthState) : ProviderOAuthStateConsumeResult()
    data class AlreadyUsed(val state: ProviderOAuthState) : ProviderOAuthStateConsumeResult()
    data class Expired(val state: ProviderOAuthState) : ProviderOAuthStateConsumeResult()
    data object NotFound : ProviderOAuthStateConsumeResult()
}

class ProviderOAuthRepository(private val database: Database) {
    suspend fun insertState(
        state: String,
        providerCode: String,
        createdAt: Instant,
        expiresAt: Instant,
    ) {
        newSuspendedTransaction(Dispatchers.IO, db = database) {
            ProviderOAuthStatesTable.insert {
                it[this.state] = state
                it[this.providerCode] = providerCode
                it[this.createdAt] = createdAt.toString()
                it[this.expiresAt] = expiresAt.toString()
                it[consumedAt] = null
            }
        }
    }

    suspend fun consumeState(
        state: String,
        providerCode: String,
        now: Instant,
    ): ProviderOAuthStateConsumeResult =
        newSuspendedTransaction(Dispatchers.IO, db = database) {
            val nowString = now.toString()
            val updated = ProviderOAuthStatesTable.update({
                (ProviderOAuthStatesTable.state eq state) and
                        (ProviderOAuthStatesTable.providerCode eq providerCode) and
                        ProviderOAuthStatesTable.consumedAt.isNull() and
                        (ProviderOAuthStatesTable.expiresAt greater nowString)
            }) {
                it[consumedAt] = nowString
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
                    ?: return@newSuspendedTransaction ProviderOAuthStateConsumeResult.NotFound
                return@newSuspendedTransaction ProviderOAuthStateConsumeResult.Consumed(consumedRow.toOAuthState())
            }

            val existingRow = ProviderOAuthStatesTable
                .selectAll()
                .where {
                    (ProviderOAuthStatesTable.state eq state) and
                            (ProviderOAuthStatesTable.providerCode eq providerCode)
                }
                .limit(1)
                .singleOrNull()
                ?: return@newSuspendedTransaction ProviderOAuthStateConsumeResult.NotFound

            val existing = existingRow.toOAuthState()
            return@newSuspendedTransaction when {
                existing.consumedAt != null -> ProviderOAuthStateConsumeResult.AlreadyUsed(existing)
                !now.isBefore(existing.expiresAt) -> ProviderOAuthStateConsumeResult.Expired(existing)
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
        newSuspendedTransaction(Dispatchers.IO, db = database) {
            val existingId = ProviderOAuthAccountsTable
                .select(ProviderOAuthAccountsTable.id)
                .where {
                    (ProviderOAuthAccountsTable.providerCode eq providerCode) and
                            (ProviderOAuthAccountsTable.providerUserId eq providerUserId)
                }
                .limit(1)
                .singleOrNull()
                ?.get(ProviderOAuthAccountsTable.id)

            if (existingId == null) {
                ProviderOAuthAccountsTable.insert {
                    it[this.providerCode] = providerCode
                    it[this.providerUserId] = providerUserId
                    it[this.providerInstanceId] = providerInstanceId
                    it[this.accessTokenCiphertext] = accessTokenCiphertext
                    it[this.refreshTokenCiphertext] = refreshTokenCiphertext
                    it[this.tokenType] = tokenType
                    it[this.expiresAt] = expiresAt.toString()
                    it[this.scope] = scope
                    it[createdAt] = now.toString()
                    it[updatedAt] = now.toString()
                }
            } else {
                ProviderOAuthAccountsTable.update({ ProviderOAuthAccountsTable.id eq existingId }) {
                    it[this.providerInstanceId] = providerInstanceId
                    it[this.accessTokenCiphertext] = accessTokenCiphertext
                    it[this.refreshTokenCiphertext] = refreshTokenCiphertext
                    it[this.tokenType] = tokenType
                    it[this.expiresAt] = expiresAt.toString()
                    it[this.scope] = scope
                    it[updatedAt] = now.toString()
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
        newSuspendedTransaction(Dispatchers.IO, db = database) {
            ProviderOAuthAccountsTable.update({ ProviderOAuthAccountsTable.id eq accountId }) {
                it[this.accessTokenCiphertext] = accessTokenCiphertext
                refreshTokenCiphertext?.let { value -> it[this.refreshTokenCiphertext] = value }
                it[this.tokenType] = tokenType
                it[this.expiresAt] = expiresAt.toString()
                scope?.let { value -> it[this.scope] = value }
                it[updatedAt] = now.toString()
            }
        }
    }

    suspend fun latestAccount(providerCode: String): ProviderOAuthAccount? =
        newSuspendedTransaction(Dispatchers.IO, db = database) {
            ProviderOAuthAccountsTable
                .selectAll()
                .where { ProviderOAuthAccountsTable.providerCode eq providerCode }
                .orderBy(ProviderOAuthAccountsTable.updatedAt to SortOrder.DESC)
                .limit(1)
                .map { it.toOAuthAccount() }
                .singleOrNull()
        }

    suspend fun startSyncRun(
        providerCode: String,
        providerInstanceId: String,
        requestedFrom: Instant,
        requestedTo: Instant,
        startedAt: Instant,
    ): Int =
        newSuspendedTransaction(Dispatchers.IO, db = database) {
            ProviderSyncRunsTable.insertAndGetId {
                it[this.providerCode] = providerCode
                it[this.providerInstanceId] = providerInstanceId
                it[this.requestedFrom] = requestedFrom.toString()
                it[this.requestedTo] = requestedTo.toString()
                it[status] = "running"
                it[this.startedAt] = startedAt.toString()
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
        newSuspendedTransaction(Dispatchers.IO, db = database) {
            ProviderSyncRunsTable.update({ ProviderSyncRunsTable.id eq runId }) {
                it[this.status] = status
                it[this.finishedAt] = finishedAt.toString()
                it[this.errorMessage] = errorMessage?.take(2000)
            }
        }
    }

    private fun ResultRow.toOAuthState(): ProviderOAuthState =
        ProviderOAuthState(
            state = this[ProviderOAuthStatesTable.state],
            providerCode = this[ProviderOAuthStatesTable.providerCode],
            expiresAt = Instant.parse(this[ProviderOAuthStatesTable.expiresAt]),
            consumedAt = this[ProviderOAuthStatesTable.consumedAt]?.let(Instant::parse),
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
            expiresAt = Instant.parse(this[ProviderOAuthAccountsTable.expiresAt]),
            scope = this[ProviderOAuthAccountsTable.scope],
        )
}

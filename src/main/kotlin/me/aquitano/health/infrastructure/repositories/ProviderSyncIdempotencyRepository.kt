package me.aquitano.health.infrastructure.repositories

import me.aquitano.health.infrastructure.database.suspendDbTransaction
import me.aquitano.health.infrastructure.database.tables.ProviderSyncIdempotencyTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.insertIgnore
import org.jetbrains.exposed.v1.jdbc.selectAll
import java.time.Instant

data class ProviderSyncIdempotencyRecord(
    val requestHash: String,
    val responseJson: String,
)

/** Stores responses of the synchronous provider sync endpoint keyed by Idempotency-Key. */
class ProviderSyncIdempotencyRepository(private val database: Database) {
    suspend fun findResponse(
        providerCode: String,
        idempotencyKey: String,
    ): ProviderSyncIdempotencyRecord? =
        suspendDbTransaction(db = database) {
            ProviderSyncIdempotencyTable
                .selectAll()
                .where {
                    (ProviderSyncIdempotencyTable.providerCode eq providerCode) and
                        (ProviderSyncIdempotencyTable.idempotencyKey eq idempotencyKey)
                }
                .limit(1)
                .map {
                    ProviderSyncIdempotencyRecord(
                        requestHash = it[ProviderSyncIdempotencyTable.requestHash],
                        responseJson = it[ProviderSyncIdempotencyTable.responseJson],
                    )
                }
                .singleOrNull()
        }

    suspend fun storeResponse(
        providerCode: String,
        idempotencyKey: String,
        requestHash: String,
        responseJson: String,
        now: Instant,
    ) {
        suspendDbTransaction(db = database) {
            // Last-resort guard; ProviderWorkflowService serializes same-key requests in-process.
            ProviderSyncIdempotencyTable.insertIgnore {
                it[this.providerCode] = providerCode
                it[this.idempotencyKey] = idempotencyKey
                it[this.requestHash] = requestHash
                it[this.responseJson] = responseJson
                it[createdAt] = now.toDbTimestamp()
            }
        }
    }
}

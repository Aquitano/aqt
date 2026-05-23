package me.aquitano.health.infrastructure.repositories

import me.aquitano.health.infrastructure.database.dao.ApiClientDao
import me.aquitano.health.infrastructure.database.toDbTimestamp
import me.aquitano.health.infrastructure.database.tables.ApiClientsTable
import me.aquitano.health.infrastructure.database.tables.SourceInstancesTable
import me.aquitano.health.infrastructure.database.tables.SourcesTable
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.insertIgnoreAndGetId
import org.jetbrains.exposed.v1.jdbc.select
import org.jetbrains.exposed.v1.jdbc.transactions.suspendTransaction
import org.jetbrains.exposed.v1.jdbc.transactions.transaction
import java.time.Instant
import java.time.OffsetDateTime

data class SourceInstanceRef(
    val id: Int,
    val provider: String,
    val providerInstanceId: String,
)

data class ApiClientRef(
    val id: Int,
    val name: String,
)

private const val API_CLIENT_LAST_USED_UPDATE_INTERVAL_SECONDS = 60L

class SupportRepository(
    private val database: Database,
) {
    fun createBootstrapApiClientIfMissing(
        name: String,
        apiKeyHash: String,
        now: Instant
    ): Boolean =
        transaction(database) {
            val existing =
                ApiClientDao.find { ApiClientsTable.name eq name }.firstOrNull()
            if (existing != null) {
                false
            } else {
                ApiClientDao.new {
                    this.name = name
                    this.apiKeyHash = apiKeyHash
                    enabled = true
                    createdAt = now.toDbTimestamp()
                    lastUsedAt = null
                }
                true
            }
        }

    suspend fun findEnabledApiClientByHash(
        apiKeyHash: String,
        now: Instant
    ): ApiClientRef? =
        dbQuery {
            val client = ApiClientDao
                .find { (ApiClientsTable.apiKeyHash eq apiKeyHash) and (ApiClientsTable.enabled eq true) }
                .firstOrNull()
                ?: return@dbQuery null
            if (shouldUpdateLastUsedAt(client.lastUsedAt, now)) {
                client.lastUsedAt = now.toDbTimestamp()
            }
            ApiClientRef(id = client.id.value, name = client.name)
        }

    suspend fun resolveOrCreateSourceInstance(
        provider: String,
        providerInstanceId: String,
        now: Instant
    ): SourceInstanceRef =
        dbQuery {
            resolveOrCreateSourceInstanceInTransaction(
                provider,
                providerInstanceId,
                now
            )
        }

    fun resolveOrCreateSourceInstanceInTransaction(
        provider: String,
        providerInstanceId: String,
        now: Instant
    ): SourceInstanceRef {
        val sourceId = SourcesTable.insertIgnoreAndGetId {
            it[code] = provider
            it[displayName] = null
            it[createdAt] = now.toDbTimestamp()
        }?.value ?: SourcesTable
            .select(SourcesTable.id)
            .where { SourcesTable.code eq provider }
            .limit(1)
            .single()[SourcesTable.id].value

        val instanceId = SourceInstancesTable.insertIgnoreAndGetId {
            it[this.sourceId] = sourceId
            it[this.providerInstanceId] = providerInstanceId
            it[displayName] = null
            it[createdAt] = now.toDbTimestamp()
            it[updatedAt] = now.toDbTimestamp()
        }?.value ?: SourceInstancesTable
            .select(SourceInstancesTable.id)
            .where {
                (SourceInstancesTable.sourceId eq sourceId) and
                        (SourceInstancesTable.providerInstanceId eq providerInstanceId)
            }
            .limit(1)
            .single()[SourceInstancesTable.id].value

        return SourceInstanceRef(
            id = instanceId,
            provider = provider,
            providerInstanceId = providerInstanceId,
        )
    }

    private suspend fun <T> dbQuery(block: () -> T): T =
        suspendTransaction(db = database) {
            block()
        }

    private fun shouldUpdateLastUsedAt(
        current: OffsetDateTime?,
        now: Instant
    ): Boolean {
        if (current == null) return true
        return current.toInstant() <= now.minusSeconds(
            API_CLIENT_LAST_USED_UPDATE_INTERVAL_SECONDS
        )
    }
}

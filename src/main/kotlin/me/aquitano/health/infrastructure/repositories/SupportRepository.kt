package me.aquitano.health.infrastructure.repositories

import kotlinx.coroutines.Dispatchers
import me.aquitano.health.infrastructure.database.dao.ApiClientDao
import me.aquitano.health.infrastructure.database.dao.SourceDao
import me.aquitano.health.infrastructure.database.dao.SourceInstanceDao
import me.aquitano.health.infrastructure.database.tables.ApiClientsTable
import me.aquitano.health.infrastructure.database.tables.SourceInstancesTable
import me.aquitano.health.infrastructure.database.tables.SourcesTable
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.transactions.experimental.newSuspendedTransaction
import org.jetbrains.exposed.sql.transactions.transaction
import java.time.Instant

data class SourceInstanceRef(
    val id: Int,
    val provider: String,
    val providerInstanceId: String,
)

data class ApiClientRef(
    val id: Int,
    val name: String,
)

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
                    createdAt = now.toString()
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
            client.lastUsedAt = now.toString()
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
        val source =
            SourceDao.find { SourcesTable.code eq provider }.firstOrNull()
                ?: SourceDao.new {
                    code = provider
                    displayName = null
                    createdAt = now.toString()
                }

        val instance = SourceInstanceDao
            .find {
                (SourceInstancesTable.sourceId eq source.id) and
                        (SourceInstancesTable.providerInstanceId eq providerInstanceId)
            }
            .firstOrNull()
            ?: SourceInstanceDao.new {
                this.source = source
                this.providerInstanceId = providerInstanceId
                displayName = null
                createdAt = now.toString()
                updatedAt = now.toString()
            }

        return SourceInstanceRef(
            id = instance.id.value,
            provider = source.code,
            providerInstanceId = instance.providerInstanceId,
        )
    }

    private suspend fun <T> dbQuery(block: () -> T): T =
        newSuspendedTransaction(Dispatchers.IO, db = database) {
            block()
        }
}

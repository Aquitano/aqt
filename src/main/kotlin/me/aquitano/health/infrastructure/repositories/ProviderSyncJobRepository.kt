package me.aquitano.health.infrastructure.repositories

import me.aquitano.health.infrastructure.database.tables.ProviderSyncJobsTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.SortOrder
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.insert
import org.jetbrains.exposed.v1.jdbc.selectAll
import org.jetbrains.exposed.v1.jdbc.transactions.suspendTransaction
import org.jetbrains.exposed.v1.jdbc.update
import java.time.Instant

data class ProviderSyncJobRecord(
    val id: String,
    val providerCode: String,
    val providerInstanceId: String?,
    val requestedFrom: Instant,
    val requestedTo: Instant,
    val dataTypes: List<String>?,
    val pageSize: Int?,
    val status: String,
    val totalItems: Int,
    val completedItems: Int,
    val currentDataType: String?,
    val currentFrom: Instant?,
    val currentTo: Instant?,
    val lastCompletedDataType: String?,
    val lastCompletedFrom: Instant?,
    val lastCompletedTo: Instant?,
    val batchesCount: Int,
    val emptyCount: Int,
    val errorCount: Int,
    val summaryJson: String?,
    val errorMessage: String?,
    val createdAt: Instant,
    val startedAt: Instant?,
    val updatedAt: Instant,
    val finishedAt: Instant?,
)

class ProviderSyncJobRepository(private val database: Database) {
    suspend fun create(
        id: String,
        providerCode: String,
        providerInstanceId: String?,
        requestedFrom: Instant,
        requestedTo: Instant,
        dataTypes: List<String>?,
        pageSize: Int?,
        now: Instant,
    ): ProviderSyncJobRecord =
        suspendTransaction(db = database) {
            ProviderSyncJobsTable.insert {
                it[this.id] = id
                it[this.providerCode] = providerCode
                it[this.providerInstanceId] = providerInstanceId
                it[this.requestedFrom] = requestedFrom.toDbTimestamp()
                it[this.requestedTo] = requestedTo.toDbTimestamp()
                it[this.dataTypes] = dataTypes?.let(::encodeDataTypes)
                it[this.pageSize] = pageSize
                it[status] = "queued"
                it[totalItems] = 0
                it[completedItems] = 0
                it[batchesCount] = 0
                it[emptyCount] = 0
                it[errorCount] = 0
                it[createdAt] = now.toDbTimestamp()
                it[updatedAt] = now.toDbTimestamp()
            }
            getByIdInTransaction(id)!!
        }

    suspend fun get(id: String): ProviderSyncJobRecord? =
        suspendTransaction(db = database) { getByIdInTransaction(id) }

    suspend fun latest(providerCode: String? = null): ProviderSyncJobRecord? =
        suspendTransaction(db = database) {
            ProviderSyncJobsTable
                .selectAll()
                .let { query ->
                    providerCode?.let {
                        query.where { ProviderSyncJobsTable.providerCode eq it }
                    } ?: query
                }
                .orderBy(ProviderSyncJobsTable.createdAt to SortOrder.DESC)
                .limit(1)
                .map { it.toRecord() }
                .singleOrNull()
        }

    suspend fun markRunning(id: String, now: Instant) {
        suspendTransaction(db = database) {
            ProviderSyncJobsTable.update({ ProviderSyncJobsTable.id eq id }) {
                it[status] = "running"
                it[startedAt] = now.toDbTimestamp()
                it[updatedAt] = now.toDbTimestamp()
                it[errorMessage] = null
            }
        }
    }

    suspend fun markStarted(
        id: String,
        providerInstanceId: String,
        totalItems: Int,
        now: Instant,
    ) {
        suspendTransaction(db = database) {
            ProviderSyncJobsTable.update({ ProviderSyncJobsTable.id eq id }) {
                it[this.providerInstanceId] = providerInstanceId
                it[this.totalItems] = totalItems
                it[updatedAt] = now.toDbTimestamp()
            }
        }
    }

    suspend fun markItemStarted(
        id: String,
        dataType: String,
        from: Instant,
        to: Instant,
        now: Instant,
    ) {
        suspendTransaction(db = database) {
            ProviderSyncJobsTable.update({ ProviderSyncJobsTable.id eq id }) {
                it[currentDataType] = dataType
                it[currentFrom] = from.toDbTimestamp()
                it[currentTo] = to.toDbTimestamp()
                it[updatedAt] = now.toDbTimestamp()
            }
        }
    }

    suspend fun markItemCompleted(
        id: String,
        dataType: String,
        from: Instant,
        to: Instant,
        now: Instant,
    ) {
        suspendTransaction(db = database) {
            val existing = getByIdInTransaction(id) ?: return@suspendTransaction
            ProviderSyncJobsTable.update({ ProviderSyncJobsTable.id eq id }) {
                it[completedItems] = existing.completedItems + 1
                it[lastCompletedDataType] = dataType
                it[lastCompletedFrom] = from.toDbTimestamp()
                it[lastCompletedTo] = to.toDbTimestamp()
                it[updatedAt] = now.toDbTimestamp()
            }
        }
    }

    suspend fun finish(
        id: String,
        status: String,
        batchesCount: Int,
        emptyCount: Int,
        errorCount: Int,
        summaryJson: String?,
        errorMessage: String?,
        now: Instant,
    ) {
        suspendTransaction(db = database) {
            ProviderSyncJobsTable.update({ ProviderSyncJobsTable.id eq id }) {
                it[this.status] = status
                it[this.batchesCount] = batchesCount
                it[this.emptyCount] = emptyCount
                it[this.errorCount] = errorCount
                it[this.summaryJson] = summaryJson
                it[this.errorMessage] = errorMessage?.take(2000)
                it[currentDataType] = null
                it[currentFrom] = null
                it[currentTo] = null
                it[updatedAt] = now.toDbTimestamp()
                it[finishedAt] = now.toDbTimestamp()
            }
        }
    }

    suspend fun markInterruptedUnfinishedJobs(now: Instant) {
        suspendTransaction(db = database) {
            listOf("queued", "running").forEach { interruptedStatus ->
                ProviderSyncJobsTable.update({
                    ProviderSyncJobsTable.status eq interruptedStatus
                }) {
                    it[status] = "failed"
                    it[errorMessage] = "Backend stopped before the sync job finished. Start a new sync to resume from completed chunks."
                    it[updatedAt] = now.toDbTimestamp()
                    it[finishedAt] = now.toDbTimestamp()
                }
            }
        }
    }

    private fun getByIdInTransaction(id: String): ProviderSyncJobRecord? =
        ProviderSyncJobsTable
            .selectAll()
            .where { ProviderSyncJobsTable.id eq id }
            .limit(1)
            .map { it.toRecord() }
            .singleOrNull()

    private fun ResultRow.toRecord(): ProviderSyncJobRecord =
        ProviderSyncJobRecord(
            id = this[ProviderSyncJobsTable.id],
            providerCode = this[ProviderSyncJobsTable.providerCode],
            providerInstanceId = this[ProviderSyncJobsTable.providerInstanceId],
            requestedFrom = this[ProviderSyncJobsTable.requestedFrom].toInstant(),
            requestedTo = this[ProviderSyncJobsTable.requestedTo].toInstant(),
            dataTypes = this[ProviderSyncJobsTable.dataTypes]?.let(::decodeDataTypes),
            pageSize = this[ProviderSyncJobsTable.pageSize],
            status = this[ProviderSyncJobsTable.status],
            totalItems = this[ProviderSyncJobsTable.totalItems],
            completedItems = this[ProviderSyncJobsTable.completedItems],
            currentDataType = this[ProviderSyncJobsTable.currentDataType],
            currentFrom = this[ProviderSyncJobsTable.currentFrom]?.toInstant(),
            currentTo = this[ProviderSyncJobsTable.currentTo]?.toInstant(),
            lastCompletedDataType = this[ProviderSyncJobsTable.lastCompletedDataType],
            lastCompletedFrom = this[ProviderSyncJobsTable.lastCompletedFrom]?.toInstant(),
            lastCompletedTo = this[ProviderSyncJobsTable.lastCompletedTo]?.toInstant(),
            batchesCount = this[ProviderSyncJobsTable.batchesCount],
            emptyCount = this[ProviderSyncJobsTable.emptyCount],
            errorCount = this[ProviderSyncJobsTable.errorCount],
            summaryJson = this[ProviderSyncJobsTable.summaryJson],
            errorMessage = this[ProviderSyncJobsTable.errorMessage],
            createdAt = this[ProviderSyncJobsTable.createdAt].toInstant(),
            startedAt = this[ProviderSyncJobsTable.startedAt]?.toInstant(),
            updatedAt = this[ProviderSyncJobsTable.updatedAt].toInstant(),
            finishedAt = this[ProviderSyncJobsTable.finishedAt]?.toInstant(),
        )
}

private fun encodeDataTypes(dataTypes: List<String>): String =
    dataTypes.joinToString(",")

private fun decodeDataTypes(value: String): List<String> =
    value.split(",").filter { it.isNotBlank() }

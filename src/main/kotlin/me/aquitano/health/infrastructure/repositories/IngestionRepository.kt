package me.aquitano.health.infrastructure.repositories

import me.aquitano.health.domain.HealthRecord
import me.aquitano.health.infrastructure.database.tables.IngestionBatchesTable
import me.aquitano.health.infrastructure.database.tables.IngestionRecordsTable
import me.aquitano.health.infrastructure.database.tables.SourceInstancesTable
import me.aquitano.health.infrastructure.database.tables.SourcesTable
import me.aquitano.health.shared.AppJson
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.SqlExpressionBuilder.greaterEq
import org.jetbrains.exposed.sql.SqlExpressionBuilder.less
import java.time.Instant

data class ExistingBatch(
    val id: Int,
    val status: String,
)

data class IngestionRecordRef(
    val id: Int,
    val record: HealthRecord,
)

data class AdminBatchRow(
    val id: Int,
    val provider: String,
    val providerInstanceId: String,
    val batchExternalId: String?,
    val status: String,
    val ingestedAt: String,
    val receivedAt: String,
    val processedAt: String?,
    val errorMessage: String?,
    val recordCount: Int,
)

class IngestionRepository {
    fun findBatchByExternalId(
        sourceInstanceId: Int,
        batchExternalId: String
    ): ExistingBatch? =
        IngestionBatchesTable
            .selectAll()
            .where {
                (IngestionBatchesTable.sourceInstanceId eq sourceInstanceId) and
                        (IngestionBatchesTable.batchExternalId eq batchExternalId)
            }
            .limit(1)
            .map(::toExistingBatch)
            .singleOrNull()

    fun insertBatch(
        sourceInstanceId: Int,
        batchExternalId: String?,
        sourcePayloadJson: String,
        normalizedPayloadJson: String,
        ingestedAt: Instant,
        receivedAt: Instant,
    ): Int =
        IngestionBatchesTable.insertAndGetId {
            it[this.sourceInstanceId] = sourceInstanceId
            it[this.batchExternalId] = batchExternalId
            it[this.sourcePayloadJson] = sourcePayloadJson
            it[this.normalizedPayloadJson] = normalizedPayloadJson
            it[status] = "received"
            it[this.ingestedAt] = ingestedAt.toString()
            it[this.receivedAt] = receivedAt.toString()
            it[processedAt] = null
            it[errorMessage] = null
            it[createdAt] = receivedAt.toString()
            it[updatedAt] = receivedAt.toString()
        }.value

    fun insertRecords(
        batchId: Int,
        records: List<HealthRecord>,
        now: Instant
    ): List<IngestionRecordRef> =
        records.map { record ->
            val id = IngestionRecordsTable.insertAndGetId {
                it[this.batchId] = batchId
                it[recordType] = record.recordType
                it[providerRecordId] = record.providerRecordId
                it[normalizedRecordJson] = AppJson.encodeToString(record.normalizedRecordJson)
                it[recordStartAt] = record.recordStartAt?.toString()
                it[recordEndAt] = record.recordEndAt?.toString()
                it[createdAt] = now.toString()
            }.value
            IngestionRecordRef(id = id, record = record)
        }

    fun markProcessed(batchId: Int, processedAt: Instant) {
        IngestionBatchesTable.update({ IngestionBatchesTable.id eq batchId }) {
            it[status] = "processed"
            it[this.processedAt] = processedAt.toString()
            it[updatedAt] = processedAt.toString()
            it[errorMessage] = null
        }
    }

    fun markFailed(batchId: Int, failedAt: Instant, error: String) {
        IngestionBatchesTable.update({ IngestionBatchesTable.id eq batchId }) {
            it[status] = "failed"
            it[processedAt] = null
            it[updatedAt] = failedAt.toString()
            it[errorMessage] = error.take(2000)
        }
    }

    fun listBatches(
        status: String?,
        from: Instant?,
        to: Instant?,
        limit: Int
    ): List<AdminBatchRow> {
        val conditions = mutableListOf<Op<Boolean>>()
        status?.let { conditions.add(IngestionBatchesTable.status eq it) }
        from?.let { conditions.add(IngestionBatchesTable.receivedAt greaterEq it.toString()) }
        to?.let { conditions.add(IngestionBatchesTable.receivedAt less it.toString()) }

        val batches = IngestionBatchesTable
            .innerJoin(SourceInstancesTable)
            .innerJoin(SourcesTable)
            .selectAll()
            .where(combineConditions(conditions))
            .orderBy(IngestionBatchesTable.receivedAt to SortOrder.DESC)
            .limit(limit)
            .toList()

        val recordCounts =
            recordCounts(batches.map { it[IngestionBatchesTable.id].value })
        return batches.map {
            AdminBatchRow(
                id = it[IngestionBatchesTable.id].value,
                provider = it[SourcesTable.code],
                providerInstanceId = it[SourceInstancesTable.providerInstanceId],
                batchExternalId = it[IngestionBatchesTable.batchExternalId],
                status = it[IngestionBatchesTable.status],
                ingestedAt = it[IngestionBatchesTable.ingestedAt],
                receivedAt = it[IngestionBatchesTable.receivedAt],
                processedAt = it[IngestionBatchesTable.processedAt],
                errorMessage = it[IngestionBatchesTable.errorMessage],
                recordCount = recordCounts[it[IngestionBatchesTable.id].value]
                    ?: 0,
            )
        }
    }

    private fun recordCounts(batchIds: List<Int>): Map<Int, Int> {
        if (batchIds.isEmpty()) return emptyMap()
        val countExpression = IngestionRecordsTable.id.count()
        return IngestionRecordsTable
            .select(IngestionRecordsTable.batchId, countExpression)
            .where { IngestionRecordsTable.batchId inList batchIds }
            .groupBy(IngestionRecordsTable.batchId)
            .associate { it[IngestionRecordsTable.batchId] to it[countExpression].toInt() }
    }

    private fun combineConditions(conditions: List<Op<Boolean>>): Op<Boolean> =
        conditions.reduceOrNull { left, right -> left and right } ?: Op.TRUE

    private fun toExistingBatch(row: ResultRow): ExistingBatch =
        ExistingBatch(
            id = row[IngestionBatchesTable.id].value,
            status = row[IngestionBatchesTable.status],
        )
}

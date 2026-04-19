package me.aquitano.health.infrastructure.repositories

import me.aquitano.health.domain.CanonicalRecord
import me.aquitano.health.infrastructure.database.tables.RawIngestionBatchesTable
import me.aquitano.health.infrastructure.database.tables.RawIngestionRecordsTable
import me.aquitano.health.shared.AppJson
import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.insertAndGetId
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.update
import java.time.Instant

data class ExistingBatch(
    val id: Int,
    val status: String,
)

data class RawRecordRef(
    val id: Int,
    val record: CanonicalRecord,
)

class IngestionRepository {
    fun findBatchByExternalId(sourceInstanceId: Int, batchExternalId: String): ExistingBatch? =
        RawIngestionBatchesTable
            .selectAll()
            .where {
                (RawIngestionBatchesTable.sourceInstanceId eq sourceInstanceId) and
                    (RawIngestionBatchesTable.batchExternalId eq batchExternalId)
            }
            .limit(1)
            .map(::toExistingBatch)
            .singleOrNull()

    fun insertBatch(
        sourceInstanceId: Int,
        batchExternalId: String?,
        rawPayloadJson: String,
        mappedPayloadJson: String,
        ingestedAt: Instant,
        receivedAt: Instant,
    ): Int =
        RawIngestionBatchesTable.insertAndGetId {
            it[this.sourceInstanceId] = sourceInstanceId
            it[this.batchExternalId] = batchExternalId
            it[this.rawPayloadJson] = rawPayloadJson
            it[this.mappedPayloadJson] = mappedPayloadJson
            it[status] = "received"
            it[this.ingestedAt] = ingestedAt.toString()
            it[this.receivedAt] = receivedAt.toString()
            it[processedAt] = null
            it[errorMessage] = null
            it[createdAt] = receivedAt.toString()
            it[updatedAt] = receivedAt.toString()
        }.value

    fun insertRawRecords(batchId: Int, records: List<CanonicalRecord>, now: Instant): List<RawRecordRef> =
        records.map { record ->
            val id = RawIngestionRecordsTable.insertAndGetId {
                it[this.batchId] = batchId
                it[recordType] = record.recordType
                it[providerRecordId] = record.providerRecordId
                it[recordJson] = AppJson.encodeToString(record.recordJson)
                it[recordStartAt] = record.recordStartAt?.toString()
                it[recordEndAt] = record.recordEndAt?.toString()
                it[createdAt] = now.toString()
            }.value
            RawRecordRef(id = id, record = record)
        }

    fun markProcessed(batchId: Int, processedAt: Instant) {
        RawIngestionBatchesTable.update({ RawIngestionBatchesTable.id eq batchId }) {
            it[status] = "processed"
            it[this.processedAt] = processedAt.toString()
            it[updatedAt] = processedAt.toString()
            it[errorMessage] = null
        }
    }

    fun markFailed(batchId: Int, failedAt: Instant, error: String) {
        RawIngestionBatchesTable.update({ RawIngestionBatchesTable.id eq batchId }) {
            it[status] = "failed"
            it[processedAt] = null
            it[updatedAt] = failedAt.toString()
            it[errorMessage] = error.take(2000)
        }
    }

    private fun toExistingBatch(row: ResultRow): ExistingBatch =
        ExistingBatch(
            id = row[RawIngestionBatchesTable.id].value,
            status = row[RawIngestionBatchesTable.status],
        )
}

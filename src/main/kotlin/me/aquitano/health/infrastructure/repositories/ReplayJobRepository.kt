package me.aquitano.health.infrastructure.repositories

import me.aquitano.health.infrastructure.database.tables.ReplayJobsTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.SortOrder
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.insert
import org.jetbrains.exposed.v1.jdbc.insertIgnore
import org.jetbrains.exposed.v1.jdbc.selectAll
import me.aquitano.health.infrastructure.database.suspendDbTransaction
import org.jetbrains.exposed.v1.jdbc.update
import java.time.Instant
import java.time.LocalDate

data class ReplayJobRecord(
    val id: String,
    val idempotencyRequestHash: String?,
    val scope: String,
    val metricTypes: List<String>?,
    val fromDate: LocalDate?,
    val toDate: LocalDate?,
    val wipe: Boolean,
    val status: String,
    val totalItems: Int,
    val completedItems: Int,
    val currentItem: String?,
    val recordsReplayed: Int,
    val metricsWritten: Int,
    val duplicatesSkipped: Int,
    val mappingFailures: Int,
    val errorMessage: String?,
    val createdAt: Instant,
    val startedAt: Instant?,
    val updatedAt: Instant,
    val finishedAt: Instant?,
)

data class ReplayJobCreateResult(val record: ReplayJobRecord, val created: Boolean)

class ReplayJobRepository(private val database: Database) {
    suspend fun create(
        id: String,
        scope: String,
        metricTypes: List<String>?,
        fromDate: LocalDate?,
        toDate: LocalDate?,
        wipe: Boolean,
        now: Instant,
        idempotencyKey: String? = null,
        idempotencyRequestHash: String? = null,
    ): ReplayJobCreateResult =
        suspendDbTransaction(db = database) {
            if (idempotencyKey == null) {
                ReplayJobsTable.insert {
                    it[this.id] = id
                    it[this.idempotencyKey] = null
                    it[this.idempotencyRequestHash] = null
                    it[this.scope] = scope
                    it[this.metricTypes] = metricTypes?.joinToString(",")
                    it[this.fromDate] = fromDate
                    it[this.toDate] = toDate
                    it[this.wipe] = wipe
                    it[status] = "queued"
                    it[totalItems] = 0
                    it[completedItems] = 0
                    it[recordsReplayed] = 0
                    it[metricsWritten] = 0
                    it[duplicatesSkipped] = 0
                    it[mappingFailures] = 0
                    it[createdAt] = now.toDbTimestamp()
                    it[updatedAt] = now.toDbTimestamp()
                }
                return@suspendDbTransaction ReplayJobCreateResult(getByIdInTransaction(id)!!, created = true)
            }

            val inserted = ReplayJobsTable.insertIgnore {
                it[this.id] = id
                it[this.idempotencyKey] = idempotencyKey
                it[this.idempotencyRequestHash] = idempotencyRequestHash
                it[this.scope] = scope
                it[this.metricTypes] = metricTypes?.joinToString(",")
                it[this.fromDate] = fromDate
                it[this.toDate] = toDate
                it[this.wipe] = wipe
                it[status] = "queued"
                it[totalItems] = 0
                it[completedItems] = 0
                it[recordsReplayed] = 0
                it[metricsWritten] = 0
                it[duplicatesSkipped] = 0
                it[mappingFailures] = 0
                it[createdAt] = now.toDbTimestamp()
                it[updatedAt] = now.toDbTimestamp()
            }.insertedCount > 0
            val record = getByIdInTransaction(id) ?: findByIdempotencyKeyInTransaction(idempotencyKey)!!
            ReplayJobCreateResult(record, created = inserted)
        }

    suspend fun get(id: String): ReplayJobRecord? =
        suspendDbTransaction(db = database) { getByIdInTransaction(id) }

    suspend fun findByIdempotencyKey(idempotencyKey: String): ReplayJobRecord? =
        suspendDbTransaction(db = database) {
            findByIdempotencyKeyInTransaction(idempotencyKey)
        }

    suspend fun latest(): ReplayJobRecord? =
        suspendDbTransaction(db = database) {
            ReplayJobsTable
                .selectAll()
                .orderBy(ReplayJobsTable.createdAt to SortOrder.DESC)
                .limit(1)
                .map { it.toRecord() }
                .singleOrNull()
        }

    suspend fun markRunning(id: String, totalItems: Int, now: Instant) {
        suspendDbTransaction(db = database) {
            ReplayJobsTable.update({ ReplayJobsTable.id eq id }) {
                it[status] = "running"
                it[this.totalItems] = totalItems
                it[startedAt] = now.toDbTimestamp()
                it[updatedAt] = now.toDbTimestamp()
                it[errorMessage] = null
            }
        }
    }

    suspend fun markItemStarted(id: String, item: String, now: Instant) {
        suspendDbTransaction(db = database) {
            ReplayJobsTable.update({ ReplayJobsTable.id eq id }) {
                it[currentItem] = item
                it[updatedAt] = now.toDbTimestamp()
            }
        }
    }

    suspend fun markItemCompleted(
        id: String,
        recordsReplayed: Int,
        metricsWritten: Int,
        duplicatesSkipped: Int,
        mappingFailures: Int,
        now: Instant,
    ) {
        suspendDbTransaction(db = database) {
            val existing = getByIdInTransaction(id) ?: return@suspendDbTransaction
            ReplayJobsTable.update({ ReplayJobsTable.id eq id }) {
                it[completedItems] = existing.completedItems + 1
                it[this.recordsReplayed] = existing.recordsReplayed + recordsReplayed
                it[this.metricsWritten] = existing.metricsWritten + metricsWritten
                it[this.duplicatesSkipped] = existing.duplicatesSkipped + duplicatesSkipped
                it[this.mappingFailures] = existing.mappingFailures + mappingFailures
                it[updatedAt] = now.toDbTimestamp()
            }
        }
    }

    suspend fun finish(id: String, status: String, errorMessage: String?, now: Instant) {
        suspendDbTransaction(db = database) {
            ReplayJobsTable.update({ ReplayJobsTable.id eq id }) {
                it[this.status] = status
                it[this.errorMessage] = errorMessage?.take(2000)
                it[currentItem] = null
                it[updatedAt] = now.toDbTimestamp()
                it[finishedAt] = now.toDbTimestamp()
            }
        }
    }

    suspend fun markInterruptedUnfinishedJobs(now: Instant) {
        suspendDbTransaction(db = database) {
            listOf("queued", "running").forEach { interruptedStatus ->
                ReplayJobsTable.update({ ReplayJobsTable.status eq interruptedStatus }) {
                    it[status] = "failed"
                    it[errorMessage] =
                        "Backend stopped before the replay job finished. Replay is idempotent; start a new job to continue."
                    it[updatedAt] = now.toDbTimestamp()
                    it[finishedAt] = now.toDbTimestamp()
                }
            }
        }
    }

    private fun getByIdInTransaction(id: String): ReplayJobRecord? =
        ReplayJobsTable
            .selectAll()
            .where { ReplayJobsTable.id eq id }
            .limit(1)
            .map { it.toRecord() }
            .singleOrNull()

    private fun findByIdempotencyKeyInTransaction(idempotencyKey: String): ReplayJobRecord? =
        ReplayJobsTable
            .selectAll()
            .where { ReplayJobsTable.idempotencyKey eq idempotencyKey }
            .limit(1)
            .map { it.toRecord() }
            .singleOrNull()

    private fun ResultRow.toRecord(): ReplayJobRecord =
        ReplayJobRecord(
            id = this[ReplayJobsTable.id],
            idempotencyRequestHash = this[ReplayJobsTable.idempotencyRequestHash],
            scope = this[ReplayJobsTable.scope],
            metricTypes = this[ReplayJobsTable.metricTypes]
                ?.split(",")
                ?.filter { it.isNotBlank() },
            fromDate = this[ReplayJobsTable.fromDate],
            toDate = this[ReplayJobsTable.toDate],
            wipe = this[ReplayJobsTable.wipe],
            status = this[ReplayJobsTable.status],
            totalItems = this[ReplayJobsTable.totalItems],
            completedItems = this[ReplayJobsTable.completedItems],
            currentItem = this[ReplayJobsTable.currentItem],
            recordsReplayed = this[ReplayJobsTable.recordsReplayed],
            metricsWritten = this[ReplayJobsTable.metricsWritten],
            duplicatesSkipped = this[ReplayJobsTable.duplicatesSkipped],
            mappingFailures = this[ReplayJobsTable.mappingFailures],
            errorMessage = this[ReplayJobsTable.errorMessage],
            createdAt = this[ReplayJobsTable.createdAt].toInstant(),
            startedAt = this[ReplayJobsTable.startedAt]?.toInstant(),
            updatedAt = this[ReplayJobsTable.updatedAt].toInstant(),
            finishedAt = this[ReplayJobsTable.finishedAt]?.toInstant(),
        )

}

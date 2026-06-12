package me.aquitano.health.infrastructure.repositories

import me.aquitano.health.application.DerivedRebuildRequest
import me.aquitano.health.domain.DerivedKind
import me.aquitano.health.infrastructure.database.suspendDbTransaction
import me.aquitano.health.infrastructure.database.tables.PendingDerivedRebuildsTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.*
import java.time.Instant
import java.time.LocalDate

data class PendingDerivedRebuildRecord(
    val id: Int,
    val sourceInstanceId: Int,
    val derivedKind: DerivedKind,
    val affectedDate: LocalDate,
    val attempts: Int,
    val nextAttemptAt: Instant,
    val lastErrorMessage: String?,
)

/**
 * Queue of derived rebuilds that failed after a committed ingestion batch. Rows are
 * retried by [me.aquitano.health.application.PendingDerivedRebuildSweeper] and deleted
 * once the rebuild succeeds.
 */
class PendingDerivedRebuildRepository(private val database: Database) {
    /**
     * Records every (kind, date) of a failed rebuild request. Must be called inside the
     * transaction that marks the batch failed so the queue and the batch state agree.
     * Dates already queued keep their backoff schedule; only the error message is refreshed.
     */
    fun enqueueInTransaction(request: DerivedRebuildRequest, error: String, now: Instant) {
        val nowTimestamp = now.toDbTimestamp()
        request.affectedDates.forEach { (kind, dates) ->
            dates.forEach { date ->
                val existing = PendingDerivedRebuildsTable
                    .selectAll()
                    .where {
                        (PendingDerivedRebuildsTable.sourceInstanceId eq request.sourceInstanceId) and
                                (PendingDerivedRebuildsTable.derivedKind eq kind.name) and
                                (PendingDerivedRebuildsTable.affectedDate eq date)
                    }
                    .limit(1)
                    .singleOrNull()
                if (existing == null) {
                    PendingDerivedRebuildsTable.insert {
                        it[sourceInstanceId] = request.sourceInstanceId
                        it[derivedKind] = kind.name
                        it[affectedDate] = date
                        it[attempts] = 0
                        it[nextAttemptAt] = nowTimestamp
                        it[lastErrorMessage] = error.take(2000)
                        it[createdAt] = nowTimestamp
                        it[updatedAt] = nowTimestamp
                    }
                } else {
                    PendingDerivedRebuildsTable.update({
                        PendingDerivedRebuildsTable.id eq existing[PendingDerivedRebuildsTable.id]
                    }) {
                        it[lastErrorMessage] = error.take(2000)
                        it[updatedAt] = nowTimestamp
                    }
                }
            }
        }
    }

    suspend fun due(now: Instant, limit: Int): List<PendingDerivedRebuildRecord> =
        suspendDbTransaction(db = database) {
            PendingDerivedRebuildsTable
                .selectAll()
                .where { PendingDerivedRebuildsTable.nextAttemptAt lessEq now.toDbTimestamp() }
                .orderBy(PendingDerivedRebuildsTable.nextAttemptAt to SortOrder.ASC)
                .limit(limit)
                .map {
                    PendingDerivedRebuildRecord(
                        id = it[PendingDerivedRebuildsTable.id].value,
                        sourceInstanceId = it[PendingDerivedRebuildsTable.sourceInstanceId],
                        derivedKind = DerivedKind.valueOf(it[PendingDerivedRebuildsTable.derivedKind]),
                        affectedDate = it[PendingDerivedRebuildsTable.affectedDate],
                        attempts = it[PendingDerivedRebuildsTable.attempts],
                        nextAttemptAt = it[PendingDerivedRebuildsTable.nextAttemptAt].toInstant(),
                        lastErrorMessage = it[PendingDerivedRebuildsTable.lastErrorMessage],
                    )
                }
        }

    suspend fun deleteCompleted(ids: List<Int>) {
        if (ids.isEmpty()) return
        suspendDbTransaction(db = database) {
            PendingDerivedRebuildsTable.deleteWhere { PendingDerivedRebuildsTable.id inList ids }
        }
    }

    suspend fun markAttemptFailed(
        ids: List<Int>,
        nextAttemptAt: (attempts: Int) -> Instant,
        error: String,
        now: Instant,
    ) {
        if (ids.isEmpty()) return
        suspendDbTransaction(db = database) {
            val nowTimestamp = now.toDbTimestamp()
            PendingDerivedRebuildsTable
                .selectAll()
                .where { PendingDerivedRebuildsTable.id inList ids }
                .forEach { row ->
                    val attempts = row[PendingDerivedRebuildsTable.attempts] + 1
                    PendingDerivedRebuildsTable.update({
                        PendingDerivedRebuildsTable.id eq row[PendingDerivedRebuildsTable.id]
                    }) {
                        it[this.attempts] = attempts
                        it[this.nextAttemptAt] = nextAttemptAt(attempts).toDbTimestamp()
                        it[lastErrorMessage] = error.take(2000)
                        it[updatedAt] = nowTimestamp
                    }
                }
        }
    }
}

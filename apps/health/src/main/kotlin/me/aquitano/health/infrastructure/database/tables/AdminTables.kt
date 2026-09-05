package me.aquitano.health.infrastructure.database.tables

import org.jetbrains.exposed.v1.core.Table
import org.jetbrains.exposed.v1.javatime.date
import org.jetbrains.exposed.v1.javatime.timestampWithTimeZone

object ReplayJobsTable : Table("replay_jobs") {
    val id = text("id")
    val idempotencyKey = text("idempotency_key").nullable()
    val idempotencyRequestHash = text("idempotency_request_hash").nullable()
    val scope = text("scope")
    val metricTypes = text("metric_types").nullable()
    val fromDate = date("from_date").nullable()
    val toDate = date("to_date").nullable()
    val wipe = bool("wipe")
    val status = text("status")
    val totalItems = integer("total_items")
    val completedItems = integer("completed_items")
    val currentItem = text("current_item").nullable()
    val recordsReplayed = integer("records_replayed")
    val metricsWritten = integer("metrics_written")
    val duplicatesSkipped = integer("duplicates_skipped")
    val mappingFailures = integer("mapping_failures")
    val errorMessage = text("error_message").nullable()
    val createdAt = timestampWithTimeZone("created_at")
    val startedAt = timestampWithTimeZone("started_at").nullable()
    val updatedAt = timestampWithTimeZone("updated_at")
    val finishedAt = timestampWithTimeZone("finished_at").nullable()

    override val primaryKey = PrimaryKey(id)
}

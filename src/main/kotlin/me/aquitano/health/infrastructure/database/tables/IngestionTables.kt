package me.aquitano.health.infrastructure.database.tables

import me.aquitano.health.infrastructure.database.jsonb
import org.jetbrains.exposed.v1.core.dao.id.IntIdTable
import org.jetbrains.exposed.v1.javatime.timestampWithTimeZone

object IngestionBatchesTable : IntIdTable("ingestion_batches") {
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val batchExternalId = text("batch_external_id").nullable()
    val sourcePayloadJson = jsonb("source_payload_json")
    val normalizedPayloadJson = jsonb("normalized_payload_json")
    val status = text("status")
    val ingestedAt = timestampWithTimeZone("ingested_at")
    val receivedAt = timestampWithTimeZone("received_at")
    val processedAt = timestampWithTimeZone("processed_at").nullable()
    val errorMessage = text("error_message").nullable()
    val createdAt = timestampWithTimeZone("created_at")
    val updatedAt = timestampWithTimeZone("updated_at")
}

object IngestionRecordsTable : IntIdTable("ingestion_records") {
    val batchId = integer("batch_id").references(IngestionBatchesTable.id)
    val recordType = text("record_type")
    val providerRecordId = text("provider_record_id").nullable()
    val normalizedRecordJson = jsonb("normalized_record_json")
    val recordStartAt = timestampWithTimeZone("record_start_at").nullable()
    val recordEndAt = timestampWithTimeZone("record_end_at").nullable()
    val createdAt = timestampWithTimeZone("created_at")
}

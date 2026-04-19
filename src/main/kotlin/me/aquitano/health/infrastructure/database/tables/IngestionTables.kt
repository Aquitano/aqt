package me.aquitano.health.infrastructure.database.tables

import org.jetbrains.exposed.dao.id.IntIdTable

object IngestionBatchesTable : IntIdTable("ingestion_batches") {
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val batchExternalId = text("batch_external_id").nullable()
    val sourcePayloadJson = text("source_payload_json")
    val normalizedPayloadJson = text("normalized_payload_json")
    val status = text("status")
    val ingestedAt = text("ingested_at")
    val receivedAt = text("received_at")
    val processedAt = text("processed_at").nullable()
    val errorMessage = text("error_message").nullable()
    val createdAt = text("created_at")
    val updatedAt = text("updated_at")
}

object IngestionRecordsTable : IntIdTable("ingestion_records") {
    val batchId = integer("batch_id").references(IngestionBatchesTable.id)
    val recordType = text("record_type")
    val providerRecordId = text("provider_record_id").nullable()
    val normalizedRecordJson = text("normalized_record_json")
    val recordStartAt = text("record_start_at").nullable()
    val recordEndAt = text("record_end_at").nullable()
    val createdAt = text("created_at")
}

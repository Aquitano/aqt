package me.aquitano.health.infrastructure.database.tables

import org.jetbrains.exposed.dao.id.IntIdTable
import org.jetbrains.exposed.sql.javatime.date
import org.jetbrains.exposed.sql.javatime.timestampWithTimeZone

object StepSamplesTable : IntIdTable("step_samples") {
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val ingestionRecordId =
        integer("ingestion_record_id").references(IngestionRecordsTable.id)
            .nullable()
    val providerRecordId = text("provider_record_id").nullable()
    val startAt = timestampWithTimeZone("start_at")
    val endAt = timestampWithTimeZone("end_at")
    val steps = integer("steps")
    val createdAt = timestampWithTimeZone("created_at")
}

object StepDailySummariesTable : IntIdTable("step_daily_summaries") {
    val date = date("date")
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val steps = integer("steps")
    val sampleCount = integer("sample_count")
    val computedAt = timestampWithTimeZone("computed_at")

    init {
        uniqueIndex(date, sourceInstanceId)
    }
}

object SleepSessionsTable : IntIdTable("sleep_sessions") {
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val ingestionRecordId =
        integer("ingestion_record_id").references(IngestionRecordsTable.id)
            .nullable()
    val providerRecordId = text("provider_record_id").nullable()
    val startAt = timestampWithTimeZone("start_at")
    val endAt = timestampWithTimeZone("end_at")
    val durationSeconds = long("duration_seconds")
    val createdAt = timestampWithTimeZone("created_at")
}

object SleepStagesTable : IntIdTable("sleep_stages") {
    val sleepSessionId =
        integer("sleep_session_id").references(SleepSessionsTable.id)
    val stage = text("stage")
    val startAt = timestampWithTimeZone("start_at")
    val endAt = timestampWithTimeZone("end_at")
    val durationSeconds = long("duration_seconds")
}

object BodyMeasurementsTable : IntIdTable("body_measurements") {
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val ingestionRecordId =
        integer("ingestion_record_id").references(IngestionRecordsTable.id)
            .nullable()
    val providerRecordId = text("provider_record_id").nullable()
    val measuredAt = timestampWithTimeZone("measured_at")
    val metricType = text("metric_type")
    val value = double("value")
    val unit = text("unit")
    val createdAt = timestampWithTimeZone("created_at")
}

object HeartRateSamplesTable : IntIdTable("heart_rate_samples") {
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val ingestionRecordId =
        integer("ingestion_record_id").references(IngestionRecordsTable.id)
            .nullable()
    val providerRecordId = text("provider_record_id").nullable()
    val measuredAt = timestampWithTimeZone("measured_at")
    val bpm = integer("bpm")
    val context = text("context").nullable()
    val createdAt = timestampWithTimeZone("created_at")
}

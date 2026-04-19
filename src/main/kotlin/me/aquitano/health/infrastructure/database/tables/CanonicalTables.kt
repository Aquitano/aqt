package me.aquitano.health.infrastructure.database.tables

import org.jetbrains.exposed.dao.id.IntIdTable

object StepSamplesTable : IntIdTable("step_samples") {
    val sourceInstanceId = integer("source_instance_id").references(SourceInstancesTable.id)
    val rawRecordId = integer("raw_record_id").references(RawIngestionRecordsTable.id).nullable()
    val providerRecordId = text("provider_record_id").nullable()
    val startAt = text("start_at")
    val endAt = text("end_at")
    val steps = integer("steps")
    val createdAt = text("created_at")
}

object StepDailySummariesTable : IntIdTable("step_daily_summaries") {
    val date = text("date")
    val sourceInstanceId = integer("source_instance_id").references(SourceInstancesTable.id)
    val steps = integer("steps")
    val sampleCount = integer("sample_count")
    val computedAt = text("computed_at")

    init {
        uniqueIndex(date, sourceInstanceId)
    }
}

object SleepSessionsTable : IntIdTable("sleep_sessions") {
    val sourceInstanceId = integer("source_instance_id").references(SourceInstancesTable.id)
    val rawRecordId = integer("raw_record_id").references(RawIngestionRecordsTable.id).nullable()
    val providerRecordId = text("provider_record_id").nullable()
    val startAt = text("start_at")
    val endAt = text("end_at")
    val durationSeconds = long("duration_seconds")
    val createdAt = text("created_at")
}

object SleepStagesTable : IntIdTable("sleep_stages") {
    val sleepSessionId = integer("sleep_session_id").references(SleepSessionsTable.id)
    val stage = text("stage")
    val startAt = text("start_at")
    val endAt = text("end_at")
    val durationSeconds = long("duration_seconds")
}

object BodyMeasurementsTable : IntIdTable("body_measurements") {
    val sourceInstanceId = integer("source_instance_id").references(SourceInstancesTable.id)
    val rawRecordId = integer("raw_record_id").references(RawIngestionRecordsTable.id).nullable()
    val providerRecordId = text("provider_record_id").nullable()
    val measuredAt = text("measured_at")
    val metricType = text("metric_type")
    val value = double("value")
    val unit = text("unit")
    val createdAt = text("created_at")
}

object HeartRateSamplesTable : IntIdTable("heart_rate_samples") {
    val sourceInstanceId = integer("source_instance_id").references(SourceInstancesTable.id)
    val rawRecordId = integer("raw_record_id").references(RawIngestionRecordsTable.id).nullable()
    val providerRecordId = text("provider_record_id").nullable()
    val measuredAt = text("measured_at")
    val bpm = integer("bpm")
    val context = text("context").nullable()
    val createdAt = text("created_at")
}

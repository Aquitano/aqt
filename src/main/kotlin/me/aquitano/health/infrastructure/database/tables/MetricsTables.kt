package me.aquitano.health.infrastructure.database.tables

import org.jetbrains.exposed.v1.core.dao.id.IntIdTable
import org.jetbrains.exposed.v1.javatime.date
import org.jetbrains.exposed.v1.javatime.timestampWithTimeZone

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

object ActivitySummariesTable : IntIdTable("activity_summaries") {
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val ingestionRecordId =
        integer("ingestion_record_id").references(IngestionRecordsTable.id)
            .nullable()
    val providerRecordId = text("provider_record_id").nullable()
    val date = date("date")
    val distanceMeters = double("distance_meters").nullable()
    val activeEnergyKcal = double("active_energy_kcal").nullable()
    val totalEnergyKcal = double("total_energy_kcal").nullable()
    val elevationMeters = double("elevation_meters").nullable()
    val softMinutes = integer("soft_minutes").nullable()
    val moderateMinutes = integer("moderate_minutes").nullable()
    val intenseMinutes = integer("intense_minutes").nullable()
    val activeMinutes = integer("active_minutes").nullable()
    val avgHeartRateBpm = integer("avg_heart_rate_bpm").nullable()
    val minHeartRateBpm = integer("min_heart_rate_bpm").nullable()
    val maxHeartRateBpm = integer("max_heart_rate_bpm").nullable()
    val createdAt = timestampWithTimeZone("created_at")
}

object SleepSummariesTable : IntIdTable("sleep_summaries") {
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val ingestionRecordId =
        integer("ingestion_record_id").references(IngestionRecordsTable.id)
            .nullable()
    val providerRecordId = text("provider_record_id").nullable()
    val startAt = timestampWithTimeZone("start_at")
    val endAt = timestampWithTimeZone("end_at")
    val timeInBedSeconds = long("time_in_bed_seconds").nullable()
    val totalSleepSeconds = long("total_sleep_seconds").nullable()
    val lightSleepSeconds = long("light_sleep_seconds").nullable()
    val deepSleepSeconds = long("deep_sleep_seconds").nullable()
    val remSleepSeconds = long("rem_sleep_seconds").nullable()
    val sleepEfficiencyPercent = double("sleep_efficiency_percent").nullable()
    val sleepLatencySeconds = long("sleep_latency_seconds").nullable()
    val wakeupLatencySeconds = long("wakeup_latency_seconds").nullable()
    val wakeupDurationSeconds = long("wakeup_duration_seconds").nullable()
    val wakeupCount = integer("wakeup_count").nullable()
    val wasoSeconds = long("waso_seconds").nullable()
    val sleepScore = integer("sleep_score").nullable()
    val createdAt = timestampWithTimeZone("created_at")
}

object RespiratoryRateSamplesTable : IntIdTable("respiratory_rate_samples") {
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val ingestionRecordId =
        integer("ingestion_record_id").references(IngestionRecordsTable.id)
            .nullable()
    val providerRecordId = text("provider_record_id").nullable()
    val measuredAt = timestampWithTimeZone("measured_at")
    val breathsPerMinute = integer("breaths_per_minute")
    val context = text("context").nullable()
    val createdAt = timestampWithTimeZone("created_at")
}

object HrvSamplesTable : IntIdTable("hrv_samples") {
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
    val context = text("context").nullable()
    val createdAt = timestampWithTimeZone("created_at")
}

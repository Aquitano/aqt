package me.aquitano.health.infrastructure.database.tables

import org.jetbrains.exposed.v1.core.Table
import org.jetbrains.exposed.v1.core.dao.id.IntIdTable
import org.jetbrains.exposed.v1.core.dao.id.LongIdTable
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

object CanonicalSleepSessionsTable : IntIdTable("canonical_sleep_sessions") {
    val date = date("date")
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val sleepSessionId =
        integer("sleep_session_id").references(SleepSessionsTable.id)
    val startAt = timestampWithTimeZone("start_at")
    val endAt = timestampWithTimeZone("end_at")
    val algorithmVersion = integer("algorithm_version")
    val computedAt = timestampWithTimeZone("computed_at")

    init {
        uniqueIndex(date, sleepSessionId, algorithmVersion)
    }
}

object SleepStagesTable : IntIdTable("sleep_stages") {
    val sleepSessionId =
        integer("sleep_session_id").references(SleepSessionsTable.id)
    val stage = text("stage")
    val startAt = timestampWithTimeZone("start_at")
    val endAt = timestampWithTimeZone("end_at")
    val durationSeconds = long("duration_seconds")
}

object SleepNightsTable : IntIdTable("sleep_nights") {
    val date = date("date")
    val timezone = text("timezone")
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val sleepSessionId =
        integer("sleep_session_id").references(SleepSessionsTable.id)
    val algorithmVersion = integer("algorithm_version")
    val computedAt = timestampWithTimeZone("computed_at")

    init {
        uniqueIndex(timezone, sleepSessionId)
    }
}

object CanonicalStepSamplesTable : IntIdTable("canonical_step_samples") {
    val date = date("date")
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val stepSampleId =
        integer("step_sample_id").references(StepSamplesTable.id)
    val startAt = timestampWithTimeZone("start_at")
    val endAt = timestampWithTimeZone("end_at")
    val steps = integer("steps")
    val algorithmVersion = integer("algorithm_version")
    val computedAt = timestampWithTimeZone("computed_at")

    init {
        uniqueIndex(date, stepSampleId, algorithmVersion)
    }
}

object CanonicalStepDailySummariesTable : IntIdTable("canonical_step_daily_summaries") {
    val date = date("date")
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val stepDailySummaryId =
        integer("step_daily_summary_id").references(StepDailySummariesTable.id)
    val steps = integer("steps")
    val algorithmVersion = integer("algorithm_version")
    val computedAt = timestampWithTimeZone("computed_at")

    init {
        uniqueIndex(date, algorithmVersion)
    }
}

object CanonicalStepDayBucketContributionsTable : IntIdTable("canonical_step_day_bucket_contributions") {
    val date = date("date")
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val stepSampleId =
        integer("step_sample_id").references(StepSamplesTable.id)
    val bucketStartAt = timestampWithTimeZone("bucket_start_at")
    val bucketEndAt = timestampWithTimeZone("bucket_end_at")
    val value = double("value")
    val algorithmVersion = integer("algorithm_version")
    val computedAt = timestampWithTimeZone("computed_at")

    init {
        uniqueIndex(date, stepSampleId, bucketStartAt, algorithmVersion)
    }
}

object CanonicalSleepNightsTable : IntIdTable("canonical_sleep_nights") {
    val date = date("date")
    val timezone = text("timezone")
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val sleepSessionId =
        integer("sleep_session_id").references(SleepSessionsTable.id)
    val algorithmVersion = integer("algorithm_version")
    val computedAt = timestampWithTimeZone("computed_at")

    init {
        uniqueIndex(timezone, sleepSessionId, algorithmVersion)
    }
}

object MetricCatalogTable : Table("metric_catalog") {
    val metricType = text("metric_type")
    val family = text("family")
    val unit = text("unit")
    val minValue = double("min_value").nullable()
    val maxValue = double("max_value").nullable()
    val supportsSegment = bool("supports_segment")

    override val primaryKey = PrimaryKey(metricType)
}

object ProviderRanksTable : Table("provider_ranks") {
    val family = text("family")
    val providerCode = text("provider_code")
    val rank = integer("rank")

    override val primaryKey = PrimaryKey(family, providerCode)
}

object ScalarSamplesTable : LongIdTable("scalar_samples") {
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
    val segment = text("segment").nullable()
    val createdAt = timestampWithTimeZone("created_at")
}

/** Read-only mapping of the canonical_scalar_samples view (see V14). */
object CanonicalScalarSamplesView : Table("canonical_scalar_samples") {
    val id = long("id")
    val sourceInstanceId = integer("source_instance_id")
    val ingestionRecordId = integer("ingestion_record_id").nullable()
    val providerRecordId = text("provider_record_id").nullable()
    val measuredAt = timestampWithTimeZone("measured_at")
    val metricType = text("metric_type")
    val value = double("value")
    val unit = text("unit")
    val context = text("context").nullable()
    val segment = text("segment").nullable()
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

object CanonicalActivitySummariesTable : IntIdTable("canonical_activity_summaries") {
    val date = date("date")
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val activitySummaryId =
        integer("activity_summary_id").references(ActivitySummariesTable.id)
    val algorithmVersion = integer("algorithm_version")
    val computedAt = timestampWithTimeZone("computed_at")

    init {
        uniqueIndex(date, algorithmVersion)
    }
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
    val remEpisodesCount = integer("rem_episodes_count").nullable()
    val outOfBedCount = integer("out_of_bed_count").nullable()
    val awakeDurationSeconds = long("awake_duration_seconds").nullable()
    val overnightHrvRmssd = double("overnight_hrv_rmssd").nullable()
    val respiratoryRhythm = double("respiratory_rhythm").nullable()
    val breathingQuality = integer("breathing_quality").nullable()
    val snoringDurationSeconds = long("snoring_duration_seconds").nullable()
    val apneaHypopneaIndex = double("apnea_hypopnea_index").nullable()
    val movementScore = double("movement_score").nullable()
    val snoringEpisodeCount = integer("snoring_episode_count").nullable()
    val hrAverageBpm = integer("hr_average_bpm").nullable()
    val hrMinBpm = integer("hr_min_bpm").nullable()
    val hrMaxBpm = integer("hr_max_bpm").nullable()
    val rrAverage = double("rr_average").nullable()
    val rrMin = double("rr_min").nullable()
    val rrMax = double("rr_max").nullable()
    val createdAt = timestampWithTimeZone("created_at")
}

object CanonicalSleepSummariesTable : IntIdTable("canonical_sleep_summaries") {
    val date = date("date")
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val sleepSummaryId =
        integer("sleep_summary_id").references(SleepSummariesTable.id)
    val startAt = timestampWithTimeZone("start_at")
    val endAt = timestampWithTimeZone("end_at")
    val algorithmVersion = integer("algorithm_version")
    val computedAt = timestampWithTimeZone("computed_at")

    init {
        uniqueIndex(date, sleepSummaryId, algorithmVersion)
    }
}

object BloodPressureMeasurementsTable : IntIdTable("blood_pressure_measurements") {
    val sourceInstanceId =
        integer("source_instance_id").references(SourceInstancesTable.id)
    val ingestionRecordId =
        integer("ingestion_record_id").references(IngestionRecordsTable.id)
            .nullable()
    val providerRecordId = text("provider_record_id").nullable()
    val measuredAt = timestampWithTimeZone("measured_at")
    val systolicMmhg = integer("systolic_mmhg")
    val diastolicMmhg = integer("diastolic_mmhg")
    val heartRateBpm = integer("heart_rate_bpm").nullable()
    val createdAt = timestampWithTimeZone("created_at")
}

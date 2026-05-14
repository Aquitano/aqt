package me.aquitano.external.withings

import kotlinx.serialization.json.JsonObject
import java.time.Instant

const val WITHINGS_PROVIDER_CODE = "withings"

val WITHINGS_SCOPES = listOf(
    "user.info",
    "user.metrics",
    "user.activity",
)

val WITHINGS_DEFAULT_DATA_TYPES = listOf(
    "activity",
    "measures",
    "sleep-summary",
    "sleep",
)

val WITHINGS_MEASURE_TYPES_ALL_LISTED = listOf(
    1, 4, 5, 6, 8, 9, 10, 11, 12, 54, 71, 73, 76, 77, 88, 91, 123, 130, 135,
    136, 137, 138, 139, 155, 167, 168, 169, 170, 173, 174, 175, 196, 226, 227,
    229,
)

val WITHINGS_MEASURE_TYPES_NORMALIZED = listOf(1, 6, 11, 76, 77, 170)

val WITHINGS_ACTIVITY_FIELDS_ALL_LISTED = listOf(
    "steps",
    "distance",
    "elevation",
    "soft",
    "moderate",
    "intense",
    "active",
    "calories",
    "totalcalories",
    "hr_average",
    "hr_min",
    "hr_max",
    "hr_zone_0",
    "hr_zone_1",
    "hr_zone_2",
    "hr_zone_3",
)

val WITHINGS_SLEEP_FIELDS_ALL_LISTED = listOf(
    "hr",
    "rr",
    "snoring",
    "sdnn_1",
    "rmssd",
    "hrv_quality",
    "mvt_score",
    "chest_movement_rate",
    "withings_index",
    "breathing_sounds",
)

val WITHINGS_SLEEP_SUMMARY_FIELDS_ALL_LISTED = listOf(
    "total_timeinbed",
    "total_sleep_time",
    "asleepduration",
    "lightsleepduration",
    "remsleepduration",
    "deepsleepduration",
    "sleep_efficiency",
    "sleep_latency",
    "wakeup_latency",
    "wakeupduration",
    "wakeupcount",
    "waso",
    "nb_rem_episodes",
    "breathing_disturbances_intensity",
    "apnea_hypopnea_index",
    "withings_index",
    "durationtosleep",
    "durationtowakeup",
    "out_of_bed_count",
    "hr_average",
    "hr_min",
    "hr_max",
    "rr_average",
    "rr_min",
    "rr_max",
    "breathing_quality_assessment",
    "snoring",
    "snoringepisodecount",
    "sleep_score",
    "night_events",
    "mvt_score_avg",
    "mvt_active_duration",
    "rmssd_start_avg",
    "rmssd_end_avg",
    "chest_movement_rate_wellness_average",
    "chest_movement_rate_wellness_min",
    "chest_movement_rate_wellness_max",
    "breathing_sounds",
    "breathing_sounds_episode_count",
    "chest_movement_rate_average",
    "chest_movement_rate_min",
    "chest_movement_rate_max",
    "core_body_temperature_min",
    "core_body_temperature_max",
    "core_body_temperature_avg",
    "core_body_temperature_status",
)

data class WithingsTokenSet(
    val providerUserId: String,
    val accessToken: String,
    val refreshToken: String,
    val tokenType: String,
    val expiresAt: Instant,
    val scope: String,
)

data class WithingsPage(
    val endpoint: String,
    val action: String,
    val pageIndex: Int,
    val payload: JsonObject,
)

data class WithingsFetchResult(
    val dataType: String,
    val pages: List<WithingsPage>,
    val records: List<JsonObject>,
)

data class WithingsNormalizedBatch(
    val sourcePayload: JsonObject,
    val records: List<me.aquitano.health.api.dto.IngestionRecordDto>,
)

class WithingsHttpException(
    val code: String,
    message: String,
) : RuntimeException(message)

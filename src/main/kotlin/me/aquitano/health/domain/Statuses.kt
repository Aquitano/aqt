package me.aquitano.health.domain

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Lifecycle enums for the status strings stored as TEXT in the database. Each entry's
 * [stored] value is the exact persisted string; [fromStored] fails loudly so a new
 * or corrupted DB value surfaces as a 500 instead of silently leaking through the API.
 */
@Serializable
enum class BatchStatus(val stored: String) {
    @SerialName("received")
    Received("received"),

    @SerialName("processed")
    Processed("processed"),

    @SerialName("failed")
    Failed("failed");

    companion object {
        fun fromStoredOrNull(value: String): BatchStatus? =
            entries.firstOrNull { it.stored == value }

        fun fromStored(value: String): BatchStatus =
            fromStoredOrNull(value)
                ?: error("Unknown ingestion batch status '$value'")
    }
}

@Serializable
enum class SyncStatus(val stored: String) {
    @SerialName("processed")
    Processed("processed"),

    @SerialName("partial_failed")
    PartialFailed("partial_failed"),

    @SerialName("failed")
    Failed("failed");

    companion object {
        fun fromStored(value: String): SyncStatus =
            entries.firstOrNull { it.stored == value }
                ?: error("Unknown provider sync status '$value'")
    }
}

@Serializable
enum class SyncJobStatus(val stored: String) {
    @SerialName("queued")
    Queued("queued"),

    @SerialName("running")
    Running("running"),

    @SerialName("processed")
    Processed("processed"),

    @SerialName("partial_failed")
    PartialFailed("partial_failed"),

    @SerialName("failed")
    Failed("failed");

    val terminal: Boolean
        get() = this != Queued && this != Running

    companion object {
        fun fromStored(value: String): SyncJobStatus =
            entries.firstOrNull { it.stored == value }
                ?: error("Unknown provider sync job status '$value'")
    }
}

@Serializable
enum class ReplayJobStatus(val stored: String) {
    @SerialName("queued")
    Queued("queued"),

    @SerialName("running")
    Running("running"),

    @SerialName("completed")
    Completed("completed"),

    @SerialName("failed")
    Failed("failed");

    val terminal: Boolean
        get() = this == Completed || this == Failed

    companion object {
        fun fromStored(value: String): ReplayJobStatus =
            entries.firstOrNull { it.stored == value }
                ?: error("Unknown replay job status '$value'")
    }
}

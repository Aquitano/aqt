package me.aquitano.health.infrastructure.database.tables

import org.jetbrains.exposed.v1.core.Table
import org.jetbrains.exposed.v1.core.dao.id.IntIdTable
import org.jetbrains.exposed.v1.javatime.timestampWithTimeZone

object ProviderOAuthAccountsTable : IntIdTable("provider_oauth_accounts") {
    val providerCode = text("provider_code")
    val providerUserId = text("provider_user_id")
    val providerInstanceId = text("provider_instance_id")
    val accessTokenCiphertext = text("access_token_ciphertext")
    val refreshTokenCiphertext = text("refresh_token_ciphertext")
    val tokenType = text("token_type")
    val expiresAt = timestampWithTimeZone("expires_at")
    val scope = text("scope")
    val accountStatus = text("account_status")
    val connectedAt = timestampWithTimeZone("connected_at").nullable()
    val disconnectedAt = timestampWithTimeZone("disconnected_at").nullable()
    val lastTokenRefreshAt = timestampWithTimeZone("last_token_refresh_at").nullable()
    val lastTokenRefreshStatus = text("last_token_refresh_status").nullable()
    val lastAuthErrorCode = text("last_auth_error_code").nullable()
    val lastAuthErrorMessage = text("last_auth_error_message").nullable()
    val createdAt = timestampWithTimeZone("created_at")
    val updatedAt = timestampWithTimeZone("updated_at")

    init {
        uniqueIndex(providerCode, providerUserId)
    }
}

object ProviderOAuthStatesTable : Table("provider_oauth_states") {
    val state = text("state")
    val providerCode = text("provider_code")
    val createdAt = timestampWithTimeZone("created_at")
    val expiresAt = timestampWithTimeZone("expires_at")
    val consumedAt = timestampWithTimeZone("consumed_at").nullable()

    override val primaryKey = PrimaryKey(state)
}

object ProviderSyncRunsTable : IntIdTable("provider_sync_runs") {
    val providerCode = text("provider_code")
    val providerInstanceId = text("provider_instance_id")
    val requestedFrom = timestampWithTimeZone("requested_from")
    val requestedTo = timestampWithTimeZone("requested_to")
    val status = text("status")
    val startedAt = timestampWithTimeZone("started_at")
    val finishedAt = timestampWithTimeZone("finished_at").nullable()
    val errorMessage = text("error_message").nullable()
}

object ProviderScheduledSyncConfigsTable : IntIdTable("provider_scheduled_sync_configs") {
    val providerCode = text("provider_code")
    val providerInstanceId = text("provider_instance_id")
    val enabled = bool("enabled")
    val dataTypes = text("data_types")
    val cadenceMinutes = integer("cadence_minutes")
    val lookbackDays = integer("lookback_days")
    val lastSuccessfulFrom = timestampWithTimeZone("last_successful_from").nullable()
    val lastSuccessfulTo = timestampWithTimeZone("last_successful_to").nullable()
    val lastSuccessAt = timestampWithTimeZone("last_success_at").nullable()
    val lastAttemptedAt = timestampWithTimeZone("last_attempted_at").nullable()
    val failureCount = integer("failure_count")
    val nextRunAt = timestampWithTimeZone("next_run_at").nullable()
    val lastErrorMessage = text("last_error_message").nullable()
    val createdAt = timestampWithTimeZone("created_at")
    val updatedAt = timestampWithTimeZone("updated_at")

    init {
        uniqueIndex(providerCode, providerInstanceId)
    }
}

object ProviderScheduledSyncCheckpointsTable : IntIdTable("provider_scheduled_sync_checkpoints") {
    val configId = reference("config_id", ProviderScheduledSyncConfigsTable)
    val dataType = text("data_type")
    val checkpointAt = timestampWithTimeZone("checkpoint_at").nullable()
    val lastSuccessfulFrom = timestampWithTimeZone("last_successful_from").nullable()
    val lastSuccessfulTo = timestampWithTimeZone("last_successful_to").nullable()
    val createdAt = timestampWithTimeZone("created_at")
    val updatedAt = timestampWithTimeZone("updated_at")

    init {
        uniqueIndex(configId, dataType)
    }
}

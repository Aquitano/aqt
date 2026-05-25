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

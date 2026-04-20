package me.aquitano.health.infrastructure.database.tables

import org.jetbrains.exposed.dao.id.IntIdTable
import org.jetbrains.exposed.sql.Table

object ProviderOAuthAccountsTable : IntIdTable("provider_oauth_accounts") {
    val providerCode = text("provider_code")
    val providerUserId = text("provider_user_id")
    val providerInstanceId = text("provider_instance_id")
    val accessTokenCiphertext = text("access_token_ciphertext")
    val refreshTokenCiphertext = text("refresh_token_ciphertext")
    val tokenType = text("token_type")
    val expiresAt = text("expires_at")
    val scope = text("scope")
    val createdAt = text("created_at")
    val updatedAt = text("updated_at")

    init {
        uniqueIndex(providerCode, providerUserId)
    }
}

object ProviderOAuthStatesTable : Table("provider_oauth_states") {
    val state = text("state")
    val providerCode = text("provider_code")
    val createdAt = text("created_at")
    val expiresAt = text("expires_at")
    val consumedAt = text("consumed_at").nullable()

    override val primaryKey = PrimaryKey(state)
}

object ProviderSyncRunsTable : IntIdTable("provider_sync_runs") {
    val providerCode = text("provider_code")
    val providerInstanceId = text("provider_instance_id")
    val requestedFrom = text("requested_from")
    val requestedTo = text("requested_to")
    val status = text("status")
    val startedAt = text("started_at")
    val finishedAt = text("finished_at").nullable()
    val errorMessage = text("error_message").nullable()
}

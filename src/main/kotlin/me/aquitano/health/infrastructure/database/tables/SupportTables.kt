package me.aquitano.health.infrastructure.database.tables

import org.jetbrains.exposed.v1.core.dao.id.IntIdTable
import org.jetbrains.exposed.v1.javatime.timestampWithTimeZone

object SourcesTable : IntIdTable("sources") {
    val code = text("code").uniqueIndex()
    val displayName = text("display_name").nullable()
    val createdAt = timestampWithTimeZone("created_at")
}

object SourceInstancesTable : IntIdTable("source_instances") {
    val sourceId = reference("source_id", SourcesTable)
    val providerInstanceId = text("provider_instance_id")
    val displayName = text("display_name").nullable()
    val createdAt = timestampWithTimeZone("created_at")
    val updatedAt = timestampWithTimeZone("updated_at")

    init {
        uniqueIndex(sourceId, providerInstanceId)
    }
}

object ApiClientsTable : IntIdTable("api_clients") {
    val name = text("name").uniqueIndex()
    val apiKeyHash = text("api_key_hash").uniqueIndex()
    val enabled = bool("enabled")
    val createdAt = timestampWithTimeZone("created_at")
    val lastUsedAt = timestampWithTimeZone("last_used_at").nullable()
}

package me.aquitano.health.infrastructure.database.dao

import me.aquitano.health.infrastructure.database.tables.ApiClientsTable
import me.aquitano.health.infrastructure.database.tables.SourceInstancesTable
import me.aquitano.health.infrastructure.database.tables.SourcesTable
import org.jetbrains.exposed.v1.core.dao.id.EntityID
import org.jetbrains.exposed.v1.dao.IntEntity
import org.jetbrains.exposed.v1.dao.IntEntityClass

class SourceDao(id: EntityID<Int>) : IntEntity(id) {
    companion object : IntEntityClass<SourceDao>(SourcesTable)

    var code by SourcesTable.code
    var displayName by SourcesTable.displayName
    var createdAt by SourcesTable.createdAt
}

class SourceInstanceDao(id: EntityID<Int>) : IntEntity(id) {
    companion object : IntEntityClass<SourceInstanceDao>(SourceInstancesTable)

    var source by SourceDao referencedOn SourceInstancesTable.sourceId
    var providerInstanceId by SourceInstancesTable.providerInstanceId
    var displayName by SourceInstancesTable.displayName
    var createdAt by SourceInstancesTable.createdAt
    var updatedAt by SourceInstancesTable.updatedAt
}

class ApiClientDao(id: EntityID<Int>) : IntEntity(id) {
    companion object : IntEntityClass<ApiClientDao>(ApiClientsTable)

    var name by ApiClientsTable.name
    var apiKeyHash by ApiClientsTable.apiKeyHash
    var enabled by ApiClientsTable.enabled
    var createdAt by ApiClientsTable.createdAt
    var lastUsedAt by ApiClientsTable.lastUsedAt
}

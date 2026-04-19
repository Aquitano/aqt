package me.aquitano.health.application

import kotlinx.coroutines.Dispatchers
import me.aquitano.health.api.dto.IngestionBatchAdminResponse
import me.aquitano.health.api.dto.IngestionBatchesResponse
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.infrastructure.repositories.IngestionRepository
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.transactions.experimental.newSuspendedTransaction

class AdminService(
    private val database: Database,
    private val ingestionRepository: IngestionRepository,
) {
    suspend fun listBatches(params: QueryParams): IngestionBatchesResponse {
        val status = params.optional("status")
        if (status != null && status !in setOf("received", "processed", "failed")) {
            throw RequestValidationException(listOf(ValidationIssue("status", "unsupported batch status")))
        }
        val from = params.instant("from")
        val to = params.instant("to")
        validateRange(from, to, "from", "to")
        val limit = params.limit(default = 100, max = 1000)
        return dbQuery {
            IngestionBatchesResponse(
                items = ingestionRepository.listBatches(status, from, to, limit).map {
                    IngestionBatchAdminResponse(
                        id = it.id,
                        provider = it.provider,
                        providerInstanceId = it.providerInstanceId,
                        batchExternalId = it.batchExternalId,
                        status = it.status,
                        ingestedAt = it.ingestedAt,
                        receivedAt = it.receivedAt,
                        processedAt = it.processedAt,
                        errorMessage = it.errorMessage,
                        recordCount = it.recordCount,
                    )
                },
            )
        }
    }

    suspend fun listFailures(params: QueryParams): IngestionBatchesResponse =
        listBatches(QueryParams(params.asMap() + ("status" to "failed")))

    private suspend fun <T> dbQuery(block: () -> T): T =
        newSuspendedTransaction(Dispatchers.IO, db = database) {
            block()
        }
}

fun QueryParams.asMap(): Map<String, String?> {
    val names = listOf("status", "from", "to", "limit")
    return names.associateWith { optional(it) }
}

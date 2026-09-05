package me.aquitano.health.application

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import me.aquitano.health.api.dto.ProviderSyncJobItemResponse
import me.aquitano.health.api.dto.ProviderSyncJobStartResponse
import me.aquitano.health.api.dto.ProviderSyncJobStatusResponse
import me.aquitano.health.api.dto.ProviderSyncRequest
import me.aquitano.health.api.dto.ProviderSyncResponse
import me.aquitano.health.domain.SyncJobStatus
import me.aquitano.health.application.providersync.ProviderSyncItem
import me.aquitano.health.application.providersync.ProviderSyncProgressSink
import me.aquitano.health.domain.ConflictException
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.domain.ProviderSyncRequest as DomainProviderSyncRequest
import me.aquitano.health.infrastructure.repositories.ProviderSyncJobRecord
import me.aquitano.health.infrastructure.repositories.ProviderSyncJobRepository
import me.aquitano.health.shared.AppJson
import io.github.oshai.kotlinlogging.KotlinLogging
import me.aquitano.health.infrastructure.logging.*
import java.time.Instant
import java.util.UUID

private val providerSyncJobLogger = KotlinLogging.logger {}

class ProviderSyncJobService(
    private val providerRegistry: HealthProviderRegistry,
    private val workflowService: ProviderWorkflowService,
    private val repository: ProviderSyncJobRepository,
    private val clock: me.aquitano.health.infrastructure.time.UtcClock,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    fun start(now: Instant) {
        scope.launch {
            repository.markInterruptedUnfinishedJobs(now)
        }
    }

    fun stop() {
        scope.cancel()
    }

    suspend fun create(
        providerCode: String,
        request: ProviderSyncRequest,
        now: Instant,
        idempotencyKey: String? = null,
    ): ProviderSyncJobStartResponse {
        val provider = providerRegistry.getProvider(providerCode)
            ?: throw NotFoundException("Provider '$providerCode' not found")
        val domainRequest = workflowService.toDomainSyncRequest(request, now)
        val requestHash = syncJobRequestHash(request)
        if (idempotencyKey != null) {
            repository.findByIdempotencyKey(provider.descriptor.providerCode, idempotencyKey)
                ?.let { existing ->
                    existing.requireMatchingIdempotencyRequest(requestHash)
                    providerSyncJobLogger.infoWithContext(
                        "provider_sync_job_idempotent_replay",
                        "provider" to provider.descriptor.providerCode,
                        "jobId" to existing.id,
                    )
                    return existing.toStartDto()
                }
        }
        val result = repository.create(
            id = UUID.randomUUID().toString(),
            providerCode = provider.descriptor.providerCode,
            providerInstanceId = domainRequest.providerInstanceId,
            requestedFrom = domainRequest.from,
            requestedTo = domainRequest.to,
            dataTypes = domainRequest.dataTypes,
            pageSize = domainRequest.pageSize,
            now = now,
            idempotencyKey = idempotencyKey,
            idempotencyRequestHash = idempotencyKey?.let { requestHash },
        )
        val job = result.record
        if (idempotencyKey != null) {
            job.requireMatchingIdempotencyRequest(requestHash)
        }
        if (result.created) {
            scope.launch {
                runJob(job.id, provider.descriptor.providerCode, domainRequest)
            }
        } else {
            providerSyncJobLogger.infoWithContext(
                "provider_sync_job_idempotent_replay",
                "provider" to provider.descriptor.providerCode,
                "jobId" to job.id,
            )
        }

        return job.toStartDto()
    }

    suspend fun get(jobId: String): ProviderSyncJobStatusResponse =
        repository.get(jobId)?.toDto()
            ?: throw NotFoundException("Provider sync job '$jobId' not found")

    suspend fun latest(providerCode: String?): ProviderSyncJobStatusResponse? {
        val canonicalProviderCode = providerCode
            ?.let { providerRegistry.getProvider(it)?.descriptor?.providerCode }
            ?: providerCode
        return repository.latest(canonicalProviderCode)?.toDto()
    }

    private suspend fun runJob(
        jobId: String,
        providerCode: String,
        request: DomainProviderSyncRequest,
    ) {
        repository.markRunning(jobId, clock.now())
        providerSyncJobLogger.infoWithContext(
            "provider_sync_job_started",
            "provider" to providerCode,
            "jobId" to jobId,
        )

        try {
            val summary = workflowService.sync(
                providerCode = providerCode,
                request = request,
                now = clock.now(),
                progress = JobProgressSink(jobId, repository, clock),
            )
            repository.finish(
                id = jobId,
                status = summary.status.stored,
                batchesCount = summary.batches.size,
                emptyCount = summary.emptyDataTypes.size,
                errorCount = summary.errors.size,
                summaryJson = AppJson.encodeToString(summary),
                errorMessage = summary.errors.joinToString("; ") { "${it.dataType}: ${it.message}" }
                    .ifBlank { null },
                now = clock.now(),
            )
            providerSyncJobLogger.infoWithContext(
                "provider_sync_job_completed",
                "provider" to providerCode,
                "jobId" to jobId,
                "status" to summary.status,
            )
        } catch (exception: Exception) {
            repository.finish(
                id = jobId,
                status = "failed",
                batchesCount = 0,
                emptyCount = 0,
                errorCount = 1,
                summaryJson = null,
                errorMessage = exception.message ?: "Provider sync failed.",
                now = clock.now(),
            )
            providerSyncJobLogger.warnWithContext(
                "provider_sync_job_failed",
                "provider" to providerCode,
                "jobId" to jobId,
                throwable = exception,
            )
        }
    }

    private class JobProgressSink(
        private val jobId: String,
        private val repository: ProviderSyncJobRepository,
        private val clock: me.aquitano.health.infrastructure.time.UtcClock,
    ) : ProviderSyncProgressSink {
        override suspend fun started(totalItems: Int, providerInstanceId: String) {
            repository.markStarted(jobId, providerInstanceId, totalItems, clock.now())
        }

        override suspend fun itemStarted(item: ProviderSyncItem) {
            repository.markItemStarted(jobId, item.dataType, item.from, item.to, clock.now())
        }

        override suspend fun itemCompleted(item: ProviderSyncItem) {
            repository.markItemCompleted(jobId, item.dataType, item.from, item.to, clock.now())
        }
    }

    private fun ProviderSyncJobRecord.toStartDto(): ProviderSyncJobStartResponse =
        ProviderSyncJobStartResponse(
            jobId = id,
            status = SyncJobStatus.fromStored(status),
            createdAt = createdAt.toString(),
        )

    private fun ProviderSyncJobRecord.requireMatchingIdempotencyRequest(requestHash: String) {
        if (idempotencyRequestHash == requestHash) return
        throw ConflictException(
            "idempotency_key_conflict",
            "Idempotency-Key was already used for a different provider sync request.",
        )
    }

    private fun ProviderSyncJobRecord.toDto(): ProviderSyncJobStatusResponse =
        ProviderSyncJobStatusResponse(
            jobId = id,
            providerCode = providerCode,
            providerInstanceId = providerInstanceId,
            requestedFrom = requestedFrom.toString(),
            requestedTo = requestedTo.toString(),
            dataTypes = dataTypes,
            status = SyncJobStatus.fromStored(status),
            totalItems = totalItems,
            completedItems = completedItems,
            currentItem = itemDto(currentDataType, currentFrom, currentTo),
            lastCompletedItem = itemDto(lastCompletedDataType, lastCompletedFrom, lastCompletedTo),
            batchesCount = batchesCount,
            emptyCount = emptyCount,
            errorCount = errorCount,
            errorMessage = errorMessage,
            createdAt = createdAt.toString(),
            startedAt = startedAt?.toString(),
            updatedAt = updatedAt.toString(),
            finishedAt = finishedAt?.toString(),
            summary = summaryJson?.let {
                runCatching { AppJson.decodeFromString<ProviderSyncResponse>(it) }.getOrNull()
            },
        )

    private fun itemDto(
        dataType: String?,
        from: Instant?,
        to: Instant?,
    ): ProviderSyncJobItemResponse? =
        if (dataType == null || from == null || to == null) {
            null
        } else {
            ProviderSyncJobItemResponse(dataType, from.toString(), to.toString())
        }
}

private fun syncJobRequestHash(request: ProviderSyncRequest): String =
    idempotencyRequestHash(
        request.providerInstanceId?.takeIf { it.isNotBlank() },
        request.from,
        request.to,
        request.dataTypes?.distinct()?.idempotencyListPart(),
        request.pageSize?.toString(),
    )

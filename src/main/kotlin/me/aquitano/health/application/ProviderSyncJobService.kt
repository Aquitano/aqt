package me.aquitano.health.application

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import me.aquitano.health.api.dto.ProviderSyncJobItemResponseDto
import me.aquitano.health.api.dto.ProviderSyncJobStartResponseDto
import me.aquitano.health.api.dto.ProviderSyncJobStatusResponseDto
import me.aquitano.health.api.dto.ProviderSyncRequestDto
import me.aquitano.health.api.dto.ProviderSyncResponseDto
import me.aquitano.health.application.providersync.ProviderSyncItem
import me.aquitano.health.application.providersync.ProviderSyncProgressSink
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.domain.ProviderSyncRequest
import me.aquitano.health.infrastructure.repositories.ProviderSyncJobRecord
import me.aquitano.health.infrastructure.repositories.ProviderSyncJobRepository
import me.aquitano.health.shared.AppJson
import net.logstash.logback.argument.StructuredArguments.kv
import org.slf4j.LoggerFactory
import java.time.Instant
import java.util.UUID

private val providerSyncJobLogger = LoggerFactory.getLogger(ProviderSyncJobService::class.java)

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
        request: ProviderSyncRequestDto,
        now: Instant,
    ): ProviderSyncJobStartResponseDto {
        val provider = providerRegistry.getProvider(providerCode)
            ?: throw NotFoundException("Provider '$providerCode' not found")
        val domainRequest = workflowService.toDomainSyncRequest(request, now)
        val job = repository.create(
            id = UUID.randomUUID().toString(),
            providerCode = provider.descriptor.providerCode,
            providerInstanceId = domainRequest.providerInstanceId,
            requestedFrom = domainRequest.from,
            requestedTo = domainRequest.to,
            dataTypes = domainRequest.dataTypes,
            pageSize = domainRequest.pageSize,
            now = now,
        )

        scope.launch {
            runJob(job.id, provider.descriptor.providerCode, domainRequest)
        }

        return ProviderSyncJobStartResponseDto(
            jobId = job.id,
            status = job.status,
            createdAt = job.createdAt.toString(),
        )
    }

    suspend fun get(jobId: String): ProviderSyncJobStatusResponseDto =
        repository.get(jobId)?.toDto()
            ?: throw NotFoundException("Provider sync job '$jobId' not found")

    suspend fun latest(providerCode: String?): ProviderSyncJobStatusResponseDto? {
        val canonicalProviderCode = providerCode
            ?.let { providerRegistry.getProvider(it)?.descriptor?.providerCode }
            ?: providerCode
        return repository.latest(canonicalProviderCode)?.toDto()
    }

    private suspend fun runJob(
        jobId: String,
        providerCode: String,
        request: ProviderSyncRequest,
    ) {
        repository.markRunning(jobId, clock.now())
        providerSyncJobLogger.info(
            "provider_sync_job_started {} {}",
            kv("provider", providerCode),
            kv("jobId", jobId),
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
                status = summary.status,
                batchesCount = summary.batches.size,
                emptyCount = summary.emptyDataTypes.size,
                errorCount = summary.errors.size,
                summaryJson = AppJson.encodeToString(summary),
                errorMessage = summary.errors.joinToString("; ") { "${it.dataType}: ${it.message}" }
                    .ifBlank { null },
                now = clock.now(),
            )
            providerSyncJobLogger.info(
                "provider_sync_job_completed {} {} {}",
                kv("provider", providerCode),
                kv("jobId", jobId),
                kv("status", summary.status),
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
            providerSyncJobLogger.warn(
                "provider_sync_job_failed {} {}",
                kv("provider", providerCode),
                kv("jobId", jobId),
                exception,
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

    private fun ProviderSyncJobRecord.toDto(): ProviderSyncJobStatusResponseDto =
        ProviderSyncJobStatusResponseDto(
            jobId = id,
            providerCode = providerCode,
            providerInstanceId = providerInstanceId,
            requestedFrom = requestedFrom.toString(),
            requestedTo = requestedTo.toString(),
            dataTypes = dataTypes,
            status = status,
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
                runCatching { AppJson.decodeFromString<ProviderSyncResponseDto>(it) }.getOrNull()
            },
        )

    private fun itemDto(
        dataType: String?,
        from: Instant?,
        to: Instant?,
    ): ProviderSyncJobItemResponseDto? =
        if (dataType == null || from == null || to == null) {
            null
        } else {
            ProviderSyncJobItemResponseDto(dataType, from.toString(), to.toString())
        }
}

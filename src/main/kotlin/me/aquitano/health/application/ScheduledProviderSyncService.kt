package me.aquitano.health.application

import kotlinx.coroutines.CancellationException
import me.aquitano.health.api.dto.*
import me.aquitano.health.domain.*
import me.aquitano.health.infrastructure.repositories.ScheduledSyncCheckpointRecord
import me.aquitano.health.infrastructure.repositories.ScheduledSyncConfigRecord
import me.aquitano.health.infrastructure.repositories.ScheduledSyncRepository
import kotlinx.coroutines.sync.Mutex
import io.github.oshai.kotlinlogging.KotlinLogging
import me.aquitano.health.infrastructure.logging.*
import java.time.Duration
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.min
import kotlin.math.pow

private val scheduledSyncLogger = KotlinLogging.logger {}

class ScheduledSyncRunGuard {
    // This is intentionally process-local. Multiple scheduler processes sharing one DB need a DB-backed claim.
    private val running = ConcurrentHashMap<String, Mutex>()

    suspend fun <T> tryRun(key: String, block: suspend () -> T): T? {
        val mutex = running.computeIfAbsent(key) { Mutex() }
        if (!mutex.tryLock()) return null
        return try {
            block()
        } finally {
            mutex.unlock()
            running.remove(key, mutex)
        }
    }
}

class ScheduledProviderSyncService(
    private val providerRegistry: HealthProviderRegistry,
    private val providerOAuthRepository: me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository,
    private val repository: ScheduledSyncRepository,
    private val runGuard: ScheduledSyncRunGuard = ScheduledSyncRunGuard(),
) {
    suspend fun getConfig(
        providerCode: String,
        providerInstanceId: String,
    ): ScheduledSyncConfigResponseDto {
        val provider = providerRegistry.getProvider(providerCode)
            ?: throw NotFoundException("Provider '$providerCode' not found")
        val normalizedCode = provider.providerCode
        providerOAuthRepository.accountByProviderInstanceForStatus(
            normalizedCode,
            providerInstanceId,
        ) ?: throw NotFoundException("Provider account '$providerInstanceId' not found")
        val config = repository.getConfig(normalizedCode, providerInstanceId)
            ?: defaultConfig(provider, providerInstanceId)
        val checkpoints = config.id.takeIf { it > 0 }?.let { repository.checkpoints(it) }.orEmpty()
        return config.toDto(checkpoints)
    }

    suspend fun updateConfig(
        providerCode: String,
        providerInstanceId: String,
        request: ScheduledSyncConfigUpdateRequestDto,
        now: Instant,
    ): ScheduledSyncConfigResponseDto {
        val provider = providerRegistry.getProvider(providerCode)
            ?: throw NotFoundException("Provider '$providerCode' not found")
        val normalizedCode = provider.providerCode
        providerOAuthRepository.accountByProviderInstanceForStatus(
            normalizedCode,
            providerInstanceId,
        ) ?: throw NotFoundException("Provider account '$providerInstanceId' not found")

        val existing = repository.getConfig(normalizedCode, providerInstanceId)
        val enabled = request.enabled ?: existing?.enabled ?: false
        val dataTypes = validateDataTypes(
            provider,
            request.dataTypes ?: existing?.dataTypes ?: provider.descriptor.defaultDataTypes,
        )
        val cadenceMinutes = validateRange(
            field = "cadenceMinutes",
            value = request.cadenceMinutes ?: existing?.cadenceMinutes ?: DEFAULT_CADENCE_MINUTES,
            min = 15,
            max = 43_200,
        )
        val lookbackDays = validateRange(
            field = "lookbackDays",
            value = request.lookbackDays ?: existing?.lookbackDays ?: DEFAULT_LOOKBACK_DAYS,
            min = 1,
            max = provider.descriptor.maxSyncRangeDays,
        )
        val nextRunAt = if (enabled) existing?.nextRunAt ?: now else null
        val config = repository.upsertConfig(
            providerCode = normalizedCode,
            providerInstanceId = providerInstanceId,
            enabled = enabled,
            dataTypes = dataTypes,
            cadenceMinutes = cadenceMinutes,
            lookbackDays = lookbackDays,
            nextRunAt = nextRunAt,
            now = now,
        )
        return config.toDto(repository.checkpoints(config.id))
    }

    suspend fun runNow(
        providerCode: String,
        providerInstanceId: String,
        now: Instant,
    ): ScheduledSyncRunResponseDto {
        val provider = providerRegistry.getProvider(providerCode)
            ?: throw NotFoundException("Provider '$providerCode' not found")
        val config = repository.getConfig(provider.providerCode, providerInstanceId)
            ?: throw ConflictException(
                code = "scheduled_sync_not_configured",
                message = "Scheduled sync is not configured for this provider account",
            )
        val result = runGuard.tryRun(runKey(config)) {
            executeConfig(provider, config, now)
        } ?: throw ConflictException(
            code = "scheduled_sync_already_running",
            message = "A scheduled sync is already running for this provider account",
        )
        return ScheduledSyncRunResponseDto(
            providerCode = provider.providerCode,
            providerInstanceId = providerInstanceId,
            status = SyncStatus.fromStored(result.status),
            requestedFrom = result.requestedFrom?.toString(),
            requestedTo = result.requestedTo?.toString(),
            errors = result.errors,
            summaries = result.summaries.map { it.toDto() },
        )
    }

    suspend fun runDue(now: Instant, limit: Int = 10): Int {
        var count = 0
        repository.dueConfigs(now, limit).forEach { config ->
            val provider = providerRegistry.getProvider(config.providerCode)
            if (provider == null) {
                repository.markFailure(
                    configId = config.id,
                    failureCount = config.failureCount + 1,
                    nextRunAt = null,
                    errorMessage = "Provider '${config.providerCode}' not found",
                    now = now,
                )
                return@forEach
            }
            val result = runGuard.tryRun(runKey(config)) {
                executeConfig(provider, config, now)
            }
            if (result != null) {
                count += 1
            }
        }
        return count
    }

    private suspend fun executeConfig(
        provider: HealthProvider,
        config: ScheduledSyncConfigRecord,
        now: Instant,
    ): ScheduledSyncExecutionResult {
        repository.markAttempt(config.id, now)
        val checkpoints = repository.checkpoints(config.id).associateBy { it.dataType }
        val summaries = mutableListOf<ProviderSyncSummary>()
        val errors = mutableListOf<String>()
        var hasNonRetryableError = false
        var earliestFrom: Instant? = null
        var latestTo: Instant? = null

        for (dataType in config.dataTypes) {
            val (from, to) = syncWindow(provider, config, checkpoints[dataType], now)
            earliestFrom = listOfNotNull(earliestFrom, from).minOrNull()
            latestTo = listOfNotNull(latestTo, to).maxOrNull()
            try {
                val summary = provider.sync(
                    ProviderSyncRequest(
                        providerInstanceId = config.providerInstanceId,
                        from = from,
                        to = to,
                        dataTypes = listOf(dataType),
                    ),
                    now,
                )
                summaries += summary
                if (summary.errors.isEmpty()) {
                    repository.markDataTypeSuccess(config.id, dataType, from, to, now)
                } else {
                    errors += summary.errors.joinToString("; ") { "${it.dataType}: ${it.message}" }
                    if (summary.errors.any { !it.retryable }) hasNonRetryableError = true
                }
            } catch (exception: Exception) {
                if (exception is CancellationException) throw exception
                errors += "${dataType}: ${exception.message ?: "Scheduled sync failed"}"
                if (!isRetryableSyncFailure(exception)) hasNonRetryableError = true
            }
        }

        return if (errors.isEmpty()) {
            repository.markSuccess(
                configId = config.id,
                from = earliestFrom ?: now,
                to = latestTo ?: now,
                nextRunAt = ScheduledSyncPolicy.nextRunAfterSuccess(now, config.cadenceMinutes),
                now = now,
            )
            ScheduledSyncExecutionResult("processed", earliestFrom, latestTo, emptyList(), summaries)
        } else {
            val failureCount = config.failureCount + 1
            repository.markFailure(
                configId = config.id,
                failureCount = failureCount,
                nextRunAt = if (hasNonRetryableError) null else ScheduledSyncPolicy.nextRunAfterFailure(now, failureCount),
                errorMessage = errors.joinToString("; "),
                now = now,
            )
            scheduledSyncLogger.warnWithContext(
                "scheduled_provider_sync_failed",
                "provider" to config.providerCode,
                "providerInstanceId" to config.providerInstanceId,
                "errorCount" to errors.size,
            )
            ScheduledSyncExecutionResult("failed", earliestFrom, latestTo, errors, summaries)
        }
    }

    private fun syncWindow(
        provider: HealthProvider,
        config: ScheduledSyncConfigRecord,
        checkpoint: ScheduledSyncCheckpointRecord?,
        now: Instant,
    ): Pair<Instant, Instant> {
        val lookback = Duration.ofDays(config.lookbackDays.toLong())
        val candidateFrom = checkpoint?.checkpointAt?.minus(lookback) ?: now.minus(lookback)
        val maxTo = candidateFrom.plus(Duration.ofDays(provider.descriptor.maxSyncRangeDays.toLong()))
        val to = if (maxTo.isBefore(now)) maxTo else now
        return candidateFrom to to
    }

    private fun runKey(config: ScheduledSyncConfigRecord): String =
        "${config.providerCode}:${config.providerInstanceId}"

    private fun defaultConfig(
        provider: HealthProvider,
        providerInstanceId: String,
    ): ScheduledSyncConfigRecord =
        ScheduledSyncConfigRecord(
            id = 0,
            providerCode = provider.providerCode,
            providerInstanceId = providerInstanceId,
            enabled = false,
            dataTypes = provider.descriptor.defaultDataTypes,
            cadenceMinutes = DEFAULT_CADENCE_MINUTES,
            lookbackDays = min(DEFAULT_LOOKBACK_DAYS, provider.descriptor.maxSyncRangeDays),
            lastSuccessfulFrom = null,
            lastSuccessfulTo = null,
            lastSuccessAt = null,
            lastAttemptedAt = null,
            failureCount = 0,
            nextRunAt = null,
            lastErrorMessage = null,
            createdAt = Instant.EPOCH,
            updatedAt = Instant.EPOCH,
        )

    private fun validateDataTypes(provider: HealthProvider, dataTypes: List<String>): List<String> {
        val selected = dataTypes.map { it.trim() }.filter { it.isNotBlank() }.distinct()
        val unsupported = selected.filterNot { provider.descriptor.supportedDataTypes.contains(it) }
        val issues = mutableListOf<ValidationIssue>()
        if (selected.isEmpty()) {
            issues += ValidationIssue("dataTypes", ValidationIssueCodes.Required, "must include at least one data type")
        }
        unsupported.forEach {
            issues += ValidationIssue("dataTypes", ValidationIssueCodes.UnsupportedValue, "'$it' is not supported")
        }
        if (issues.isNotEmpty()) throw RequestValidationException(issues)
        return selected
    }

    private fun validateRange(field: String, value: Int, min: Int, max: Int): Int {
        if (value < min || value > max) {
            throw RequestValidationException(
                listOf(ValidationIssue(field, ValidationIssueCodes.OutOfRange, "must be between $min and $max"))
            )
        }
        return value
    }

    private fun ProviderSyncSummary.toDto(): ProviderSyncResponseDto =
        ProviderSyncResponseDto(
            providerCode = providerCode,
            providerInstanceId = providerInstanceId,
            requestedFrom = requestedFrom.toString(),
            requestedTo = requestedTo.toString(),
            status = SyncStatus.fromStored(status),
            batches = batches.map { it.toDto() },
            emptyDataTypes = emptyDataTypes.map { it.toDto() },
            errors = errors.map { ProviderSyncErrorResponseDto(it.dataType, it.code, it.message) },
        )

    private fun ProviderSyncBatch.toDto(): ProviderSyncBatchResponseDto =
        ProviderSyncBatchResponseDto(
            dataType = dataType,
            batchId = batchId,
            duplicateBatch = duplicateBatch,
            recordsReceived = recordsReceived,
            ingestionRecordsStored = ingestionRecordsStored,
            metricsCreated = metricsCreated.counts,
            duplicateMetricsSkipped = duplicateMetricsSkipped,
            affectedStepSummaryDates = affectedStepSummaryDates,
        )

    private fun ProviderSyncEmptyDataType.toDto(): ProviderSyncEmptyDataTypeResponseDto =
        ProviderSyncEmptyDataTypeResponseDto(
            dataType = dataType,
            pagesFetched = pagesFetched,
            sourceRecordsReceived = sourceRecordsReceived,
            normalizedRecords = normalizedRecords,
        )
}

object ScheduledSyncPolicy {
    fun nextRunAfterSuccess(now: Instant, cadenceMinutes: Int): Instant =
        now.plus(Duration.ofMinutes(cadenceMinutes.toLong()))

    fun nextRunAfterFailure(now: Instant, failureCount: Int): Instant {
        val exponent = (failureCount - 1).coerceAtLeast(0)
        val minutes = min(1_440.0, 2.0.pow(exponent).coerceAtLeast(1.0)).toLong()
        return now.plus(Duration.ofMinutes(minutes))
    }
}

private data class ScheduledSyncExecutionResult(
    val status: String,
    val requestedFrom: Instant?,
    val requestedTo: Instant?,
    val errors: List<String>,
    val summaries: List<ProviderSyncSummary>,
)

private const val DEFAULT_CADENCE_MINUTES = 1_440
private const val DEFAULT_LOOKBACK_DAYS = 7

private fun ScheduledSyncConfigRecord.toDto(
    checkpoints: List<ScheduledSyncCheckpointRecord>,
): ScheduledSyncConfigResponseDto =
    ScheduledSyncConfigResponseDto(
        providerCode = providerCode,
        providerInstanceId = providerInstanceId,
        enabled = enabled,
        dataTypes = dataTypes,
        cadenceMinutes = cadenceMinutes,
        lookbackDays = lookbackDays,
        lastSuccessfulFrom = lastSuccessfulFrom?.toString(),
        lastSuccessfulTo = lastSuccessfulTo?.toString(),
        lastSuccessAt = lastSuccessAt?.toString(),
        lastAttemptedAt = lastAttemptedAt?.toString(),
        failureCount = failureCount,
        nextRunAt = nextRunAt?.toString(),
        lastErrorMessage = lastErrorMessage,
        checkpoints = checkpoints.map { it.toDto() },
    )

private fun ScheduledSyncCheckpointRecord.toDto(): ScheduledSyncCheckpointResponseDto =
    ScheduledSyncCheckpointResponseDto(
        dataType = dataType,
        checkpointAt = checkpointAt?.toString(),
        lastSuccessfulFrom = lastSuccessfulFrom?.toString(),
        lastSuccessfulTo = lastSuccessfulTo?.toString(),
    )

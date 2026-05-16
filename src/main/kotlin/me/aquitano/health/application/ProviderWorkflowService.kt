package me.aquitano.health.application

import me.aquitano.health.api.dto.*
import me.aquitano.health.domain.*
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.repositories.ProviderOAuthStateConsumeResult
import net.logstash.logback.argument.StructuredArguments.kv
import org.slf4j.LoggerFactory
import java.security.SecureRandom
import java.time.Duration
import java.time.Instant
import java.util.*

private val logger =
    LoggerFactory.getLogger(ProviderWorkflowService::class.java)

class ProviderWorkflowService(
    private val providerRegistry: HealthProviderRegistry,
    private val providerOAuthRepository: ProviderOAuthRepository,
) {
    private val random = SecureRandom()

    suspend fun startOAuth(
        providerCode: String,
        now: Instant
    ): ProviderOAuthStartResponse {
        val provider = providerRegistry.getProvider(providerCode)
            ?: throw NotFoundException("Provider '$providerCode' not found")

        val state = randomState()
        val expiresAt = now.plus(Duration.ofMinutes(10))
        providerOAuthRepository.insertState(
            state,
            provider.providerCode,
            now,
            expiresAt
        )
        logger.info(
            "provider_oauth_start_created {} {}",
            kv("provider", provider.providerCode),
            kv("expiresAt", expiresAt.toString()),
        )

        return ProviderOAuthStartResponse(
            provider = provider.providerCode,
            authorizationUrl = provider.getAuthUrl(state),
            expiresAt = expiresAt.toString(),
        )
    }

    suspend fun completeOAuth(
        providerCode: String,
        code: String?,
        state: String?,
        error: String?,
        now: Instant,
    ): ProviderOAuthCallbackResponse {
        val provider = providerRegistry.getProvider(providerCode)
            ?: throw NotFoundException("Provider '$providerCode' not found")

        if (!error.isNullOrBlank()) {
            logger.warn(
                "provider_oauth_callback_rejected {} {}",
                kv("provider", provider.providerCode),
                kv("error", error),
            )
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "error",
                        code = ValidationIssueCodes.InvalidState,
                        message = error,
                    )
                )
            )
        }

        val authCode = code?.takeIf { it.isNotBlank() }
        val authState = state?.takeIf { it.isNotBlank() }
        if (authCode == null || authState == null) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue("code"),
                    ValidationIssue("state"),
                )
            )
        }

        when (providerOAuthRepository.consumeState(
            authState,
            provider.providerCode,
            now
        )) {
            is ProviderOAuthStateConsumeResult.Consumed -> Unit
            is ProviderOAuthStateConsumeResult.AlreadyUsed ->
                throw RequestValidationException(
                    listOf(
                        ValidationIssue(
                            field = "state",
                            code = ValidationIssueCodes.InvalidState,
                            message = "was already used",
                        )
                    )
                )

            is ProviderOAuthStateConsumeResult.Expired ->
                throw RequestValidationException(
                    listOf(
                        ValidationIssue(
                            field = "state",
                            code = ValidationIssueCodes.InvalidState,
                            message = "has expired",
                        )
                    )
                )

            ProviderOAuthStateConsumeResult.NotFound ->
                throw RequestValidationException(
                    listOf(
                        ValidationIssue(
                            field = "state",
                            code = ValidationIssueCodes.InvalidState,
                            message = "is invalid",
                        )
                    )
                )
        }

        val connection = provider.connect(authCode, now)
        return ProviderOAuthCallbackResponse(
            provider = connection.providerCode,
            providerInstanceId = connection.providerInstanceId,
            connected = connection.connected,
        )
    }

    suspend fun sync(
        providerCode: String,
        request: ProviderSyncRequestDto,
        now: Instant
    ): ProviderSyncResponseDto =
        providerRegistry.getProvider(providerCode)
            ?.sync(request.toDomain(now), now)
            ?.toDto()
            ?: throw NotFoundException("Provider '$providerCode' not found")

    private fun ProviderSyncRequestDto.toDomain(now: Instant): ProviderSyncRequest {
        val issues = mutableListOf<ValidationIssue>()
        val parsedFrom = from?.let { parseInstant("from", it, issues) }
        val parsedTo = to?.let { parseInstant("to", it, issues) }

        val resolvedFrom: Instant
        val resolvedTo: Instant
        if (parsedFrom == null && parsedTo == null && issues.isEmpty()) {
            resolvedTo = now
            resolvedFrom = now.minus(Duration.ofDays(7))
        } else {
            resolvedFrom = parsedFrom ?: run {
                issues.add(
                    ValidationIssue(
                        field = "from",
                        code = ValidationIssueCodes.Required,
                        message = "is required when to is provided",
                    )
                )
                now
            }
            resolvedTo = parsedTo ?: run {
                issues.add(
                    ValidationIssue(
                        field = "to",
                        code = ValidationIssueCodes.Required,
                        message = "is required when from is provided",
                    )
                )
                now
            }
        }

        if (!resolvedFrom.isBefore(resolvedTo)) {
            issues.add(
                ValidationIssue(
                    field = "from",
                    code = ValidationIssueCodes.InvalidRange,
                    message = "must be before to",
                )
            )
        }
        if (Duration.between(resolvedFrom, resolvedTo) > Duration.ofDays(31)) {
            issues.add(
                ValidationIssue(
                    field = "to",
                    code = ValidationIssueCodes.OutOfRange,
                    message = "range must not exceed 31 days",
                )
            )
        }
        if (pageSize != null && pageSize <= 0) {
            issues.add(
                ValidationIssue(
                    field = "pageSize",
                    code = ValidationIssueCodes.OutOfRange,
                    message = "must be greater than 0",
                )
            )
        }
        if (providerInstanceId != null && providerInstanceId.isNotBlank() && providerInstanceId.trim() != providerInstanceId) {
            issues.add(
                ValidationIssue(
                    field = "providerInstanceId",
                    code = ValidationIssueCodes.InvalidFormat,
                    message = "must not have leading or trailing whitespace",
                )
            )
        }

        if (issues.isNotEmpty()) throw RequestValidationException(issues)
        return ProviderSyncRequest(
            providerInstanceId = providerInstanceId?.takeIf { it.isNotBlank() },
            from = resolvedFrom,
            to = resolvedTo,
            dataTypes = dataTypes?.distinct(),
            pageSize = pageSize,
        )
    }

    private fun parseInstant(
        field: String,
        value: String,
        issues: MutableList<ValidationIssue>
    ): Instant? =
        runCatching { Instant.parse(value) }.getOrElse {
            issues.add(
                ValidationIssue(
                    field = field,
                    code = ValidationIssueCodes.InvalidFormat,
                    message = "must be an ISO-8601 instant",
                )
            )
            null
        }

    private fun randomState(): String {
        val bytes = ByteArray(32)
        random.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    private fun ProviderSyncSummary.toDto(): ProviderSyncResponseDto =
        ProviderSyncResponseDto(
            providerCode = providerCode,
            providerInstanceId = providerInstanceId,
            requestedFrom = requestedFrom.toString(),
            requestedTo = requestedTo.toString(),
            status = status,
            batches = batches.map { it.toDto() },
            emptyDataTypes = emptyDataTypes.map { it.toDto() },
            errors = errors.map { it.toDto() },
        )

    private fun ProviderSyncBatch.toDto(): ProviderSyncBatchResponseDto =
        ProviderSyncBatchResponseDto(
            dataType = dataType,
            batchId = batchId,
            duplicateBatch = duplicateBatch,
            recordsReceived = recordsReceived,
            ingestionRecordsStored = ingestionRecordsStored,
            metricsCreated = metricsCreated.toDto(),
            duplicateMetricsSkipped = duplicateMetricsSkipped,
            affectedStepSummaryDates = affectedStepSummaryDates,
        )

    private fun ProviderSyncError.toDto(): ProviderSyncErrorResponseDto =
        ProviderSyncErrorResponseDto(
            dataType = dataType,
            code = code,
            message = message,
        )

    private fun ProviderSyncEmptyDataType.toDto(): ProviderSyncEmptyDataTypeResponseDto =
        ProviderSyncEmptyDataTypeResponseDto(
            dataType = dataType,
            pagesFetched = pagesFetched,
            sourceRecordsReceived = sourceRecordsReceived,
            normalizedRecords = normalizedRecords,
        )

    private fun MetricCreatedCounts.toDto(): MetricCreatedCountsResponse =
        MetricCreatedCountsResponse(
            stepSamples = stepSamples,
            sleepSessions = sleepSessions,
            sleepStages = sleepStages,
            bodyMeasurements = bodyMeasurements,
            heartRateSamples = heartRateSamples,
        )
}

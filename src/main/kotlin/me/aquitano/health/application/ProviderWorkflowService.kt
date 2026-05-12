package me.aquitano.health.application

import me.aquitano.health.api.dto.ProviderOAuthCallbackResponse
import me.aquitano.health.api.dto.ProviderOAuthStartResponse
import me.aquitano.health.api.dto.ProviderSyncRequestDto
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.domain.ProviderSyncRequest
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import net.logstash.logback.argument.StructuredArguments.kv
import org.slf4j.LoggerFactory
import java.security.SecureRandom
import java.time.Duration
import java.time.Instant
import java.util.Base64

private val logger = LoggerFactory.getLogger(ProviderWorkflowService::class.java)

class ProviderWorkflowService(
    private val providerRegistry: HealthProviderRegistry,
    private val providerOAuthRepository: ProviderOAuthRepository,
) {
    private val random = SecureRandom()

    suspend fun startOAuth(providerCode: String, now: Instant): ProviderOAuthStartResponse {
        val provider = providerRegistry.getProvider(providerCode)
            ?: throw NotFoundException("Provider '$providerCode' not found")

        val state = randomState()
        val expiresAt = now.plus(Duration.ofMinutes(10))
        providerOAuthRepository.insertState(state, provider.providerCode, now, expiresAt)
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
            throw RequestValidationException(listOf(ValidationIssue("error", error)))
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

        val storedState = providerOAuthRepository.consumeState(authState, provider.providerCode, now)
            ?: throw RequestValidationException(listOf(ValidationIssue("state", "is invalid")))
        if (storedState.consumedAt != null) {
            throw RequestValidationException(listOf(ValidationIssue("state", "was already used")))
        }
        if (!now.isBefore(storedState.expiresAt)) {
            throw RequestValidationException(listOf(ValidationIssue("state", "has expired")))
        }

        val connection = provider.connect(authCode, now)
        return ProviderOAuthCallbackResponse(
            provider = connection.providerCode,
            providerInstanceId = connection.providerInstanceId,
            connected = connection.connected,
        )
    }

    suspend fun sync(providerCode: String, request: ProviderSyncRequestDto, now: Instant) =
        providerRegistry.getProvider(providerCode)
            ?.sync(request.toDomain(now), now)
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
                issues.add(ValidationIssue("from", "is required when to is provided"))
                now
            }
            resolvedTo = parsedTo ?: run {
                issues.add(ValidationIssue("to", "is required when from is provided"))
                now
            }
        }

        if (!resolvedFrom.isBefore(resolvedTo)) {
            issues.add(ValidationIssue("from", "must be before to"))
        }
        if (Duration.between(resolvedFrom, resolvedTo) > Duration.ofDays(31)) {
            issues.add(ValidationIssue("to", "range must not exceed 31 days"))
        }
        if (pageSize != null && pageSize <= 0) {
            issues.add(ValidationIssue("pageSize", "must be greater than 0"))
        }
        if (providerInstanceId != null && providerInstanceId.isNotBlank() && providerInstanceId.trim() != providerInstanceId) {
            issues.add(ValidationIssue("providerInstanceId", "must not have leading or trailing whitespace"))
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

    private fun parseInstant(field: String, value: String, issues: MutableList<ValidationIssue>): Instant? =
        runCatching { Instant.parse(value) }.getOrElse {
            issues.add(ValidationIssue(field, "must be an ISO-8601 instant"))
            null
        }

    private fun randomState(): String {
        val bytes = ByteArray(32)
        random.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}

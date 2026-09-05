package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.util.*
import me.aquitano.health.domain.UnauthorizedException
import me.aquitano.health.infrastructure.repositories.ApiClientRef
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.infrastructure.security.ApiKeyHasher
import me.aquitano.health.infrastructure.time.UtcClock

val ApiClientAttributeKey = AttributeKey<ApiClientRef>("ApiClient")

/** Matches the OpenAPI security scheme name so inferred route security stays consistent. */
const val ApiKeyAuthProviderName = BearerApiKeySecurityScheme

fun Application.configureAuthentication(
    supportRepository: SupportRepository,
    apiKeyHasher: ApiKeyHasher,
    clock: UtcClock,
) {
    install(Authentication) {
        register(ApiKeyAuthenticationProvider(supportRepository, apiKeyHasher, clock))
    }
}

private class ApiKeyAuthProviderConfig :
    AuthenticationProvider.Config(ApiKeyAuthProviderName)

/**
 * Bearer API-key authentication for `authenticate(ApiKeyAuthProviderName)` route blocks.
 * Failures (missing header included) throw [UnauthorizedException] so StatusPages keeps
 * producing the structured error envelope.
 */
private class ApiKeyAuthenticationProvider(
    private val supportRepository: SupportRepository,
    private val apiKeyHasher: ApiKeyHasher,
    private val clock: UtcClock,
) : AuthenticationProvider(ApiKeyAuthProviderConfig()) {
    override suspend fun onAuthenticate(context: AuthenticationContext) {
        val client = context.call.requireApiClient(
            supportRepository = supportRepository,
            apiKeyHasher = apiKeyHasher,
            clock = clock,
        )
        context.principal(client)
    }
}

private suspend fun ApplicationCall.requireApiClient(
    supportRepository: SupportRepository,
    apiKeyHasher: ApiKeyHasher,
    clock: UtcClock,
): ApiClientRef {
    val cached = attributes.getOrNull(ApiClientAttributeKey)
    if (cached != null) return cached

    val header = request.headers[HttpHeaders.Authorization]
        ?: throw UnauthorizedException()
    val apiKey = header.removePrefix("Bearer ").takeIf { it != header }?.trim()
        ?: throw UnauthorizedException()
    if (apiKey.isBlank()) throw UnauthorizedException()

    val client = supportRepository.findEnabledApiClientByHash(
        apiKeyHash = apiKeyHasher.hash(apiKey),
        now = clock.now(),
    ) ?: throw UnauthorizedException()

    attributes.put(ApiClientAttributeKey, client)
    return client
}


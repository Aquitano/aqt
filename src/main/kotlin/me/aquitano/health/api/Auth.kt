package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.util.*
import me.aquitano.health.domain.UnauthorizedException
import me.aquitano.health.infrastructure.repositories.ApiClientRef
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.infrastructure.security.ApiKeyHasher
import me.aquitano.health.infrastructure.time.UtcClock

val ApiClientAttributeKey = AttributeKey<ApiClientRef>("ApiClient")

suspend fun ApplicationCall.requireApiClient(
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


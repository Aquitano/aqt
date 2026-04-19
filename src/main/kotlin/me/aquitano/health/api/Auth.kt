package me.aquitano.health.api

import io.ktor.http.HttpHeaders
import io.ktor.server.application.ApplicationCall
import me.aquitano.health.domain.UnauthorizedException
import me.aquitano.health.infrastructure.repositories.ApiClientRef
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.infrastructure.security.ApiKeyHasher
import me.aquitano.health.infrastructure.time.UtcClock

suspend fun ApplicationCall.requireApiClient(
    supportRepository: SupportRepository,
    apiKeyHasher: ApiKeyHasher,
    clock: UtcClock,
): ApiClientRef {
    val header = request.headers[HttpHeaders.Authorization] ?: throw UnauthorizedException()
    val apiKey = header.removePrefix("Bearer ").takeIf { it != header }?.trim()
        ?: throw UnauthorizedException()
    if (apiKey.isBlank()) throw UnauthorizedException()

    return supportRepository.findEnabledApiClientByHash(
        apiKeyHash = apiKeyHasher.hash(apiKey),
        now = clock.now(),
    ) ?: throw UnauthorizedException()
}

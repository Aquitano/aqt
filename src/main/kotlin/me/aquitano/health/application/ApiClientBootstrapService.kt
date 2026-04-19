package me.aquitano.health.application

import me.aquitano.health.infrastructure.config.AuthConfig
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.infrastructure.security.ApiKeyHasher
import me.aquitano.health.infrastructure.time.UtcClock

class ApiClientBootstrapService(
    private val authConfig: AuthConfig,
    private val supportRepository: SupportRepository,
    private val apiKeyHasher: ApiKeyHasher,
    private val clock: UtcClock,
) {
    fun bootstrap() {
        val bootstrapApiKey = authConfig.bootstrapApiKey
        if (bootstrapApiKey.isBlank()) return

        supportRepository.createBootstrapApiClientIfMissing(
            name = authConfig.bootstrapClientName,
            apiKeyHash = apiKeyHasher.hash(bootstrapApiKey),
            now = clock.now(),
        )
    }
}

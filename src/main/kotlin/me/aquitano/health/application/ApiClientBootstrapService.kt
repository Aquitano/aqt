package me.aquitano.health.application

import me.aquitano.health.infrastructure.config.AuthConfig
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.infrastructure.security.ApiKeyHasher
import me.aquitano.health.infrastructure.time.UtcClock
import net.logstash.logback.argument.StructuredArguments.kv
import org.slf4j.LoggerFactory

private val logger =
    LoggerFactory.getLogger(ApiClientBootstrapService::class.java)

class ApiClientBootstrapService(
    private val authConfig: AuthConfig,
    private val supportRepository: SupportRepository,
    private val apiKeyHasher: ApiKeyHasher,
    private val clock: UtcClock,
) {
    fun bootstrap() {
        val bootstrapApiKey = authConfig.bootstrapApiKey
        if (bootstrapApiKey.isBlank()) {
            logger.info(
                "api_client_bootstrap_skipped {}",
                kv("clientName", authConfig.bootstrapClientName),
            )
            return
        }

        val created = supportRepository.createBootstrapApiClientIfMissing(
            name = authConfig.bootstrapClientName,
            apiKeyHash = apiKeyHasher.hash(bootstrapApiKey),
            now = clock.now(),
        )
        logger.info(
            if (created) "api_client_bootstrap_created {}" else "api_client_bootstrap_skipped {}",
            kv("clientName", authConfig.bootstrapClientName),
        )
    }
}

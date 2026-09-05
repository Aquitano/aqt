package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.cors.routing.*
import kotlinx.serialization.json.Json
import me.aquitano.health.infrastructure.config.CorsConfig
import java.net.URI

fun Application.configureHttp(corsConfig: CorsConfig) {
    install(ContentNegotiation) {
        json(
            Json {
                ignoreUnknownKeys = false
                explicitNulls = false
                isLenient = false
                encodeDefaults = true
            },
        )
    }
    install(CORS) {
        allowMethod(HttpMethod.Get)
        allowMethod(HttpMethod.Post)
        allowMethod(HttpMethod.Put)
        allowMethod(HttpMethod.Delete)
        allowHeader(HttpHeaders.Authorization)
        allowHeader(HttpHeaders.ContentType)
        allowHeader("Idempotency-Key")
        allowNonSimpleContentTypes = true
        allowCredentials = true
        corsConfig.origins.forEach { origin ->
            // Register each configured origin under only its own scheme. With allowCredentials = true,
            // registering both http and https for an https origin would also accept the plaintext
            // variant for credentialed cross-origin requests. Fall back to host-only with both schemes
            // only when the origin has no parseable scheme/host (legacy bare-host config).
            val uri = runCatching { URI(origin) }.getOrNull()
            val scheme = uri?.scheme?.lowercase()
            val host = uri?.host
            if (scheme != null && host != null) {
                val hostWithPort = if (uri.port != -1) "$host:${uri.port}" else host
                allowHost(hostWithPort, schemes = listOf(scheme))
            } else {
                allowHost(origin.removePrefix("http://").removePrefix("https://"), schemes = listOf("http", "https"))
            }
        }
    }
    configureRequestLogging()
    configureErrorHandling()
}

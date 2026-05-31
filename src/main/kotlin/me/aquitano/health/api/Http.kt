package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.cors.routing.*
import kotlinx.serialization.json.Json
import me.aquitano.health.infrastructure.config.CorsConfig

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
        allowNonSimpleContentTypes = true
        allowCredentials = true
        corsConfig.origins.forEach { origin ->
            allowHost(origin.removePrefix("http://").removePrefix("https://"), schemes = listOf("http", "https"))
        }
    }
    configureRequestLogging()
    configureErrorHandling()
}

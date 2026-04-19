package me.aquitano.health.api

import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.plugins.calllogging.*
import io.ktor.server.plugins.contentnegotiation.*
import kotlinx.serialization.json.Json
import org.slf4j.event.Level

fun Application.configureHttp() {
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
    install(CallLogging) {
        level = Level.INFO
    }
    configureErrorHandling()
}

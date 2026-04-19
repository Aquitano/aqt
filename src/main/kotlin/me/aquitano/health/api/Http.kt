package me.aquitano.health.api

import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.plugins.calllogging.CallLogging
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
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
    install(StatusPages)
}

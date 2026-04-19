package me.aquitano.health.api

import io.ktor.server.application.Application
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import kotlinx.serialization.Serializable
import me.aquitano.health.infrastructure.time.UtcClock

fun Application.configureRoutes(clock: UtcClock) {
    routing {
        get("/api/v1/admin/health") {
            call.respond(HealthResponse(status = "ok", service = "aqt-health", time = clock.now().toString()))
        }
    }
}

@Serializable
data class HealthResponse(
    val status: String,
    val service: String,
    val time: String,
)

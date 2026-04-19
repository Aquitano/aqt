package me.aquitano.health.api

import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import kotlinx.serialization.Serializable
import me.aquitano.health.api.dto.IngestionBatchRequest

fun Application.configureRoutes(services: ApplicationServices) {
    routing {
        get("/api/v1/admin/health") {
            call.respond(HealthResponse(status = "ok", service = "aqt-health", time = services.clock.now().toString()))
        }
        post("/api/v1/ingestion/batches") {
            call.requireApiClient(
                supportRepository = services.supportRepository,
                apiKeyHasher = services.apiKeyHasher,
                clock = services.clock,
            )
            val response = services.ingestionService.ingestBatch(
                request = call.receive<IngestionBatchRequest>(),
                now = services.clock.now(),
            )
            val status = if (response.duplicateBatch) HttpStatusCode.OK else HttpStatusCode.Created
            call.respond(status, response)
        }
    }
}

@Serializable
data class HealthResponse(
    val status: String,
    val service: String,
    val time: String,
)

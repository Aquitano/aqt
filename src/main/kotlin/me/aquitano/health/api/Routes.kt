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
import me.aquitano.health.application.QueryParams

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
        get("/api/v1/metrics/steps") {
            call.authenticateProtected(services)
            call.respond(services.metricsQueryService.listStepSamples(call.queryParams()))
        }
        get("/api/v1/metrics/steps/daily") {
            call.authenticateProtected(services)
            call.respond(services.metricsQueryService.listStepDailySummaries(call.queryParams()))
        }
        get("/api/v1/sleep/sessions") {
            call.authenticateProtected(services)
            call.respond(services.metricsQueryService.listSleepSessions(call.queryParams()))
        }
        get("/api/v1/body/measurements") {
            call.authenticateProtected(services)
            call.respond(services.metricsQueryService.listBodyMeasurements(call.queryParams()))
        }
        get("/api/v1/metrics/heart-rate") {
            call.authenticateProtected(services)
            call.respond(services.metricsQueryService.listHeartRateSamples(call.queryParams()))
        }
        get("/api/v1/admin/ingestion/batches") {
            call.authenticateProtected(services)
            call.respond(services.adminService.listBatches(call.queryParams()))
        }
        get("/api/v1/admin/ingestion/failures") {
            call.authenticateProtected(services)
            call.respond(services.adminService.listFailures(call.queryParams()))
        }
    }
}

@Serializable
data class HealthResponse(
    val status: String,
    val service: String,
    val time: String,
)

private suspend fun io.ktor.server.application.ApplicationCall.authenticateProtected(services: ApplicationServices) {
    requireApiClient(
        supportRepository = services.supportRepository,
        apiKeyHasher = services.apiKeyHasher,
        clock = services.clock,
    )
}

private fun io.ktor.server.application.ApplicationCall.queryParams(): QueryParams =
    QueryParams(request.queryParameters.entries().associate { it.key to it.value.firstOrNull() })

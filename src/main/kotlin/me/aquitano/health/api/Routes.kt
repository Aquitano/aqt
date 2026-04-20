package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.plugins.openapi.*
import io.ktor.server.plugins.swagger.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import me.aquitano.health.api.dto.GoogleHealthSyncRequest
import kotlinx.serialization.Serializable
import me.aquitano.health.api.dto.IngestionBatchRequest
import me.aquitano.health.application.QueryParams

fun Application.configureRoutes(services: ApplicationServices) {
    routing {
        openAPI(path = "openapi", swaggerFile = "openapi/aqt-health.yaml")
        swaggerUI(path = "swagger", swaggerFile = "openapi/aqt-health.yaml")

        get("/api/v1/admin/health") {
            call.respond(
                HealthResponse(
                    status = "ok",
                    service = "aqt-health",
                    time = services.clock.now().toString()
                )
            )
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
            val status =
                if (response.duplicateBatch) HttpStatusCode.OK else HttpStatusCode.Created
            call.respond(status, response)
        }
        get("/api/v1/providers/google-health/oauth/start") {
            call.authenticateProtected(services)
            call.respond(services.googleHealthOAuthService.start(services.clock.now()))
        }
        get("/api/v1/providers/google-health/oauth/callback") {
            call.respond(
                services.googleHealthOAuthService.callback(
                    code = call.request.queryParameters["code"],
                    state = call.request.queryParameters["state"],
                    error = call.request.queryParameters["error"],
                    now = services.clock.now(),
                )
            )
        }
        post("/api/v1/providers/google-health/sync") {
            call.authenticateProtected(services)
            call.respond(
                services.googleHealthSyncService.sync(
                    request = call.receive<GoogleHealthSyncRequest>(),
                    now = services.clock.now(),
                )
            )
        }
        get("/api/v1/metrics/steps") {
            call.authenticateProtected(services)
            call.respond(services.metricsQueryService.listStepSamples(call.queryParams()))
        }
        get("/api/v1/metrics/steps/daily") {
            call.authenticateProtected(services)
            call.respond(
                services.metricsQueryService.listStepDailySummaries(
                    call.queryParams(),
                    services.clock.now()
                )
            )
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
        get("/api/v1/dashboard/summary") {
            call.authenticateProtected(services)
            call.respond(
                services.metricsQueryService.dashboardSummary(
                    call.queryParams(),
                    services.clock.now()
                )
            )
        }
        get("/api/v1/admin/ingestion/batches") {
            call.authenticateProtected(services)
            call.respond(services.adminService.listBatches(call.queryParams()))
        }
        get("/api/v1/admin/ingestion/batches/{id}") {
            call.authenticateProtected(services)
            call.respond(
                services.adminService.getBatchDetail(
                    call.parameters["id"],
                    call.queryParams()
                )
            )
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

private suspend fun ApplicationCall.authenticateProtected(
    services: ApplicationServices
) {
    requireApiClient(
        supportRepository = services.supportRepository,
        apiKeyHasher = services.apiKeyHasher,
        clock = services.clock,
    )
}

private fun ApplicationCall.queryParams(): QueryParams =
    QueryParams(
        request.queryParameters.entries()
            .associate { it.key to it.value.firstOrNull() })

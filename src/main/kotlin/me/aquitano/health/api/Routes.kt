@file:OptIn(io.ktor.utils.io.ExperimentalKtorApi::class)

package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.plugins.swagger.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.routing.openapi.describe
import io.ktor.server.routing.openapi.hide
import io.ktor.server.routing.openapi.OpenApiDocSource
import io.ktor.openapi.Components
import io.ktor.openapi.OpenApiDoc
import io.ktor.openapi.OpenApiInfo
import io.ktor.openapi.Operation
import kotlinx.serialization.Serializable
import me.aquitano.health.api.dto.*
import me.aquitano.health.application.QueryParams
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import kotlin.reflect.typeOf

fun Application.configureRoutes(services: ApplicationServices) {
    val openApiInfo = OpenApiInfo(
        title = "aqt-health",
        version = "0.0.1",
    )
    val openApiBaseDoc = OpenApiDoc(
        openapi = OpenApiDoc.OPENAPI_VERSION,
        info = openApiInfo,
        servers = emptyList(),
        paths = emptyMap(),
        webhooks = emptyMap(),
        components = Components(),
        security = emptyList(),
        tags = emptyList(),
        externalDocs = null,
        extensions = emptyMap(),
    )
    val openApiSource = OpenApiDocSource.Routing()

    routing {
        get("/openapi") {
            val doc = openApiSource.read(application, openApiBaseDoc)
            call.respondText(doc.content, doc.contentType)
        }.hide()
        swaggerUI(path = "swagger") {
            info = openApiInfo
            components = Components()
            source = openApiSource
            remotePath = "openapi"
        }

        get("/api/v1/admin/health") {
            call.respond(
                HealthResponse(
                    status = "ok",
                    service = "aqt-health",
                    time = services.clock.now().toString()
                )
            )
        }.describe {
            operationId = "getHealth"
            tag("Admin")
            summary = "Health check"
            responses {
                HttpStatusCode.OK {
                    description = "Service health status"
                    schema = buildSchema(typeOf<HealthResponse>())
                }
                commonErrors(
                    unauthorized = false,
                    validation = false,
                    internal = true,
                )
                defaultError()
            }
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
        }.describe {
            operationId = "ingestBatch"
            tag("Ingestion")
            summary = "Ingest a normalized health data batch"
            bearerApiKey()
            jsonRequest<IngestionBatchRequest>("Normalized ingestion batch")
            responses {
                HttpStatusCode.Created {
                    description = "Batch accepted and processed"
                    schema = buildSchema(typeOf<IngestionSummaryResponse>())
                }
                HttpStatusCode.OK {
                    description = "Duplicate batch accepted without creating a new batch"
                    schema = buildSchema(typeOf<IngestionSummaryResponse>())
                }
                commonErrors(conflict = true)
            }
        }
        get("/api/v1/providers") {
            call.authenticateProtected(services)
            call.respond(services.providerDiscoveryService.listProviders())
        }.describe {
            operationId = "listProviders"
            tag("Providers")
            summary = "List provider discovery metadata"
            bearerApiKey()
            jsonResponse<ProviderCatalogResponseDto>(HttpStatusCode.OK, "Provider catalog")
            errorResponses()
        }
        get("/api/v1/providers/{providerCode}") {
            call.authenticateProtected(services)
            val code = call.providerCode() ?: return@get
            call.respond(services.providerDiscoveryService.getProvider(code))
        }.describe {
            operationId = "getProvider"
            tag("Providers")
            summary = "Get provider discovery metadata"
            bearerApiKey()
            providerCodePath()
            jsonResponse<ProviderDescriptorResponseDto>(HttpStatusCode.OK, "Provider metadata")
            errorResponses(notFound = true)
        }
        get("/api/v1/providers/{providerCode}/oauth/start") {
            call.authenticateProtected(services)
            val code = call.providerCode() ?: return@get
            call.respond(services.providerWorkflowService.startOAuth(code, services.clock.now()))
        }.describe {
            operationId = "startProviderOAuth"
            tag("Providers")
            summary = "Start provider OAuth flow"
            bearerApiKey()
            providerCodePath()
            jsonResponse<ProviderOAuthStartResponse>(HttpStatusCode.OK, "Provider OAuth authorization URL")
            errorResponses(notFound = true)
        }
        get("/api/v1/providers/{providerCode}/oauth/callback") {
            val code = call.providerCode() ?: return@get
            call.respond(
                services.providerWorkflowService.completeOAuth(
                    providerCode = code,
                    code = call.request.queryParameters["code"],
                    state = call.request.queryParameters["state"],
                    error = call.request.queryParameters["error"],
                    now = services.clock.now(),
                )
            )
        }.describe {
            operationId = "completeProviderOAuth"
            tag("Providers")
            summary = "Complete provider OAuth flow"
            providerCodePath()
            parameters {
                query("code") {
                    description = "OAuth authorization code"
                    schema = buildSchema(typeOf<String>())
                }
                query("state") {
                    description = "OAuth state value"
                    schema = buildSchema(typeOf<String>())
                }
                query("error") {
                    description = "OAuth provider error"
                    schema = buildSchema(typeOf<String>())
                }
            }
            jsonResponse<ProviderOAuthCallbackResponse>(HttpStatusCode.OK, "Provider connection result")
            errorResponses(unauthorized = false, notFound = true, upstream = true)
        }
        post("/api/v1/providers/{providerCode}/sync") {
            call.authenticateProtected(services)
            val code = call.providerCode() ?: return@post
            call.respond(
                services.providerWorkflowService.sync(
                    providerCode = code,
                    request = call.receive<ProviderSyncRequestDto>(),
                    now = services.clock.now(),
                )
            )
        }.describe {
            operationId = "syncProvider"
            tag("Providers")
            summary = "Synchronize provider data"
            bearerApiKey()
            providerCodePath()
            jsonRequest<ProviderSyncRequestDto>("Provider sync request")
            jsonResponse<ProviderSyncResponseDto>(HttpStatusCode.OK, "Provider sync result")
            errorResponses(notFound = true, conflict = true, upstream = true)
        }
        get("/api/v1/metrics/steps") {
            call.authenticateProtected(services)
            call.respond(services.metricsQueryService.listStepSamples(call.queryParams()))
        }.describeReadOperation<StepSamplesResponse>(
            operationId = "listStepSamples",
            summary = "List step samples",
        )
        get("/api/v1/metrics/steps/daily") {
            call.authenticateProtected(services)
            call.respond(
                services.metricsQueryService.listStepDailySummaries(
                    call.queryParams(),
                    services.clock.now()
                )
            )
        }.describeReadOperation<StepDailySummariesResponse>(
            operationId = "listDailyStepSummaries",
            summary = "List daily step summaries",
        )
        get("/api/v1/sleep/sessions") {
            call.authenticateProtected(services)
            call.respond(services.metricsQueryService.listSleepSessions(call.queryParams()))
        }.describeReadOperation<SleepSessionsResponse>(
            operationId = "listSleepSessions",
            summary = "List sleep sessions",
        )
        get("/api/v1/body/measurements") {
            call.authenticateProtected(services)
            call.respond(services.metricsQueryService.listBodyMeasurements(call.queryParams()))
        }.describeReadOperation<BodyMeasurementsResponse>(
            operationId = "listBodyMeasurements",
            summary = "List body measurements",
        )
        get("/api/v1/metrics/heart-rate") {
            call.authenticateProtected(services)
            call.respond(services.metricsQueryService.listHeartRateSamples(call.queryParams()))
        }.describeReadOperation<HeartRateSamplesResponse>(
            operationId = "listHeartRateSamples",
            summary = "List heart rate samples",
        )
        get("/api/v1/dashboard/summary") {
            call.authenticateProtected(services)
            call.respond(
                services.metricsQueryService.dashboardSummary(
                    call.queryParams(),
                    services.clock.now()
                )
            )
        }.describeReadOperation<DashboardSummaryResponse>(
            operationId = "getDashboardSummary",
            summary = "Get dashboard summary",
        )
        get("/api/v1/admin/ingestion/batches") {
            call.authenticateProtected(services)
            call.respond(services.adminService.listBatches(call.queryParams()))
        }.describe {
            operationId = "listIngestionBatches"
            tag("Admin")
            summary = "List ingestion batches"
            bearerApiKey()
            adminQueryParameters()
            jsonResponse<IngestionBatchesResponse>(HttpStatusCode.OK, "Ingestion batches")
            errorResponses()
        }
        get("/api/v1/admin/ingestion/batches/{id}") {
            call.authenticateProtected(services)
            call.respond(
                services.adminService.getBatchDetail(
                    call.parameters["id"],
                    call.queryParams()
                )
            )
        }.describe {
            operationId = "getIngestionBatch"
            tag("Admin")
            summary = "Get ingestion batch detail"
            bearerApiKey()
            parameters {
                path("id") {
                    description = "Ingestion batch id"
                    schema = buildSchema(typeOf<Int>())
                }
            }
            jsonResponse<IngestionBatchDetailResponse>(HttpStatusCode.OK, "Ingestion batch detail")
            errorResponses(notFound = true)
        }
        get("/api/v1/admin/ingestion/failures") {
            call.authenticateProtected(services)
            call.respond(services.adminService.listFailures(call.queryParams()))
        }.describe {
            operationId = "listIngestionFailures"
            tag("Admin")
            summary = "List failed ingestion batches"
            bearerApiKey()
            adminQueryParameters()
            jsonResponse<IngestionBatchesResponse>(HttpStatusCode.OK, "Failed ingestion batches")
            errorResponses()
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

private suspend fun ApplicationCall.providerCode(): String? {
    val code = parameters["providerCode"]
    if (code.isNullOrBlank()) {
        throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = "providerCode",
                    code = ValidationIssueCodes.InvalidFormat,
                    message = "must not be blank",
                )
            )
        )
    }
    return code
}

private inline fun <reified T : Any> Operation.Builder.jsonRequest(descriptionText: String) {
    requestBody {
        description = descriptionText
        required = true
        schema = buildSchema(typeOf<T>())
    }
}

private inline fun <reified T : Any> Operation.Builder.jsonResponse(
    status: HttpStatusCode,
    descriptionText: String,
) {
    responses {
        status {
            description = descriptionText
            schema = buildSchema(typeOf<T>())
        }
    }
}

private fun Operation.Builder.errorResponses(
    unauthorized: Boolean = true,
    validation: Boolean = true,
    notFound: Boolean = false,
    conflict: Boolean = false,
    upstream: Boolean = false,
    internal: Boolean = true,
) {
    responses {
        commonErrors(
            unauthorized = unauthorized,
            validation = validation,
            notFound = notFound,
            conflict = conflict,
            upstream = upstream,
            internal = internal,
        )
        defaultError()
    }
}

private fun io.ktor.openapi.Responses.Builder.defaultError() {
    default {
        description = "Error response"
        schema = buildSchema(typeOf<ErrorResponse>())
    }
}

private fun io.ktor.openapi.Responses.Builder.commonErrors(
    unauthorized: Boolean = true,
    validation: Boolean = true,
    notFound: Boolean = false,
    conflict: Boolean = false,
    upstream: Boolean = false,
    internal: Boolean = true,
) {
    if (validation) {
        HttpStatusCode.BadRequest {
            description = "Request validation failed"
            schema = buildSchema(typeOf<ErrorResponse>())
        }
    }
    if (unauthorized) {
        HttpStatusCode.Unauthorized {
            description = "Missing or invalid API key"
            schema = buildSchema(typeOf<ErrorResponse>())
        }
    }
    if (notFound) {
        HttpStatusCode.NotFound {
            description = "Resource not found"
            schema = buildSchema(typeOf<ErrorResponse>())
        }
    }
    if (conflict) {
        HttpStatusCode.Conflict {
            description = "Request conflicts with current state"
            schema = buildSchema(typeOf<ErrorResponse>())
        }
    }
    if (upstream) {
        HttpStatusCode.BadGateway {
            description = "Upstream provider request failed"
            schema = buildSchema(typeOf<ErrorResponse>())
        }
    }
    if (internal) {
        HttpStatusCode.InternalServerError {
            description = "Unexpected server error"
            schema = buildSchema(typeOf<ErrorResponse>())
        }
    }
}

private fun Operation.Builder.bearerApiKey() {
    parameters {
        header(HttpHeaders.Authorization) {
            description = "Bearer API key"
            required = true
            schema = buildSchema(typeOf<String>())
        }
    }
}

private fun Operation.Builder.providerCodePath() {
    parameters {
        path("providerCode") {
            description = "Provider code"
            schema = buildSchema(typeOf<String>())
        }
    }
}

private inline fun <reified T : Any> Route.describeReadOperation(
    operationId: String,
    summary: String,
): Route = describe {
    this.operationId = operationId
    tag("Read")
    this.summary = summary
    bearerApiKey()
    readQueryParameters()
    jsonResponse<T>(HttpStatusCode.OK, summary)
    errorResponses()
}

private fun Operation.Builder.readQueryParameters() {
    parameters {
        query("from") {
            description = "Inclusive start timestamp or date"
            schema = buildSchema(typeOf<String>())
        }
        query("to") {
            description = "Exclusive end timestamp or date"
            schema = buildSchema(typeOf<String>())
        }
        query("provider") {
            description = "Source provider filter"
            schema = buildSchema(typeOf<String>())
        }
        query("providerInstanceId") {
            description = "Source provider instance filter"
            schema = buildSchema(typeOf<String>())
        }
        query("limit") {
            description = "Maximum number of items"
            schema = buildSchema(typeOf<Int>())
        }
    }
}

private fun Operation.Builder.adminQueryParameters() {
    parameters {
        query("status") {
            description = "Batch status filter"
            schema = buildSchema(typeOf<String>())
        }
        query("from") {
            description = "Inclusive received-at start timestamp"
            schema = buildSchema(typeOf<String>())
        }
        query("to") {
            description = "Exclusive received-at end timestamp"
            schema = buildSchema(typeOf<String>())
        }
        query("limit") {
            description = "Maximum number of items"
            schema = buildSchema(typeOf<Int>())
        }
    }
}

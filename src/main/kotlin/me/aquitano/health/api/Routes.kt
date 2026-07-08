@file:OptIn(io.ktor.utils.io.ExperimentalKtorApi::class)

package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.plugins.swagger.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.routing.openapi.*
import kotlinx.serialization.Serializable
import me.aquitano.health.api.dto.*
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import kotlin.reflect.typeOf

fun Application.configureRoutes(services: ApplicationServices) {
    val openApiInfo = openApiInfo()
    val openApiBaseDoc = openApiBaseDoc()
    val openApiSource = OpenApiDocSource.Routing()

    routing {
        get("/openapi") {
            val doc = openApiSource.read(application, openApiBaseDoc)
            call.respondText(
                stripInferredAuthorizationParameters(doc.content),
                doc.contentType
            )
        }.hide()
        swaggerUI(path = "swagger") {
            info = openApiInfo
            components = openApiBaseDoc.components
            source = openApiSource
            remotePath = "../openapi"
        }

        get("/api/v2/admin/health") {
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
            description =
                "Public liveness check for local process and dependency monitoring."
            publicEndpoint()
            responses {
                HttpStatusCode.OK {
                    description = "Service health status"
                    content {
                        schema = buildSchema(typeOf<HealthResponse>())
                        example("health", healthResponseExample())
                    }
                }
                commonErrors(
                    unauthorized = false,
                    validation = false,
                    internal = true,
                )
                defaultError()
            }
        }
        get("/api/v2/providers/{providerCode}/oauth/callback") {
            val code = call.providerCode()
            call.respond(
                HttpStatusCode.OK,
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
            description =
                "Public OAuth redirect target. Exchanges a provider authorization code for stored encrypted tokens, or returns a provider-error response when the provider redirects with `error`."
            publicEndpoint()
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
            errorResponses(
                unauthorized = false,
                notFound = true,
                upstream = true
            )
        }
        authenticate(ApiKeyAuthProviderName) {
            post("/api/v2/ingestion/batches") {
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
                description =
                    "Accepts a trusted normalized health data batch, stores the source payload for audit/reprocessing, writes structured metric tables, and treats repeated provider/batch identifiers idempotently. A duplicate batch returns 200 OK with `duplicateBatch=true`; a newly processed batch returns 201 Created."
                requiresBearerAuth()
                ingestionBatchJsonRequest()
                responses {
                    HttpStatusCode.Created {
                        description = "Batch accepted and processed"
                        content {
                            schema = buildSchema(typeOf<IngestionSummaryResponse>())
                            example("created", ingestionSummaryExample())
                        }
                    }
                    HttpStatusCode.OK {
                        description =
                            "Duplicate batch accepted without creating a new batch"
                        content {
                            schema = buildSchema(typeOf<IngestionSummaryResponse>())
                            example(
                                "duplicate",
                                ingestionSummaryExample(duplicate = true)
                            )
                        }
                    }
                    commonErrors(conflict = true)
                }
            }
            providerRoutes(services)
            readRoutes(services)
            adminRoutes(services)
        }
    }
}

@Serializable
data class HealthResponse(
    val status: String,
    val service: String,
    val time: String,
)

internal fun ApplicationCall.queryParams(): QueryParams =
    QueryParams(
        request.queryParameters.entries()
            .associate { it.key to it.value.firstOrNull() })

internal fun ApplicationCall.metricTypePath(): String {
    val metricType = parameters["metricType"]
    if (metricType.isNullOrBlank()) {
        throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = "metricType",
                    code = ValidationIssueCodes.InvalidFormat,
                    message = "must not be blank",
                )
            )
        )
    }
    return metricType
}

internal fun ApplicationCall.idempotencyKey(): String? =
    request.headers["Idempotency-Key"]?.trim()?.takeIf { it.isNotEmpty() }

internal fun ApplicationCall.providerCode(): String {
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

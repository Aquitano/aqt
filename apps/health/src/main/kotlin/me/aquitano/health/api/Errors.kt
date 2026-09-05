@file:OptIn(ExperimentalKtorApi::class)

package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.openapi.JsonSchema
import io.ktor.server.application.*
import io.ktor.server.plugins.*
import io.ktor.server.plugins.callid.*
import io.ktor.server.plugins.statuspages.*
import io.ktor.server.response.*
import io.ktor.utils.io.ExperimentalKtorApi
import kotlinx.serialization.Serializable
import me.aquitano.health.domain.*
import me.aquitano.health.domain.NotFoundException
import io.github.oshai.kotlinlogging.KotlinLogging
import me.aquitano.health.infrastructure.logging.*

private val logger = KotlinLogging.logger("me.aquitano.health.api.Errors")

fun Application.configureErrorHandling() {
    install(StatusPages) {
        status(HttpStatusCode.NotFound) { call, status ->
            logger.infoWithContext(
                "request_not_found",
                "errorCode" to "not_found",
                "requestId" to call.requestId(),
            )
            call.respond(
                status,
                ErrorResponse(
                    ErrorBody(
                        code = "not_found",
                        message = "Resource not found",
                        requestId = call.requestId(),
                    )
                ),
            )
        }
        exception<UnauthorizedException> { call, _ ->
            logger.infoWithContext(
                "request_unauthorized",
                "errorCode" to "unauthorized",
                "requestId" to call.requestId(),
            )
            call.respond(
                HttpStatusCode.Unauthorized,
                ErrorResponse(
                    ErrorBody(
                        code = "unauthorized",
                        message = "Missing or invalid API key",
                        requestId = call.requestId(),
                    )
                ),
            )
        }
        exception<RequestValidationException> { call, cause ->
            logger.infoWithContext(
                "request_validation_failed",
                "errorCode" to "validation_failed",
                "fields" to cause.issues.map { it.field },
                "requestId" to call.requestId(),
            )
            call.respond(
                HttpStatusCode.BadRequest,
                ErrorResponse(
                    ErrorBody(
                        code = "validation_failed",
                        message = "Request validation failed",
                        requestId = call.requestId(),
                        details = cause.issues.map {
                            ErrorDetail(
                                field = it.field,
                                code = it.code,
                                message = it.message,
                            )
                        },
                    ),
                ),
            )
        }
        exception<NotFoundException> { call, cause ->
            logger.infoWithContext(
                "request_not_found",
                "errorCode" to "not_found",
                "requestId" to call.requestId(),
            )
            call.respond(
                HttpStatusCode.NotFound,
                ErrorResponse(
                    ErrorBody(
                        code = "not_found",
                        message = cause.message ?: "Resource not found",
                        requestId = call.requestId(),
                    )
                ),
            )
        }
        exception<ConflictException> { call, cause ->
            logger.warnWithContext(
                "request_conflict",
                "errorCode" to cause.code,
                "requestId" to call.requestId(),
            )
            call.respond(
                HttpStatusCode.Conflict,
                ErrorResponse(
                    ErrorBody(
                        code = cause.code,
                        message = cause.message
                            ?: "Request conflicts with current state",
                        requestId = call.requestId(),
                    )
                ),
            )
        }
        exception<UpstreamProviderException> { call, cause ->
            logger.warnWithContext(
                "upstream_provider_failed",
                "errorCode" to cause.code,
                "status" to cause.statusCode,
                "requestId" to call.requestId(),
                throwable = cause.cause ?: cause,
            )
            call.respond(
                HttpStatusCode.fromValue(cause.statusCode),
                ErrorResponse(
                    ErrorBody(
                        code = cause.code,
                        message = cause.message ?: "Provider request failed",
                        requestId = call.requestId(),
                    )
                ),
            )
        }
        exception<BadRequestException> { call, _ ->
            logger.infoWithContext(
                "request_bad_request",
                "errorCode" to "validation_failed",
                "requestId" to call.requestId(),
            )
            call.respond(
                HttpStatusCode.BadRequest,
                ErrorResponse(
                    ErrorBody(
                        code = "validation_failed",
                        message = "Request validation failed",
                        requestId = call.requestId(),
                    )
                ),
            )
        }
        exception<ServerConfigurationException> { call, cause ->
            logger.errorWithContext(
                "server_configuration_error",
                "errorCode" to cause.code,
                "fields" to cause.details.map { it.field },
                "requestId" to call.requestId(),
                throwable = cause,
            )
            call.respond(
                HttpStatusCode.InternalServerError,
                ErrorResponse(
                    ErrorBody(
                        code = cause.code,
                        message = cause.publicMessage,
                        requestId = call.requestId(),
                    )
                ),
            )
        }
        exception<Throwable> { call, cause ->
            logger.errorWithContext(
                "request_unexpected_error",
                "errorCode" to "internal_error",
                "requestId" to call.requestId(),
                throwable = cause,
            )
            call.respond(
                HttpStatusCode.InternalServerError,
                ErrorResponse(
                    ErrorBody(
                        code = "internal_error",
                        message = "Unexpected server error",
                        requestId = call.requestId(),
                    )
                ),
            )
        }
    }
}

@Serializable
data class ErrorResponse(
    val error: ErrorBody,
)

@Serializable
data class ErrorBody(
    @JsonSchema.Description(
        "Stable machine-readable error code. Envelope-level values are `validation_failed`, `unauthorized`, " +
            "`not_found`, and `internal_error`; provider-sync and ingestion endpoints additionally return " +
            "provider-specific conflict and upstream codes (for example `idempotency_key_conflict`, " +
            "`scheduled_sync_already_running`, or `withings_needs_reauth`)."
    )
    val code: String,
    val message: String,
    val requestId: String,
    val details: List<ErrorDetail>? = null,
)

@Serializable
data class ErrorDetail(
    val field: String,
    @JsonSchema.Description("Machine-readable validation issue code for this field.")
    @JsonSchema.Enum(
        ValidationIssueCodes.Required,
        ValidationIssueCodes.InvalidFormat,
        ValidationIssueCodes.UnsupportedValue,
        ValidationIssueCodes.OutOfRange,
        ValidationIssueCodes.InvalidRange,
        ValidationIssueCodes.InvalidState,
    )
    val code: String,
    val message: String,
)

private fun ApplicationCall.requestId(): String =
    callId ?: response.headers[HttpHeaders.XRequestId] ?: "unknown"

package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.plugins.*
import io.ktor.server.plugins.callid.*
import io.ktor.server.plugins.statuspages.*
import io.ktor.server.response.*
import kotlinx.serialization.Serializable
import me.aquitano.health.domain.ConflictException
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ServerConfigurationException
import me.aquitano.health.domain.UnauthorizedException
import me.aquitano.health.domain.UpstreamProviderException
import net.logstash.logback.argument.StructuredArguments.kv
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("me.aquitano.health.api.Errors")

fun Application.configureErrorHandling() {
    install(StatusPages) {
        status(HttpStatusCode.NotFound) { call, status ->
            logger.info(
                "request_not_found {} {}",
                kv("errorCode", "not_found"),
                kv("requestId", call.requestId()),
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
            logger.info(
                "request_unauthorized {} {}",
                kv("errorCode", "unauthorized"),
                kv("requestId", call.requestId()),
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
            logger.info(
                "request_validation_failed {} {} {}",
                kv("errorCode", "validation_failed"),
                kv("fields", cause.issues.map { it.field }),
                kv("requestId", call.requestId()),
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
            logger.info(
                "request_not_found {} {}",
                kv("errorCode", "not_found"),
                kv("requestId", call.requestId()),
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
            logger.warn(
                "request_conflict {} {}",
                kv("errorCode", cause.code),
                kv("requestId", call.requestId()),
            )
            call.respond(
                HttpStatusCode.Conflict,
                ErrorResponse(
                    ErrorBody(
                        code = cause.code,
                        message = cause.message ?: "Request conflicts with current state",
                        requestId = call.requestId(),
                    )
                ),
            )
        }
        exception<UpstreamProviderException> { call, cause ->
            if (cause.cause != null) {
                logger.warn(
                    "upstream_provider_failed {} {} {}",
                    kv("errorCode", cause.code),
                    kv("status", cause.statusCode),
                    kv("requestId", call.requestId()),
                    cause,
                )
            } else {
                logger.warn(
                    "upstream_provider_failed {} {} {}",
                    kv("errorCode", cause.code),
                    kv("status", cause.statusCode),
                    kv("requestId", call.requestId()),
                )
            }
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
            logger.info(
                "request_bad_request {} {}",
                kv("errorCode", "validation_failed"),
                kv("requestId", call.requestId()),
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
            logger.error(
                "server_configuration_error {} {} {}",
                kv("errorCode", cause.code),
                kv("fields", cause.details.map { it.field }),
                kv("requestId", call.requestId()),
                cause,
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
            logger.error(
                "request_unexpected_error {} {}",
                kv("errorCode", "internal_error"),
                kv("requestId", call.requestId()),
                cause,
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
    val code: String,
    val message: String,
    val requestId: String,
    val details: List<ErrorDetail>? = null,
)

@Serializable
data class ErrorDetail(
    val field: String,
    val code: String,
    val message: String,
)

private fun ApplicationCall.requestId(): String =
    callId ?: response.headers[HttpHeaders.XRequestId] ?: "unknown"

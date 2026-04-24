package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.plugins.*
import io.ktor.server.plugins.statuspages.*
import io.ktor.server.response.*
import kotlinx.serialization.Serializable
import me.aquitano.health.domain.ConflictException
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.UnauthorizedException
import me.aquitano.health.domain.UpstreamProviderException
import net.logstash.logback.argument.StructuredArguments.kv
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("me.aquitano.health.api.Errors")

fun Application.configureErrorHandling() {
    install(StatusPages) {
        exception<UnauthorizedException> { call, _ ->
            logger.info(
                "request_unauthorized {}",
                kv("errorCode", "unauthorized"),
            )
            call.respond(
                HttpStatusCode.Unauthorized,
                ErrorResponse(
                    ErrorBody(
                        code = "unauthorized",
                        message = "Missing or invalid API key"
                    )
                ),
            )
        }
        exception<RequestValidationException> { call, cause ->
            logger.info(
                "request_validation_failed {} {}",
                kv("errorCode", "validation_failed"),
                kv("fields", cause.issues.map { it.field }),
            )
            call.respond(
                HttpStatusCode.BadRequest,
                ErrorResponse(
                    ErrorBody(
                        code = "validation_failed",
                        message = "Request validation failed",
                        details = cause.issues.map {
                            ErrorDetail(
                                field = it.field,
                                message = it.message
                            )
                        },
                    ),
                ),
            )
        }
        exception<NotFoundException> { call, cause ->
            logger.info(
                "request_not_found {}",
                kv("errorCode", "not_found"),
            )
            call.respond(
                HttpStatusCode.NotFound,
                ErrorResponse(
                    ErrorBody(
                        code = "not_found",
                        message = cause.message ?: "Resource not found"
                    )
                ),
            )
        }
        exception<ConflictException> { call, cause ->
            logger.warn(
                "request_conflict {}",
                kv("errorCode", cause.code),
            )
            call.respond(
                HttpStatusCode.Conflict,
                ErrorResponse(
                    ErrorBody(
                        code = cause.code,
                        message = cause.message ?: "Request conflicts with current state"
                    )
                ),
            )
        }
        exception<UpstreamProviderException> { call, cause ->
            if (cause.cause != null) {
                logger.warn(
                    "upstream_provider_failed {} {}",
                    kv("errorCode", cause.code),
                    kv("status", cause.statusCode),
                    cause,
                )
            } else {
                logger.warn(
                    "upstream_provider_failed {} {}",
                    kv("errorCode", cause.code),
                    kv("status", cause.statusCode),
                )
            }
            call.respond(
                HttpStatusCode.fromValue(cause.statusCode),
                ErrorResponse(
                    ErrorBody(
                        code = cause.code,
                        message = cause.message ?: "Provider request failed"
                    )
                ),
            )
        }
        exception<BadRequestException> { call, _ ->
            logger.info(
                "request_bad_request {}",
                kv("errorCode", "validation_failed"),
            )
            call.respond(
                HttpStatusCode.BadRequest,
                ErrorResponse(
                    ErrorBody(
                        code = "validation_failed",
                        message = "Request validation failed"
                    )
                ),
            )
        }
        exception<Throwable> { call, cause ->
            logger.error(
                "request_unexpected_error {}",
                kv("errorCode", "internal_error"),
                cause,
            )
            call.respond(
                HttpStatusCode.InternalServerError,
                ErrorResponse(
                    ErrorBody(
                        code = "internal_error",
                        message = "Unexpected server error"
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
    val details: List<ErrorDetail>? = null,
)

@Serializable
data class ErrorDetail(
    val field: String,
    val message: String,
)

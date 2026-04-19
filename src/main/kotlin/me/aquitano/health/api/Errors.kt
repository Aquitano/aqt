package me.aquitano.health.api

import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond
import kotlinx.serialization.Serializable
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.UnauthorizedException

fun Application.configureErrorHandling() {
    install(StatusPages) {
        exception<UnauthorizedException> { call, _ ->
            call.respond(
                HttpStatusCode.Unauthorized,
                ErrorResponse(ErrorBody(code = "unauthorized", message = "Missing or invalid API key")),
            )
        }
        exception<RequestValidationException> { call, cause ->
            call.respond(
                HttpStatusCode.BadRequest,
                ErrorResponse(
                    ErrorBody(
                        code = "validation_failed",
                        message = "Request validation failed",
                        details = cause.issues.map { ErrorDetail(field = it.field, message = it.message) },
                    ),
                ),
            )
        }
        exception<BadRequestException> { call, _ ->
            call.respond(
                HttpStatusCode.BadRequest,
                ErrorResponse(ErrorBody(code = "validation_failed", message = "Request validation failed")),
            )
        }
        exception<Throwable> { call, _ ->
            call.respond(
                HttpStatusCode.InternalServerError,
                ErrorResponse(ErrorBody(code = "internal_error", message = "Unexpected server error")),
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

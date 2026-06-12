package me.aquitano.health.domain

data class ValidationIssue(
    val field: String,
    val code: String = ValidationIssueCodes.Required,
    val message: String = "is required"
)

object ValidationIssueCodes {
    const val Required = "required"
    const val InvalidFormat = "invalid_format"
    const val UnsupportedValue = "unsupported_value"
    const val OutOfRange = "out_of_range"
    const val InvalidRange = "invalid_range"
    const val InvalidState = "invalid_state"
}

class RequestValidationException(
    val issues: List<ValidationIssue>,
    cause: Throwable? = null,
) : RuntimeException("Request validation failed", cause)

class NotFoundException(
    message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause)

class UnauthorizedException(
    cause: Throwable? = null,
) : RuntimeException("Missing or invalid API key", cause)

class ConflictException(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause)

class UpstreamProviderException(
    val code: String,
    message: String,
    val statusCode: Int = 502,
    val retryable: Boolean = true,
    cause: Throwable? = null,
) : RuntimeException(message, cause)

class ServerConfigurationException(
    val code: String,
    val publicMessage: String,
    val details: List<ValidationIssue> = emptyList(),
    cause: Throwable? = null,
) : RuntimeException(publicMessage, cause)

/**
 * Whether a failed provider sync may succeed on a later automatic attempt. Permanent
 * failures (invalid request, broken or missing auth, server misconfiguration) need
 * operator action and must not be retried by schedulers.
 */
fun isRetryableSyncFailure(error: Throwable): Boolean =
    when (error) {
        is RequestValidationException,
        is NotFoundException,
        is UnauthorizedException,
        is ConflictException,
        is ServerConfigurationException,
        -> false

        is UpstreamProviderException -> error.retryable
        else -> true
    }

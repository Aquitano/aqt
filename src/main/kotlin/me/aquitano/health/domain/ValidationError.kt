package me.aquitano.health.domain

data class ValidationIssue(
    val field: String,
    val message: String,
)

class RequestValidationException(
    val issues: List<ValidationIssue>,
) : RuntimeException("Request validation failed")

class NotFoundException(message: String) : RuntimeException(message)

class UnauthorizedException : RuntimeException("Missing or invalid API key")

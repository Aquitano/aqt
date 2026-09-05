@file:OptIn(ExperimentalKtorApi::class)

package me.aquitano.health.api

import io.ktor.openapi.*
import io.ktor.utils.io.*
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import me.aquitano.health.shared.AppJson

internal const val BearerApiKeySecurityScheme = "bearerApiKey"
internal fun openApiInfo(): OpenApiInfo =
    OpenApiInfo(
        title = "aqt-health",
        version = "0.0.1",
        description = "Personal health data hub API for normalized ingestion, provider OAuth and sync workflows, metric reads, and local administration.",
        contact = null,
    )

internal fun openApiBaseDoc(): OpenApiDoc =
    OpenApiDoc(
        openapi = OpenApiDoc.OPENAPI_VERSION,
        info = openApiInfo(),
        servers = listOf(
            Server(url = "/", description = "Same-origin deployment"),
            Server(
                url = "http://localhost:8080",
                description = "Local development"
            ),
        ),
        paths = emptyMap(),
        webhooks = emptyMap(),
        components = openApiComponents(),
        security = listOf(mapOf(BearerApiKeySecurityScheme to emptyList())),
        tags = listOf(
            Tag("Admin", "Health checks and ingestion administration."),
            Tag(
                "Ingestion",
                "Normalized health batch ingestion for trusted clients and provider adapters."
            ),
            Tag(
                "Providers",
                "Provider discovery, OAuth connection, status, and synchronization workflows."
            ),
            Tag(
                "Read",
                "Metric catalog and read endpoints for health data queries."
            ),
        ),
        externalDocs = null,
        extensions = emptyMap(),
    )

internal fun stripInferredAuthorizationParameters(content: String): String {
    val root = runCatching { AppJson.parseToJsonElement(content).jsonObject }
        .getOrElse { return content }
    val paths = root["paths"]?.jsonObject ?: return content
    val sanitizedPaths = JsonObject(
        paths.mapValues { (_, pathItem) ->
            JsonObject(
                pathItem.jsonObject.mapValues { (_, operation) ->
                    sanitizeOperation(operation)
                }
            )
        }
    )
    val sanitizedRoot = JsonObject(
        root.toMutableMap().also { it["paths"] = sanitizedPaths }
    )
    return sanitizedRoot.toString()
}

private fun sanitizeOperation(operation: JsonElement): JsonElement {
    if (operation !is JsonObject) return operation
    val operationObject = operation.jsonObject
    val parameters = operationObject["parameters"]?.jsonArray ?: return operation
    val sanitizedParameters = JsonArray(
        parameters.filterNot { parameter ->
            val parameterObject = parameter.jsonObject
            parameterObject["name"]?.jsonPrimitive?.content == "Authorization" &&
                    parameterObject["in"]?.jsonPrimitive?.content == "header"
        }
    )
    return JsonObject(
        operationObject.toMutableMap().also { operation ->
            if (sanitizedParameters.isEmpty()) {
                operation.remove("parameters")
            } else {
                operation["parameters"] = sanitizedParameters
            }
        }
    )
}

private fun openApiComponents(): Components =
    Components(
        schemas = emptyMap(),
        securitySchemes = mapOf(
            BearerApiKeySecurityScheme to ReferenceOr.Value<SecurityScheme>(
                HttpSecurityScheme(
                    scheme = "bearer",
                    bearerFormat = "API key",
                    description = "Use `Authorization: Bearer <api-key>` with an API key registered in aqt-health.",
                )
            )
        ),
        examples = mapOf(
            "ErrorResponse" to ReferenceOr.Value(
                validationErrorExample()
            ),
        ),
    )

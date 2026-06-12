@file:OptIn(ExperimentalKtorApi::class)

package me.aquitano.health.api

import io.ktor.openapi.*
import io.ktor.server.routing.openapi.*
import io.ktor.utils.io.*
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import me.aquitano.health.api.dto.*
import me.aquitano.health.domain.RecordTypes
import me.aquitano.health.shared.AppJson
import kotlin.reflect.typeOf

internal const val BearerApiKeySecurityScheme = "bearerApiKey"
internal const val StepIntervalSchemaName = "StepIntervalDto"
internal const val SleepSessionSchemaName = "SleepSessionDto"
internal const val BodyMeasurementSchemaName = "BodyMeasurementDto"
internal const val HeartRateSchemaName = "HeartRateDto"
internal const val ActivitySummarySchemaName = "ActivitySummaryDto"
internal const val SleepSummarySchemaName = "SleepSummaryDto"
internal const val RespiratoryRateSchemaName = "RespiratoryRateDto"
internal const val HrvSchemaName = "HrvDto"
internal const val BloodPressureSchemaName = "BloodPressureDto"
internal const val CardiovascularSchemaName = "CardiovascularDto"
internal const val ExtendedBodyMeasurementSchemaName = "ExtendedBodyMeasurementDto"
internal const val ScalarSampleSchemaName = "ScalarSampleDto"
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
        schemas = ingestionRecordComponentSchemas(),
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

private fun ingestionRecordComponentSchemas(): Map<String, JsonSchema> =
    mapOf(
        StepIntervalSchemaName to KotlinxJsonSchemaInference.buildSchema(typeOf<StepIntervalDto>()),
        SleepSessionSchemaName to KotlinxJsonSchemaInference.buildSchema(typeOf<SleepSessionDto>()),
        BodyMeasurementSchemaName to KotlinxJsonSchemaInference.buildSchema(typeOf<BodyMeasurementDto>()),
        HeartRateSchemaName to KotlinxJsonSchemaInference.buildSchema(typeOf<HeartRateDto>()),
        ActivitySummarySchemaName to KotlinxJsonSchemaInference.buildSchema(typeOf<ActivitySummaryDto>()),
        SleepSummarySchemaName to KotlinxJsonSchemaInference.buildSchema(typeOf<SleepSummaryDto>()),
        RespiratoryRateSchemaName to KotlinxJsonSchemaInference.buildSchema(typeOf<RespiratoryRateDto>()),
        HrvSchemaName to KotlinxJsonSchemaInference.buildSchema(typeOf<HrvDto>()),
        BloodPressureSchemaName to KotlinxJsonSchemaInference.buildSchema(typeOf<BloodPressureDto>()),
        CardiovascularSchemaName to KotlinxJsonSchemaInference.buildSchema(typeOf<CardiovascularDto>()),
        ExtendedBodyMeasurementSchemaName to
            KotlinxJsonSchemaInference.buildSchema(typeOf<ExtendedBodyMeasurementDto>()),
        ScalarSampleSchemaName to KotlinxJsonSchemaInference.buildSchema(typeOf<ScalarSampleDto>()),
    )
internal fun ingestionRecordSchema(): JsonSchema =
    JsonSchema(
        oneOf = listOf(
            ReferenceOr.schema(StepIntervalSchemaName),
            ReferenceOr.schema(SleepSessionSchemaName),
            ReferenceOr.schema(BodyMeasurementSchemaName),
            ReferenceOr.schema(HeartRateSchemaName),
            ReferenceOr.schema(ActivitySummarySchemaName),
            ReferenceOr.schema(SleepSummarySchemaName),
            ReferenceOr.schema(RespiratoryRateSchemaName),
            ReferenceOr.schema(HrvSchemaName),
            ReferenceOr.schema(BloodPressureSchemaName),
            ReferenceOr.schema(CardiovascularSchemaName),
            ReferenceOr.schema(ExtendedBodyMeasurementSchemaName),
            ReferenceOr.schema(ScalarSampleSchemaName),
        ),
        discriminator = JsonSchemaDiscriminator(
            propertyName = "type",
            mapping = mapOf(
                RecordTypes.STEP_INTERVAL to componentSchemaRef(
                    StepIntervalSchemaName
                ),
                RecordTypes.SLEEP_SESSION to componentSchemaRef(
                    SleepSessionSchemaName
                ),
                RecordTypes.BODY_MEASUREMENT to componentSchemaRef(
                    BodyMeasurementSchemaName
                ),
                RecordTypes.HEART_RATE to componentSchemaRef(HeartRateSchemaName),
                RecordTypes.ACTIVITY_SUMMARY to componentSchemaRef(
                    ActivitySummarySchemaName
                ),
                RecordTypes.SLEEP_SUMMARY to componentSchemaRef(
                    SleepSummarySchemaName
                ),
                RecordTypes.RESPIRATORY_RATE to componentSchemaRef(
                    RespiratoryRateSchemaName
                ),
                RecordTypes.HRV to componentSchemaRef(HrvSchemaName),
                RecordTypes.BLOOD_PRESSURE to componentSchemaRef(
                    BloodPressureSchemaName
                ),
                RecordTypes.CARDIOVASCULAR to componentSchemaRef(
                    CardiovascularSchemaName
                ),
                RecordTypes.EXTENDED_BODY_MEASUREMENT to componentSchemaRef(
                    ExtendedBodyMeasurementSchemaName
                ),
                RecordTypes.SCALAR to componentSchemaRef(ScalarSampleSchemaName),
            )
        ),
    )

private fun componentSchemaRef(schemaName: String): String =
    "#/components/schemas/$schemaName"

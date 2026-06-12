@file:OptIn(ExperimentalKtorApi::class)

package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.openapi.*
import io.ktor.server.routing.*
import io.ktor.server.routing.openapi.*
import io.ktor.utils.io.*
import me.aquitano.external.withings.WITHINGS_PROVIDER_CODE
import me.aquitano.health.api.dto.*
import kotlin.reflect.typeOf

internal fun Operation.Builder.publicEndpoint() {
    security {
        optional()
    }
}

internal fun Operation.Builder.requiresBearerAuth() {
    security {
        requirement(BearerApiKeySecurityScheme)
    }
}

internal inline fun <reified T : Any> Operation.Builder.jsonRequest(
    descriptionText: String,
    exampleName: String? = null,
    example: ExampleObject? = null,
) {
    require((exampleName == null) == (example == null)) {
        "exampleName and example must either both be set or both be null."
    }

    requestBody {
        description = descriptionText
        required = true
        content {
            schema = buildSchema(typeOf<T>())

            if (exampleName != null && example != null) {
                example(exampleName, example)
            }
        }
    }
}

internal fun Operation.Builder.ingestionBatchJsonRequest() {
    requestBody {
        description =
            "Normalized ingestion batch. Fields are nullable at the transport layer where provider adapters may omit them, but validation enforces provider, providerInstanceId, batch identity, and record-specific required fields."
        required = true
        content {
            schema = JsonSchema(
                type = JsonType.OBJECT,
                properties = mapOf(
                    "provider" to ReferenceOr.Value(stringSchema(example = WITHINGS_PROVIDER_CODE)),
                    "providerInstanceId" to ReferenceOr.Value(
                        stringSchema(
                            example = ExampleProviderInstanceId
                        )
                    ),
                    "batchExternalId" to ReferenceOr.Value(stringSchema(example = ExampleBatchExternalId)),
                    "ingestedAt" to ReferenceOr.Value(
                        stringSchema(
                            format = JsonFormatDateTime,
                            example = ExampleIngestedAt
                        )
                    ),
                    "sourcePayload" to ReferenceOr.Value(JsonSchema(type = JsonType.OBJECT)),
                    "records" to ReferenceOr.Value(
                        JsonSchema(
                            type = JsonType.ARRAY,
                            items = ReferenceOr.Value(ingestionRecordSchema()),
                        )
                    ),
                ),
            )
            example("batch", ingestionBatchExample())
        }
    }
}

internal fun Operation.Builder.errorResponses(
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

internal fun Responses.Builder.defaultError() {
    default {
        description = "Error response"
        content {
            schema = buildSchema(typeOf<ErrorResponse>())
            example(
                "error",
                internalErrorExample()
            )
        }
    }
}

internal fun Responses.Builder.commonErrors(
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
            content {
                schema = buildSchema(typeOf<ErrorResponse>())
                example("validation", validationErrorExample())
            }
        }
    }
    if (unauthorized) {
        HttpStatusCode.Unauthorized {
            description = "Missing or invalid API key"
            content {
                schema = buildSchema(typeOf<ErrorResponse>())
                example("unauthorized", unauthorizedErrorExample())
            }
        }
    }
    if (notFound) {
        HttpStatusCode.NotFound {
            description = "Resource not found"
            content {
                schema = buildSchema(typeOf<ErrorResponse>())
                example("notFound", notFoundErrorExample())
            }
        }
    }
    if (conflict) {
        HttpStatusCode.Conflict {
            description = "Request conflicts with current state"
            content {
                schema = buildSchema(typeOf<ErrorResponse>())
                example("conflict", conflictErrorExample())
            }
        }
    }
    if (upstream) {
        HttpStatusCode.BadGateway {
            description = "Upstream provider request failed"
            content {
                schema = buildSchema(typeOf<ErrorResponse>())
                example("upstream", upstreamErrorExample())
            }
        }
    }
    if (internal) {
        HttpStatusCode.InternalServerError {
            description = "Unexpected server error"
            content {
                schema = buildSchema(typeOf<ErrorResponse>())
                example("internal", internalErrorExample())
            }
        }
    }
}
internal fun Route.describeReadOperation(
    operationId: String,
    summary: String,
    descriptionText: String,
    includeLatest: Boolean = false,
    sortValues: List<String>,
    defaultSort: String,
    sortExample: String = defaultSort,
): Route = describe {
    this.operationId = operationId
    tag("Read")
    this.summary = summary
    description = descriptionText
    requiresBearerAuth()
    readQueryParameters(
        includeLatest = includeLatest,
        sortValues = sortValues,
        defaultSort = defaultSort,
        sortExample = sortExample,
    )
    errorResponses()
}

internal fun Route.describeDailyStepReadOperation(): Route = describe {
    operationId = "listDailyStepSummaries"
    tag("Read")
    summary = "List daily step summaries"
    description =
        "Returns daily UTC step totals. Use `date` for one day, or `fromDate` and `toDate` for an inclusive date range."
    requiresBearerAuth()
    dailyStepQueryParameters()
    parameters {
        query("latest") {
            description =
                "Return the latest matching daily step summary when true. Defaults to false. Cannot be combined with limit, sort, order, or cursor."
            schema = booleanSchema(default = false, example = true)
        }
    }
    errorResponses()
}

internal fun Route.describeActivitySummaryReadOperation(): Route = describe {
    operationId = "listActivitySummaries"
    tag("Read")
    summary = "List activity summaries"
    description =
        "Returns daily activity summary metrics such as distance, calories, elevation, activity minutes, and daily heart-rate summary values."
    requiresBearerAuth()
    dailyStepQueryParameters()
    parameters {
        query("latest") {
            description =
                "Return the latest matching activity summary when true. Defaults to false. Cannot be combined with limit, sort, order, or cursor."
            schema = booleanSchema(default = false, example = true)
        }
    }
    errorResponses()
}
internal fun Route.describeSleepNightReadOperation(): Route = describe {
    operationId = "listSleepNights"
    tag("Read")
    summary = "List sleep nights"
    description =
        "Returns sleep sessions classified by the localized date of `endAt`. Use `timezone` to control night boundaries."
    requiresBearerAuth()
    sleepNightQueryParameters()
    errorResponses()
}

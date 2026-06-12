@file:OptIn(ExperimentalKtorApi::class)

package me.aquitano.health.api

import io.ktor.openapi.*
import io.ktor.utils.io.*
import kotlinx.serialization.builtins.serializer

internal const val JsonFormatDate = "date"
internal const val JsonFormatDateTime = "date-time"
internal fun stringSchema(
    format: String? = null,
    enumValues: List<String> = emptyList(),
    example: String? = null,
    default: String? = null,
): JsonSchema =
    JsonSchema(
        type = JsonType.STRING,
        format = format,
        enum = enumValues.map { stringElement(it) }.ifEmpty { null },
        example = example?.let(::stringElement),
        default = default?.let(::stringElement),
    )

internal fun integerSchema(
    default: Int? = null,
    minimum: Double? = null,
    maximum: Double? = null,
    example: Int? = null,
): JsonSchema =
    JsonSchema(
        type = JsonType.INTEGER,
        default = default?.let {
            GenericElement.encodeToElement(
                Int.serializer(),
                it
            )
        },
        minimum = minimum,
        maximum = maximum,
        example = example?.let {
            GenericElement.encodeToElement(
                Int.serializer(),
                it
            )
        },
    )

internal fun booleanSchema(
    default: Boolean? = null,
    example: Boolean? = null
): JsonSchema =
    JsonSchema(
        type = JsonType.BOOLEAN,
        default = default?.let {
            GenericElement.encodeToElement(
                Boolean.serializer(),
                it
            )
        },
        example = example?.let {
            GenericElement.encodeToElement(
                Boolean.serializer(),
                it
            )
        },
    )
private fun stringElement(value: String): GenericElement =
    GenericElement.encodeToElement(String.serializer(), value)

package me.aquitano.health.infrastructure.database

import org.jetbrains.exposed.v1.core.Column
import org.jetbrains.exposed.v1.core.ColumnType
import org.jetbrains.exposed.v1.core.Table
import org.postgresql.util.PGobject
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset

fun Instant.toDbTimestamp(): OffsetDateTime = atOffset(ZoneOffset.UTC)

fun OffsetDateTime.toApiString(): String = toInstant().toString()

fun Table.jsonb(name: String): Column<String> =
    registerColumn(name, JsonbColumnType())

private class JsonbColumnType : ColumnType<String>() {
    override fun sqlType(): String = "JSONB"

    override fun valueFromDB(value: Any): String =
        when (value) {
            is PGobject -> value.value ?: "null"
            else -> value.toString()
        }

    override fun notNullValueToDB(value: String): Any =
        PGobject().apply {
            type = "jsonb"
            this.value = value
        }

    override fun nonNullValueToString(value: String): String =
        "'${value.replace("'", "''")}'::jsonb"

    override fun parameterMarker(value: String?): String = "?::jsonb"
}

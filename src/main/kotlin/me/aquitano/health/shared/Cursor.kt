package me.aquitano.health.shared

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import java.util.Base64

/**
 * Opaque keyset-pagination cursor. Encodes the sort value and row id of the last item of a
 * page plus the sort/order it was produced under; decoding rejects a cursor whose sort or
 * order no longer matches the request, so clients cannot silently mix pagination schemes.
 */
@Serializable
data class Cursor(
    /** Sort value of the last row (ISO timestamp, date, or numeric string). */
    @SerialName("s") val sortValue: String,
    /** Row id of the last row; tie-break for equal sort values. */
    @SerialName("id") val lastId: Long,
    @SerialName("o") val order: String,
    @SerialName("f") val field: String,
) {
    fun encode(): String =
        Base64.getUrlEncoder().withoutPadding()
            .encodeToString(AppJson.encodeToString(serializer(), this).toByteArray(Charsets.UTF_8))

    companion object {
        fun encode(sortValue: String, lastId: Long, order: String, field: String): String =
            Cursor(sortValue, lastId, order, field).encode()

        fun decode(value: String, expectedField: String, expectedOrder: String): Cursor {
            val cursor = runCatching {
                val json = String(Base64.getUrlDecoder().decode(value), Charsets.UTF_8)
                AppJson.decodeFromString(serializer(), json)
            }.getOrElse {
                throw RequestValidationException(
                    listOf(
                        ValidationIssue(
                            field = "cursor",
                            code = ValidationIssueCodes.InvalidFormat,
                            message = "is not a valid cursor",
                        )
                    )
                )
            }
            if (cursor.field != expectedField || cursor.order != expectedOrder) {
                throw RequestValidationException(
                    listOf(
                        ValidationIssue(
                            field = "cursor",
                            code = ValidationIssueCodes.InvalidState,
                            message = "was issued for sort=${cursor.field} order=${cursor.order} " +
                                "and cannot be used with this request",
                        )
                    )
                )
            }
            return cursor
        }
    }
}

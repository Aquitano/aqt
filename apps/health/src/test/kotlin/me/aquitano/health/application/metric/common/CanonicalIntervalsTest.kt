package me.aquitano.health.application.metric.common

import kotlin.test.Test
import kotlin.test.assertEquals
import java.time.Instant

class CanonicalIntervalsTest {

    data class SimpleRow(val id: String)

    @Test
    fun `returns non-overlapping intervals`() {
        val candidates = listOf(
            candidate("A", 1, "2023-01-01T10:00:00Z", "2023-01-01T11:00:00Z"),
            candidate("B", 2, "2023-01-01T12:00:00Z", "2023-01-01T13:00:00Z"),
        )

        val result = canonicalIntervalRows(
            rows = candidates,
            overlaps = { left, right -> left.startAt.isBefore(right.endAt) && right.startAt.isBefore(left.endAt) },
            choosePreferred = { _, _ -> throw IllegalStateException("Should not conflict") }
        )

        assertEquals(listOf("A", "B"), result.map { it.id })
    }

    @Test
    fun `resolves overlap by preferring candidate`() {
        val candidates = listOf(
            candidate("A", 1, "2023-01-01T10:00:00Z", "2023-01-01T11:00:00Z"),
            candidate("B", 2, "2023-01-01T10:30:00Z", "2023-01-01T11:30:00Z"),
        )

        val result = canonicalIntervalRows(
            rows = candidates,
            overlaps = { left, right -> left.startAt.isBefore(right.endAt) && right.startAt.isBefore(left.endAt) },
            choosePreferred = { left, right -> if (left.row.id == "B") left else right }
        )

        assertEquals(listOf("B"), result.map { it.id })
    }

    @Test
    fun `ignores same source overlaps by default`() {
        val candidates = listOf(
            candidate("A", 1, "2023-01-01T10:00:00Z", "2023-01-01T11:00:00Z"),
            candidate("B", 1, "2023-01-01T10:30:00Z", "2023-01-01T11:30:00Z"),
        )

        val result = canonicalIntervalRows(
            rows = candidates,
            overlaps = { left, right -> left.startAt.isBefore(right.endAt) && right.startAt.isBefore(left.endAt) },
            choosePreferred = { _, _ -> throw IllegalStateException("Should not conflict") }
        )

        assertEquals(listOf("A", "B"), result.map { it.id })
    }

    private fun candidate(id: String, sourceInstanceId: Int, startAt: String, endAt: String) =
        CanonicalIntervalCandidate(
            row = SimpleRow(id),
            sourceInstanceId = sourceInstanceId,
            startAt = Instant.parse(startAt),
            endAt = Instant.parse(endAt),
        )
}

package me.aquitano.health.application.metric.common

import me.aquitano.health.domain.RequestValidationException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class QueryParamSpecsTest {
    @Test
    fun `limit spec enforces documented default and bounds`() {
        assertEquals(500, QueryParams(emptyMap()).limit(QueryParamSpecs.readLimit))
        assertEquals(5000, QueryParams(mapOf("limit" to "5000")).limit(QueryParamSpecs.readLimit))
        assertFailsWith<RequestValidationException> {
            QueryParams(mapOf("limit" to "5001")).limit(QueryParamSpecs.readLimit)
        }
        assertEquals(100, QueryParams(emptyMap()).limit(QueryParamSpecs.adminLimit))
        assertFailsWith<RequestValidationException> {
            QueryParams(mapOf("limit" to "1001")).limit(QueryParamSpecs.adminLimit)
        }
    }

    @Test
    fun `sort spec enforces documented enum and default`() {
        assertEquals("measuredAt", QueryParams(emptyMap()).sort(QueryParamSpecs.sortByMeasuredAt))
        assertFailsWith<RequestValidationException> {
            QueryParams(mapOf("sort" to "date")).sort(QueryParamSpecs.sortByMeasuredAt)
        }
    }

    @Test
    fun `boolean spec applies documented default`() {
        assertEquals(false, QueryParams(emptyMap()).boolean(QueryParamSpecs.includeSource))
        assertEquals(true, QueryParams(mapOf("includeSource" to "true")).boolean(QueryParamSpecs.includeSource))
    }

    @Test
    fun `enum spec rejects a default outside its values`() {
        assertFailsWith<IllegalArgumentException> {
            EnumParamSpec("sort", listOf("date"), "measuredAt")
        }
    }
}

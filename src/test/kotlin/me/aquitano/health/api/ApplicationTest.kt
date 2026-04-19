package me.aquitano.health.api

import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals

class ApplicationTest {
    @Test
    fun healthEndpointResponds() = testApplication {
        application {
            module()
        }

        val response = client.get("/api/v1/admin/health")

        assertEquals(HttpStatusCode.OK, response.status)
        assert(response.bodyAsText().contains(""""status":"ok""""))
    }
}

package me.aquitano.health.api

import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.config.MapApplicationConfig
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.createDirectories
import kotlin.io.path.writeText
import kotlin.test.Test
import kotlin.test.assertEquals

class OpenApiExportTest {
    @Test
    fun exportOpenApiSpec() = testApplication {
        configureExportApplication()

        val response = client.get("/openapi")

        assertEquals(HttpStatusCode.OK, response.status)
        val output = System.getProperty("aqtHealth.openapi.output")
            ?.let(Path::of)
            ?: return@testApplication
        output.parent?.createDirectories()
        output.writeText(response.bodyAsText())
    }

    private fun ApplicationTestBuilder.configureExportApplication() {
        val dbPath = Files.createTempFile("aqt-health-openapi-export", ".db")
        environment {
            config = MapApplicationConfig(
                "ktor.application.modules.size" to "1",
                "ktor.application.modules.0" to "me.aquitano.health.api.ApplicationKt.module",
                "aqtHealth.database.jdbcUrl" to "jdbc:sqlite:$dbPath",
                "aqtHealth.database.driver" to "org.sqlite.JDBC",
                "aqtHealth.auth.bootstrapClientName" to "test-client",
                "aqtHealth.auth.bootstrapApiKey" to "test-key",
            )
        }
    }
}

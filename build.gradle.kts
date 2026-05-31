val exposed_version: String by project
val flyway_version: String by project
val hikari_version: String by project
val kotlin_version: String by project
val logback_version: String by project
val logstash_logback_encoder_version: String by project
val okhttp_version: String by project
val postgresql_jdbc_version: String by project
val testcontainers_version: String by project

plugins {
    kotlin("jvm") version "2.3.0"
    id("io.ktor.plugin") version "3.5.0"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.3.0"

    id("com.github.ben-manes.versions") version "0.54.0"
}

group = "me.aquitano"
version = "0.0.1"

application {
    mainClass = "io.ktor.server.netty.EngineMain"
}

kotlin {
    jvmToolchain(21)
}

ktor {
    openApi {
        enabled = true
        codeInferenceEnabled = true
        onlyCommented = false
    }
}

dependencies {
    implementation("io.ktor:ktor-client-cio")
    implementation("io.ktor:ktor-client-content-negotiation")
    implementation("io.ktor:ktor-client-core")
    implementation("io.ktor:ktor-server-auth")
    implementation("io.ktor:ktor-server-call-id")
    implementation("io.ktor:ktor-server-call-logging")
    implementation("io.ktor:ktor-server-core")
    implementation("io.ktor:ktor-server-content-negotiation")
    implementation("io.ktor:ktor-server-netty")
    implementation("io.ktor:ktor-server-openapi")
    implementation("io.ktor:ktor-server-routing-openapi")
    implementation("io.ktor:ktor-openapi-schema")
    implementation("io.ktor:ktor-server-status-pages")
    implementation("io.ktor:ktor-server-cors")
    implementation("io.ktor:ktor-server-swagger")
    implementation("io.ktor:ktor-serialization-kotlinx-json")
    implementation("io.ktor:ktor-server-config-yaml")
    implementation("ch.qos.logback:logback-classic:$logback_version")
    implementation("net.logstash.logback:logstash-logback-encoder:$logstash_logback_encoder_version")
    implementation("com.squareup.okhttp3:okhttp:$okhttp_version")

    implementation("org.jetbrains.exposed:exposed-core:$exposed_version")
    implementation("org.jetbrains.exposed:exposed-dao:$exposed_version")
    implementation("org.jetbrains.exposed:exposed-java-time:$exposed_version")
    implementation("org.jetbrains.exposed:exposed-jdbc:$exposed_version")
    implementation("org.postgresql:postgresql:$postgresql_jdbc_version")
    implementation("com.zaxxer:HikariCP:$hikari_version")
    implementation("org.flywaydb:flyway-core:$flyway_version")
    implementation("org.flywaydb:flyway-database-postgresql:$flyway_version")

    implementation("com.google.cloud:google-cloud-health:0.1.0")

    testImplementation("io.ktor:ktor-server-test-host")
    testImplementation("io.ktor:ktor-client-mock")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:$kotlin_version")
    testImplementation("org.testcontainers:postgresql:$testcontainers_version")
}

val integrationTestClasses = listOf(
    "**/ApplicationTest.class",
    "**/GoogleHealthProviderTest.class",
    "**/GoogleHealthProviderRouteTest.class",
    "**/IngestionRouteTest.class",
    "**/ProviderStatusRouteTest.class",
    "**/ReadApiRouteTest.class",
    "**/WithingsProviderTest.class",
    "**/WithingsProviderRouteTest.class",
    "**/DatabaseFactoryTest.class",
    "**/SupportRepositoryTest.class",
    "**/ScheduledSyncRepositoryTest.class",
)

fun dockerIsAvailable(): Boolean =
    listOf(
        listOf("docker", "info"),
        listOf("/usr/local/bin/docker", "info"),
        listOf("/opt/homebrew/bin/docker", "info"),
    ).any { command ->
        try {
            ProcessBuilder(command)
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start()
                .waitFor() == 0
        } catch (_: Exception) {
            false
        }
    }

fun requirePostgresIntegrationDatabase() {
    if (System.getenv("AQT_HEALTH_TEST_JDBC_URL").isNullOrBlank() && !dockerIsAvailable()) {
        throw GradleException(
            "PostgreSQL integration tests require Docker/Testcontainers or AQT_HEALTH_TEST_JDBC_URL.",
        )
    }
}

tasks.test {
    description = "Runs fast unit tests that do not require PostgreSQL."
    exclude(integrationTestClasses)
    exclude("**/OpenApiExportTest.class")
}

tasks.register<Test>("integrationTest") {
    description = "Runs PostgreSQL-backed integration tests."
    group = LifecycleBasePlugin.VERIFICATION_GROUP
    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    shouldRunAfter(tasks.test)
    include(integrationTestClasses)
    doFirst {
        requirePostgresIntegrationDatabase()
    }
}

tasks.check {
    dependsOn(tasks.named("integrationTest"))
}

tasks.register<Test>("generateOpenApi") {
    description = "Generates the runtime OpenAPI contract at build/openapi/openapi.json."
    group = "documentation"
    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    include("**/OpenApiExportTest.class")
    systemProperty(
        "aqtHealth.openapi.output",
        layout.buildDirectory.file("openapi/openapi.json").get().asFile.absolutePath,
    )
    outputs.file(layout.buildDirectory.file("openapi/openapi.json"))
    doFirst {
        requirePostgresIntegrationDatabase()
    }
}

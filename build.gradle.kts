val exposed_version: String by project
val flyway_version: String by project
val kotlin_version: String by project
val logback_version: String by project
val logstash_logback_encoder_version: String by project
val okhttp_version: String by project
val sqlite_jdbc_version: String by project

plugins {
    kotlin("jvm") version "2.3.0"
    id("io.ktor.plugin") version "3.4.2"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.3.0"
}

group = "me.aquitano"
version = "0.0.1"

application {
    mainClass = "io.ktor.server.netty.EngineMain"
}

kotlin {
    jvmToolchain(21)
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
    implementation("org.xerial:sqlite-jdbc:$sqlite_jdbc_version")
    implementation("org.flywaydb:flyway-core:$flyway_version")

    implementation("com.google.cloud:google-cloud-health:0.1.0")

    testImplementation("io.ktor:ktor-server-test-host")
    testImplementation("io.ktor:ktor-client-mock")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:$kotlin_version")
}

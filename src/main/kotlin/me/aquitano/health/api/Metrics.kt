@file:OptIn(io.ktor.utils.io.ExperimentalKtorApi::class)

package me.aquitano.health.api

import io.ktor.client.*
import io.ktor.client.statement.HttpResponse
import io.ktor.client.engine.cio.*
import io.ktor.client.request.post
import io.ktor.client.request.header
import io.ktor.client.request.setBody
import io.ktor.http.HttpHeaders
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.server.application.*
import io.ktor.server.metrics.micrometer.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.routing.openapi.*
import io.micrometer.prometheusmetrics.*
import kotlinx.coroutines.*
import me.aquitano.health.infrastructure.config.AppConfig
import io.github.oshai.kotlinlogging.KotlinLogging
import org.xerial.snappy.Snappy
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets

private val logger = KotlinLogging.logger("me.aquitano.health.api.Metrics")

fun Application.configureMetrics(appConfig: AppConfig, sharedHttpClient: HttpClient? = null) {
    val registry = PrometheusMeterRegistry(PrometheusConfig.DEFAULT)

    // Configure distribution statistics (percentiles and histograms) for request durations
    registry.config().meterFilter(object : io.micrometer.core.instrument.config.MeterFilter {
        override fun configure(
            id: io.micrometer.core.instrument.Meter.Id,
            config: io.micrometer.core.instrument.distribution.DistributionStatisticConfig
        ): io.micrometer.core.instrument.distribution.DistributionStatisticConfig {
            if (id.name == "ktor.http.server.requests") {
                return io.micrometer.core.instrument.distribution.DistributionStatisticConfig.builder()
                    .percentilesHistogram(true)
                    .percentiles(0.5, 0.9, 0.95, 0.99)
                    .build()
                    .merge(config)
            }
            return config
        }
    })

    install(MicrometerMetrics) {
        this.registry = registry
    }

    routing {
        // Prometheus scrape endpoint; infrastructure-only, kept out of the OpenAPI contract.
        get("/metrics") {
            call.respondText(registry.scrape())
        }.hide()
    }

    val url = appConfig.openObserve.url
    val org = appConfig.openObserve.org
    val user = appConfig.openObserve.user
    val password = appConfig.openObserve.password

    if (url.isBlank()) {
        logger.warn { "OpenObserve metrics pusher not started: url is blank." }
        return
    }

    val targetUrl = if (url.contains("/prometheus/api/v1/write")) {
        url
    } else {
        val base = url.trimEnd('/')
        if (org.isBlank()) {
            logger.warn { "OpenObserve metrics pusher not started: url is base path but org is blank." }
            return
        }
        "$base/api/$org/prometheus/api/v1/write"
    }

    if (user.isBlank() || password.isBlank()) {
        logger.warn { "OpenObserve metrics pusher not started: missing username or password." }
        return
    }

    logger.info { "Configuring OpenObserve metrics pusher to $targetUrl every 15s" }

    val client = sharedHttpClient ?: HttpClient(CIO)

    launch {
        val authHeaderValue = "Basic " + java.util.Base64.getEncoder().encodeToString("$user:$password".toByteArray())
        while (isActive) {
            delay(15_000)
            try {
                val scrapedData = registry.scrape()
                if (scrapedData.isNotBlank()) {
                    val parsedMetrics = parsePrometheusScrape(scrapedData, System.currentTimeMillis())
                    if (parsedMetrics.isNotEmpty()) {
                        val protobufBytes = serializeWriteRequest(parsedMetrics)
                        val snappyBytes = Snappy.compress(protobufBytes)

                        val response = client.post(targetUrl) {
                            header(HttpHeaders.Authorization, authHeaderValue)
                            header("X-Prometheus-Remote-Write-Version", "0.1.0")
                            header(HttpHeaders.ContentEncoding, "snappy")
                            contentType(ContentType("application", "x-protobuf"))
                            setBody(snappyBytes)
                        }
                        if (response.status.value >= 300) {
                            logger.warn { "Failed to push metrics to OpenObserve. Status: ${response.status}" }
                        }
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                logger.error(e) { "Error while pushing metrics to OpenObserve: ${e.message}" }
            }
        }
    }
}

// --- Protobuf Remote Write Serialization Helpers ---

private data class ParsedMetric(
    val name: String,
    val labels: Map<String, String>,
    val value: Double,
    val timestampMs: Long
)

private fun parsePrometheusScrape(scrapedData: String, timestampMs: Long): List<ParsedMetric> {
    val labelRegex = """([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"""".toRegex()
    return scrapedData.lineSequence().mapNotNull { line ->
        val trimmed = line.trim()
        if (trimmed.isEmpty() || trimmed.startsWith("#")) return@mapNotNull null

        val lastSpaceIdx = trimmed.lastIndexOf(' ')
        if (lastSpaceIdx == -1) return@mapNotNull null

        val nameAndLabels = trimmed.substring(0, lastSpaceIdx).trim()
        val value = trimmed.substring(lastSpaceIdx + 1).trim().toDoubleOrNull() ?: return@mapNotNull null

        val braceIdx = nameAndLabels.indexOf('{')
        if (braceIdx == -1) {
            ParsedMetric(nameAndLabels, emptyMap(), value, timestampMs)
        } else {
            val name = nameAndLabels.substring(0, braceIdx).trim()
            val labelsStr = nameAndLabels.substring(braceIdx + 1, nameAndLabels.length - 1)
            val labels = labelRegex.findAll(labelsStr).associate { it.groupValues[1] to it.groupValues[2] }
            ParsedMetric(name, labels, value, timestampMs)
        }
    }.toList()
}

private fun serializeWriteRequest(metrics: List<ParsedMetric>): ByteArray {
    val out = ByteArrayOutputStream()
    val utf8 = StandardCharsets.UTF_8
    for (metric in metrics) {
        val tsOut = ByteArrayOutputStream()

        val allLabels = metric.labels.toMutableMap()
        allLabels["__name__"] = metric.name

        for ((k, v) in allLabels.entries.sortedBy { it.key }) {
            val labelOut = ByteArrayOutputStream()
            labelOut.writeBytesField(1, k.toByteArray(utf8)) // name
            labelOut.writeBytesField(2, v.toByteArray(utf8)) // value
            tsOut.writeBytesField(1, labelOut.toByteArray()) // repeated Label labels = 1
        }

        val sampleOut = ByteArrayOutputStream()
        sampleOut.writeDoubleField(1, metric.value) // double value = 1
        sampleOut.writeLongField(2, metric.timestampMs) // int64 timestamp = 2
        tsOut.writeBytesField(2, sampleOut.toByteArray()) // repeated Sample samples = 2

        out.writeBytesField(1, tsOut.toByteArray()) // repeated TimeSeries timeseries = 1
    }
    return out.toByteArray()
}

private fun ByteArrayOutputStream.writeVarint(value: Long) {
    var v = value
    while (v and -0x80L != 0L) {
        write(((v and 0x7F) or 0x80).toInt())
        v = v ushr 7
    }
    write((v and 0x7F).toInt())
}

private fun ByteArrayOutputStream.writeBytesField(fieldNumber: Int, bytes: ByteArray) {
    writeVarint(((fieldNumber shl 3) or 2).toLong())
    writeVarint(bytes.size.toLong())
    write(bytes)
}

private fun ByteArrayOutputStream.writeDoubleField(fieldNumber: Int, value: Double) {
    writeVarint(((fieldNumber shl 3) or 1).toLong())
    val bits = java.lang.Double.doubleToRawLongBits(value)
    for (i in 0..7) {
        write(((bits shr (i * 8)) and 0xFF).toInt())
    }
}

private fun ByteArrayOutputStream.writeLongField(fieldNumber: Int, value: Long) {
    writeVarint(((fieldNumber shl 3) or 0).toLong())
    writeVarint(value)
}

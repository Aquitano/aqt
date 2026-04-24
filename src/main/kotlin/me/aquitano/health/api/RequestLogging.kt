package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.http.content.*
import io.ktor.server.application.*
import io.ktor.server.plugins.callid.*
import io.ktor.server.plugins.calllogging.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.util.*
import net.logstash.logback.argument.StructuredArguments.kv
import org.slf4j.LoggerFactory
import org.slf4j.MDC
import org.slf4j.event.Level
import java.util.UUID

private val RequestStartedAtKey = AttributeKey<Long>("RequestStartedAt")
private val logger = LoggerFactory.getLogger("me.aquitano.health.api.RequestLogging")

fun Application.configureRequestLogging() {
    install(CallId) {
        retrieveFromHeader(HttpHeaders.XRequestId)
        generate { UUID.randomUUID().toString() }
        verify { it.isNotBlank() }
        replyToHeader(HttpHeaders.XRequestId)
    }

    intercept(ApplicationCallPipeline.Setup) {
        call.attributes.put(RequestStartedAtKey, System.nanoTime())
    }

    sendPipeline.intercept(ApplicationSendPipeline.After) {
        val requestId = call.callId.orEmpty()
        val method = call.request.httpMethod.value
        val path = call.request.path()
        val status = (call.response.status() ?: (subject as? OutgoingContent)?.status)
            ?.value
            ?.toString()
            ?: HttpStatusCode.OK.value.toString()
        val durationMs = call.durationMs()?.toString().orEmpty()
        withRequestMdc(requestId, method, path, status, durationMs) {
            logger.info(
                "request_completed {}",
                kv("route", path),
            )
        }
    }

    install(CallLogging) {
        level = Level.INFO
        mdc("requestId") { call -> call.callId.orEmpty() }
        mdc("method") { call -> call.request.httpMethod.value }
        mdc("path") { call -> call.request.path() }
        mdc("status") { call -> call.response.status()?.value?.toString().orEmpty() }
        mdc("durationMs") { call -> call.durationMs()?.toString().orEmpty() }
    }
}

private fun ApplicationCall.durationMs(): Long? =
    attributes.getOrNull(RequestStartedAtKey)
        ?.let { (System.nanoTime() - it) / 1_000_000 }

private fun withRequestMdc(
    requestId: String,
    method: String,
    path: String,
    status: String,
    durationMs: String,
    block: () -> Unit,
) {
    val keys = listOf("requestId", "method", "path", "status", "durationMs")
    val previousValues = keys.associateWith { MDC.get(it) }
    MDC.put("requestId", requestId)
    MDC.put("method", method)
    MDC.put("path", path)
    MDC.put("status", status)
    MDC.put("durationMs", durationMs)
    try {
        block()
    } finally {
        previousValues.forEach { (key, value) ->
            if (value == null) {
                MDC.remove(key)
            } else {
                MDC.put(key, value)
            }
        }
    }
}

package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.plugins.callid.*
import io.ktor.server.plugins.calllogging.*
import io.ktor.server.request.*
import io.ktor.util.*
import kotlinx.coroutines.slf4j.MDCContext
import kotlinx.coroutines.withContext
import org.slf4j.event.Level
import java.util.*

private val RequestStartedAtKey = AttributeKey<Long>("RequestStartedAt")

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

    // Request-scoped MDC for logs emitted while the call is handled. The client identity is
    // intentionally NOT resolved here: hashing the bearer token and querying the DB on *every*
    // inbound request (before auth runs, including public/invalid traffic) is an unauthenticated
    // load-amplification primitive and duplicates the auth provider's work. clientId/clientName are
    // filled in by CallLogging below, read from the attribute the auth provider sets once a request
    // reaches an authenticated route.
    intercept(ApplicationCallPipeline.Plugins) {
        val mdcMap = mapOf(
            "requestId" to call.callId.orEmpty(),
            "method" to call.request.httpMethod.value,
            "path" to call.request.path(),
            "clientIp" to call.request.local.remoteHost,
            "userAgent" to call.request.headers[HttpHeaders.UserAgent].orEmpty(),
        )

        withContext(MDCContext(mdcMap)) {
            proceed()
        }
    }

    install(CallLogging) {
        level = Level.INFO
        mdc("requestId") { call -> call.callId.orEmpty() }
        mdc("method") { call -> call.request.httpMethod.value }
        mdc("path") { call -> call.request.path() }
        mdc("clientIp") { call -> call.request.local.remoteHost }
        mdc("userAgent") { call -> call.request.headers[HttpHeaders.UserAgent].orEmpty() }
        mdc("status") { call ->
            call.response.status()?.value?.toString().orEmpty()
        }
        mdc("durationMs") { call -> call.durationMs()?.toString().orEmpty() }
        mdc("clientId") { call -> call.attributes.getOrNull(ApiClientAttributeKey)?.id?.toString().orEmpty() }
        mdc("clientName") { call -> call.attributes.getOrNull(ApiClientAttributeKey)?.name.orEmpty() }
    }
}

private fun ApplicationCall.durationMs(): Long? =
    attributes.getOrNull(RequestStartedAtKey)
        ?.let { (System.nanoTime() - it) / 1_000_000 }

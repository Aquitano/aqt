package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.plugins.callid.*
import io.ktor.server.plugins.calllogging.*
import io.ktor.server.request.*
import io.ktor.util.*
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

    install(CallLogging) {
        level = Level.INFO
        mdc("requestId") { call -> call.callId.orEmpty() }
        mdc("method") { call -> call.request.httpMethod.value }
        mdc("path") { call -> call.request.path() }
        mdc("status") { call ->
            call.response.status()?.value?.toString().orEmpty()
        }
        mdc("durationMs") { call -> call.durationMs()?.toString().orEmpty() }
    }
}

private fun ApplicationCall.durationMs(): Long? =
    attributes.getOrNull(RequestStartedAtKey)
        ?.let { (System.nanoTime() - it) / 1_000_000 }

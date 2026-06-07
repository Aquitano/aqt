package me.aquitano.health.infrastructure.logging

import io.github.oshai.kotlinlogging.KLogger
import io.github.oshai.kotlinlogging.withLoggingContext

fun KLogger.infoWithContext(message: String, context: Map<String, Any?>) {
    withLoggingContext(context.mapValues { it.value?.toString() }) {
        info { "$message ${context.entries.joinToString(" ") { "${it.key}=${it.value}" }}" }
    }
}

fun KLogger.infoWithContext(message: String, vararg pairs: Pair<String, Any?>) {
    infoWithContext(message, pairs.toMap())
}

fun KLogger.warnWithContext(message: String, context: Map<String, Any?>, throwable: Throwable? = null) {
    withLoggingContext(context.mapValues { it.value?.toString() }) {
        if (throwable != null) {
            warn(throwable) { "$message ${context.entries.joinToString(" ") { "${it.key}=${it.value}" }}" }
        } else {
            warn { "$message ${context.entries.joinToString(" ") { "${it.key}=${it.value}" }}" }
        }
    }
}

fun KLogger.warnWithContext(message: String, vararg pairs: Pair<String, Any?>, throwable: Throwable? = null) {
    warnWithContext(message, pairs.toMap(), throwable)
}

fun KLogger.errorWithContext(message: String, context: Map<String, Any?>, throwable: Throwable? = null) {
    withLoggingContext(context.mapValues { it.value?.toString() }) {
        if (throwable != null) {
            error(throwable) { "$message ${context.entries.joinToString(" ") { "${it.key}=${it.value}" }}" }
        } else {
            error { "$message ${context.entries.joinToString(" ") { "${it.key}=${it.value}" }}" }
        }
    }
}

fun KLogger.errorWithContext(message: String, vararg pairs: Pair<String, Any?>, throwable: Throwable? = null) {
    errorWithContext(message, pairs.toMap(), throwable)
}

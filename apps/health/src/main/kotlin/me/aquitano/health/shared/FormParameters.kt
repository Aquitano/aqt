package me.aquitano.health.shared

import io.ktor.http.*

fun formParameters(vararg pairs: Pair<String, String?>): Parameters =
    formParameters(pairs.asIterable())

fun formParameters(pairs: Iterable<Pair<String, String?>>): Parameters =
    parameters {
        pairs.forEach { (key, value) ->
            if (value != null) append(key, value)
        }
    }

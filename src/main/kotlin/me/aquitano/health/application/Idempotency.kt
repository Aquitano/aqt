package me.aquitano.health.application

import java.security.MessageDigest

internal fun idempotencyRequestHash(vararg parts: String?): String {
    val digest = MessageDigest.getInstance("SHA-256")
    parts.forEach { part ->
        val value = part ?: ""
        val bytes = value.toByteArray(Charsets.UTF_8)
        digest.update(bytes.size.toString().toByteArray(Charsets.UTF_8))
        digest.update(0)
        digest.update(bytes)
        digest.update(0)
    }
    return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
}

internal fun Iterable<String>.idempotencyListPart(): String =
    joinToString("\n")

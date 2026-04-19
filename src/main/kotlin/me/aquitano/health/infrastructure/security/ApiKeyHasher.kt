package me.aquitano.health.infrastructure.security

import java.security.MessageDigest

class ApiKeyHasher {
    fun hash(apiKey: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(apiKey.toByteArray(Charsets.UTF_8))
        return "sha256:" + digest.joinToString(separator = "") {
            "%02x".format(
                it
            )
        }
    }

    fun matches(apiKey: String, expectedHash: String): Boolean =
        constantTimeEquals(hash(apiKey), expectedHash)

    private fun constantTimeEquals(left: String, right: String): Boolean {
        val leftBytes = left.toByteArray(Charsets.UTF_8)
        val rightBytes = right.toByteArray(Charsets.UTF_8)
        var result = leftBytes.size xor rightBytes.size
        val max = maxOf(leftBytes.size, rightBytes.size)
        for (index in 0 until max) {
            val leftByte = leftBytes.getOrNull(index) ?: 0
            val rightByte = rightBytes.getOrNull(index) ?: 0
            result = result or (leftByte.toInt() xor rightByte.toInt())
        }
        return result == 0
    }
}

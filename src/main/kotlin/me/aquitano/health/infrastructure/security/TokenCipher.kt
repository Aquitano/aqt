package me.aquitano.health.infrastructure.security

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.*
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class TokenCipher(secret: String) {
    private val key = SecretKeySpec(deriveKey(secret), "AES")
    private val random = SecureRandom()

    fun encrypt(plaintext: String): String {
        val nonce = ByteArray(12)
        random.nextBytes(nonce)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, nonce))
        val encrypted = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return listOf(
            "v1",
            nonce.encodeBase64(),
            encrypted.encodeBase64()
        ).joinToString(":")
    }

    fun decrypt(ciphertext: String): String {
        val parts = ciphertext.split(":")
        require(parts.size == 3 && parts[0] == "v1") { "Unsupported token ciphertext format" }
        val nonce = parts[1].decodeBase64()
        val encrypted = parts[2].decodeBase64()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, nonce))
        return cipher.doFinal(encrypted).toString(Charsets.UTF_8)
    }

    private fun deriveKey(secret: String): ByteArray {
        require(secret.isNotBlank()) {
            "AQT_HEALTH_GOOGLE_TOKEN_ENCRYPTION_KEY is required for Google Health OAuth"
        }
        return MessageDigest.getInstance("SHA-256")
            .digest(secret.toByteArray(Charsets.UTF_8))
    }

    private fun ByteArray.encodeBase64(): String =
        Base64.getEncoder().encodeToString(this)

    private fun String.decodeBase64(): ByteArray =
        Base64.getDecoder().decode(this)
}

package me.aquitano.health.application

import me.aquitano.health.api.dto.ProviderAccountStatusResponseDto
import me.aquitano.health.api.dto.ProviderNextAction
import me.aquitano.health.api.dto.ProviderStatusCatalogResponseDto
import me.aquitano.health.api.dto.ProviderStatusResponseDto
import me.aquitano.health.api.dto.ProviderTokenStatus
import me.aquitano.health.domain.HealthProvider
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.infrastructure.repositories.ProviderOAuthAccount
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import java.time.Instant

class ProviderStatusService(
    private val providerRegistry: HealthProviderRegistry,
    private val providerOAuthRepository: ProviderOAuthRepository,
) {
    suspend fun listProviderStatuses(now: Instant): ProviderStatusCatalogResponseDto =
        ProviderStatusCatalogResponseDto(
            providers = providerRegistry.listProviders()
                .map { it.toStatusDto(now) },
        )

    suspend fun getProviderStatus(
        providerCode: String,
        now: Instant
    ): ProviderStatusResponseDto =
        providerRegistry.getProvider(providerCode)
            ?.toStatusDto(now)
            ?: throw NotFoundException("Provider '$providerCode' not found")

    private suspend fun HealthProvider.toStatusDto(now: Instant): ProviderStatusResponseDto {
        val configured = isConfigured()
        val accounts = providerOAuthRepository.accountsByProvider(providerCode)
        val accountStatuses = accounts.map { it.toStatusDto(now) }
        val connected = accountStatuses.isNotEmpty()
        val canSync = configured && accounts.any { it.hasStoredTokens() }
        val needsAuthentication = configured && !canSync
        val nextAction = when {
            !configured -> ProviderNextAction.Configure
            !connected -> ProviderNextAction.Connect
            !canSync -> ProviderNextAction.Reconnect
            else -> ProviderNextAction.Sync
        }

        return ProviderStatusResponseDto(
            providerCode = descriptor.providerCode,
            displayName = descriptor.displayName,
            configured = configured,
            connected = connected,
            needsAuthentication = needsAuthentication,
            canSync = canSync,
            nextAction = nextAction,
            accounts = accountStatuses,
        )
    }

    private suspend fun ProviderOAuthAccount.toStatusDto(now: Instant): ProviderAccountStatusResponseDto =
        ProviderAccountStatusResponseDto(
            providerInstanceId = providerInstanceId,
            connectedAt = createdAt.toString(),
            lastSyncAt = providerOAuthRepository.latestFinishedSyncAt(
                providerCode = providerCode,
                providerInstanceId = providerInstanceId,
            )?.toString(),
            tokenStatus = tokenStatus(now),
            expiresAt = expiresAt.toString(),
        )

    private fun ProviderOAuthAccount.tokenStatus(now: Instant): ProviderTokenStatus =
        when {
            accessTokenCiphertext.isBlank() || refreshTokenCiphertext.isBlank() -> ProviderTokenStatus.Missing
            !expiresAt.isAfter(now) -> ProviderTokenStatus.Expired
            else -> ProviderTokenStatus.Valid
        }

    private fun ProviderOAuthAccount.hasStoredTokens(): Boolean =
        accessTokenCiphertext.isNotBlank() && refreshTokenCiphertext.isNotBlank()
}

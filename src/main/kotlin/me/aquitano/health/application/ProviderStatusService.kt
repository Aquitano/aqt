package me.aquitano.health.application

import me.aquitano.health.api.dto.ProviderAccountStatusResponse
import me.aquitano.health.api.dto.ProviderAccountLifecycleStatus
import me.aquitano.health.api.dto.ProviderNextAction
import me.aquitano.health.api.dto.ProviderStatusCatalogResponse
import me.aquitano.health.api.dto.ProviderStatusResponse
import me.aquitano.health.api.dto.ProviderTokenStatus
import me.aquitano.health.domain.HealthProvider
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.infrastructure.repositories.ACCOUNT_STATUS_CONNECTED
import me.aquitano.health.infrastructure.repositories.ACCOUNT_STATUS_DISCONNECTED
import me.aquitano.health.infrastructure.repositories.ACCOUNT_STATUS_NEEDS_REAUTH
import me.aquitano.health.infrastructure.repositories.ProviderOAuthAccount
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import java.time.Instant

class ProviderStatusService(
    private val providerRegistry: HealthProviderRegistry,
    private val providerOAuthRepository: ProviderOAuthRepository,
) {
    suspend fun listProviderStatuses(now: Instant): ProviderStatusCatalogResponse =
        ProviderStatusCatalogResponse(
            items = providerRegistry.listProviders()
                .map { it.toStatusDto(now) },
        )

    suspend fun getProviderStatus(
        providerCode: String,
        now: Instant
    ): ProviderStatusResponse =
        providerRegistry.getProvider(providerCode)
            ?.toStatusDto(now)
            ?: throw NotFoundException("Provider '$providerCode' not found")

    suspend fun listAccountStatuses(
        providerCode: String,
        now: Instant,
    ): List<ProviderAccountStatusResponse> {
        val provider = providerRegistry.getProvider(providerCode)
            ?: throw NotFoundException("Provider '$providerCode' not found")
        val normalizedCode = providerRegistry.normalize(providerCode)
        return providerOAuthRepository.accountsByProvider(normalizedCode)
            .map { it.toStatusDto(now, configured = provider.isConfigured()) }
    }

    suspend fun getAccountStatus(
        providerCode: String,
        providerInstanceId: String,
        now: Instant,
    ): ProviderAccountStatusResponse {
        val provider = providerRegistry.getProvider(providerCode)
            ?: throw NotFoundException("Provider '$providerCode' not found")
        val normalizedCode = providerRegistry.normalize(providerCode)
        val account = providerOAuthRepository.accountByProviderInstanceForStatus(
            providerCode = normalizedCode,
            providerInstanceId = providerInstanceId,
        ) ?: throw NotFoundException("Provider account '$providerInstanceId' not found")
        return account.toStatusDto(now, configured = provider.isConfigured())
    }

    private suspend fun HealthProvider.toStatusDto(now: Instant): ProviderStatusResponse {
        val configured = isConfigured()
        val accounts = providerOAuthRepository.accountsByProvider(providerCode)
        val accountStatuses = accounts.map { it.toStatusDto(now, configured) }
        val connected = configured && accountStatuses.any {
            it.status == ProviderAccountLifecycleStatus.Connected
        }
        val canSync = configured && accounts.any { it.canSync() }
        val needsReauth = accountStatuses.any {
            it.status == ProviderAccountLifecycleStatus.NeedsReauth
        }
        val needsAuthentication = configured && !canSync
        val nextAction = when {
            !configured -> ProviderNextAction.Configure
            !canSync && needsReauth -> ProviderNextAction.Reconnect
            !connected -> ProviderNextAction.Connect
            !canSync -> ProviderNextAction.Reconnect
            else -> ProviderNextAction.Sync
        }

        return ProviderStatusResponse(
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

    suspend fun accountStatusDto(
        account: ProviderOAuthAccount,
        now: Instant,
        configured: Boolean,
    ): ProviderAccountStatusResponse = account.toStatusDto(now, configured)

    private suspend fun ProviderOAuthAccount.toStatusDto(
        now: Instant,
        configured: Boolean,
    ): ProviderAccountStatusResponse =
        ProviderAccountStatusResponse(
            providerInstanceId = providerInstanceId,
            status = lifecycleStatus(configured),
            connectedAt = (connectedAt ?: createdAt).toString(),
            disconnectedAt = disconnectedAt?.toString(),
            lastSyncAt = providerOAuthRepository.latestFinishedSyncAt(
                providerCode = providerCode,
                providerInstanceId = providerInstanceId,
            )?.toString(),
            tokenStatus = tokenStatus(now),
            expiresAt = expiresAt.toString(),
            lastTokenRefreshAt = lastTokenRefreshAt?.toString(),
            lastTokenRefreshStatus = lastTokenRefreshStatus,
            lastAuthErrorCode = lastAuthErrorCode,
            lastAuthErrorMessage = lastAuthErrorMessage,
        )

    private fun ProviderOAuthAccount.lifecycleStatus(configured: Boolean): ProviderAccountLifecycleStatus =
        when {
            !configured -> ProviderAccountLifecycleStatus.ConfigurationError
            accountStatus == ACCOUNT_STATUS_NEEDS_REAUTH -> ProviderAccountLifecycleStatus.NeedsReauth
            accountStatus == ACCOUNT_STATUS_DISCONNECTED -> ProviderAccountLifecycleStatus.Disconnected
            accountStatus == ACCOUNT_STATUS_CONNECTED && hasStoredTokens() -> ProviderAccountLifecycleStatus.Connected
            else -> ProviderAccountLifecycleStatus.NotConnected
        }

    private fun ProviderOAuthAccount.tokenStatus(now: Instant): ProviderTokenStatus =
        when {
            accessTokenCiphertext.isBlank() || refreshTokenCiphertext.isBlank() -> ProviderTokenStatus.Missing
            !expiresAt.isAfter(now) -> ProviderTokenStatus.Expired
            else -> ProviderTokenStatus.Valid
        }

    private fun ProviderOAuthAccount.hasStoredTokens(): Boolean =
        accessTokenCiphertext.isNotBlank() && refreshTokenCiphertext.isNotBlank()

    private fun ProviderOAuthAccount.canSync(): Boolean =
        accountStatus == ACCOUNT_STATUS_CONNECTED && hasStoredTokens()
}

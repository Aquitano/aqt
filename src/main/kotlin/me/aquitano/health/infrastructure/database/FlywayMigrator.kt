package me.aquitano.health.infrastructure.database

import me.aquitano.health.infrastructure.config.DatabaseConfig
import org.flywaydb.core.Flyway

class FlywayMigrator {
    fun migrate(config: DatabaseConfig) {
        Flyway.configure()
            .dataSource(config.jdbcUrl, null, null)
            .locations("classpath:db/migration")
            .load()
            .migrate()
    }
}

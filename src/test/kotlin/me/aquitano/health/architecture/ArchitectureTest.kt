package me.aquitano.health.architecture

import com.lemonappdev.konsist.api.Konsist
import com.lemonappdev.konsist.api.verify.assertFalse
import kotlin.test.Test

class ArchitectureTest {

    /**
     * Konsist scans the filesystem, so it also picks up copies of the source under
     * nested git worktrees (`.claude/worktrees`, `.t3/worktrees`) and stale IDE output
     * (`bin/`). Those are not this project's production source and can carry pre-refactor
     * code that trips these rules locally even when the real tree is clean. Restrict the
     * scope to the primary working tree; CI runs on a clean checkout and is unaffected.
     */
    private val production = Konsist.scopeFromProduction()
        .slice { file -> NESTED_TREE_MARKERS.none { file.path.contains(it) } }

    /**
     * Read-model repositories under application/ build Exposed queries but must
     * never open transactions; the calling service owns the transaction boundary.
     *
     * Infrastructure repositories (jobs, OAuth state, scheduling) are exempt by
     * design: they are entry points that own their own transaction boundaries.
     */
    @Test
    fun `application-layer repositories never open transactions`() {
        val repositories = production
            .classes()
            .filter { it.resideInPackage("me.aquitano.health.application..") }
            .filter { it.name.endsWith("Repository") }
        check(repositories.size >= 9) {
            "Expected the metric read-model repositories, found ${repositories.size} - scope is broken"
        }
        repositories.assertFalse { clazz ->
            val text = clazz.text
            text.contains("suspendDbTransaction(") ||
                text.contains("newSuspendedTransaction(") ||
                text.contains("transaction(database)")
        }
    }

    /**
     * The api/ layer speaks DTOs and services only; Exposed must stay behind
     * application/ and infrastructure/. Checked on file text, not just imports,
     * so fully-qualified references cannot slip through.
     */
    @Test
    fun `api layer never references Exposed`() {
        val apiFiles = production
            .files
            .filter { it.packagee?.name?.startsWith("me.aquitano.health.api") == true }
        check(apiFiles.isNotEmpty()) { "No api/ files found - scope is broken" }
        apiFiles.assertFalse { file -> file.text.contains("org.jetbrains.exposed") }
    }

    private companion object {
        val NESTED_TREE_MARKERS = listOf("/.claude/", "/.t3/", "/bin/")
    }
}

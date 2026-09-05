# Contributing to aqt-health

Welcome! This guide outlines the development standards and conventional commit guidelines for contributing to `aqt-health`, ensuring a consistent git history and clean workflows across both human contributors and AI agents.

## Conventional Commits

We use [Conventional Commits](https://www.conventionalcommits.org/) to maintain a structured, readable, and machine-parsable repository history. 

### Format

All commit messages must follow this structure:

```
<type>(<scope>): <summary>

[optional body]

[optional footer(s)]
```

### Commit Types

- **`feat`**: A new feature for the application or API.
- **`fix`**: A bug fix for the codebase.
- **`refactor`**: Code changes that neither fix a bug nor add a feature (e.g., restructuring files, renaming classes, improving readability).
- **`test`**: Adding missing tests or correcting existing tests.
- **`docs`**: Documentation-only changes (e.g., editing `README.md` or this contributing guide).
- **`chore`**: Changes to the build process, dependencies, auxiliary tools, or configuration (e.g., Gradle updates, CI config).

### Recommended Scopes

Use the following scopes to keep commits organized. If a change spans multiple components, choose the most specific scope or omit the scope (e.g., `refactor: clean up bootstrap config`).

- **`api`**: Routing, HTTP endpoints, OpenAPI generation, authentication, and HTTP request validation.
- **`providers`**: OAuth configuration, credentials management, and provider-specific integrations (Google Health, Withings).
- **`sync`**: Synchronization pipelines, scheduling, provider sync adapters, and ingestion runs.
- **`sleep`**: Sleep session parsing, calendar sleep-night categorization, and timezone adjustments.
- **`ingestion`**: Raw health batches, records parsing, and source database audits.
- **`metrics`**: Daily step summaries, heart-rate queries, body measurements, database models, and Exposed DSL interactions.
- **`frontend`**: Frontend UI, HTML, CSS, JavaScript, and trends dashboard components.
- **`db`**: Database migrations (Flyway scripts), schema definitions, and connection pool configurations.
- **`docs`**: Documentation, README, user manuals, and API contracts.
- **`test`**: Test helpers, Testcontainers setup, integration testing suite, and mock providers.

### Commit Guidelines & Best Practices

1. **Keep Commits Focused**: Each commit should represent a single logical change. Do not bundle unrelated changes, refactorings, and features into a single commit.
2. **Imperative Mood**: Use the imperative, present tense in the summary (e.g., "add dashboard trends" instead of "added dashboard trends" or "adds dashboard trends").
3. **Reference Issues**: When applicable, reference issues in the commit footer or body (e.g., `Closes #12`).

### Examples

Here are examples of how to apply this policy for typical tasks:

- **Sleep Fixes**:
  `fix(sleep): resolve timezone alignment issues for night calculation`
- **Provider Discovery**:
  `feat(providers): add automatic OAuth credentials discovery for new accounts`
- **Sync Workflow**:
  `feat(sync): parallelize provider ingestion workflow to handle multiple accounts`
- **Documentation-only Work**:
  `docs(contributing): document conventional commit scopes`

---

## Verification & Testing

Before submitting a Pull Request or closing an issue:

1. **Run All Tests**: Ensure the test suite passes locally:
   - Bash: `./gradlew test`
   - PowerShell: `.\gradlew.bat test`
2. **Document Testing**: In your pull request description or issue closeout notes, you **must** explicitly mention the tests that were run (both automated tests and manual verification steps).

Example PR/Closeout Note:
> **Verification Run:**
> - Ran `./gradlew test` successfully (all 42 tests passed).
> - Manually verified sleep night routing with local timezone `Europe/Berlin` using `curl` against local dev server.

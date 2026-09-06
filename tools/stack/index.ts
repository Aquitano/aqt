import { intro, log, confirm, cancel, outro } from "@clack/prompts";

import { step, die, unwrap } from "./src/helpers.ts";
import { scaffold } from "./src/pipeline.ts";
import { promptConfig } from "./src/prompts.ts";
import { BunShellRunner } from "./src/shell.ts";

async function main(): Promise<void> {
  const wantsHelp = Bun.argv.slice(2).some((arg) => arg === "--help" || arg === "-h");
  if (wantsHelp) {
    console.log(
      `\n  AQT Stack · App Bootstrapper\n\n  An interactive CLI to scaffold Next.js + Tailwind + shadcn/ui + Hono.js apps under apps/<name>.\n\n  Usage: bun run tools/stack/index.ts\n`,
    );
    process.exit(0);
  }

  intro("AQT Stack · App Bootstrapper");

  const config = await promptConfig();

  log.info("Configuration:");
  log.info(`  Project:   ${config.projectName}`);
  log.info(`  TypeScript: yes`);
  log.info(`  Tailwind:   yes`);
  log.info("  Tooling:    workspace Oxlint, Oxfmt, TypeScript");
  log.info("  Validation: ArkType");
  log.info(
    `  shadcn/ui:  ${config.shadcn ? `${config.shadcnComponents.length} components` : "no"}`,
  );
  log.info(`  Hono.js:    ${config.hono ? "yes" : "no"}`);
  log.info(`  Themes:     ${config.themes ? "yes" : "no"}`);
  log.info(`  Testing:    ${config.testing ? "yes" : "no"}`);
  log.info(`  CI:         ${config.ci ? "yes" : "no"}`);

  const proceed = unwrap(
    await confirm({
      message: "Proceed with scaffolding?",
      initialValue: true,
    }),
  );
  if (!proceed) {
    cancel("Scaffolding cancelled.");
    process.exit(0);
  }

  await scaffold(config, new BunShellRunner(), step);

  outro(`Done! Your project is ready at apps/${config.projectName}`);
  log.info(`  cd apps/${config.projectName}`);
  log.info("  bun dev\n");
}

main().catch(die);

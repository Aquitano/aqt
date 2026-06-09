import { intro, log, confirm, cancel, outro } from '@clack/prompts';
import { promptConfig } from './src/prompts.ts';
import { scaffold } from './src/pipeline.ts';
import { BunShellRunner } from './src/shell.ts';
import { step, die, unwrap } from './src/helpers.ts';

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      `\n  AQT Stack · App Bootstrapper\n\n  An interactive CLI to scaffold Next.js + Tailwind + shadcn/ui + Hono.js projects.\n\n  Usage: bun run index.ts\n`,
    );
    process.exit(0);
  }

  intro('AQT Stack · App Bootstrapper');

  const config = await promptConfig();

  log.info('Configuration:');
  log.info(`  Project:   ${config.projectName}`);
  log.info(`  TypeScript: yes`);
  log.info(`  Tailwind:   yes`);
  log.info(`  ESLint:     ${config.eslint ? 'yes' : 'no'}`);
  log.info(`  Prettier:   ${config.prettier ? config.prettierPreset : 'no'}`);
  log.info(`  shadcn/ui:  ${config.shadcn ? `${config.shadcnComponents.length} components` : 'no'}`);
  log.info(`  Hono.js:    ${config.hono ? 'yes' : 'no'}`);

  const proceed = unwrap(
    await confirm({
      message: 'Proceed with scaffolding?',
      initialValue: true,
    }),
  );
  if (!proceed) {
    cancel('Scaffolding cancelled.');
    process.exit(0);
  }

  await scaffold(config, new BunShellRunner(), step);

  outro(`Done! Your project is ready at ./${config.projectName}`);
  log.info(`  cd ${config.projectName}`);
  log.info('  bun dev\n');
}

main().catch(die);

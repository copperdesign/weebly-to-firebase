#!/usr/bin/env node
/**
 * weebly-to-firebase — CLI entry point.
 *
 * Parses argv, dispatches to the matching command module under commands/.
 * Default subcommand when none given: init.
 *
 * Exit codes:
 *   0  success
 *   1  command failure (runtime error)
 *   2  usage error (unknown flag / unknown command)
 */

import { parseCli, printHelp, printVersion, VALID_COMMANDS } from './lib/args.mjs';
import { close as closePrompt } from './lib/prompt.mjs';

const { command, flags, positionals, error } = parseCli(process.argv.slice(2));

if (error) {
  console.error(`error: ${error}`);
  console.error("Run 'weebly-to-firebase --help' for usage.");
  process.exit(2);
}

if (flags?.version || command === 'version') {
  printVersion();
  process.exit(0);
}

if (flags?.help || command === 'help') {
  // For `help <command>`, the subcommand sits in positionals[0] (parseCli
  // already stripped the leading 'help'). For `<command> --help`, `command`
  // is the subcommand. For plain `--help` with no command, both are undefined
  // → printHelp falls back to the global help.
  const sub = command === 'help' ? positionals[0] : command;
  printHelp(VALID_COMMANDS.includes(sub) ? sub : undefined);
  process.exit(0);
}

// Default to `init` only on the run path — earlier branches need to know
// whether the user explicitly named a command.
const runCommand = command || 'init';

if (!VALID_COMMANDS.includes(runCommand)) {
  console.error(`unknown command: ${runCommand}`);
  console.error("Run 'weebly-to-firebase --help' for usage.");
  process.exit(2);
}

try {
  const mod = await import(`./commands/${runCommand}.mjs`);
  await mod.run(flags, positionals);
  process.exit(0);
} catch (err) {
  console.error(`\nerror: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
} finally {
  closePrompt();
}

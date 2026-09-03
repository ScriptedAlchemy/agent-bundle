/**
 * A self-executing plain script: no `main` export, so the artifact bundles the
 * module as-is and its top-level code runs when the process evaluates it.
 */
process.stdout.write(`banner: ${process.argv.slice(2).join(' ')}\n`);

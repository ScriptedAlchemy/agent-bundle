/**
 * A plain script whose `main` export is not callable. The builder's static
 * export scan still selects the process envelope, which re-verifies the export
 * at runtime and throws — so the generated executable evaluates the module,
 * then always exits 1.
 */
process.stdout.write('constant evaluated\n');

export const main = 'not callable';

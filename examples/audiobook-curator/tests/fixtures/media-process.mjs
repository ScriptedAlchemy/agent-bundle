const [mode] = process.argv.slice(2);

switch (mode) {
  case 'success':
    process.stdout.write('ready');
    break;
  case 'failure':
    process.stderr.write('fixture failure');
    process.exitCode = 3;
    break;
  case 'overflow':
    process.stdout.write(Buffer.alloc(256 * 1024 + 1, 97));
    break;
  case 'sleep':
    setInterval(() => undefined, 1_000);
    break;
  default:
    process.exitCode = 4;
}

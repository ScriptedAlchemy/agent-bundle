import { Badge } from '../badge.js';
import { Ribbon } from '../ribbon.jsx';

/**
 * A plain script that imports a `.tsx` helper — and, with `--ribbon`, a
 * JavaScript `.jsx` one — the way a project shares presentational pieces
 * between its rendered and plain scripts: the bundler lowers the JSX for the
 * generated executable, and the harness must do the same for the source it
 * runs.
 */
export const main = (argv: readonly string[]): number => {
  const label = argv.filter((argument) => !argument.startsWith('--')).join(' ') || 'unlabelled';
  const element = argv.includes('--ribbon') ? Ribbon({ label }) : Badge({ label });
  const { children, className } = element.props as { readonly children: string; readonly className: string };
  process.stdout.write(`<${String(element.type)} class="${className}">${children}</${String(element.type)}>\n`);
  return 0;
};

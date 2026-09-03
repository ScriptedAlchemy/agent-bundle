/**
 * A JavaScript JSX helper (`.jsx`, imported with its extension) shared by the
 * fixture's plain `badge` script; not a route. The bundler lowers it through
 * the React plugin, as it does the `.tsx` helper beside it.
 */
export const Ribbon = ({ label }) => <em className="ribbon">{label}</em>;

/** One wire contract for provenance labels: short identifiers, never paths, commands, or credential material. */
const identifierSource = '[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}';

export const provenanceIdentifierPattern = new RegExp(`^${identifierSource}$`, 'u');
export const explicitInvocationProvenancePattern = new RegExp(`^explicit:${identifierSource}$`, 'u');
export const semanticGraderIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}@[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

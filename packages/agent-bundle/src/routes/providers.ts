/** Derives the request-context key for one conventional provider file stem. */
export const providerKeyFromName = (name: string): string => {
  const words = name.split(/[._-]+/u);
  return words.map((word, index) => {
    const normalized = word === word.toUpperCase() ? word.toLowerCase() : word;
    if (index === 0) return `${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}`;
    return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
  }).join('');
};

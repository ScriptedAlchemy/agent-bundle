export const shikiLanguageAliases = Object.freeze({
  bash: 'bash',
  css: 'css',
  html: 'html',
  javascript: 'javascript',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  markdown: 'markdown',
  md: 'markdown',
  py: 'python',
  python: 'python',
  sh: 'bash',
  shell: 'bash',
  sql: 'sql',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  typescript: 'typescript',
  xml: 'html',
  yaml: 'yaml',
  yml: 'yaml',
} as const);

export type SupportedShikiLanguage = typeof shikiLanguageAliases[keyof typeof shikiLanguageAliases];

/** This tiny allowlist runs before the deferred Shiki module is requested. */
export const supportedShikiLanguage = (language: string): SupportedShikiLanguage | undefined =>
  shikiLanguageAliases[language.toLowerCase() as keyof typeof shikiLanguageAliases];

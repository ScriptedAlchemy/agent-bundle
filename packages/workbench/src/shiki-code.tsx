import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import React, { useEffect, useState } from 'react';

export interface ShikiCodeProps {
  readonly language: string;
  readonly value: string;
}

const languageLoaders = {
  bash: () => import('shiki/dist/langs/bash.mjs'),
  css: () => import('shiki/dist/langs/css.mjs'),
  html: () => import('shiki/dist/langs/html.mjs'),
  javascript: () => import('shiki/dist/langs/javascript.mjs'),
  json: () => import('shiki/dist/langs/json.mjs'),
  jsx: () => import('shiki/dist/langs/jsx.mjs'),
  markdown: () => import('shiki/dist/langs/markdown.mjs'),
  python: () => import('shiki/dist/langs/python.mjs'),
  sql: () => import('shiki/dist/langs/sql.mjs'),
  toml: () => import('shiki/dist/langs/toml.mjs'),
  tsx: () => import('shiki/dist/langs/tsx.mjs'),
  typescript: () => import('shiki/dist/langs/typescript.mjs'),
  yaml: () => import('shiki/dist/langs/yaml.mjs'),
} as const;

type SupportedLanguage = keyof typeof languageLoaders;

const aliases: Readonly<Record<string, SupportedLanguage>> = Object.freeze({
  bash: 'bash',
  css: 'css',
  html: 'html',
  js: 'javascript',
  javascript: 'javascript',
  json: 'json',
  jsx: 'jsx',
  md: 'markdown',
  markdown: 'markdown',
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
});

let highlighter: Promise<HighlighterCore> | undefined;
const loadedLanguages = new Map<SupportedLanguage, Promise<void>>();

const supportedLanguage = (language: string): SupportedLanguage | undefined => aliases[language.toLowerCase()];

const highlighterFor = async (language: string): Promise<Readonly<{ readonly highlighter: HighlighterCore; readonly lang: SupportedLanguage }> | undefined> => {
  const lang = supportedLanguage(language);
  if (lang === undefined) return undefined;
  highlighter ??= createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    themes: [import('shiki/dist/themes/github-light.mjs')],
  });
  const instance = await highlighter;
  let load = loadedLanguages.get(lang);
  if (load === undefined) {
    load = instance.loadLanguage(languageLoaders[lang]());
    loadedLanguages.set(lang, load);
  }
  await load;
  return Object.freeze({ highlighter: instance, lang });
};

/** Loaded after a fenced block is shown; core, theme, and one known grammar only. */
export const ShikiCode = ({ language, value }: ShikiCodeProps) => {
  const [html, setHtml] = useState<string>();

  useEffect(() => {
    let current = true;
    setHtml(undefined);
    void highlighterFor(language).then(
      (loaded) => loaded === undefined ? undefined : loaded.highlighter.codeToHtml(value, { lang: loaded.lang, theme: 'github-light' }),
    ).then(
      (next) => { if (current && next !== undefined) setHtml(next); },
      () => { if (current) setHtml(undefined); },
    );
    return () => { current = false; };
  }, [language, value]);

  if (html === undefined) {
    return <pre className="skill-code-block"><code className={`language-${language}`}>{value}</code></pre>;
  }
  // Shiki escapes source code before emitting this element; authored Markdown
  // never becomes HTML because react-markdown has no raw HTML plugin here.
  return <div className="skill-shiki" dangerouslySetInnerHTML={{ __html: html }} />;
};

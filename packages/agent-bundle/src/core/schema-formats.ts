import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

/**
 * The `uri` and `email` formats the pinned host schemas enforce, compiled once
 * from the same ajv-formats build the adapters validate documents with.
 *
 * A hand-written approximation is not equivalent: ajv's full `uri` rejects
 * characters `new URL()` happily parses (`|`, `<`, a bare `%`), and its `email`
 * rejects local parts a `[^\s@]+@[^\s@]+\.[^\s@]+` regex admits (`a..b@x.test`).
 * The shared descriptive layer withholds a value one of those formats would
 * refuse, so a `package.json` field can never become a host manifest error;
 * that promise only holds while both judgements run the same validator.
 *
 * This module is a leaf so the shared layer in `core/` and the adapters can
 * both read it without a cycle through `adapters/types.ts`.
 */
const validator = new Ajv2020({ allErrors: true, strict: false });
(addFormats as unknown as (target: Ajv2020) => void)(validator);

const validateUri = validator.compile({ format: 'uri', type: 'string' });
const validateEmail = validator.compile({ format: 'email', type: 'string' });

/** An absolute `http`/`https` URL the pinned schemas' `uri` format admits. */
export const isSchemaHttpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || !validateUri(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

/** An address the pinned schemas' `email` format admits. */
export const isSchemaEmail = (value: unknown): value is string =>
  typeof value === 'string' && validateEmail(value) === true;

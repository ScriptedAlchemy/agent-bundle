import { serializeRuntimeDefinition } from '../build/serialize-definition.js';
import { canonicalJson } from './canonical-json.js';

process.stdout.write(`${canonicalJson(serializeRuntimeDefinition())}\n`);

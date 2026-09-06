/**
 * Browser-consumable contract surface for served skill documents. Type-only:
 * the document service reads from disk on the server.
 */
export type {
  ServedSkillDocument,
  ServedStaticDocument,
  SkillDocumentBase,
  SkillDocumentResource,
  SkillDocumentTree,
  StaticDocumentKind,
  StaticDocumentProjection,
} from '../dev/skill-document-service.ts';

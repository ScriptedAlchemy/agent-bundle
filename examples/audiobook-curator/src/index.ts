export { auditAudiobook, inspectSources, prepareAudiobook } from './curator-core.js';
export {
  audibleCandidateEvidence,
  cacheAudibleEdition,
  defaultCuratorHttpClient,
  searchAudible,
  selectAudibleEdition,
} from './audible.js';
export type {
  AudibleCacheInput,
  AudibleCacheReceipt,
  AudibleCandidate,
  AudibleCandidateEvidence,
  AudibleDependencies,
  AudibleQuery,
  AudibleRegion,
  AudibleSearchInput,
  AudibleSearchReceipt,
  AudibleSelectionReceipt,
  CuratorHttpClient,
  CuratorHttpOptions,
} from './audible.js';
export type {
  AudioProbe,
  AuditInput,
  AuditReceipt,
  CuratorDependencies,
  InspectedAudioFile,
  InspectionReceipt,
  PrepareInput,
  PrepareReceipt,
} from './curator-core.js';
export { runMediaProcess } from './media-process.js';
export type { MediaProcess, MediaProcessOptions, MediaProcessResult } from './media-process.js';
export {
  applyAudiobookChapters,
  applyAudiobookMetadata,
  chapterRowsFromPayload,
  cleanCatalogText,
} from './media-mutation.js';
export type {
  ChapterInput,
  ChapterReceipt,
  MediaMutationDependencies,
  MetadataInput,
  MetadataReceipt,
} from './media-mutation.js';
export { audiobookCuratorApplication, createAudiobookCuratorApplication } from './application.js';
export type { AudiobookCuratorOperations } from './application.js';
export {
  alacChunkCounts,
  chapterMappingIssues,
  chapterRows,
  convertAudiobook,
  resolveJobs,
  uniformAudioProperties,
} from './conversion.js';
export type {
  ChapterRow,
  ConversionDependencies,
  ConvertInput,
  ConvertReceipt,
} from './conversion.js';
export {
  CuratorError,
  audioExtensions,
  audibleHosts,
  naturalCompare,
  normalizedIdentity,
  protectReceiptPath,
  readJson,
  safeFilename,
  utcNow,
  writeReceipt,
} from './foundation.js';
export {
  identifyAudibleSample,
  verifyAudibleSample,
  verifyWithWhisper,
  whisperSamplingFractions,
  whisperText,
} from './evidence.js';
export type {
  AcousticIdentifyInput,
  AcousticIdentifyReceipt,
  AcousticMatchOptions,
  AcousticMatcher,
  AcousticReceipt,
  AcousticVerifyInput,
  EvidenceDependencies,
  WhisperInput,
  WhisperReceipt,
  WhisperWindow,
} from './evidence.js';
export {
  auditLibrary,
  createInventory,
  probeMediaDetails,
  probeMediaRecord,
  qualityScore,
  selectInventorySources,
} from './library.js';
export type {
  InventoryReceipt,
  LibraryAuditFile,
  LibraryAuditReceipt,
  LibraryDependencies,
  MediaDetails,
  MediaRecord,
  SelectionReceipt,
  SelectionRow,
} from './library.js';

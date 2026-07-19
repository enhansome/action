export {
  classifyKind,
  classifyRepo,
  COMPILE_PRODUCT_MANIFESTS,
  countAnchors,
  createRepoLookup,
  decideClassification,
  DEFAULT_CLASSIFIER_CONFIG,
  isAwesomeListName,
  isCompileProductRepo,
  parseAwesomeMembers,
  REGISTRY_CONFIRM_MIN_OUTBOUND,
  REGISTRY_CONTENT_BACKSTOP_DISTINCT,
  REGISTRY_CONTENT_BACKSTOP_LINKS,
  REGISTRY_NAME_BREADTH_MIN,
} from './classify.js';
export type {
  AnchorCounts,
  Classification,
  ClassifierConfig,
  GateScope,
  Kind,
  RegistrySignal,
  RepoLookup,
  RepoLookupOptions,
  RepoRef,
} from './classify.js';
export {
  formatRequestError,
  getRepoInfo,
  getRootEntryNames,
  makeOctokit,
  parseGitHubUrl,
  parseOwnerRepo,
} from './github.js';
export type {
  GithubClient,
  RepoIdentifier,
  RepoInfoDetails,
} from './github.js';
export type { Logger } from './logger.js';
export { consoleLog, silentLog } from './logger.js';
export {
  classifySource,
  decideSourceClassification,
  DEFAULT_SOURCE_CLASSIFIER_CONFIG,
  REGISTRY_MIN_LINKS,
  toRepoInfo,
} from './markdown.js';
export type {
  JsonGroup,
  JsonItem,
  JsonMetadata,
  JsonNode,
  JsonOutput,
  JsonSection,
  ReplacementRule,
  RepoInfo,
  SourceClassifierConfig,
} from './markdown.js';
export { enhance } from './orchestrator.js';
export type { EnhanceOptions, EnhanceResult } from './orchestrator.js';

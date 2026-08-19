import { Logger } from './logger.js';
import {
  JsonOutput,
  processMarkdownContent,
  ReplacementRule,
  SortOptions,
} from './markdown.js';

export interface EnhanceOptions {
  content: string;
  disableBranding?: boolean;
  enhancedRepository?: string;
  enhancedRepositoryDescription?: string;
  /** Defaults to the console sink; pass your own (e.g. an Actions workflow-command sink) to route diagnostics. */
  log?: Logger;
  now?: Date;
  originalRepository: string;
  originalRepositoryId?: number;
  originalRepositorySha?: string;
  relativeLinkPrefix?: string;
  /** Text substitutions applied to the source before it is parsed. */
  replacements?: ReplacementRule[];
  sortBy?: '' | 'last_commit' | 'stars';
  token: string;
}

export interface EnhanceResult {
  finalContent: string;
  jsonData: JsonOutput;
}

export async function enhance(options: EnhanceOptions): Promise<EnhanceResult> {
  const {
    content,
    disableBranding = false,
    log,
    now = new Date(),
    originalRepository,
    originalRepositoryId,
    originalRepositorySha,
    relativeLinkPrefix = '',
    replacements = [],
    sortBy = '',
    enhancedRepository,
    enhancedRepositoryDescription,
    token,
  } = options;

  // Branding is an internal rule prepended to the caller's own; build a fresh
  // array so the caller's `replacements` is never mutated.
  const branding: ReplacementRule = { type: 'branding' };
  const rules = disableBranding ? replacements : [branding, ...replacements];

  const sortOptions: SortOptions = {
    by: sortBy,
    minLinks: 2,
  };

  const { finalContent, jsonData } = await processMarkdownContent(
    content,
    token,
    rules,
    sortOptions,
    originalRepository,
    relativeLinkPrefix,
    enhancedRepository,
    enhancedRepositoryDescription,
    originalRepositorySha,
    originalRepositoryId,
    now,
    log,
  );

  return {
    finalContent,
    jsonData,
  };
}

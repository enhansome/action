import { Logger } from './logger.js';
import type { RepoInfoDetails } from './github.js';
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
  log?: Logger;
  now?: Date;
  originalRepositoryInfo?: null | RepoInfoDetails;
  originalRepositorySha?: string;
  previousJson?: JsonOutput;
  relativeLinkPrefix?: string;
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
    originalRepositoryInfo,
    originalRepositorySha,
    previousJson,
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
    relativeLinkPrefix,
    enhancedRepository,
    enhancedRepositoryDescription,
    originalRepositorySha,
    originalRepositoryInfo,
    previousJson,
    now,
    log,
  );

  return {
    finalContent,
    jsonData,
  };
}

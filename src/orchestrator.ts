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
  findAndReplaceRaw?: string;
  originalRepository: string;
  originalRepositorySha?: string;
  regexFindAndReplaceRaw?: string;
  relativeLinkPrefix?: string;
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
    findAndReplaceRaw = '',
    originalRepository,
    originalRepositorySha,
    regexFindAndReplaceRaw = '',
    relativeLinkPrefix = '',
    sortBy = '',
    enhancedRepository,
    enhancedRepositoryDescription,
    token,
  } = options;

  const rules = parseReplacementRules(
    findAndReplaceRaw,
    regexFindAndReplaceRaw,
  );

  if (!disableBranding) {
    rules.unshift({ type: 'branding' });
  }

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
  );

  return {
    finalContent,
    jsonData,
  };
}

function parseReplacementRules(
  findAndReplaceRaw: string,
  regexFindAndReplaceRaw: string,
): ReplacementRule[] {
  const rules: ReplacementRule[] = [];
  const separator = ':::';

  if (findAndReplaceRaw) {
    findAndReplaceRaw
      .split('\n')
      .filter(line => line.trim() && line.includes(separator))
      .forEach(line => {
        const [find, ...rest] = line.split(separator);
        rules.push({
          find,
          replace: rest.join(separator),
          type: 'literal',
        });
      });
  }

  if (regexFindAndReplaceRaw) {
    regexFindAndReplaceRaw
      .split('\n')
      .filter(line => line.trim() && line.includes(separator))
      .forEach(line => {
        const [find, ...rest] = line.split(separator);
        rules.push({
          find,
          replace: rest.join(separator),
          type: 'regex',
        });
      });
  }

  return rules;
}

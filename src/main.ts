import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  enhance,
  getLatestCommitSha,
  getReadme,
  getRepoInfoOrNull,
  type JsonOutput,
  makeOctokit,
  parseOwnerRepo,
  type ReplacementRule,
} from '@enhansome/core';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { actionsLog } from './actions-log.js';

export async function run(): Promise<void> {
  try {
    const token = core.getInput('github_token');
    if (!token) {
      core.warning(
        'No github_token provided; fetching metadata anonymously (rate-limited).',
      );
    }
    const markdownFile = core.getInput('markdown_file');
    const jsonOutputFile = core.getInput('json_output_file');
    const findAndReplaceRaw = core.getInput('find_and_replace');
    const regexFindAndReplaceRaw = core.getInput('regex_find_and_replace');
    const disableBranding = core.getInput('disable_branding') === 'true';
    const sortBy = core.getInput('sort_by') as '' | 'last_commit' | 'stars';
    const relativeLinkPrefix = core.getInput('relative_link_prefix');
    const originalRepository = core.getInput('original_repository');

    if (!markdownFile) {
      core.warning('No markdown file specified to process.');
      return;
    }

    // The action always fetches the source list over the API:
    // `original_repository` is required and `markdown_file` is the output path.
    const parsed = parseOwnerRepo(originalRepository);
    if (!parsed) {
      core.setFailed(
        `original_repository is required and must be "owner/repo" or a github.com URL (got: "${originalRepository}").`,
      );
      return;
    }

    core.info(`Fetching source README from ${parsed.owner}/${parsed.repo}`);
    const octokit = makeOctokit(token, { log: actionsLog });
    const [readme, originalRepositorySha, originalRepositoryInfo] =
      await Promise.all([
        getReadme(octokit, parsed.owner, parsed.repo),
        getLatestCommitSha(octokit, parsed.owner, parsed.repo),
        getRepoInfoOrNull(octokit, parsed.owner, parsed.repo),
      ]);
    // getReadme throws on failure (strict mode); the top-level catch surfaces
    // it via setFailed, so there is no null branch to handle.
    if (originalRepositorySha === null) {
      core.warning(
        `Could not determine the latest commit SHA for ${parsed.owner}/${parsed.repo}; it will be omitted from the JSON output.`,
      );
    }
    if (originalRepositoryInfo === null) {
      core.warning(
        `Could not determine the repo info for ${parsed.owner}/${parsed.repo}; the repo id and info will be omitted from the JSON output.`,
      );
    }
    const originalContent = readme;

    const { repo } = github.context;
    const enhancedRepository = `${repo.owner}/${repo.repo}`;
    const enhancedRepositoryDescription =
      (github.context.payload.repository?.description as string | undefined) ??
      '';

    const replacements = parseReplacementRules(
      findAndReplaceRaw,
      regexFindAndReplaceRaw,
    );

    // Read before the overwrite: the previous output carries first_seen.
    let fullJsonPath: string | undefined;
    if (jsonOutputFile) {
      fullJsonPath =
        jsonOutputFile.toLowerCase() === 'auto'
          ? `${path.basename(markdownFile, path.extname(markdownFile))}.json`
          : jsonOutputFile;
    }
    const previousJson = fullJsonPath
      ? await readPreviousJson(fullJsonPath)
      : undefined;

    const result = await enhance({
      content: originalContent,
      disableBranding,
      originalRepositoryInfo: originalRepositoryInfo ?? undefined,
      originalRepositorySha: originalRepositorySha ?? undefined,
      previousJson,
      replacements,
      relativeLinkPrefix,
      sortBy,
      enhancedRepository,
      enhancedRepositoryDescription,
      token,
      log: actionsLog,
    });

    if (fullJsonPath) {
      const outputDir = path.dirname(fullJsonPath);
      await fs.mkdir(outputDir, { recursive: true });

      await fs.writeFile(
        fullJsonPath,
        JSON.stringify(result.jsonData, null, 2),
        'utf-8',
      );
      core.info(
        `Successfully generated user-requested JSON file at ${fullJsonPath}`,
      );
    }

    // `markdown_file` is the output path; the badged source always differs from
    // upstream, so write unconditionally.
    await fs.writeFile(markdownFile, result.finalContent, 'utf-8');
    core.info(`Successfully wrote ${markdownFile}.`);

    core.info('Process finished.');
  } catch (error: unknown) {
    if (error instanceof Error) {
      core.setFailed(`Action failed with error: ${error.message}`);
    } else {
      core.setFailed(`Action failed with an unknown error: ${error}`);
    }
  }
}

async function readPreviousJson(
  fullJsonPath: string,
): Promise<JsonOutput | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(fullJsonPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      core.warning(
        `Could not read previous JSON at ${fullJsonPath}: ${error instanceof Error ? error.message : error}`,
      );
    }
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    core.warning(
      `Previous JSON at ${fullJsonPath} is not parseable; first_seen starts fresh. (${error instanceof Error ? error.message : error})`,
    );
    return undefined;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as { items?: unknown }).items)
  ) {
    core.warning(
      `Previous JSON at ${fullJsonPath} is not an enhansomed output; first_seen starts fresh.`,
    );
    return undefined;
  }
  return value as JsonOutput;
}

/**
 * Parses the `find_and_replace` / `regex_find_and_replace` Actions inputs — each
 * a newline-separated list of `find:::replace` lines — into the structured
 * `ReplacementRule[]` the library consumes. Lives here, at the Actions-input
 * boundary, so the library API takes structured rules directly.
 */
export function parseReplacementRules(
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

// Only auto-run when invoked directly (e.g. `node dist/main.js`), not when
// imported by the unit tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void run();
}

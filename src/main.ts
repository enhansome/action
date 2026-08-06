import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

import type { ReplacementRule } from './markdown.js';

import { actionsLog } from './actions-log.js';
import {
  getLatestCommitSha,
  getReadme,
  makeOctokit,
  parseOwnerRepo,
} from './github.js';
import { enhance } from './orchestrator.js';

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
    const [readme, originalRepositorySha] = await Promise.all([
      getReadme(octokit, parsed.owner, parsed.repo),
      getLatestCommitSha(octokit, parsed.owner, parsed.repo),
    ]);
    // getReadme throws on failure (strict mode); the top-level catch surfaces
    // it via setFailed, so there is no null branch to handle.
    if (originalRepositorySha === null) {
      core.warning(
        `Could not determine the latest commit SHA for ${parsed.owner}/${parsed.repo}; it will be omitted from the JSON output.`,
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

    const result = await enhance({
      content: originalContent,
      disableBranding,
      originalRepository,
      originalRepositorySha: originalRepositorySha ?? undefined,
      replacements,
      relativeLinkPrefix,
      sortBy,
      enhancedRepository,
      enhancedRepositoryDescription,
      token,
      log: actionsLog,
    });

    if (jsonOutputFile) {
      let fullJsonPath: string;

      if (jsonOutputFile.toLowerCase() === 'auto') {
        const baseName = path.basename(
          markdownFile,
          path.extname(markdownFile),
        );
        fullJsonPath = `${baseName}.json`;
      } else {
        fullJsonPath = jsonOutputFile;
      }

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

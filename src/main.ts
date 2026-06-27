import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
  getLatestCommitSha,
  getReadme,
  makeOctokit,
  parseOwnerRepo,
} from './github.js';
import { enhance } from './orchestrator.js';

export async function run(): Promise<void> {
  try {
    // 1. Get all inputs from the GitHub Actions environment
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

    // 2. The action always fetches the source list over the API:
    // `original_repository` is required and `markdown_file` is the output path.
    const parsed = parseOwnerRepo(originalRepository);
    if (!parsed) {
      core.setFailed(
        `original_repository is required and must be "owner/repo" or a github.com URL (got: "${originalRepository}").`,
      );
      return;
    }

    core.info(`Fetching source README from ${parsed.owner}/${parsed.repo}`);
    const octokit = makeOctokit(token);
    const [readme, originalRepositorySha] = await Promise.all([
      getReadme(octokit, parsed.owner, parsed.repo),
      getLatestCommitSha(octokit, parsed.owner, parsed.repo),
    ]);
    if (readme === null) {
      core.setFailed(`No README found in ${parsed.owner}/${parsed.repo}`);
      return;
    }
    if (originalRepositorySha === null) {
      core.warning(
        `Could not determine the latest commit SHA for ${parsed.owner}/${parsed.repo}; it will be omitted from the JSON output.`,
      );
    }
    const originalContent = readme;

    // 3. Call the pure orchestrator function with all the data
    const { repo } = github.context;
    const enhancedRepository = `${repo.owner}/${repo.repo}`;
    const enhancedRepositoryDescription =
      (github.context.payload.repository?.description as string | undefined) ??
      '';

    const result = await enhance({
      content: originalContent,
      disableBranding,
      findAndReplaceRaw,
      originalRepository,
      originalRepositorySha: originalRepositorySha ?? undefined,
      regexFindAndReplaceRaw,
      relativeLinkPrefix,
      sortBy,
      enhancedRepository,
      enhancedRepositoryDescription,
      token,
    });

    // 4. Optionally, save a copy of the JSON data based on user's input
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

    // 5. Write the markdown output. `markdown_file` is the output path and the
    // badged source always differs from upstream, so write unconditionally.
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

// Only auto-run when invoked directly (e.g. `node dist/main.js`), not when
// imported by the unit tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void run();
}

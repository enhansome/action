// Path rules for following a README's links into other markdown files of the
// SAME repo — the "content moved out of the README" shape (android-root moved
// 600+ entries into docs/apps-and-modules/*.md and left a landing page).
// Pure string/path logic only; fetching and AST splicing live in markdown.ts.

/** Bounds for one follow run: files fetched, and bytes per file. */
export const MAX_FOLLOWED_FILES = 50;
export const MAX_FOLLOWED_FILE_BYTES = 1_000_000;

const MARKDOWN_EXT = /\.(md|markdown)$/i;

// Repo-convention meta documents. Only honored at the repo root and under
// .github/ — elsewhere a same-named file is content: android-root's
// docs/apps-and-modules/security.md is the Security category, and a basename
// rule would silently drop it.
const META_BASENAMES = new Set([
  'acknowledgements',
  'acknowledgments',
  'authors',
  'changes',
  'changelog',
  'citation',
  'code of conduct',
  'code_of_conduct',
  'code-of-conduct',
  'conduct',
  'contributing',
  'contributors',
  'funding',
  'history',
  'issue_template',
  'license',
  'licence',
  'notice',
  'pull_request_template',
  'security',
  'support',
  'todo',
]);

// The root README and its translations/self-links are alternate views of the
// document being enhanced, never additional content — inlining one would
// duplicate the whole list. Directory READMEs (pages/RISH.md aside,
// CLI/README.md shapes) are content and stay followable.
const ROOT_README = /^readme[^/]*\.(md|markdown)$/i;

function baseName(path: string): string {
  const tail = path.slice(path.lastIndexOf('/') + 1);
  const dot = tail.lastIndexOf('.');
  return (dot > 0 ? tail.slice(0, dot) : tail).toLowerCase();
}

/** True for a resolved repo path that must never be followed or inlined. */
export function isSkippedPath(path: string): boolean {
  if (!MARKDOWN_EXT.test(path)) {
    return true;
  }
  if (!path.includes('/')) {
    return ROOT_README.test(path) || META_BASENAMES.has(baseName(path));
  }
  return path.startsWith('.github/') && META_BASENAMES.has(baseName(path));
}

/**
 * Resolves one link target against the referring document's directory.
 * Accepts repo-relative (`docs/x.md`), referring-file-relative
 * (`../guides/y.md`) and repo-root-absolute (`/x.md`) forms. Returns null for
 * anything that is not an in-repo path: external URLs, anchors, non-markdown
 * files, or `..` escaping the repo root.
 */
export function resolveRepoPath(target: string, baseDir: string): null | string {
  const stripped = target.split('#')[0].split('?')[0].trim();
  if (!stripped || stripped.includes('://') || stripped.startsWith('mailto:')) {
    return null;
  }
  const segments = (stripped.startsWith('/') ? [] : baseDir.split('/')).concat(
    stripped.split('/'),
  );
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (stack.length === 0) {
        return null;
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.length > 0 ? stack.join('/') : null;
}

/**
 * Extracts the in-repo markdown path from a same-repo absolute GitHub URL
 * (`https://github.com/owner/repo/blob/main/docs/x.md`), or null for links to
 * any other host/repo.
 */
export function parseSameRepoBlobPath(
  url: string,
  owner: string,
  repo: string,
): null | string {
  const match =
    /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:blob|raw)\/[^/]+\/(.+)$/i.exec(
      url,
    );
  if (!match) {
    return null;
  }
  if (
    `${match[1]}/${match[2]}`.toLowerCase() !== `${owner}/${repo}`.toLowerCase()
  ) {
    return null;
  }
  return decodeURIComponent(match[3]);
}

/** True when a link's visible text is just a filename/path, not a category name. */
export function isFilenameLabel(label: string, path: string): boolean {
  const text = label.trim().toLowerCase();
  if (!text) {
    return true;
  }
  const file = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return (
    text === file ||
    text === path.toLowerCase() ||
    text.includes('/') ||
    MARKDOWN_EXT.test(text)
  );
}

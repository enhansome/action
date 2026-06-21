#!/bin/sh -l

set -e

# GITHUB_WORKSPACE is the default working directory in GitHub Actions
# INPUT_WORKING_DIRECTORY allows overriding this if files are elsewhere
TARGET_DIR="${GITHUB_WORKSPACE}/${INPUT_WORKING_DIRECTORY}"

echo "Running Star Enhancer..."
echo "Working Directory: ${TARGET_DIR}"
echo "Markdown File: ${INPUT_MARKDOWN_FILE}"

# Change to the target directory
cd "${TARGET_DIR}"

# Execute the Node.js script (compiled JavaScript)
# Pass environment variables as arguments if your script expects them that way,
# or ensure your script reads them directly using process.env.
# Here, main.js is expected to read process.env.INPUT_GITHUB_TOKEN and process.env.INPUT_MARKDOWN_FILE
node /app/dist/main.js

echo "Star enhancement process complete."
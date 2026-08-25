# Changelog

## [1.10.0](https://github.com/enhansome/action/compare/v1.9.0...v1.10.0) (2026-08-25)


### Features

* fall back from degenerate item titles to the link label or owner/name ([72d5c02](https://github.com/enhansome/action/commit/72d5c024bcf0a8186cc224dab40ab52b31c2dbd5))

## [1.9.0](https://github.com/enhansome/action/compare/v1.8.1...v1.9.0) (2026-08-24)


### Features

* emit blockquote cards and details sections (empty-tree step 5) ([0532a52](https://github.com/enhansome/action/commit/0532a52f64f184d3293fc7a8d2848624f74ba6d4))
* emit link-headings as items and gate one-entry sections by run (empty-tree step 6) ([1b3a694](https://github.com/enhansome/action/commit/1b3a694cd7268cba09180652d0aa5f4c06e1826d))
* emit paragraph entries (empty-tree step 4) ([74f0aa2](https://github.com/enhansome/action/commit/74f0aa21c1fc2f902eac980e892810e446dcac13))
* emit table rows as registry items (empty-tree step 3) ([ea8882b](https://github.com/enhansome/action/commit/ea8882ba962a3d331b849f674596ffb80a341139))
* implicit Overview section for containerless lists (empty-tree step 2) ([04f1993](https://github.com/enhansome/action/commit/04f19935d1c58c4b8ea6e778910721208d3eb349))
* minLinks gate per section + yield harness (empty-tree steps 0-1) ([65ad0a5](https://github.com/enhansome/action/commit/65ad0a5849c0f5d01e07d472bb44c7321b630641))
* normalize bare github.com text and inline html anchors into links (empty-tree step 8) ([4b8b387](https://github.com/enhansome/action/commit/4b8b3875bfb5442ac961938de8bea676ae3b2d84))
* resolve list-item own-link across all own paragraphs (empty-tree step 7) ([e0ed662](https://github.com/enhansome/action/commit/e0ed6623e7203427ce14a0caee2ced69f3745e51))

## [1.8.1](https://github.com/enhansome/action/compare/v1.8.0...v1.8.1) (2026-08-19)


### Bug Fixes

* emit original_repository_id in JSON metadata ([3a3a64e](https://github.com/enhansome/action/commit/3a3a64eb8d4862cd44b56e7cb4be9b86c3b24df3))

## [1.8.0](https://github.com/enhansome/action/compare/v1.7.1...v1.8.0) (2026-08-19)


### Features

* readme json tree-shape overhaul ([fbfc33c](https://github.com/enhansome/action/commit/fbfc33cdc9840e6d75862d1a800510baaeeccc65))


### Bug Fixes

* emit numeric GitHub id in repo_info ([552eafc](https://github.com/enhansome/action/commit/552eafc9d5a6d541d9f8a369f78343c853e7e3b6))

## [1.7.1](https://github.com/enhansome/action/compare/v1.7.0...v1.7.1) (2026-08-06)


### Bug Fixes

* **core:** add repository field for npm provenance ([60608f9](https://github.com/enhansome/action/commit/60608f97f985e69ef561c3bbf0c8470534dd547a))

## [1.7.0](https://github.com/enhansome/action/compare/v1.6.1...v1.7.0) (2026-08-06)


### Features

* split library into @enhansome/core workspace package ([#15](https://github.com/enhansome/action/issues/15)) ([9f4a323](https://github.com/enhansome/action/commit/9f4a3237322dc067774c32e85fbe83a63fc70fb3))

## [1.6.1](https://github.com/enhansome/action/compare/v1.6.0...v1.6.1) (2026-08-06)


### Bug Fixes

* expose octokit options ([3c98f2d](https://github.com/enhansome/action/commit/3c98f2d9e6d6f0f7795e96453b0c9e08ccb6a78a))

## [1.6.0](https://github.com/enhansome/action/compare/v1.5.1...v1.6.0) (2026-08-05)


### Features

* migrate to yarn ([3c58194](https://github.com/enhansome/action/commit/3c5819484f0f4d6332fc3867899ef6cb5e842115))

## [1.5.1](https://github.com/enhansome/action/compare/v1.5.0...v1.5.1) (2026-08-04)


### Bug Fixes

* export getReadme and getLatestCommitSha ([fc97f24](https://github.com/enhansome/action/commit/fc97f24441da418035a8a002b68f6bb5ca7eec4a))

## [1.5.0](https://github.com/enhansome/action/compare/v1.4.1...v1.5.0) (2026-08-04)


### Features

* remove classify ([97064a5](https://github.com/enhansome/action/commit/97064a5aa165b118fd40df32796930f335f87224))


### Bug Fixes

* refine classifier ([b931d62](https://github.com/enhansome/action/commit/b931d623baf3aee769999e74581c0d96e5a84f06))
* refine source classifier ([9108303](https://github.com/enhansome/action/commit/9108303b60d0ac5caf72cece96f2ea78466d80ba))

## [1.4.1](https://github.com/enhansome/action/compare/v1.4.0...v1.4.1) (2026-07-13)


### Bug Fixes

* self reference in classify source ([4f70d77](https://github.com/enhansome/action/commit/4f70d779d3d9138c5df93e2327d82e8d1f17a047))

## [1.4.0](https://github.com/enhansome/action/compare/v1.3.1...v1.4.0) (2026-07-12)


### Features

* lib ([417c248](https://github.com/enhansome/action/commit/417c248c4e3b24537b763d2c9553ade61f777c00))


### Bug Fixes

* case normalization ([b830120](https://github.com/enhansome/action/commit/b830120525c4a631ef4edd06147d31b0bc0146e5))
* default to console log ([7a5ccab](https://github.com/enhansome/action/commit/7a5ccabf1a92176803088f326cbbd9754fc7fc47))
* docs ([a1ca133](https://github.com/enhansome/action/commit/a1ca133628cbd8e6642cebf5be6927c95e0c7fb1))

## [1.3.1](https://github.com/enhansome/action/compare/v1.3.0...v1.3.1) (2026-07-11)


### Bug Fixes

* registry detection signal ([#7](https://github.com/enhansome/action/issues/7)) ([1d6fc6c](https://github.com/enhansome/action/commit/1d6fc6c758349e5451cca98764a0f6b90d425086))

## [1.3.0](https://github.com/enhansome/action/compare/v1.2.2...v1.3.0) (2026-07-10)


### Features

* item kinds ([#5](https://github.com/enhansome/action/issues/5)) ([99fe942](https://github.com/enhansome/action/commit/99fe942fb9ffdbf95fc7cee76b055bebdd099f91))

## [1.2.2](https://github.com/enhansome/action/compare/v1.2.1...v1.2.2) (2026-07-09)


### Bug Fixes

* golden tests expected json ([b28063d](https://github.com/enhansome/action/commit/b28063d66d3784f00f26203f0ff6e5a2dd7aa776))
* sort by stars by default ([8582633](https://github.com/enhansome/action/commit/85826330a01a61472d73f63ce06c4509fea104fd))

## [1.2.1](https://github.com/enhansome/action/compare/v1.2.0...v1.2.1) (2026-07-04)


### Bug Fixes

* brand title via AST and guarantee single H1 ([0da145a](https://github.com/enhansome/action/commit/0da145a3bbcd7cbf6c354350614f9fd96691a7a5))
* migrate to vite ([718a258](https://github.com/enhansome/action/commit/718a2586b6e68ce095ac56fdda49b8226c5a70f7))

## [1.2.0](https://github.com/enhansome/action/compare/v1.1.0...v1.2.0) (2026-06-27)


### Features

* enhance GitHub API interactions with Octokit and improve error handling ([89667c0](https://github.com/enhansome/action/commit/89667c01e0a65904348289a1e8cb209dd03228ad))

## [1.1.0](https://github.com/enhansome/action/compare/v1.0.0...v1.1.0) (2026-06-27)


### Features

* add release and test workflows ([e7eb17e](https://github.com/enhansome/action/commit/e7eb17eccde072ccd857c41b5f1072ce46c818ce))

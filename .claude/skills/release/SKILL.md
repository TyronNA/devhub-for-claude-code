---
name: release
description: Ship a Dev Hub version — test, bump, CHANGELOG, commit, tag, push, package the .vsix and attach it to a GitHub release. Use when asked to "release", "ship it", "cut a version", "bump version" or "publish the vsix".
disable-model-invocation: true
---

# Release

Run every step in order from the repo root. Stop at the first failure and report the real output.

1. **Clean tree, on `main`, up to date.**
   `git status --short` must be empty apart from the release itself; `git pull --ff-only`.
2. **Tests pass.** `npm test` → `fail 0`.
3. **Bump.** Edit `version` in `package.json` (patch unless told otherwise).
4. **CHANGELOG.** New `## X.Y.Z — <short title>` section at the top: what broke or changed, and how
   it was proven. If it was only covered by tests and never opened in a real window, say so.
   `manifest.test.ts` fails if the shipped version has no section, so rerun `npm test`.
5. **Commit + tag.**
   `git commit -am "vX.Y.Z: <lowercase sentence about the actual change>"` then `git tag vX.Y.Z`.
6. **Push.** `git push && git push origin vX.Y.Z`, then wait for CI (`gh run watch`) to go green on
   both ubuntu and macos before publishing.
7. **Package.** `npm run package` → `dev-hub-claude-codex-X.Y.Z.vsix` at the repo root (gitignored).
8. **GitHub release.**
   `gh release create vX.Y.Z dev-hub-claude-codex-X.Y.Z.vsix --title vX.Y.Z --notes "<the CHANGELOG section>"`
9. **Verify.** `gh release view vX.Y.Z` lists the `.vsix` asset. Optionally install it:
   `code --install-extension dev-hub-claude-codex-X.Y.Z.vsix --force`, then **Developer: Reload Window**.

Never force-push `main` or move an existing tag — people may already have installed that version.

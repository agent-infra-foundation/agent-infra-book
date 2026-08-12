# Source-built Computer package

The benchmark does not copy or reimplement Cloudflare Computer's VFS.
`scripts/prepare-computer.ps1` exports the pinned Git commit into an isolated
temporary directory, builds the official `@cloudflare/computer` workspace, and
places its npm package tarball here.

The tarball is ignored by Git. `PROVENANCE.json` records its source commit,
package version, and SHA-256 digest.


# pi-file-tools

Linux-only filesystem mutation tools for the [pi](https://github.com/earendil-works/pi-coding-agent) coding agent. The extension registers `rename`, `delete`, `copy`, and `mkdir` without shelling out.

All paths are resolved relative to pi's active working directory. A leading `@` is accepted and normalized (for example, `@src/file`); empty and control-character paths are rejected (C0, DEL, and Unicode C1 controls U+0080–U+009F). Destination parents are never created implicitly. Results include readable text and structured `details`.

## Tool semantics

- **`rename`** moves a file, symlink, or directory to the exact destination. Existing destinations require `overwrite: true`; directory moves into their own descendants are rejected. Overwriting the filesystem root, home directory, active working directory, or any real directory containing them is refused, as is any overwrite that would replace a directory with a file or symlink (or vice versa).
- **`delete`** permanently removes a file or symlink, or an empty directory. A non-empty directory requires `recursive: true`; missing paths, the filesystem root, home directory, active working directory, and any real directory containing the home or active working directory are refused. Abort signals are checked before mutation; Node's recursive `fs.rm` cannot be cancelled safely once deletion starts.
- **`copy`** copies a regular file, symlink, or directory to the exact destination while preserving symlinks and source permission bits. Special filesystem entries are rejected. Directories require `recursive: true`, and existing destinations require `overwrite: true` (refused for the same protected destinations and kind-mismatched replacements as `rename`). Overwrites are staged in a temporary sibling and swapped only after the copy succeeds, preserving the old destination if staging fails. Abort signals are checked before mutation and between recursive entries.
- **`mkdir`** creates a directory and missing parents by default (`recursive: true`). It reports whether the directory was newly created or already existed and rejects an existing non-directory.

Mutations use pi's `withFileMutationQueue`; each operation acquires its lexical and canonical ancestor chains (bounded by the active cwd when applicable) in deterministic order, so source/destination and parent traversals serialize safely. Lock keys are re-resolved as they are acquired; if a concurrent mutation redirects a parent so two keys converge on one queue slot, the operation fails explicitly instead of deadlocking.

## Permission-system integration

When the `@gotgenes/pi-permission-system` extension is installed, the `rename` and `copy` tools declare their destination paths to it (via `registerToolAccessExtractor` on the `permissions:ready` broadcast), so the cross-cutting `path` rules and the `external_directory` outside-CWD boundary apply to them like they do to the built-in file tools. `delete` and `mkdir` are covered by convention because their input is `input.path`. A single path is declared per tool — the destination — which is the path whose write crosses the working-directory boundary; the source path is not separately gated (`rename .env` out of a project is not caught by a source-path rule). Without the permission system installed, pi-file-tools works standalone and the registration is skipped.

## Development

```bash
npm install
npm run typecheck
npm run check
npm run check:fix
npm run format
npm run test
```

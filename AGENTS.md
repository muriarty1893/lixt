# lixt — agent guide

Local-first YouTube video library. Tauri v2 + Rust + React + Tailwind v4 + shadcn/ui.

## Commands

- `pnpm install` — install workspace deps
- `pnpm tauri dev` — run the desktop app (Vite dev server + Tauri window)
- `pnpm build` — frontend typecheck (`tsc --noEmit`) + Vite production build
- `pnpm tsc --noEmit` — typecheck frontend only (fast loop)
- `cargo check` (run inside `src-tauri/`) — Rust quick check
- `pnpm tauri build` — produce a native binary in `src-tauri/target/release/lixt`

Run lint/typecheck before considering a frontend change done: `pnpm tsc --noEmit`.
For Rust changes, run `cargo check` (and `pnpm tauri build` for a real binary).

## System deps (Arch / Hyprland)

`webkit2gtk-4.1 libsoup3 gtk3 openssl` are required at runtime; `base-devel`
for the Rust build.

## Conventions

- Frontend: TypeScript strict, shadcn-style components live in
  `src/components/ui/` and are pure presentational primitives — do not import
  the Rust API there. App logic, `invoke` wrappers and DTOs live in
  `src/lib/api.ts` and `src/types.ts`.
- All SQLite / network / filesystem access is in Rust (`src-tauri/src/lib.rs`).
  Frontend never touches the disk; it receives base64 thumbnails via
  `read_thumbnail_blob`.
- When adding a Tauri command, also export it from `src/lib/api.ts` and wire
  the call site explicitly.
- Comments: keep minimal; let types and names carry the meaning.
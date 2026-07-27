# lixt

A small local-first desktop app to save your YouTube videos by drag-and-drop.
Built with **Tauri v2 + Rust + React + TypeScript + Tailwind v4 + shadcn/ui**.
Single-user, SQLite-backed, optional thumbnail caching.

## What it does

- Drag a YouTube URL from your browser onto a playlist row in the sidebar →
  the link is saved (with title/channel fetched via YouTube oEmbed, thumbnail
  fetched from `img.youtube.com` and cached locally).
- Each video can belong to multiple playlists (many-to-many).
- Search by title, channel, URL, or youtube id.
- "Move to trash" removes a video and its cached thumbnail; the trash keeps the
  title / channel / link only — no thumbnail. Restore from trash or purge
  permanently.
- Click a video → opens its watch URL in a new browser window via `xdg-open`.

## System deps (Arch / Hyprland)

```sh
sudo pacman -S --needed webkit2gtk-4.1 libsoup3 gtk3 base-devel openssl file
```

Rust is installed via [rustup](https://rustup.rs) (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`).

## Run

```sh
pnpm install
pnpm tauri dev
```

## Build a native binary

```sh
pnpm tauri build
# binary: src-tauri/target/release/lixt
```

## Layout

- `src/`                 React + Tailwind frontend (shadcn-style UI primitives in `components/ui/`)
- `src/lib/api.ts`       TypeScript wrappers around `tauri::invoke`
- `src/types.ts`         shared DTOs
- `src-tauri/src/lib.rs` Tauri commands + SQLite + oEmbed/thumbnail fetch

## Schema (SQLite, in `~/.local/share/com.lixt.app/lixt.db`)

- `videos` (id, youtube_id UNIQUE, url, title, channel, thumbnail_path, added_at)
- `playlists` (id, name UNIQUE, created_at)
- `video_playlists` (video_id, playlist_id) — many-to-many
- `trash` (id, youtube_id UNIQUE, url, title, channel, deleted_at)

Thumbnails cached under `~/.local/share/com.lixt.app/thumbnails/<youtube_id>.jpg`.
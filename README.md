# lixt

A small local-first desktop app to save your YouTube videos by drag-and-drop.
Built with **Tauri v2 + Rust + React + TypeScript + Tailwind v4 + shadcn/ui**.
Single-user, SQLite-backed, optional thumbnail caching.

## What it does

- Drag a YouTube URL from your browser onto a **playlist row** in the sidebar →
  the link is saved (title + channel via YouTube oEmbed, thumbnail cached locally).
- Each video can belong to multiple playlists (many-to-many).
- **Drag-reorder** videos inside any view, and drag-reorder playlists in the sidebar.
- **Drag a video card onto another playlist row** in the sidebar to add it there too.
- Search by title, channel, URL, or youtube id.
- **Grid** or **List** view toggle (file-explorer style). List mode has a
  **compact** / **comfortable** density toggle.
- **Sort menu**: manual order, date added, title, channel, favorites first.
- **Click thumbnail or title** to open the video in your browser (`xdg-open`).
- **Right-click context menu** on any card: open, add to playlist, favorite,
  watched, remove from playlist, trash.
- **Keyboard navigation**: ↑/↓ move focus, Enter open, Delete/Backspace trash,
  Space toggle favorite.
- **Multi-select** (Ctrl/Shift-click) with bulk **Add to playlist…** and bulk **Trash**.
- **Favorite (star)** and **watched (eye)** toggles per video.
- **Duplicate detection**: dropping a URL you already saved pops a dialog asking
  whether to add it to the new playlist anyway.
- **Undo toast** for single-video trash (6-second undo → restores from trash).
- **Trash** keeps link + title + channel only (no thumbnail). Restore or purge
  permanently. Empty trash in one click.
- **Backup / Export** to a single `.json` bundle (videos, playlists, M2M links,
  trash, and base64-embedded thumbnails). **Import** restores everything.
- Relative time display ("3 days ago") under each video.
- Window-state, view-mode, density, and sort persist between runs.

## System deps (Arch / Hyprland)

```sh
sudo pacman -S --needed webkit2gtk-4.1 libsoup3 gtk3 base-devel openssl file
```

Rust via [rustup](https://rustup.rs):
```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

If `cargo` is not found, add it to PATH (fish):
```fish
fish_add_path ~/.cargo/bin
```

For the Wayland `Gdk-Message: Error 71 (Protocol error)` crash on first launch:
```fish
set -Ux WEBKIT_DISABLE_DMABUF_RENDERER 1
```

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

- `videos` (id, youtube_id UNIQUE, url, title, channel, thumbnail_path, added_at, position, is_favorite, is_watched)
- `playlists` (id, name UNIQUE, created_at, position)
- `video_playlists` (video_id, playlist_id, added_at, position) — many-to-many
- `trash` (id, youtube_id UNIQUE, url, title, channel, deleted_at)

Thumbnails cached under `~/.local/share/com.lixt.app/thumbnails/<youtube_id>.jpg`.
Schema migrations are idempotent `ALTER TABLE … ADD COLUMN` on app startup.

## Keyboard shortcuts (when not focused an input)

| Key | Action |
| --- | --- |
| ↑ / ↓ | Move focus between videos |
| Enter | Open focused video in browser |
| Delete / Backspace | Trash focused video (or all selected) |
| Space | Toggle favorite on focused video |
| Ctrl/Cmd/Shift + click | Toggle selection of a card |

DevTools are enabled in dev builds — right-click the window → Inspect Element.
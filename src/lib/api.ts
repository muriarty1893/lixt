import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { ExistingVideo, Playlist, TrashEntry, Video } from "@/types";

export async function addVideo(url: string, playlistIds: number[]): Promise<Video> {
  return invoke<Video>("add_video", { url, playlistIds });
}

export async function checkExisting(url: string): Promise<ExistingVideo | null> {
  return invoke<ExistingVideo | null>("check_existing", { url });
}

export async function listVideos(playlistId?: number, sort?: string): Promise<Video[]> {
  return invoke<Video[]>("list_videos", { playlistId: playlistId ?? null, sort: sort ?? null });
}

export async function searchVideos(query: string): Promise<Video[]> {
  return invoke<Video[]>("search_videos", { query });
}

export async function reorderVideos(playlistId: number | null, orderedIds: number[]): Promise<void> {
  return invoke<void>("reorder_videos", { playlistId, orderedVideoIds: orderedIds });
}

export async function listPlaylists(): Promise<Playlist[]> {
  return invoke<Playlist[]>("list_playlists");
}

export async function createPlaylist(name: string): Promise<Playlist> {
  return invoke<Playlist>("create_playlist", { name });
}

export async function renamePlaylist(id: number, name: string): Promise<void> {
  return invoke<void>("rename_playlist", { id, name });
}

export async function deletePlaylist(id: number): Promise<void> {
  return invoke<void>("delete_playlist", { id });
}

export async function reorderPlaylists(orderedIds: number[]): Promise<void> {
  return invoke<void>("reorder_playlists", { orderedIds });
}

export async function removeVideoFromPlaylist(videoId: number, playlistId: number): Promise<void> {
  return invoke<void>("remove_video_from_playlist", { videoId, playlistId });
}

export async function bulkAddToPlaylist(videoIds: number[], playlistId: number): Promise<void> {
  return invoke<void>("bulk_add_to_playlist", { videoIds, playlistId });
}

export async function trashVideo(videoId: number): Promise<void> {
  return invoke<void>("trash_video", { videoId });
}

export async function bulkTrash(videoIds: number[]): Promise<void> {
  return invoke<void>("bulk_trash", { videoIds });
}

export async function toggleFavorite(videoId: number): Promise<Video> {
  return invoke<Video>("toggle_favorite", { videoId });
}

export async function toggleWatched(videoId: number): Promise<Video> {
  return invoke<Video>("toggle_watched", { videoId });
}

export async function listTrash(): Promise<TrashEntry[]> {
  return invoke<TrashEntry[]>("list_trash");
}

export async function restoreFromTrash(youtubeId: string, playlistIds: number[]): Promise<void> {
  return invoke<void>("restore_from_trash", { youtubeId, playlistIds });
}

export async function purgeTrashEntry(youtubeId: string): Promise<void> {
  return invoke<void>("purge_trash_entry", { youtubeId });
}

export async function emptyTrash(): Promise<void> {
  return invoke<void>("empty_trash");
}

export async function readThumbnailBlob(path: string): Promise<string> {
  return invoke<string>("read_thumbnail_blob", { path });
}

export async function openUrl(url: string): Promise<void> {
  return invoke<void>("open_url", { url });
}

export async function exportBackup() {
  const path = await saveDialog({
    title: "Export lixt backup",
    defaultPath: "lixt-backup.json",
    filters: [{ name: "lixt backup", extensions: ["json"] }],
  });
  if (!path) return null;
  return invoke<number>("export_backup_to_path", { path });
}

export async function importBackup() {
  const paths = await openDialog({
    title: "Import lixt backup",
    multiple: false,
    filters: [{ name: "lixt backup", extensions: ["json"] }],
  });
  const path = Array.isArray(paths) ? paths[0] : paths;
  if (!path) return null;
  return invoke<number>("import_backup_from_path", { path });
}
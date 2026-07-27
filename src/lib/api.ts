import { invoke } from "@tauri-apps/api/core";
import type { Playlist, TrashEntry, Video } from "@/types";

export async function addVideo(url: string, playlistIds: number[]): Promise<Video> {
  return invoke<Video>("add_video", { url, playlistIds });
}

export async function listVideos(playlistId?: number): Promise<Video[]> {
  return invoke<Video[]>("list_videos", { playlistId: playlistId ?? null });
}

export async function searchVideos(query: string): Promise<Video[]> {
  return invoke<Video[]>("search_videos", { query });
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

export async function removeVideoFromPlaylist(videoId: number, playlistId: number): Promise<void> {
  return invoke<void>("remove_video_from_playlist", { videoId, playlistId });
}

export async function trashVideo(videoId: number): Promise<void> {
  return invoke<void>("trash_video", { videoId });
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
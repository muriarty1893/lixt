export interface Video {
  id: number;
  youtube_id: string;
  url: string;
  title: string;
  channel: string;
  thumbnail_path: string | null;
  added_at: number;
  is_favorite: boolean;
  is_watched: boolean;
}

export interface Playlist {
  id: number;
  name: string;
  created_at: number;
}

export interface TrashEntry {
  id: number;
  youtube_id: string;
  url: string;
  title: string;
  channel: string;
  deleted_at: number;
}

export interface ExistingVideo {
  video: Video;
  playlist_ids: number[];
  playlist_names: string[];
}
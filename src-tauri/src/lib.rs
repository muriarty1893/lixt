use std::path::PathBuf;
use std::sync::Mutex;
use base64::{engine::general_purpose::STANDARD, Engine};
use once_cell::sync::Lazy;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::Manager;

static DB: Lazy<Mutex<Option<Connection>>> = Lazy::new(|| Mutex::new(None));

// ───── types ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Video {
    pub id: i64,
    pub youtube_id: String,
    pub url: String,
    pub title: String,
    pub channel: String,
    pub thumbnail_path: Option<String>,
    pub added_at: i64,
    pub is_favorite: bool,
    pub is_watched: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TrashEntry {
    pub id: i64,
    pub youtube_id: String,
    pub url: String,
    pub title: String,
    pub channel: String,
    pub deleted_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ExistingVideo {
    pub video: Video,
    pub playlist_ids: Vec<i64>,
    pub playlist_names: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct BackupBundle {
    pub version: i64,
    pub videos: Vec<Video>,
    pub playlists: Vec<Playlist>,
    pub video_playlists: Vec<(i64, i64)>,
    pub trash: Vec<TrashEntry>,
    pub thumbnails: Vec<ThumbnailBlob>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ThumbnailBlob {
    pub youtube_id: String,
    pub base64: String,
}

// ───── db path ─────────────────────────────────────────────────────────────────

fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().expect("no app data dir");
    std::fs::create_dir_all(&dir).ok();
    dir
}

fn db_path(app: &tauri::AppHandle) -> PathBuf {
    data_dir(app).join("lixt.db")
}

fn thumb_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = data_dir(app).join("thumbnails");
    std::fs::create_dir_all(&dir).ok();
    dir
}

fn add_column_if_missing(conn: &Connection, table: &str, col: &str, decl: &str) {
    let sql = format!("PRAGMA table_info({})", table);
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return,
    };
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .ok()
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default();
    if !cols.iter().any(|c| c == col) {
        let _ = conn.execute(&format!("ALTER TABLE {} ADD COLUMN {} {}", table, col, decl), []);
    }
}

fn init_db(app: &tauri::AppHandle) -> Connection {
    let path = db_path(app);
    let conn = Connection::open(path).expect("open db");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            youtube_id TEXT NOT NULL UNIQUE,
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            channel TEXT NOT NULL,
            thumbnail_path TEXT,
            added_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS playlists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS video_playlists (
            video_id INTEGER NOT NULL,
            playlist_id INTEGER NOT NULL,
            added_at INTEGER NOT NULL,
            PRIMARY KEY (video_id, playlist_id),
            FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
            FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS trash (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            youtube_id TEXT NOT NULL UNIQUE,
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            channel TEXT NOT NULL,
            deleted_at INTEGER NOT NULL
        );",
    )
    .expect("init schema");
    add_column_if_missing(&conn, "videos", "position", "INTEGER NOT NULL DEFAULT 0");
    add_column_if_missing(&conn, "videos", "is_favorite", "INTEGER NOT NULL DEFAULT 0");
    add_column_if_missing(&conn, "videos", "is_watched", "INTEGER NOT NULL DEFAULT 0");
    add_column_if_missing(&conn, "playlists", "position", "INTEGER NOT NULL DEFAULT 0");
    add_column_if_missing(&conn, "video_playlists", "position", "INTEGER NOT NULL DEFAULT 0");
    conn
}

// ───── youtube url parsing ─────────────────────────────────────────────────────

fn parse_youtube_id(input: &str) -> Option<(String, String)> {
    let trimmed = input.trim();
    if trimmed.len() == 11 && !trimmed.contains('/') && !trimmed.contains('.') {
        return Some((trimmed.to_string(), format!("https://www.youtube.com/watch?v={}", trimmed)));
    }
    let url = url::Url::parse(trimmed).ok()?;
    let host = url.host_str()?.to_lowercase();
    let is_yt = host.ends_with("youtube.com") || host == "youtu.be" || host.ends_with("youtube-nocookie.com");
    if !is_yt {
        return None;
    }
    if host == "youtu.be" {
        let id = url.path().trim_start_matches('/').to_string();
        if id.len() == 11 {
            return Some((id.clone(), format!("https://www.youtube.com/watch?v={}", id)));
        }
        return None;
    }
    if let Some(segs) = url.path_segments() {
        let segs: Vec<&str> = segs.collect();
        if segs.len() == 2 && segs[0] == "shorts" && segs[1].len() == 11 {
            let id = segs[1].to_string();
            return Some((id.clone(), format!("https://www.youtube.com/watch?v={}", id)));
        }
        if segs.len() == 2 && segs[0] == "embed" && segs[1].len() == 11 {
            let id = segs[1].to_string();
            return Some((id.clone(), format!("https://www.youtube.com/watch?v={}", id)));
        }
    }
    for (k, v) in url.query_pairs() {
        if k == "v" && v.len() == 11 {
            let id = v.to_string();
            return Some((id.clone(), format!("https://www.youtube.com/watch?v={}", id)));
        }
    }
    None
}

// ───── oembed + thumbnail ──────────────────────────────────────────────────────

#[derive(Deserialize)]
struct OEmbed {
    title: Option<String>,
    author_name: Option<String>,
}

async fn fetch_thumbnail(client: &reqwest::Client, youtube_id: &str, dest: PathBuf) -> Result<(), String> {
    for quality in &["hqdefault", "mqdefault", "default"] {
        let url = format!("https://img.youtube.com/vi/{}/{}.jpg", youtube_id, quality);
        let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
            tokio::fs::write(&dest, &bytes).await.map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    Err("all thumbnail qualities failed".to_string())
}

// ───── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
fn add_video(
    app: tauri::AppHandle,
    url: String,
    playlist_ids: Vec<i64>,
) -> Result<Video, String> {
    let (youtube_id, canonical_url) = parse_youtube_id(&url).ok_or("not a youtube url".to_string())?;

    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db not initialised");

    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM videos WHERE youtube_id = ?1",
            params![&youtube_id],
            |r| r.get(0),
        )
        .ok();

    if let Some(id) = existing {
        for pid in &playlist_ids {
            conn.execute(
                "INSERT OR IGNORE INTO video_playlists (video_id, playlist_id, added_at) VALUES (?1, ?2, ?3)",
                params![id, pid, now_ts()],
            )
            .ok();
        }
        return Ok(get_video(conn, id).unwrap());
    }

    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    let oembed = runtime
        .block_on(async {
            let client = reqwest::Client::builder()
                .user_agent("lixt/0.1")
                .timeout(std::time::Duration::from_secs(12))
                .build();
            let client = match client {
                Ok(c) => c,
                Err(e) => return Err(e.to_string()),
            };
            let resp = match client
                .get("https://www.youtube.com/oembed")
                .query(&[("url", canonical_url.as_str()), ("format", "json")])
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => return Err(e.to_string()),
            };
            if !resp.status().is_success() {
                return Err(format!("oembed status {}", resp.status()));
            }
            resp.json::<OEmbed>().await.map_err(|e| e.to_string())
        })
        .ok();

    let title = oembed.as_ref().and_then(|o| o.title.clone()).unwrap_or_else(|| format!("YouTube {}", &youtube_id));
    let channel = oembed.as_ref().and_then(|o| o.author_name.clone()).unwrap_or_else(|| "Unknown".to_string());

    let thumb_path = {
        let dest = thumb_dir(&app).join(format!("{}.jpg", youtube_id));
        let client = reqwest::Client::builder()
            .user_agent("lixt/0.1")
            .timeout(std::time::Duration::from_secs(12))
            .build()
            .map_err(|e| e.to_string())?;
        runtime.block_on(fetch_thumbnail(&client, &youtube_id, dest.clone())).ok();
        if dest.exists() {
            Some(dest.to_string_lossy().to_string())
        } else {
            None
        }
    };

    conn.execute(
        "INSERT INTO videos (youtube_id, url, title, channel, thumbnail_path, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![&youtube_id, &canonical_url, &title, &channel, &thumb_path, now_ts()],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();

    // Insert at top: shift existing videos down by 1, then assign position 0 to the new one.
    conn.execute("UPDATE videos SET position = position + 1", []).ok();
    conn.execute("UPDATE videos SET position = 0 WHERE id = ?1", params![id]).ok();

    for pid in &playlist_ids {
        // Same for the playlist link: insert at top of that playlist.
        conn.execute(
            "UPDATE video_playlists SET position = position + 1 WHERE playlist_id = ?1",
            params![pid],
        )
        .ok();
        conn.execute(
            "INSERT OR IGNORE INTO video_playlists (video_id, playlist_id, added_at, position) VALUES (?1, ?2, ?3, 0)",
            params![id, pid, now_ts()],
        )
        .ok();
    }

    get_video(conn, id).ok_or("insert failed".to_string())
}

#[tauri::command]
fn check_existing(url: String) -> Result<Option<ExistingVideo>, String> {
    let (youtube_id, _) = match parse_youtube_id(&url) {
        Some(p) => p,
        None => return Ok(None),
    };
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    let video = match get_video_by_youtube_id(conn, &youtube_id) {
        Some(v) => v,
        None => return Ok(None),
    };
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.name FROM playlists p
             JOIN video_playlists vp ON vp.playlist_id = p.id
             WHERE vp.video_id = ?1
             ORDER BY p.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![video.id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut playlist_ids = Vec::new();
    let mut playlist_names = Vec::new();
    for row in rows {
        let (id, name) = row.map_err(|e| e.to_string())?;
        playlist_ids.push(id);
        playlist_names.push(name);
    }
    Ok(Some(ExistingVideo { video, playlist_ids, playlist_names }))
}

#[tauri::command]
fn list_videos(playlist_id: Option<i64>, sort: Option<String>) -> Result<Vec<Video>, String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    let sort = sort.unwrap_or_else(|| "manual".to_string());
    let order = match sort.as_str() {
        "added_desc" => "added_at DESC",
        "added_asc" => "added_at ASC",
        "title" => "LOWER(title) ASC",
        "channel" => "LOWER(channel) ASC, LOWER(title) ASC",
        "favorite" => "is_favorite DESC, added_at DESC",
        _ => {
            if playlist_id.is_some() {
                "vp.position ASC"
            } else {
                "position ASC"
            }
        }
    };

    let (sql, has_pl_filter): (String, bool) = if playlist_id.is_some() {
        (
            format!(
                "SELECT v.id, v.youtube_id, v.url, v.title, v.channel, v.thumbnail_path, v.added_at, v.is_favorite, v.is_watched
                 FROM videos v
                 JOIN video_playlists vp ON vp.video_id = v.id
                 WHERE vp.playlist_id = ?1
                 ORDER BY {}",
                order
            ),
            true,
        )
    } else {
        (
            format!(
                "SELECT id, youtube_id, url, title, channel, thumbnail_path, added_at, is_favorite, is_watched
                 FROM videos
                 ORDER BY {}",
                order
            ),
            false,
        )
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = if has_pl_filter {
        stmt.query_map(params![playlist_id.unwrap()], row_to_video).map_err(|e| e.to_string())?
    } else {
        stmt.query_map([], row_to_video).map_err(|e| e.to_string())?
    };
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn search_videos(query: String) -> Result<Vec<Video>, String> {
    let q = format!("%{}%", query.to_lowercase());
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    let mut stmt = conn
        .prepare(
            "SELECT id, youtube_id, url, title, channel, thumbnail_path, added_at, is_favorite, is_watched
             FROM videos
             WHERE LOWER(title) LIKE ?1 OR LOWER(channel) LIKE ?1 OR LOWER(url) LIKE ?1 OR LOWER(youtube_id) LIKE ?1
             ORDER BY is_favorite DESC, added_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![&q], row_to_video).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn reorder_videos(playlist_id: Option<i64>, ordered_video_ids: Vec<i64>) -> Result<(), String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    for (i, vid) in ordered_video_ids.iter().enumerate() {
        let i = i as i64;
        if let Some(pid) = playlist_id {
            conn.execute(
                "UPDATE video_playlists SET position = ?1 WHERE video_id = ?2 AND playlist_id = ?3",
                params![i, vid, pid],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute("UPDATE videos SET position = ?1 WHERE id = ?2", params![i, vid]).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn list_playlists() -> Result<Vec<Playlist>, String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    let mut stmt = conn
        .prepare("SELECT id, name, created_at FROM playlists ORDER BY position ASC, name COLLATE NOCASE ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(Playlist { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn create_playlist(name: String) -> Result<Playlist, String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    let max_pos: i64 = conn.query_row("SELECT COALESCE(MAX(position), -1) FROM playlists", [], |r| r.get(0)).unwrap_or(-1);
    conn.execute(
        "INSERT INTO playlists (name, created_at, position) VALUES (?1, ?2, ?3)",
        params![&name, now_ts(), max_pos + 1],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(Playlist { id, name, created_at: now_ts() })
}

#[tauri::command]
fn rename_playlist(id: i64, name: String) -> Result<(), String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    conn.execute("UPDATE playlists SET name = ?1 WHERE id = ?2", params![&name, id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_playlist(id: i64) -> Result<(), String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    conn.execute("DELETE FROM video_playlists WHERE playlist_id = ?1", params![id]).ok();
    conn.execute("DELETE FROM playlists WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn reorder_playlists(ordered_ids: Vec<i64>) -> Result<(), String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    for (i, id) in ordered_ids.iter().enumerate() {
        conn.execute("UPDATE playlists SET position = ?1 WHERE id = ?2", params![i as i64, id]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn remove_video_from_playlist(video_id: i64, playlist_id: i64) -> Result<(), String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    conn.execute(
        "DELETE FROM video_playlists WHERE video_id = ?1 AND playlist_id = ?2",
        params![video_id, playlist_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn bulk_add_to_playlist(video_ids: Vec<i64>, playlist_id: i64) -> Result<(), String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    // Insert at top of the playlist: shift existing entries down by N (the number we'll add),
    // then assign positions 0..N-1 to the newly-added ones (in the order the user picked them).
    let to_add: Vec<i64> = video_ids
        .iter()
        .filter(|vid| {
            conn.query_row(
                "SELECT 1 FROM video_playlists WHERE video_id = ?1 AND playlist_id = ?2",
                params![vid, playlist_id],
                |r| r.get::<_, i64>(0),
            )
            .is_err()
        })
        .copied()
        .collect();
    if to_add.is_empty() {
        return Ok(());
    }
    let shift = to_add.len() as i64;
    conn.execute(
        "UPDATE video_playlists SET position = position + ?1 WHERE playlist_id = ?2",
        params![shift, playlist_id],
    )
    .map_err(|e| e.to_string())?;
    for (i, vid) in to_add.iter().enumerate() {
        conn.execute(
            "INSERT OR IGNORE INTO video_playlists (video_id, playlist_id, added_at, position) VALUES (?1, ?2, ?3, ?4)",
            params![vid, playlist_id, now_ts(), i as i64],
        )
        .ok();
    }
    Ok(())
}

fn trash_video_inner(video_id: i64) -> Result<(), String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    let v: Option<(i64, String, String, String, String, Option<String>)> = conn
        .query_row(
            "SELECT id, youtube_id, url, title, channel, thumbnail_path FROM videos WHERE id = ?1",
            params![video_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .ok();
    let (id, yid, url, title, channel, thumb) = match v {
        Some(v) => v,
        None => return Ok(()),
    };
    conn.execute(
        "INSERT OR REPLACE INTO trash (youtube_id, url, title, channel, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![&yid, &url, &title, &channel, now_ts()],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM video_playlists WHERE video_id = ?1", params![id]).ok();
    conn.execute("DELETE FROM videos WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    if let Some(p) = thumb {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

#[tauri::command]
fn trash_video(video_id: i64) -> Result<(), String> {
    trash_video_inner(video_id)
}

#[tauri::command]
fn bulk_trash(video_ids: Vec<i64>) -> Result<(), String> {
    for vid in video_ids {
        trash_video_inner(vid)?;
    }
    Ok(())
}

#[tauri::command]
fn toggle_favorite(video_id: i64) -> Result<Video, String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    conn.execute(
        "UPDATE videos SET is_favorite = 1 - is_favorite WHERE id = ?1",
        params![video_id],
    )
    .map_err(|e| e.to_string())?;
    get_video(conn, video_id).ok_or("not found".to_string())
}

#[tauri::command]
fn toggle_watched(video_id: i64) -> Result<Video, String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    conn.execute(
        "UPDATE videos SET is_watched = 1 - is_watched WHERE id = ?1",
        params![video_id],
    )
    .map_err(|e| e.to_string())?;
    get_video(conn, video_id).ok_or("not found".to_string())
}

#[tauri::command]
fn list_trash() -> Result<Vec<TrashEntry>, String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    let mut stmt = conn
        .prepare("SELECT id, youtube_id, url, title, channel, deleted_at FROM trash ORDER BY deleted_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(TrashEntry {
            id: r.get(0)?,
            youtube_id: r.get(1)?,
            url: r.get(2)?,
            title: r.get(3)?,
            channel: r.get(4)?,
            deleted_at: r.get(5)?,
        }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn restore_from_trash(youtube_id: String, playlist_ids: Vec<i64>) -> Result<(), String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT url, title, channel FROM trash WHERE youtube_id = ?1",
            params![&youtube_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    let (url, title, channel) = match row {
        Some(r) => r,
        None => return Ok(()),
    };
    conn.execute(
        "INSERT OR IGNORE INTO videos (youtube_id, url, title, channel, thumbnail_path, added_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
        params![&youtube_id, &url, &title, &channel, now_ts()],
    )
    .map_err(|e| e.to_string())?;
    let vid: i64 = conn
        .query_row("SELECT id FROM videos WHERE youtube_id = ?1", params![&youtube_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    // Insert restored video at top of All videos.
    conn.execute("UPDATE videos SET position = position + 1", []).ok();
    conn.execute("UPDATE videos SET position = 0 WHERE id = ?1", params![vid]).ok();
    for pid in &playlist_ids {
        // And at top of each requested playlist.
        conn.execute(
            "UPDATE video_playlists SET position = position + 1 WHERE playlist_id = ?1",
            params![pid],
        )
        .ok();
        conn.execute(
            "INSERT OR IGNORE INTO video_playlists (video_id, playlist_id, added_at, position) VALUES (?1, ?2, ?3, 0)",
            params![vid, pid, now_ts()],
        )
        .ok();
    }
    conn.execute("DELETE FROM trash WHERE youtube_id = ?1", params![&youtube_id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn purge_trash_entry(youtube_id: String) -> Result<(), String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    conn.execute("DELETE FROM trash WHERE youtube_id = ?1", params![&youtube_id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn empty_trash() -> Result<(), String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    conn.execute("DELETE FROM trash", []).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn read_thumbnail_blob(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(&bytes))
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ───── backup / export ─────────────────────────────────────────────────────────

#[tauri::command]
fn export_backup_to_path(app: tauri::AppHandle, path: String) -> Result<usize, String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");

    let mut stmt = conn
        .prepare("SELECT id, youtube_id, url, title, channel, thumbnail_path, added_at, is_favorite, is_watched FROM videos")
        .map_err(|e| e.to_string())?;
    let videos = stmt.query_map([], row_to_video).map_err(|e| e.to_string())?;
    let videos: Vec<Video> = videos.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, name, created_at FROM playlists")
        .map_err(|e| e.to_string())?;
    let playlists = stmt
        .query_map([], |r| Ok(Playlist { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)? }))
        .map_err(|e| e.to_string())?;
    let playlists: Vec<Playlist> = playlists.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    let mut stmt = conn.prepare("SELECT video_id, playlist_id FROM video_playlists").map_err(|e| e.to_string())?;
    let vp = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    let video_playlists: Vec<(i64, i64)> = vp.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, youtube_id, url, title, channel, deleted_at FROM trash")
        .map_err(|e| e.to_string())?;
    let trash = stmt
        .query_map([], |r| Ok(TrashEntry {
            id: r.get(0)?,
            youtube_id: r.get(1)?,
            url: r.get(2)?,
            title: r.get(3)?,
            channel: r.get(4)?,
            deleted_at: r.get(5)?,
        }))
        .map_err(|e| e.to_string())?;
    let trash: Vec<TrashEntry> = trash.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    let thumb_root = thumb_dir(&app);
    let mut thumbnails: Vec<ThumbnailBlob> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&thumb_root) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) == Some("jpg") {
                let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                if let Ok(bytes) = std::fs::read(&p) {
                    thumbnails.push(ThumbnailBlob { youtube_id: stem, base64: STANDARD.encode(&bytes) });
                }
            }
        }
    }

    let bundle = BackupBundle {
        version: 1,
        videos,
        playlists,
        video_playlists,
        trash,
        thumbnails,
    };
    let json = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(serde_json::to_string(&bundle).map_or(0, |s| s.len()))
}

#[tauri::command]
fn import_backup_from_path(app: tauri::AppHandle, path: String) -> Result<usize, String> {
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let bundle: BackupBundle = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");

    for v in &bundle.videos {
        conn.execute(
            "INSERT OR IGNORE INTO videos (id, youtube_id, url, title, channel, thumbnail_path, added_at, is_favorite, is_watched)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![v.id, &v.youtube_id, &v.url, &v.title, &v.channel, &v.thumbnail_path, v.added_at, v.is_favorite as i64, v.is_watched as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    for p in &bundle.playlists {
        conn.execute(
            "INSERT OR IGNORE INTO playlists (id, name, created_at) VALUES (?1, ?2, ?3)",
            params![p.id, &p.name, p.created_at],
        )
        .map_err(|e| e.to_string())?;
    }
    for (vid, pid) in &bundle.video_playlists {
        conn.execute(
            "INSERT OR IGNORE INTO video_playlists (video_id, playlist_id, added_at, position) VALUES (?1, ?2, ?3, 0)",
            params![vid, pid, now_ts()],
        )
        .ok();
    }
    for t in &bundle.trash {
        conn.execute(
            "INSERT OR IGNORE INTO trash (youtube_id, url, title, channel, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![&t.youtube_id, &t.url, &t.title, &t.channel, t.deleted_at],
        )
        .ok();
    }

    let thumb_root = thumb_dir(&app);
    std::fs::create_dir_all(&thumb_root).ok();
    for tb in &bundle.thumbnails {
        let dest = thumb_root.join(format!("{}.jpg", tb.youtube_id));
        if let Ok(bytes) = STANDARD.decode(&tb.base64) {
            let _ = std::fs::write(&dest, &bytes);
        }
    }

    Ok(bundle.videos.len() + bundle.playlists.len())
}

// ───── helpers ─────────────────────────────────────────────────────────────────

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn row_to_video(r: &rusqlite::Row) -> rusqlite::Result<Video> {
    Ok(Video {
        id: r.get(0)?,
        youtube_id: r.get(1)?,
        url: r.get(2)?,
        title: r.get(3)?,
        channel: r.get(4)?,
        thumbnail_path: r.get(5)?,
        added_at: r.get(6)?,
        is_favorite: r.get::<_, i64>(7)? != 0,
        is_watched: r.get::<_, i64>(8)? != 0,
    })
}

fn get_video(conn: &Connection, id: i64) -> Option<Video> {
    conn.query_row(
        "SELECT id, youtube_id, url, title, channel, thumbnail_path, added_at, is_favorite, is_watched FROM videos WHERE id = ?1",
        params![id],
        row_to_video,
    )
    .ok()
}

fn get_video_by_youtube_id(conn: &Connection, yid: &str) -> Option<Video> {
    conn.query_row(
        "SELECT id, youtube_id, url, title, channel, thumbnail_path, added_at, is_favorite, is_watched FROM videos WHERE youtube_id = ?1",
        params![yid],
        row_to_video,
    )
    .ok()
}

// ───── entry ───────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let conn = init_db(&app.handle());
            *DB.lock().unwrap() = Some(conn);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_video,
            check_existing,
            list_videos,
            search_videos,
            reorder_videos,
            list_playlists,
            create_playlist,
            rename_playlist,
            delete_playlist,
            reorder_playlists,
            remove_video_from_playlist,
            bulk_add_to_playlist,
            trash_video,
            bulk_trash,
            toggle_favorite,
            toggle_watched,
            list_trash,
            restore_from_trash,
            purge_trash_entry,
            empty_trash,
            read_thumbnail_blob,
            open_url,
            export_backup_to_path,
            import_backup_from_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
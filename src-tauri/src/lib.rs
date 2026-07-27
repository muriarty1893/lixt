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

#[derive(Serialize, Deserialize, Debug)]
pub struct VideoWithPlaylists {
    pub video: Video,
    pub playlists: Vec<i64>,
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
    conn
}

// ───── youtube url parsing ─────────────────────────────────────────────────────

fn parse_youtube_id(input: &str) -> Option<(String, String)> {
    let trimmed = input.trim();
    // bare id
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

// ───── oembed fetch ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct OEmbed {
    title: Option<String>,
    author_name: Option<String>,
}

async fn fetch_thumbnail(client: &reqwest::Client, youtube_id: &str, dest: PathBuf) -> Result<(), String> {
    // try hqdefault then mqdefault
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
    let oembed = runtime.block_on(async {
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

    for pid in &playlist_ids {
        conn.execute(
            "INSERT OR IGNORE INTO video_playlists (video_id, playlist_id, added_at) VALUES (?1, ?2, ?3)",
            params![id, pid, now_ts()],
        )
        .ok();
    }

    get_video(conn, id).ok_or("insert failed".to_string())
}

#[tauri::command]
fn list_videos(playlist_id: Option<i64>) -> Result<Vec<Video>, String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    let mut stmt = match playlist_id {
        Some(_pid) => conn
            .prepare(
                "SELECT v.id, v.youtube_id, v.url, v.title, v.channel, v.thumbnail_path, v.added_at
                 FROM videos v
                 JOIN video_playlists vp ON vp.video_id = v.id
                 WHERE vp.playlist_id = ?1
                 ORDER BY vp.added_at DESC",
            )
            .map_err(|e| e.to_string())?,
        None => conn
            .prepare("SELECT id, youtube_id, url, title, channel, thumbnail_path, added_at FROM videos ORDER BY added_at DESC")
            .map_err(|e| e.to_string())?,
    };
    let rows = if let Some(pid) = playlist_id {
        stmt.query_map(params![pid], row_to_video).map_err(|e| e.to_string())?
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
            "SELECT id, youtube_id, url, title, channel, thumbnail_path, added_at
             FROM videos
             WHERE LOWER(title) LIKE ?1 OR LOWER(channel) LIKE ?1 OR LOWER(url) LIKE ?1 OR LOWER(youtube_id) LIKE ?1
             ORDER BY added_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![&q], row_to_video).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn list_playlists() -> Result<Vec<Playlist>, String> {
    let conn_lock = DB.lock().unwrap();
    let conn = conn_lock.as_ref().expect("db");
    let mut stmt = conn
        .prepare("SELECT id, name, created_at FROM playlists ORDER BY name COLLATE NOCASE")
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
    conn.execute("INSERT INTO playlists (name, created_at) VALUES (?1, ?2)", params![&name, now_ts()])
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
fn trash_video(app: tauri::AppHandle, video_id: i64) -> Result<(), String> {
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
    let _ = app;
    Ok(())
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
    for pid in &playlist_ids {
        conn.execute(
            "INSERT OR IGNORE INTO video_playlists (video_id, playlist_id, added_at) VALUES (?1, ?2, ?3)",
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
    })
}

fn get_video(conn: &Connection, id: i64) -> Option<Video> {
    conn.query_row(
        "SELECT id, youtube_id, url, title, channel, thumbnail_path, added_at FROM videos WHERE id = ?1",
        params![id],
        row_to_video,
    )
    .ok()
}

// ───── entry ───────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let conn = init_db(&app.handle());
            *DB.lock().unwrap() = Some(conn);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_video,
            list_videos,
            search_videos,
            list_playlists,
            create_playlist,
            rename_playlist,
            delete_playlist,
            remove_video_from_playlist,
            trash_video,
            list_trash,
            restore_from_trash,
            purge_trash_entry,
            empty_trash,
            read_thumbnail_blob,
            open_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Plus, Search, Trash2, Library, MoreVertical, ExternalLink, FolderMinus, X, Check, Edit3,
  LayoutGrid, List, Star, Eye, EyeOff, ArrowUpNarrowWide, Download, Upload, GripVertical,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Segmented } from "@/components/ui/segmented";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ExistingVideo, Playlist, TrashEntry, Video } from "@/types";
import * as api from "@/lib/api";
import { cn } from "@/lib/utils";

type View = { kind: "all" } | { kind: "playlist"; id: number; name: string } | { kind: "trash" };
type ViewMode = "grid" | "list";
type Density = "comfortable" | "compact";
type SortMode = "manual" | "added_desc" | "added_asc" | "title" | "channel" | "favorite";

const LS_KEYS = {
  viewMode: "lixt.viewMode",
  density: "lixt.density",
  sort: "lixt.sort",
};

function loadLS<T extends string>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return (v as T) ?? fallback;
  } catch {
    return fallback;
  }
}

function relativeTime(ts: number): string {
  const now = Date.now() / 1000;
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} mo ago`;
  const y = Math.floor(mo / 12);
  return `${y} yr ago`;
}

type Toast = { id: number; message: string; undo?: () => void };

export default function App() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [view, setView] = useState<View>({ kind: "all" });
  const [videos, setVideos] = useState<Video[]>([]);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [search, setSearch] = useState("");
  const [thumbCache, setThumbCache] = useState<Record<number, string>>({});
  const [droppingOn, setDroppingOn] = useState<string | null>(null);
  const [droppingSection, setDroppingSection] = useState(false);
  const [addDialog, setAddDialog] = useState(false);
  const [newName, setNewName] = useState("");
  const [renameDialog, setRenameDialog] = useState<Playlist | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [existingDialog, setExistingDialog] = useState<{ url: string; existing: ExistingVideo } | null>(null);
  const [pendingPlaylistIds, setPendingPlaylistIds] = useState<number[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>(loadLS(LS_KEYS.viewMode, "grid"));
  const [density, setDensity] = useState<Density>(loadLS(LS_KEYS.density, "comfortable"));
  const [sortMode, setSortMode] = useState<SortMode>(loadLS(LS_KEYS.sort, "manual"));
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [focusedIdx, setFocusedIdx] = useState(0);
  const [draggingVid, setDraggingVid] = useState<number | null>(null);
  const [dragOverVid, setDragOverVid] = useState<number | null>(null);
  const [draggingPLId, setDraggingPLId] = useState<number | null>(null);

  const toastId = useRef(0);

  const pushToast = useCallback((message: string, undo?: () => void) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message, undo }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), undo ? 6000 : 3200);
  }, []);

  const dismissToast = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

  const loadPlaylists = async () => setPlaylists(await api.listPlaylists());
  const loadTrash = async () => setTrash(await api.listTrash());

  const refresh = useCallback(async () => {
    if (search.trim()) {
      setVideos(await api.searchVideos(search.trim()));
    } else if (view.kind === "all") {
      setVideos(await api.listVideos(undefined, sortMode));
    } else if (view.kind === "playlist") {
      setVideos(await api.listVideos(view.id, sortMode));
    } else {
      setVideos([]);
    }
  }, [view, search, sortMode]);

  useEffect(() => { loadPlaylists(); loadTrash(); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { setSelected(new Set()); setFocusedIdx(0); }, [view, search]);
  useEffect(() => { try { localStorage.setItem(LS_KEYS.viewMode, viewMode); } catch {} }, [viewMode]);
  useEffect(() => { try { localStorage.setItem(LS_KEYS.density, density); } catch {} }, [density]);
  useEffect(() => { try { localStorage.setItem(LS_KEYS.sort, sortMode); } catch {} }, [sortMode]);

  const ensureThumb = useCallback(async (v: Video) => {
    if (!v.thumbnail_path || thumbCache[v.id]) return;
    try {
      const blob = await api.readThumbnailBlob(v.thumbnail_path);
      setThumbCache((p) => ({ ...p, [v.id]: `data:image/jpeg;base64,${blob}` }));
    } catch (err) {
      console.error("thumb load failed", v.id, err);
    }
  }, [thumbCache]);

  useEffect(() => { videos.forEach(ensureThumb); setThumbCache((p) => {
    const keep: Record<number, string> = {};
    videos.forEach((v) => { if (p[v.id]) keep[v.id] = p[v.id]; });
    return keep;
  }); }, [videos, ensureThumb]);

  // ───── actions ────────────────────────────────────────────────────────────────

  const onAddPlaylist = async () => {
    const name = newName.trim();
    if (!name) return;
    try { await api.createPlaylist(name); await loadPlaylists(); setNewName(""); setAddDialog(false); }
    catch (e) { pushToast(`Error: ${e}`); }
  };

  const onRename = async () => {
    if (!renameDialog) return;
    const name = renameTo.trim();
    if (!name) return;
    try {
      await api.renamePlaylist(renameDialog.id, name);
      await loadPlaylists();
      if (view.kind === "playlist" && view.id === renameDialog.id) setView({ kind: "playlist", id: renameDialog.id, name });
      setRenameDialog(null);
    } catch (e) { pushToast(`Error: ${e}`); }
  };

  const onDeletePlaylist = async (p: Playlist) => {
    if (!confirm(`Delete playlist "${p.name}"? Videos stay (just unsorted).`)) return;
    await api.deletePlaylist(p.id);
    await loadPlaylists();
    if (view.kind === "playlist" && view.id === p.id) setView({ kind: "all" });
  };

  const extractUrl = (e: React.DragEvent): string | null => {
    const list = e.dataTransfer.getData("text/uri-list");
    const text = e.dataTransfer.getData("text/plain");
    const cand = (list || text || "").trim();
    return cand || null;
  };

  const urlToVideoIds = (e: React.DragEvent): number[] => {
    const data = e.dataTransfer.getData("application/x-lixt-video-ids");
    return data ? data.split(",").map(Number).filter(Boolean) : [];
  };

  const onDropToPlaylist = async (e: React.DragEvent, playlistId?: number) => {
    e.preventDefault();
    e.stopPropagation();
    setDroppingOn(null);

    const url = extractUrl(e);
    if (url) {
      try {
        const existing = await api.checkExisting(url);
        if (existing) {
          setExistingDialog({ url, existing });
          setPendingPlaylistIds(playlistId ? [playlistId] : []);
          return;
        }
        await api.addVideo(url, playlistId ? [playlistId] : []);
        await refresh();
        await loadPlaylists();
        pushToast("Added");
      } catch (err) {
        pushToast(`Add failed: ${err}`);
      }
      return;
    }

    const ids = urlToVideoIds(e);
    if (ids.length && playlistId) {
      try {
        const target = playlists.find((p) => p.id === playlistId)?.name;
        await api.bulkAddToPlaylist(ids, playlistId);
        await refresh();
        await loadPlaylists();
        pushToast(ids.length === 1 ? `Added to ${target}` : `${ids.length} added to ${target}`);
      } catch (err) { pushToast(`Move failed: ${err}`); }
    }
  };

  const onDropToAll = (e: React.DragEvent) => onDropToPlaylist(e, undefined);

  const confirmAddExisting = async () => {
    if (!existingDialog) return;
    try {
      await api.addVideo(existingDialog.url, pendingPlaylistIds);
      await refresh();
      await loadPlaylists();
      pushToast("Added to playlist");
    } catch (e) { pushToast(`Error: ${e}`); }
    setExistingDialog(null);
    setPendingPlaylistIds([]);
  };

  const openVideo = async (v: Video | TrashEntry) => {
    api.openUrl(v.url).catch((err) => pushToast(`Open failed: ${err}`));
    if ("is_watched" in v && !v.is_watched) {
      try {
        const updated = await api.toggleWatched(v.id);
        setVideos((cur) => cur.map((x) => (x.id === v.id ? updated : x)));
      } catch { /* ignore */ }
    }
  };

  const trashOne = async (v: Video) => {
    if (!confirm(`Move "${v.title}" to trash?`)) return;
    await api.trashVideo(v.id);
    await refresh();
    await loadTrash();
    pushToast("Moved to trash", async () => {
      await api.restoreFromTrash(v.youtube_id, view.kind === "playlist" ? [view.id] : []);
      await refresh();
      await loadTrash();
    });
  };

  const trashSelected = async () => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    await api.bulkTrash(ids);
    setSelected(new Set());
    await refresh();
    await loadTrash();
    pushToast(`${ids.length} moved to trash`, async () => {
      // best-effort undo: restore from latest trash entries we just made (no per-id restore path here)
      pushToast("Undo not available for bulk trash");
    });
  };

  const toggleSelect = (id: number, additive: boolean) => {
    setSelected((cur) => {
      const next = new Set(additive ? cur : []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addToPlaylistFromMenu = async (v: Video, playlistId: number) => {
    try {
      await api.bulkAddToPlaylist([v.id], playlistId);
      await loadPlaylists();
      pushToast(`Added to ${playlists.find((p) => p.id === playlistId)?.name ?? "playlist"}`);
    } catch (e) { pushToast(`Error: ${e}`); }
  };

  const addSelectedToPlaylist = async (playlistId: number) => {
    if (selected.size === 0) return;
    await api.bulkAddToPlaylist(Array.from(selected), playlistId);
    await loadPlaylists();
    pushToast(`${selected.size} added to ${playlists.find((p) => p.id === playlistId)?.name ?? "playlist"}`);
  };

  const onFavorite = async (v: Video) => {
    const updated = await api.toggleFavorite(v.id);
    setVideos((cur) => cur.map((x) => (x.id === v.id ? updated : x)));
  };

  const onWatched = async (v: Video) => {
    const updated = await api.toggleWatched(v.id);
    setVideos((cur) => cur.map((x) => (x.id === v.id ? updated : x)));
  };

  const restore = async (t: TrashEntry) => {
    await api.restoreFromTrash(t.youtube_id, view.kind === "playlist" ? [view.id] : []);
    await loadTrash();
    await refresh();
  };

  const purge = async (t: TrashEntry) => {
    if (!confirm(`Permanently delete "${t.title}"?`)) return;
    await api.purgeTrashEntry(t.youtube_id);
    await loadTrash();
  };

  const emptyAllTrash = async () => {
    if (!confirm("Empty trash? Cannot undo.")) return;
    await api.emptyTrash();
    await loadTrash();
  };

  const removeFromPlaylist = async (v: Video) => {
    if (view.kind !== "playlist") return;
    await api.removeVideoFromPlaylist(v.id, view.id);
    await refresh();
  };

  // ───── reorder: videos ─────────────────────────────────────────────────────────

  const commitReorderVideos = async (ordered: number[]) => {
    const playlistId = view.kind === "playlist" ? view.id : null;
    try { await api.reorderVideos(playlistId, ordered); }
    catch (e) { pushToast(`Reorder failed: ${e}`); }
  };

  const onVideoDragStart = (e: React.DragEvent, v: Video) => {
    if (selected.has(v.id)) {
      const ids = Array.from(selected);
      e.dataTransfer.setData("application/x-lixt-video-ids", ids.join(","));
    } else {
      e.dataTransfer.setData("application/x-lixt-video-ids", String(v.id));
    }
    setDraggingVid(v.id);
  };

  const onVideoDragOver = (e: React.DragEvent, v: Video) => {
    if (draggingVid === null) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (dragOverVid !== v.id) setDragOverVid(v.id);
  };

  const onVideoDrop = (e: React.DragEvent, target: Video) => {
    if (draggingVid === null) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOverVid(null);

    setVideos((cur) => {
      const fromId = draggingVid;
      const fromIdx = cur.findIndex((x) => x.id === fromId);
      const toIdx = cur.findIndex((x) => x.id === target.id);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return cur;
      const next = [...cur];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      void commitReorderVideos(next.map((x) => x.id));
      return next;
    });
    setDraggingVid(null);
  };

  const onVideoDragEnd = () => {
    setDraggingVid(null);
    setDragOverVid(null);
  };

  // ───── reorder: playlists in sidebar ─────────────────────────────────────────

  const commitReorderPlaylists = async (ordered: number[]) => {
    try { await api.reorderPlaylists(ordered); }
    catch (e) { pushToast(`Reorder failed: ${e}`); }
  };

  const onPLDragStart = (e: React.DragEvent, p: Playlist) => {
    e.dataTransfer.setData("application/x-lixt-playlist-id", String(p.id));
    setDraggingPLId(p.id);
  };

  const onPLDragOver = (e: React.DragEvent, p: Playlist) => {
    const t = e.dataTransfer.types;
    const hasPlaylist = t.includes("application/x-lixt-playlist-id");
    const hasVideo = t.includes("application/x-lixt-video-ids");
    const hasUrl = t.includes("text/uri-list") || t.includes("text/plain");
    if (!hasPlaylist && !hasVideo && !hasUrl) return;
    e.preventDefault();
    e.stopPropagation();
    if (droppingOn !== `pl-${p.id}`) setDroppingOn(`pl-${p.id}`);
  };

  const onPLDrop = (e: React.DragEvent, target: Playlist) => {
    e.preventDefault();
    e.stopPropagation();
    setDroppingOn(null);

    if (draggingPLId !== null && e.dataTransfer.types.includes("application/x-lixt-playlist-id")) {
      const fromId = draggingPLId;
      setPlaylists((cur) => {
        const fromIdx = cur.findIndex((p) => p.id === fromId);
        const toIdx = cur.findIndex((p) => p.id === target.id);
        if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return cur;
        const next = [...cur];
        const [moved] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, moved);
        void commitReorderPlaylists(next.map((p) => p.id));
        return next;
      });
      setDraggingPLId(null);
      return;
    }

    void onDropToPlaylist(e, target.id);
  };

  // ───── keyboard nav ───────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (view.kind === "trash") return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setVideos((cur) => {
          if (cur.length === 0) return cur;
          let idx = Math.min(focusedIdx, cur.length - 1);
          idx = e.key === "ArrowDown" ? Math.min(cur.length - 1, idx + 1) : Math.max(0, idx - 1);
          setFocusedIdx(idx);
          return cur;
        });
      } else if (e.key === "Enter" && videos[focusedIdx]) {
        e.preventDefault();
        openVideo(videos[focusedIdx]);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selected.size > 0) { e.preventDefault(); trashSelected(); }
        else if (videos[focusedIdx]) { e.preventDefault(); trashOne(videos[focusedIdx]); }
      } else if (e.key === " " && videos[focusedIdx]) {
        e.preventDefault();
        onFavorite(videos[focusedIdx]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusedIdx, videos, selected, view]);

  // ───── backup ────────────────────────────────────────────────────────────────

  const onExport = async () => {
    try {
      const n = await api.exportBackup();
      if (n !== null) pushToast("Backup exported");
    } catch (e) { pushToast(`Export failed: ${e}`); }
  };
  const onImport = async () => {
    try {
      const n = await api.importBackup();
      if (n === null) return;
      await refresh(); await loadPlaylists(); await loadTrash();
      pushToast(`Backup imported (${n} records)`);
    } catch (e) { pushToast(`Import failed: ${e}`); }
  };

  // ───── render ─────────────────────────────────────────────────────────────────

  const isPLView = (id: number) => view.kind === "playlist" && view.id === id;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {/* Sidebar */}
      <aside className="flex w-64 shrink-0 flex-col border-r bg-secondary/30">
        <div className="flex items-center gap-2 px-4 py-3">
          <Library className="size-5 text-primary" />
          <span className="font-semibold tracking-tight">lixt</span>
          <div className="ml-auto flex gap-1">
            <Button variant="ghost" size="icon" className="size-7" title="Import backup" onClick={onImport}>
              <Upload className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="size-7" title="Export backup" onClick={onExport}>
              <Download className="size-3.5" />
            </Button>
          </div>
        </div>
        <Separator />

        <div
          onDrop={onDropToAll}
          onDragOver={(e) => { e.preventDefault(); setDroppingOn("all"); }}
          onDragLeave={() => setDroppingOn(null)}
          className={cn(
            "px-3 py-2 text-sm transition-colors",
            "hover:bg-accent/40 cursor-pointer",
            view.kind === "all" && "bg-accent/60 font-medium",
            droppingOn === "all" && "ring-2 ring-primary ring-inset rounded-md",
          )}
          onClick={() => setView({ kind: "all" })}
        >All videos</div>

        <div className="mt-2 flex items-center justify-between px-3">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Playlists</span>
          <Button variant="ghost" size="icon" className="size-7" onClick={() => setAddDialog(true)}>
            <Plus className="size-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-1">
          {playlists.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground">No playlists yet.</div>}
          {playlists.map((p) => (
            <div
              key={p.id}
              draggable
              onDragStart={(e) => onPLDragStart(e, p)}
              onDragOver={(e) => onPLDragOver(e, p)}
              onDragLeave={() => { setDroppingOn((cur) => (cur === `pl-${p.id}` ? null : cur)); }}
              onDrop={(e) => onPLDrop(e, p)}
              onDragEnd={() => { setDraggingPLId(null); setDroppingOn(null); }}
              onClick={() => setView({ kind: "playlist", id: p.id, name: p.name })}
              className={cn(
                "group mb-0.5 flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors",
                "hover:bg-accent/40 cursor-pointer",
                isPLView(p.id) && "bg-accent/60 font-medium",
                droppingOn === `pl-${p.id}` && "ring-2 ring-primary ring-inset bg-accent/40",
              )}
            >
              <GripVertical className="size-3.5 shrink-0 opacity-0 group-hover:opacity-60" />
              <span className="truncate flex-1">{p.name}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    onClick={(e) => e.stopPropagation()}
                    className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-primary"
                  ><MoreVertical className="size-4" /></button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setRenameDialog(p); setRenameTo(p.name); }}>
                    <Edit3 className="size-4" /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onDeletePlaylist(p)}>
                    <Trash2 className="size-4" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>

        <Separator />
        <div
          onClick={() => setView({ kind: "trash" })}
          onDragOver={(e) => { e.preventDefault(); setDroppingOn("trash"); }}
          onDragLeave={() => setDroppingOn(null)}
          onDrop={(e) => { e.preventDefault(); setDroppingOn(null); pushToast("Trash holds deleted videos. Drop on a playlist instead."); }}
          className={cn(
            "flex items-center gap-2 px-3 py-2.5 text-sm transition-colors",
            "hover:bg-accent/40 cursor-pointer",
            view.kind === "trash" && "bg-accent/60 font-medium",
            droppingOn === "trash" && "ring-2 ring-primary ring-inset",
          )}
        >
          <Trash2 className="size-4 text-muted-foreground" />
          <span>Trash</span>
          {trash.length > 0 && (
            <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{trash.length}</span>
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="flex flex-1 flex-col overflow-hidden" onClick={() => setSelected(new Set())}>
        <header className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5">
          <div className="relative flex-1 min-w-[200px] max-w-xl">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by title, channel, or URL…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              className="pl-8"
            />
          </div>

          <Segmented
            value={viewMode}
            onChange={(v) => setViewMode(v as ViewMode)}
            options={[
              { value: "grid", icon: <LayoutGrid className="size-3.5" />, title: "Grid" },
              { value: "list", icon: <List className="size-3.5" />, title: "List" },
            ]}
          />

          {viewMode === "list" && (
            <Segmented
              value={density}
              onChange={(v) => setDensity(v as Density)}
              options={[
                { value: "comfortable", title: "Comfortable", label: "C" },
                { value: "compact", title: "Compact", label: "P" },
              ]}
            />
          )}

          {view.kind !== "trash" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <ArrowUpNarrowWide className="size-3.5" />
                  Sort
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setSortMode("manual")}>
                  {sortMode === "manual" && <Check className="size-4" />} Manual order
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSortMode("added_desc")}>
                  {sortMode === "added_desc" && <Check className="size-4" />} Date added (newest)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSortMode("added_asc")}>
                  {sortMode === "added_asc" && <Check className="size-4" />} Date added (oldest)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSortMode("title")}>
                  {sortMode === "title" && <Check className="size-4" />} Title A-Z
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSortMode("channel")}>
                  {sortMode === "channel" && <Check className="size-4" />} Channel A-Z
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSortMode("favorite")}>
                  {sortMode === "favorite" && <Check className="size-4" />} Favorites first
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {selected.size > 0 && (
            <>
              <span className="text-sm text-muted-foreground">{selected.size} selected</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Plus className="size-3.5" /> Add {selected.size} to…
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {playlists.length === 0 && <DropdownMenuItem disabled>No playlists</DropdownMenuItem>}
                  {playlists.map((p) => (
                    <DropdownMenuItem key={p.id} onClick={() => addSelectedToPlaylist(p.id)}>{p.name}</DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="outline" size="sm" onClick={trashSelected}>
                <Trash2 className="size-3.5" /> Trash
              </Button>
            </>
          )}

          <div className="text-sm text-muted-foreground">
            {view.kind === "all" && "All videos"}
            {view.kind === "playlist" && view.name}
            {view.kind === "trash" && "Trash"}
          </div>
        </header>

        <section
          className={cn(
            "flex-1 overflow-y-auto p-4 transition-colors",
            droppingSection && view.kind !== "trash" && "outline-2 outline-dashed outline-primary rounded-lg",
          )}
          onDragOver={(e) => {
            if (view.kind === "trash") return;
            const t = e.dataTransfer.types;
            const ok = t.includes("text/uri-list") || t.includes("text/plain") || t.includes("application/x-lixt-video-ids");
            if (ok) { e.preventDefault(); setDroppingSection(true); }
          }}
          onDragLeave={() => setDroppingSection(false)}
          onDrop={(e) => {
            setDroppingSection(false);
            if (view.kind === "trash") return;
            const isUrl = extractUrl(e);
            const ids = urlToVideoIds(e);
            if (!isUrl && ids.length === 0) return;
            e.preventDefault();
            const targetPlaylistId = view.kind === "playlist" ? view.id : undefined;
            void onDropToPlaylist(e, targetPlaylistId);
          }}
        >
          {view.kind === "trash" ? (
            <TrashView trash={trash} onRestore={restore} onPurge={purge} onOpen={openVideo} onEmpty={emptyAllTrash} />
          ) : (
            <VideoGrid
              videos={videos}
              thumbCache={thumbCache}
              view={view}
              viewMode={viewMode}
              density={density}
              selected={selected}
              focusedIdx={focusedIdx}
              draggingVid={draggingVid}
              dragOverVid={dragOverVid}
              playlists={playlists}
              onOpen={openVideo}
              onTrash={trashOne}
              onRemoveFromPlaylist={view.kind === "playlist" ? removeFromPlaylist : undefined}
              onFavorite={onFavorite}
              onWatched={onWatched}
              onToggleSelect={toggleSelect}
              onVideoDragStart={onVideoDragStart}
              onVideoDragOver={onVideoDragOver}
              onVideoDrop={onVideoDrop}
              onVideoDragEnd={onVideoDragEnd}
              onAddToPlaylist={addToPlaylistFromMenu}
            />
          )}
        </section>
      </main>

      {/* Toasts */}
      <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="flex items-center gap-3 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground shadow-lg">
            <span>{t.message}</span>
            {t.undo && (
              <button className="font-semibold underline" onClick={() => { t.undo!(); dismissToast(t.id); }}>Undo</button>
            )}
            <button onClick={() => dismissToast(t.id)}><X className="size-3.5" /></button>
          </div>
        ))}
      </div>

      {/* Add playlist dialog */}
      <Dialog open={addDialog} onOpenChange={setAddDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New playlist</DialogTitle>
            <DialogDescription>Give it a name. You can rename later.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus placeholder="Playlist name" value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onAddPlaylist()}
          />
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAddDialog(false)}><X className="size-4" /> Cancel</Button>
            <Button onClick={onAddPlaylist}><Check className="size-4" /> Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={!!renameDialog} onOpenChange={(o) => !o && setRenameDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename playlist</DialogTitle>
            <DialogDescription>{renameDialog?.name}</DialogDescription>
          </DialogHeader>
          <Input autoFocus value={renameTo} onChange={(e) => setRenameTo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onRename()} />
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenameDialog(null)}><X className="size-4" /> Cancel</Button>
            <Button onClick={onRename}><Check className="size-4" /> Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Duplicate detection dialog */}
      <Dialog open={!!existingDialog} onOpenChange={(o) => !o && setExistingDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Already in your library</DialogTitle>
            <DialogDescription>
              {existingDialog?.existing.video.title} — {existingDialog?.existing.video.channel}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md bg-muted/40 p-3 text-sm">
            <div className="font-medium">{existingDialog && existingDialog.existing.playlist_names.length > 0
              ? "In playlists: " + existingDialog.existing.playlist_names.join(", ")
              : "Not in any playlist yet"}</div>
            <div className="text-muted-foreground mt-1">Add it to the chosen playlist anyway?</div>
          </div>
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setExistingDialog(null)}>Don't add</Button>
            <Button onClick={confirmAddExisting}><Plus className="size-4" /> Add anyway</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ───────── helpers / subcomponents ──────────────────────────────────────────────

function ThumbBox({ src, className }: { src?: string; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded bg-muted", className)}>
      {src ? <img src={src} alt="" className="size-full object-cover" /> : <div className="flex size-full items-center justify-center text-xs text-muted-foreground">no thumb</div>}
    </div>
  );
}

interface GridProps {
  videos: Video[];
  thumbCache: Record<number, string>;
  view: View;
  viewMode: ViewMode;
  density: Density;
  selected: Set<number>;
  focusedIdx: number;
  draggingVid: number | null;
  dragOverVid: number | null;
  playlists: Playlist[];
  onOpen: (v: Video) => void;
  onTrash: (v: Video) => void;
  onRemoveFromPlaylist?: (v: Video) => void;
  onFavorite: (v: Video) => void;
  onWatched: (v: Video) => void;
  onToggleSelect: (id: number, additive: boolean) => void;
  onVideoDragStart: (e: React.DragEvent, v: Video) => void;
  onVideoDragOver: (e: React.DragEvent, v: Video) => void;
  onVideoDrop: (e: React.DragEvent, v: Video) => void;
  onVideoDragEnd: () => void;
  onAddToPlaylist: (v: Video, playlistId: number) => void;
}

function VideoGrid(props: GridProps) {
  const { videos, view, viewMode } = props;

  if (videos.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <Library className="size-10 opacity-30" />
        <div className="text-sm">{view.kind === "all" ? "Drag a YouTube URL from your browser onto a playlist in the sidebar." : "No videos here yet."}</div>
      </div>
    );
  }

  if (viewMode === "list") return <ListView {...props} />;
  return <GridView {...props} />;
}

function cardClass(opts: {
  selected: boolean; focused: boolean; dragging: boolean; dragOver: boolean;
}) {
  return cn(
    "group flex flex-col gap-2 rounded-lg border bg-card p-2 text-sm shadow-sm transition-colors",
    "hover:bg-accent/30",
    opts.selected && "ring-2 ring-primary",
    opts.focused && !opts.selected && "border-primary",
    opts.dragging && "opacity-50",
    opts.dragOver && "border-l-4 border-l-primary",
  );
}

function GridView(props: GridProps) {
  const { videos, thumbCache, selected, focusedIdx, draggingVid, dragOverVid } = props;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {videos.map((v, idx) => (
        <ContextMenu key={v.id}>
          <ContextMenuTrigger asChild>
            <div
              draggable
              onDragStart={(e) => props.onVideoDragStart(e, v)}
              onDragOver={(e) => props.onVideoDragOver(e, v)}
              onDrop={(e) => props.onVideoDrop(e, v)}
              onDragEnd={props.onVideoDragEnd}
              onClick={(e) => { e.stopPropagation(); props.onToggleSelect(v.id, e.ctrlKey || e.metaKey || e.shiftKey); }}
              className={cardClass({ selected: selected.has(v.id), focused: idx === focusedIdx, dragging: draggingVid === v.id, dragOver: dragOverVid === v.id })}
            >
              <button onClick={(e) => { e.stopPropagation(); props.onOpen(v); }} className="block w-full text-left">
                <ThumbBox src={thumbCache[v.id]} className="aspect-video w-full rounded-md" />
              </button>
              <button onClick={(e) => { e.stopPropagation(); props.onOpen(v); }} className="block w-full text-left">
                <div className="line-clamp-2 font-medium leading-snug hover:text-primary">{v.title}</div>
              </button>
              <div className="text-xs text-muted-foreground">{v.channel} · {relativeTime(v.added_at)}</div>
              <CardFooter v={v} {...props} />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>{ctxMenu(props, v)}</ContextMenuContent>
        </ContextMenu>
      ))}
    </div>
  );
}

function ListView(props: GridProps) {
  const { videos, thumbCache, selected, focusedIdx, draggingVid, dragOverVid, density } = props;
  const rowPad = density === "compact" ? "py-1.5" : "py-2.5";
  const thumbSize = density === "compact" ? "size-12" : "h-12 w-20";
  return (
    <div className="flex flex-col divide-y rounded-lg border">
      {videos.map((v, idx) => (
        <ContextMenu key={v.id}>
          <ContextMenuTrigger asChild>
            <div
              draggable
              onDragStart={(e) => props.onVideoDragStart(e, v)}
              onDragOver={(e) => props.onVideoDragOver(e, v)}
              onDrop={(e) => props.onVideoDrop(e, v)}
              onDragEnd={props.onVideoDragEnd}
              onClick={(e) => { e.stopPropagation(); props.onToggleSelect(v.id, e.ctrlKey || e.metaKey || e.shiftKey); }}
              className={cn(
                "flex items-center gap-3 border-b px-3 transition-colors hover:bg-accent/30",
                rowPad,
                selected.has(v.id) && "bg-accent/40",
                idx === focusedIdx && !selected.has(v.id) && "border-l-2 border-primary",
                draggingVid === v.id && "opacity-50",
                dragOverVid === v.id && "border-t-2 border-primary",
              )}
            >
              <button onClick={(e) => { e.stopPropagation(); props.onOpen(v); }} className="shrink-0">
                <ThumbBox src={thumbCache[v.id]} className={cn(thumbSize, "shrink-0")} />
              </button>
              <div className="flex min-w-0 flex-1 flex-col">
                <button onClick={(e) => { e.stopPropagation(); props.onOpen(v); }} className="block w-full text-left">
                  <div className="truncate text-sm font-medium hover:text-primary">{v.title}</div>
                </button>
                <div className="truncate text-xs text-muted-foreground">{v.channel} · {relativeTime(v.added_at)}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <CardFooter v={v} {...props} compact />
              </div>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>{ctxMenu(props, v)}</ContextMenuContent>
        </ContextMenu>
      ))}
    </div>
  );
}

function CardFooter({
  v, compact, onOpen, onFavorite, onWatched, onTrash, onRemoveFromPlaylist, playlists, onAddToPlaylist,
}: GridProps & {
  v: Video;
  compact?: boolean;
}) {
  const btn = cn("size-7", compact ? "size-6" : "");
  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="icon" className={btn} title="Favorite"
        onClick={(e) => { e.stopPropagation(); onFavorite(v); }}>
        <Star className={cn("size-3.5", v.is_favorite && "fill-primary text-primary")} />
      </Button>
      <Button variant="ghost" size="icon" className={btn} title="Watched"
        onClick={(e) => { e.stopPropagation(); onWatched(v); }}>
        {v.is_watched ? <Eye className="size-3.5 text-muted-foreground" /> : <EyeOff className="size-3.5" />}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className={btn} onClick={(e) => e.stopPropagation()}>
            <MoreVertical className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onOpen(v)}><ExternalLink className="size-4" /> Open in browser</DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Add to playlist</DropdownMenuSubTrigger>
            <DropdownMenuContent align="end">
              {playlists.length === 0 && <DropdownMenuItem disabled>No playlists</DropdownMenuItem>}
              {playlists.map((p) => (
                <DropdownMenuItem key={p.id} onClick={() => onAddToPlaylist(v, p.id)}>{p.name}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenuSub>
          <DropdownMenuItem onClick={() => onFavorite(v)}><Star className="size-4" /> Toggle favorite</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onWatched(v)}><EyeOff className="size-4" /> Toggle watched</DropdownMenuItem>
          {onRemoveFromPlaylist && (
            <DropdownMenuItem onClick={() => onRemoveFromPlaylist!(v)}><FolderMinus className="size-4" /> Remove from playlist</DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => onTrash(v)}>
            <Trash2 className="size-4" /> Move to trash
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ctxMenu(props: GridProps, v: Video) {
  return (
    <>
      <ContextMenuItem onClick={() => props.onOpen(v)}><ExternalLink className="size-4" /> Open in browser</ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>Add to playlist</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {props.playlists.length === 0 && <ContextMenuItem disabled>No playlists</ContextMenuItem>}
          {props.playlists.map((p) => (
            <ContextMenuItem key={p.id} onClick={() => props.onAddToPlaylist(v, p.id)}>{p.name}</ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem onClick={() => props.onFavorite(v)}>
        <Star className={cn("size-4", v.is_favorite && "fill-primary text-primary")} /> Toggle favorite
      </ContextMenuItem>
      <ContextMenuItem onClick={() => props.onWatched(v)}><EyeOff className="size-4" /> Toggle watched</ContextMenuItem>
      {props.onRemoveFromPlaylist && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => props.onRemoveFromPlaylist!(v)}><FolderMinus className="size-4" /> Remove from playlist</ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem className="text-destructive" onClick={() => props.onTrash(v)}>
        <Trash2 className="size-4" /> Move to trash
      </ContextMenuItem>
    </>
  );
}

function TrashView({
  trash, onRestore, onPurge, onOpen, onEmpty,
}: {
  trash: TrashEntry[]; onRestore: (t: TrashEntry) => void; onPurge: (t: TrashEntry) => void;
  onOpen: (t: TrashEntry) => void; onEmpty: () => void;
}) {
  if (trash.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <Trash2 className="size-10 opacity-30" />
        <div className="text-sm">Trash is empty.</div>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{trash.length} trashed · only link + title kept</span>
        <Button variant="outline" size="sm" onClick={onEmpty}><Trash2 className="size-4" /> Empty trash</Button>
      </div>
      <div className="flex flex-col divide-y rounded-lg border">
        {trash.map((t) => (
          <div key={t.id} className="flex items-center gap-3 px-3 py-2.5">
            <div className="flex-1">
              <div className="line-clamp-1 text-sm font-medium">{t.title}</div>
              <div className="text-xs text-muted-foreground">{t.channel}</div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onOpen(t)}><ExternalLink className="size-4" /></Button>
            <Button variant="ghost" size="sm" onClick={() => onRestore(t)} title="Restore">Restore</Button>
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => onPurge(t)}>Delete forever</Button>
          </div>
        ))}
      </div>
    </div>
  );
}
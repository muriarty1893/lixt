import { useEffect, useState } from "react";
import { Plus, Search, Trash2, Library, MoreVertical, ExternalLink, FolderMinus, X, Check, Edit3 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Playlist, TrashEntry, Video } from "@/types";
import * as api from "@/lib/api";
import { cn } from "@/lib/utils";

type View = { kind: "all" } | { kind: "playlist"; id: number; name: string } | { kind: "trash" };

export default function App() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [view, setView] = useState<View>({ kind: "all" });
  const [videos, setVideos] = useState<Video[]>([]);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [search, setSearch] = useState("");
  const [thumbCache, setThumbCache] = useState<Record<string, string>>({});
  const [droppingOn, setDroppingOn] = useState<string | null>(null);
  const [addDialog, setAddDialog] = useState(false);
  const [newName, setNewName] = useState("");
  const [renameDialog, setRenameDialog] = useState<Playlist | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  const loadPlaylists = async () => setPlaylists(await api.listPlaylists());
  const loadTrash = async () => setTrash(await api.listTrash());

  const refresh = async () => {
    if (search.trim()) {
      setVideos(await api.searchVideos(search.trim()));
    } else if (view.kind === "all") {
      setVideos(await api.listVideos());
    } else if (view.kind === "playlist") {
      setVideos(await api.listVideos(view.id));
    } else {
      setVideos([]);
    }
  };

  useEffect(() => {
    loadPlaylists();
    loadTrash();
  }, []);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, search]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const ensureThumb = async (v: Video) => {
    if (!v.thumbnail_path) {
      console.warn("video has no thumbnail_path", v.id, v.youtube_id);
      return;
    }
    if (thumbCache[v.id]) return;
    console.log("ensureThumb fetch", v.id, "from", v.thumbnail_path);
    try {
      const blob = await api.readThumbnailBlob(v.thumbnail_path);
      console.log("ensureThumb got blob len", blob.length, "for", v.id);
      setThumbCache((p) => ({ ...p, [v.id]: `data:image/jpeg;base64,${blob}` }));
    } catch (err) {
      console.error("read_thumbnail_blob failed for", v.id, v.thumbnail_path, err);
      flash(`thumb load failed: ${String(err)}`);
    }
  };

  useEffect(() => {
    videos.forEach(ensureThumb);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos]);

  const onAddPlaylist = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      await api.createPlaylist(name);
      await loadPlaylists();
      setNewName("");
      setAddDialog(false);
    } catch (e) {
      flash(`Error: ${e}`);
    }
  };

  const onRename = async () => {
    if (!renameDialog) return;
    const name = renameTo.trim();
    if (!name) return;
    try {
      await api.renamePlaylist(renameDialog.id, name);
      await loadPlaylists();
      if (view.kind === "playlist" && view.id === renameDialog.id) {
        setView({ kind: "playlist", id: renameDialog.id, name });
      }
      setRenameDialog(null);
    } catch (e) {
      flash(`Error: ${e}`);
    }
  };

  const onDeletePlaylist = async (p: Playlist) => {
    if (!confirm(`Delete playlist "${p.name}"? Videos themselves stay (just unsorted).`)) return;
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

  const onDropToPlaylist = async (e: React.DragEvent, playlistId?: number) => {
    e.preventDefault();
    e.stopPropagation();
    setDroppingOn(null);
    const url = extractUrl(e);
    if (!url) {
      flash("Nothing to drop");
      return;
    }
    try {
      await api.addVideo(url, playlistId ? [playlistId] : []);
      await refresh();
      await loadPlaylists();
      flash("Added");
    } catch (err) {
      flash(`Add failed: ${err}`);
    }
  };

  const onDropToAll = (e: React.DragEvent) => onDropToPlaylist(e, undefined);

  const isPlaylistView = (id: number) => view.kind === "playlist" && view.id === id;

  const openVideo = (v: Video | TrashEntry) => {
    api.openUrl(v.url).catch((err) => flash(`Open failed: ${err}`));
  };

  const trashOne = async (v: Video) => {
    if (!confirm(`Move "${v.title}" to trash?`)) return;
    await api.trashVideo(v.id);
    await refresh();
    await loadTrash();
  };

  const restore = async (t: TrashEntry) => {
    await api.restoreFromTrash(t.youtube_id, []);
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

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {/* Sidebar */}
      <aside className="flex w-64 shrink-0 flex-col border-r bg-secondary/30">
        <div className="flex items-center gap-2 px-4 py-4">
          <Library className="size-5 text-primary" />
          <span className="font-semibold tracking-tight">lixt</span>
        </div>
        <Separator />

        <div
          onDrop={onDropToAll}
          onDragOver={(e) => {
            e.preventDefault();
            setDroppingOn("all");
          }}
          onDragLeave={() => setDroppingOn(null)}
          className={cn(
            "px-3 py-2 text-sm transition-colors",
            "hover:bg-accent/40 cursor-pointer",
            view.kind === "all" && "bg-accent/60 font-medium",
            droppingOn === "all" && "ring-2 ring-primary ring-inset rounded-md",
          )}
          onClick={() => setView({ kind: "all" })}
        >
          All videos
        </div>

        <div className="mt-2 flex items-center justify-between px-3">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Playlists</span>
          <Button variant="ghost" size="icon" className="size-7" onClick={() => setAddDialog(true)}>
            <Plus className="size-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-1">
          {playlists.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">No playlists yet.</div>
          )}
          {playlists.map((p) => (
            <div
              key={p.id}
              onDrop={(e) => onDropToPlaylist(e, p.id)}
              onDragOver={(e) => {
                e.preventDefault();
                setDroppingOn(`pl-${p.id}`);
              }}
              onDragLeave={() => setDroppingOn(null)}
              onClick={() => setView({ kind: "playlist", id: p.id, name: p.name })}
              className={cn(
                "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                "hover:bg-accent/40 cursor-pointer",
                isPlaylistView(p.id) && "bg-accent/60 font-medium",
                droppingOn === `pl-${p.id}` && "ring-2 ring-primary ring-inset bg-accent/40",
              )}
            >
              <span className="truncate flex-1">{p.name}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    onClick={(e) => e.stopPropagation()}
                    className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-primary"
                  >
                    <MoreVertical className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenameDialog(p);
                      setRenameTo(p.name);
                    }}
                  >
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
          onDragOver={(e) => {
            e.preventDefault();
            setDroppingOn("trash");
          }}
          onDragLeave={() => setDroppingOn(null)}
          onDrop={(e) => {
            e.preventDefault();
            setDroppingOn(null);
            flash("Drop on a playlist row to add. Trash is for deleted videos.");
          }}
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
            <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {trash.length}
            </span>
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex items-center gap-3 border-b px-4 py-3">
          <div className="relative flex-1 max-w-xl">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by title, channel, or URL…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <div className="text-sm text-muted-foreground">
            {view.kind === "all" && "All videos"}
            {view.kind === "playlist" && view.name}
            {view.kind === "trash" && "Trash"}
          </div>
        </header>

        {/* Content */}
        <section className="flex-1 overflow-y-auto p-4">
          {view.kind === "trash" ? (
            <TrashView
              trash={trash}
              onRestore={restore}
              onPurge={purge}
              onOpen={openVideo}
              onEmpty={emptyAllTrash}
            />
          ) : (
            <VideoGrid
              videos={videos}
              thumbCache={thumbCache}
              view={view}
              onOpen={openVideo}
              onTrash={trashOne}
              onRemoveFromPlaylist={
                view.kind === "playlist"
                  ? async (v) => {
                      await api.removeVideoFromPlaylist(v.id, view.id);
                      await refresh();
                    }
                  : undefined
              }
            />
          )}
        </section>
      </main>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground shadow-lg">
          {toast}
        </div>
      )}

      {/* Add playlist dialog */}
      <Dialog open={addDialog} onOpenChange={setAddDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New playlist</DialogTitle>
            <DialogDescription>Give it a name. You can rename later.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Playlist name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onAddPlaylist()}
          />
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAddDialog(false)}>
              <X className="size-4" /> Cancel
            </Button>
            <Button onClick={onAddPlaylist}>
              <Check className="size-4" /> Create
            </Button>
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
          <Input
            autoFocus
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onRename()}
          />
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenameDialog(null)}>
              <X className="size-4" /> Cancel
            </Button>
            <Button onClick={onRename}>
              <Check className="size-4" /> Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ThumbBox({ src }: { src?: string }) {
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-md bg-muted">
      {src ? (
        <img src={src} alt="" className="size-full object-cover transition-transform group-hover:scale-[1.03]" />
      ) : (
        <div className="flex size-full items-center justify-center text-xs text-muted-foreground">no thumb</div>
      )}
    </div>
  );
}

function VideoGrid({
  videos,
  thumbCache,
  view,
  onOpen,
  onTrash,
  onRemoveFromPlaylist,
}: {
  videos: Video[];
  thumbCache: Record<string, string>;
  view: View;
  onOpen: (v: Video) => void;
  onTrash: (v: Video) => void;
  onRemoveFromPlaylist?: (v: Video) => Promise<void>;
}) {
  if (videos.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <Library className="size-10 opacity-30" />
        <div className="text-sm">
          {view.kind === "all"
            ? "Drag a YouTube URL from your browser onto a playlist in the sidebar."
            : "No videos here yet."}
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {videos.map((v) => (
        <div key={v.id} className="group flex flex-col gap-2 rounded-lg border bg-card p-2 text-sm shadow-sm">
          <ThumbBox src={thumbCache[v.id]} />
          <div className="line-clamp-2 font-medium leading-snug">{v.title}</div>
          <div className="text-xs text-muted-foreground">{v.channel}</div>
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] text-muted-foreground">{v.youtube_id}</span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="size-7" onClick={() => onOpen(v)}>
                <ExternalLink className="size-3.5" />
              </Button>
              {onRemoveFromPlaylist && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  title="Remove from this playlist"
                  onClick={() => onRemoveFromPlaylist(v)}
                >
                  <FolderMinus className="size-3.5" />
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-7">
                    <MoreVertical className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onOpen(v)}>
                    <ExternalLink className="size-4" /> Open in browser
                  </DropdownMenuItem>
                  {onRemoveFromPlaylist && (
                    <DropdownMenuItem onClick={() => onRemoveFromPlaylist(v)}>
                      <FolderMinus className="size-4" /> Remove from playlist
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => onTrash(v)}
                  >
                    <Trash2 className="size-4" /> Move to trash
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function TrashView({
  trash,
  onRestore,
  onPurge,
  onOpen,
  onEmpty,
}: {
  trash: TrashEntry[];
  onRestore: (t: TrashEntry) => void;
  onPurge: (t: TrashEntry) => void;
  onOpen: (t: TrashEntry) => void;
  onEmpty: () => void;
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
        <Button variant="outline" size="sm" onClick={onEmpty}>
          <Trash2 className="size-4" /> Empty trash
        </Button>
      </div>
      <div className="flex flex-col divide-y rounded-lg border">
        {trash.map((t) => (
          <div key={t.id} className="flex items-center gap-3 px-3 py-2.5">
            <div className="flex-1">
              <div className="line-clamp-1 text-sm font-medium">{t.title}</div>
              <div className="text-xs text-muted-foreground">{t.channel}</div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onOpen(t)}>
              <ExternalLink className="size-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onRestore(t)} title="Restore (adds to All videos)">
              Restore
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => onPurge(t)}
            >
              Delete forever
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
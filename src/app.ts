interface Manifest {
  folders: string[];
  images: string[];
  generatedAt: string;
}

interface CacheEntry {
  data: Manifest;
  ts: number;
}

const MANIFEST_URL: string = "cats-manifest.json";
const CACHE_KEY: string = "comg_manifest";
const CACHE_TTL: number = 24 * 60 * 60 * 1000;

class Gallery {
  private el: HTMLElement;
  private paths: string[] = [];
  private selected: Set<string> = new Set();
  private selectMode: boolean = false;
  private scrolling: boolean = false;
  private scrollId: number | null = null;
  private scrollSpeed: number = 0.6;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressFired: boolean = false;

  constructor() {
    this.el = document.getElementById("gallery")!;
    this.bind();
    this.load();
  }

  private getCached(): Manifest | null {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const entry: CacheEntry = JSON.parse(raw);
      if (Date.now() - entry.ts > CACHE_TTL) {
        localStorage.removeItem(CACHE_KEY);
        return null;
      }
      return entry.data;
    } catch {
      return null;
    }
  }

  private cache(data: Manifest): void {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
    } catch {}
  }

  private async fetchManifest(): Promise<Manifest> {
    const cached = this.getCached();
    if (cached) {
      this.setStatus("Loaded from cache");
      return cached;
    }

    try {
      const res = await fetch(`${MANIFEST_URL}?_=${Date.now()}`);
      if (!res.ok) throw new Error(String(res.status));
      const data: Manifest = await res.json();
      this.cache(data);
      this.setStatus("Manifest loaded");
      return data;
    } catch {
      this.setStatus("Manifest not found");
      return { folders: [], images: [], generatedAt: "" };
    }
  }

  private async load(): Promise<void> {
    this.setStatus("Loading...");
    const manifest = await this.fetchManifest();
    this.paths = manifest.images;
    this.renderBadges(manifest.folders);
    this.updateCount();
    this.render();
    if (this.paths.length === 0) this.setStatus("No images - run build.js");
  }

  private setStatus(text: string): void {
    document.getElementById("statusText")!.textContent = text;
  }

  private updateCount(): void {
    document.getElementById("imageCount")!.textContent = `${this.paths.length} images`;
  }

  private renderBadges(folders: string[]): void {
    const container = document.getElementById("folderBadges")!;
    container.innerHTML = "";
    folders.forEach((f) => {
      const span = document.createElement("span");
      span.className = "folder-badge";
      span.textContent = f;
      container.appendChild(span);
    });
  }

  private render(): void {
    this.el.innerHTML = "";
    if (this.paths.length === 0) {
      document.getElementById("emptyState")!.classList.add("visible");
      return;
    }
    document.getElementById("emptyState")!.classList.remove("visible");
    const frag = document.createDocumentFragment();
    this.paths.forEach((p, i) => frag.appendChild(this.card(p, i)));
    this.el.appendChild(frag);
  }

  private card(path: string, index: number): HTMLElement {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.index = String(index);
    card.dataset.path = path;

    const img = document.createElement("img");
    img.src = path;
    img.alt = "";
    img.loading = "lazy";
    img.draggable = false;
    img.onerror = () => { card.style.display = "none"; };

    const actions = document.createElement("div");
    actions.className = "card-actions";

    const check = document.createElement("div");
    check.className = "card-check";
    check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

    const tweet = document.createElement("button");
    tweet.className = "card-tweet";
    tweet.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
    tweet.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.tweet(path);
    });

    actions.appendChild(check);
    actions.appendChild(tweet);
    card.appendChild(img);
    card.appendChild(actions);

    card.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      this.longPressFired = false;
      this.longPressTimer = setTimeout(() => {
        this.longPressFired = true;
        if (!this.selectMode) this.enterSelect();
        this.toggle(card, path);
      }, 500);
    });

    card.addEventListener("pointerup", () => this.clearLongPress());
    card.addEventListener("pointercancel", () => this.clearLongPress());
    card.addEventListener("pointermove", () => this.clearLongPress());

    card.addEventListener("click", (e) => {
      if (this.longPressFired) { e.preventDefault(); return; }
      if (this.selectMode) { e.preventDefault(); this.toggle(card, path); }
    });

    return card;
  }

  private clearLongPress(): void {
    if (this.longPressTimer) { clearTimeout(this.longPressTimer); this.longPressTimer = null; }
  }

  private toggle(card: HTMLElement, path: string): void {
    if (this.selected.has(path)) {
      this.selected.delete(path);
      card.classList.remove("selected");
    } else {
      this.selected.add(path);
      card.classList.add("selected");
    }
    this.refreshUI();
  }

  private enterSelect(): void {
    this.selectMode = true;
    document.body.classList.add("select-mode");
  }

  private exitSelect(): void {
    this.selectMode = false;
    document.body.classList.remove("select-mode");
    this.selected.clear();
    this.el.querySelectorAll(".card.selected").forEach((el) => el.classList.remove("selected"));
    this.refreshUI();
  }

  private refreshUI(): void {
    const counter = document.getElementById("selectionCount")!;
    const dlBtn = document.getElementById("downloadBtn") as HTMLButtonElement;
    const count = this.selected.size;
    counter.textContent = count > 0 ? `${count} selected` : "";
    dlBtn.style.display = count > 0 ? "inline-flex" : "none";
  }

  private async download(): Promise<void> {
    if (this.selected.size === 0) return;
    const dlBtn = document.getElementById("downloadBtn") as HTMLButtonElement;
    dlBtn.textContent = "Packing...";
    dlBtn.disabled = true;
    this.setStatus("Creating ZIP...");

    try {
      const zip = new (window as any).JSZip();
      const arr = Array.from(this.selected);
      await Promise.all(arr.map((p, i) =>
        fetch(p).then((r) => r.blob()).then((blob) => {
          const name = p.split("/").pop() || `cat_${i + 1}.jpg`;
          zip.file(name, blob);
        }).catch(() => {})
      ));
      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement("a");
      a.href = url;
      a.download = "cat_oh_my_god.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.setStatus("ZIP downloaded");
    } catch {
      this.setStatus("ZIP failed");
    }

    dlBtn.textContent = "Download ZIP";
    dlBtn.disabled = false;
  }

  private tweet(path: string): void {
    const base = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, "/");
    const full = base + path;
    const text = encodeURIComponent("Check out this cat! #CatOhMyGod #Cats");
    const url = encodeURIComponent(full);
    window.open(`https://twitter.com/intent/tweet?text=${text}&url=${url}`, "_blank", "noopener");
  }

  private shuffle(): void {
    for (let i = this.paths.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.paths[i], this.paths[j]] = [this.paths[j], this.paths[i]];
    }
    this.render();
    this.setStatus("Shuffled");
  }

  private startScroll(): void {
    if (this.scrollId) return;
    const tick = (): void => {
      this.el.scrollTop += this.scrollSpeed;
      this.scrollId = requestAnimationFrame(tick);
    };
    this.scrollId = requestAnimationFrame(tick);
  }

  private stopScroll(): void {
    if (this.scrollId) { cancelAnimationFrame(this.scrollId); this.scrollId = null; }
  }

  private toggleScroll(): void {
    this.scrolling = !this.scrolling;
    const btn = document.getElementById("scrollToggle")!;
    if (this.scrolling) {
      this.startScroll();
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause';
    } else {
      this.stopScroll();
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Auto';
    }
  }

  private bind(): void {
    document.getElementById("selectBtn")!.addEventListener("click", () => {
      if (this.selectMode) this.exitSelect(); else this.enterSelect();
    });
    document.getElementById("downloadBtn")!.addEventListener("click", () => this.download());
    document.getElementById("scrollTopBtn")!.addEventListener("click", () => {
      this.el.scrollTo({ top: 0, behavior: "smooth" });
    });
    document.getElementById("scrollToggle")!.addEventListener("click", () => this.toggleScroll());
    document.getElementById("shuffleBtn")!.addEventListener("click", () => this.shuffle());

    this.el.addEventListener("pointerenter", () => { if (this.scrolling) this.stopScroll(); });
    this.el.addEventListener("pointerleave", () => { if (this.scrolling) this.startScroll(); });
    this.el.addEventListener("touchstart", () => { if (this.scrolling) this.stopScroll(); }, { passive: true });
    this.el.addEventListener("touchend", () => { if (this.scrolling) setTimeout(() => this.startScroll(), 2000); });
  }
}

document.addEventListener("DOMContentLoaded", () => new Gallery());

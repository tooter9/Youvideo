interface CatImage {
  id: string;
  url: string;
  width: number;
  height: number;
}

interface CacheEntry {
  images: CatImage[];
  timestamp: number;
}

const CACHE_KEY = 'minecraft_cats_cache';
const CACHE_DURATION = 30 * 60 * 1000;
const BATCH_SIZE = 25;
const API_URL = 'https://api.thecatapi.com/v1/images/search';

class CatGallery {
  private container: HTMLElement;
  private selectedIds: Set<string> = new Set();
  private allImages: CatImage[] = [];
  private isSelectMode: boolean = false;
  private isLoading: boolean = false;
  private scrollSpeed: number = 0.5;
  private animationId: number | null = null;

  constructor() {
    this.container = document.getElementById('gallery')!;
    this.init();
  }

  private async init(): Promise<void> {
    this.setupEventListeners();
    await this.loadImages();
    this.startAutoScroll();
  }

  private getCache(): CacheEntry | null {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const entry: CacheEntry = JSON.parse(raw);
      if (Date.now() - entry.timestamp > CACHE_DURATION) {
        localStorage.removeItem(CACHE_KEY);
        return null;
      }
      return entry;
    } catch {
      return null;
    }
  }

  private setCache(images: CatImage[]): void {
    const entry: CacheEntry = { images, timestamp: Date.now() };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
    } catch {
      console.warn('Cache storage failed');
    }
  }

  private async fetchCats(count: number = BATCH_SIZE): Promise<CatImage[]> {
    const cached = this.getCache();
    if (cached && cached.images.length >= count) {
      return cached.images;
    }

    try {
      const res = await fetch(`${API_URL}?limit=${count}&size=small`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data: CatImage[] = await res.json();
      
      const merged = [...(cached?.images || [])];
      const existingIds = new Set(merged.map(i => i.id));
      for (const img of data) {
        if (!existingIds.has(img.id)) {
          merged.push(img);
          existingIds.add(img.id);
        }
      }
      this.setCache(merged);
      return data;
    } catch (err) {
      console.error('Fetch failed:', err);
      return cached?.images || [];
    }
  }

  private async loadImages(): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;
    this.showLoading(true);

    const images = await this.fetchCats(BATCH_SIZE);
    this.allImages.push(...images);
    this.renderImages(images);

    this.showLoading(false);
    this.isLoading = false;
  }

  private renderImages(images: CatImage[]): void {
    for (const img of images) {
      const card = this.createCard(img);
      this.container.appendChild(card);
    }
  }

  private createCard(cat: CatImage): HTMLElement {
    const card = document.createElement('div');
    card.className = 'cat-card';
    card.dataset.id = cat.id;

    const img = document.createElement('img');
    img.src = cat.url;
    img.alt = 'Cat';
    img.loading = 'lazy';
    img.draggable = false;

    const overlay = document.createElement('div');
    overlay.className = 'card-overlay';

    const checkbox = document.createElement('div');
    checkbox.className = 'card-checkbox';
    checkbox.innerHTML = '&#10003;';

    const tweetBtn = document.createElement('button');
    tweetBtn.className = 'tweet-btn';
    tweetBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
    tweetBtn.title = 'Tweet this cat';
    tweetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.tweetCat(cat);
    });

    overlay.appendChild(checkbox);
    overlay.appendChild(tweetBtn);
    card.appendChild(img);
    card.appendChild(overlay);

    let pressTimer: ReturnType<typeof setTimeout> | null = null;

    card.addEventListener('pointerdown', () => {
      pressTimer = setTimeout(() => {
        if (!this.isSelectMode) this.toggleSelectMode();
        this.toggleSelect(card, cat.id);
      }, 500);
    });

    card.addEventListener('pointerup', () => {
      if (pressTimer) clearTimeout(pressTimer);
    });

    card.addEventListener('pointerleave', () => {
      if (pressTimer) clearTimeout(pressTimer);
    });

    card.addEventListener('click', () => {
      if (this.isSelectMode) {
        this.toggleSelect(card, cat.id);
      }
    });

    return card;
  }

  private toggleSelect(card: HTMLElement, id: string): void {
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
      card.classList.remove('selected');
    } else {
      this.selectedIds.add(id);
      card.classList.add('selected');
    }
    this.updateSelectionUI();
  }

  private toggleSelectMode(): void {
    this.isSelectMode = !this.isSelectMode;
    document.body.classList.toggle('select-mode', this.isSelectMode);
    const btn = document.getElementById('selectBtn')!;
    btn.textContent = this.isSelectMode ? 'Cancel' : 'Select';
    
    if (!this.isSelectMode) {
      this.clearSelection();
    }
    this.updateSelectionUI();
  }

  private clearSelection(): void {
    this.selectedIds.clear();
    document.querySelectorAll('.cat-card.selected').forEach(el => {
      el.classList.remove('selected');
    });
  }

  private updateSelectionUI(): void {
    const counter = document.getElementById('selectionCount')!;
    const downloadBtn = document.getElementById('downloadBtn')!;
    const count = this.selectedIds.size;
    counter.textContent = count > 0 ? `${count} selected` : '';
    downloadBtn.style.display = count > 0 ? 'flex' : 'none';
  }

  private async downloadSelected(): Promise<void> {
    if (this.selectedIds.size === 0) return;

    const downloadBtn = document.getElementById('downloadBtn')!;
    downloadBtn.textContent = 'Packing...';
    downloadBtn.setAttribute('disabled', 'true');

    try {
      const JSZip = (window as any).JSZip;
      const zip = new JSZip();

      const selectedImages = this.allImages.filter(img => this.selectedIds.has(img.id));

      await Promise.all(selectedImages.map(async (img, i) => {
        try {
          const res = await fetch(img.url);
          const blob = await res.blob();
          const ext = img.url.split('.').pop()?.split('?')[0] || 'jpg';
          zip.file(`cat_${i + 1}.${ext}`, blob);
        } catch {
          console.warn(`Failed to fetch: ${img.url}`);
        }
      }));

      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'minecraft_cats.zip';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('ZIP creation failed:', err);
      alert('Failed to create ZIP. Please try again.');
    }

    downloadBtn.textContent = 'Download ZIP';
    downloadBtn.removeAttribute('disabled');
  }

  private tweetCat(cat: CatImage): void {
    const text = encodeURIComponent('Check out this cute cat! 🐱 #MinecraftCats #CatsOfTwitter');
    const url = encodeURIComponent(cat.url);
    window.open(`https://twitter.com/intent/tweet?text=${text}&url=${url}`, '_blank');
  }

  private startAutoScroll(): void {
    const scroll = (): void => {
      this.container.scrollTop += this.scrollSpeed;
      
      if (this.container.scrollTop + this.container.clientHeight >= this.container.scrollHeight - 200) {
        this.loadImages();
      }
      
      this.animationId = requestAnimationFrame(scroll);
    };
    this.animationId = requestAnimationFrame(scroll);

    this.container.addEventListener('mouseenter', () => {
      if (this.animationId) {
        cancelAnimationFrame(this.animationId);
        this.animationId = null;
      }
    });

    this.container.addEventListener('mouseleave', () => {
      if (!this.animationId) {
        this.animationId = requestAnimationFrame(scroll);
      }
    });
  }

  private showLoading(show: boolean): void {
    const loader = document.getElementById('loader')!;
    loader.style.display = show ? 'flex' : 'none';
  }

  private setupEventListeners(): void {
    document.getElementById('selectBtn')!.addEventListener('click', () => {
      this.toggleSelectMode();
    });

    document.getElementById('downloadBtn')!.addEventListener('click', () => {
      this.downloadSelected();
    });

    document.getElementById('refreshBtn')!.addEventListener('click', async () => {
      localStorage.removeItem(CACHE_KEY);
      this.container.innerHTML = '';
      this.allImages = [];
      await this.loadImages();
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new CatGallery();
});

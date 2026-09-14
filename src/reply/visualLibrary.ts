import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/paths';

export type VisualItemType = 'braille' | 'ascii' | 'kaomoji' | 'emoji' | 'steam' | 'custom';

export interface VisualReplyItem {
  id: string;
  type: VisualItemType;
  content: string;
  enabled: boolean;
  tags: string[];
  mood: string[];
  style?: string;
  weight: number;
  description?: string;
  cooldownSeconds?: number;
  allowRepeat?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface VisualSelectCriteria {
  type?: VisualItemType | VisualItemType[];
  tags?: string[];
  mood?: string[];
  complement?: boolean;
}

export class VisualReplyLibrary {
  private baseDir: string;
  private items: Map<string, VisualReplyItem> = new Map();
  private itemFileMap: Map<string, string> = new Map();
  private recentSelections: string[] = [];
  private userRecentSelections: Map<string, string[]> = new Map();
  private maxHistory: number = 20;

  constructor(customDir?: string) {
    this.baseDir = customDir || path.resolve(getDataDir(), 'visual-replies');
    this.ensureInitialized();
    this.loadAll();
  }

  public getBaseDir(): string {
    return this.baseDir;
  }

  /**
   * Initializes the library directory and seeds default starter files if not present.
   * Strictly preserves existing files to guarantee zero overwrite of user customizations.
   */
  public ensureInitialized(): void {
    if (!fs.existsSync(this.baseDir)) {
      try {
        fs.mkdirSync(this.baseDir, { recursive: true });
      } catch (err: any) {
        console.warn(`[VisualReplyLibrary] Failed to create directory ${this.baseDir}:`, err.message);
        return;
      }
    }

    const defaultSeeders: { file: string; items: VisualReplyItem[] }[] = [
      {
        file: 'braille.json',
        items: [
          {
            id: 'braille_sparkle_heart',
            type: 'braille',
            content: '⢀⡤⣄⡀⠀⠀⠀⠀⣀⣤⡀\n⢠⡏⠀⠈⠳⡄⢠⠞⠁⠀⢹⡄\n⠘⣇⠀⠀⠀⠹⠏⠀⠀⠀⢸⠃\n⠀⠘⢧⡀⠀⠀⠀⠀⠀⡴⠃⠀\n⠀⠀⠀⠉⠓⠲⠤⠖⠛⠁⠀⠀',
            enabled: true,
            tags: ['heart', 'warm', 'compact'],
            mood: ['happy', 'friendly'],
            style: 'compact',
            weight: 20,
            description: '精致小型 Braille 爱心'
          },
          {
            id: 'braille_cute_paw',
            type: 'braille',
            content: '⠀⢀⣠⣄⡀⠀⢀⣀⣀⡀⠀\n⠀⣾⠁⠈⢹⣆⣼⠃⠀⢹⡆\n⠀⠙⠷⠶⠿⠋⠹⠷⠶⠿⠃\n⠀⢀⣴⣶⣄⠀⣠⣶⣦⡀⠀\n⠀⢸⣿⣿⣿⣿⣿⣿⣿⡇⠀\n⠀⠈⠻⢿⣿⣿⣿⣿⠟⠁⠀',
            enabled: true,
            tags: ['paw', 'cat', 'cute'],
            mood: ['playful', 'friendly'],
            style: 'compact',
            weight: 15,
            description: '可爱猫爪 Braille'
          },
          {
            id: 'braille_star_sparkle',
            type: 'braille',
            content: '⠀⠀⠀⢠⡄⠀⠀⠀\n⠀⠀⢀⣸⣇⡀⠀⠀\n⠒⠚⠛⣿⣿⠛⠓⠒\n⠀⠀⠘⠛⣿⠃⠀⠀\n⠀⠀⠀⠠⠿⠄⠀⠀',
            enabled: true,
            tags: ['star', 'sparkle'],
            mood: ['positive'],
            style: 'mini',
            weight: 12,
            description: '闪烁小星星'
          }
        ]
      },
      {
        file: 'kaomoji.json',
        items: [
          {
            id: 'kaomoji_warm_heart',
            type: 'kaomoji',
            content: '(｡･ω･｡)ﾉ♡ 来踩踩～祝游戏愉快！',
            enabled: true,
            tags: ['warm', 'greeting', 'heart'],
            mood: ['happy', 'friendly'],
            style: 'single_line',
            weight: 25,
            description: '温暖爱心挥手颜文字'
          },
          {
            id: 'kaomoji_happy_sparkle',
            type: 'kaomoji',
            content: '✨(*^▽^*)✨ 感谢回访！今天也要开开心心玩游戏～',
            enabled: true,
            tags: ['happy', 'sparkle'],
            mood: ['happy', 'playful'],
            style: 'single_line',
            weight: 20,
            description: '开朗笑脸颜文字'
          },
          {
            id: 'kaomoji_polite_bow',
            type: 'kaomoji',
            content: '(ฅ´ω`ฅ) 暖暖主页～祝顺顺利利！',
            enabled: true,
            tags: ['cute', 'cat', 'polite'],
            mood: ['friendly', 'warm'],
            style: 'single_line',
            weight: 18,
            description: '萌萌小猫爪颜文字'
          },
          {
            id: 'kaomoji_victory_cheer',
            type: 'kaomoji',
            content: '(๑•̀ㅂ•́)و✧ 加油冲冲冲！常来玩哦～',
            enabled: true,
            tags: ['cheer', 'power'],
            mood: ['positive', 'playful'],
            style: 'single_line',
            weight: 15,
            description: '打气奋斗颜文字'
          }
        ]
      },
      {
        file: 'ascii.json',
        items: [
          {
            id: 'ascii_mini_bunny',
            type: 'ascii',
            content: ' /\\_/\\\n( o.o )\n > ^ <  ✨ 感谢来踩！',
            enabled: true,
            tags: ['bunny', 'cat', 'mini'],
            mood: ['cute', 'friendly'],
            style: 'compact',
            weight: 15,
            description: '迷你小兔/小猫 ASCII'
          },
          {
            id: 'ascii_star_badge',
            type: 'ascii',
            content: ' ★*゜*☆*゜*★\n 祝你天天开心！\n ★*゜*☆*゜*★',
            enabled: true,
            tags: ['star', 'blessing'],
            mood: ['happy', 'warm'],
            style: 'badge',
            weight: 15,
            description: '星光祝福横幅'
          }
        ]
      },
      {
        file: 'emoji.json',
        items: [
          {
            id: 'emoji_gaming_vibes',
            type: 'emoji',
            content: '🎮✨ ( •̀ ω •́ )✧ 游戏愉快！把把超神～ 🏆🔥',
            enabled: true,
            tags: ['gaming', 'victory', 'vibes'],
            mood: ['playful', 'happy'],
            style: 'combo',
            weight: 20,
            description: '游戏超神组合 Emoji'
          },
          {
            id: 'emoji_tea_cozy',
            type: 'emoji',
            content: '☕🍪 暖暖主页，祝你今天也是美好的一天～ 🌸🍃',
            enabled: true,
            tags: ['cozy', 'warm', 'tea'],
            mood: ['warm', 'relaxing'],
            style: 'combo',
            weight: 20,
            description: '午后红茶治愈 Emoji'
          }
        ]
      },
      {
        file: 'steam.json',
        items: [
          {
            id: 'steam_plus_rep_friendly',
            type: 'steam',
            content: '➕ ʀᴇᴘ ✨ 友善的 Steam 好友！常来常往～ 🎮',
            enabled: true,
            tags: ['rep', 'steam_style'],
            mood: ['friendly'],
            style: 'steam_rep',
            weight: 15,
            description: '经典 Steam +rep 风格回访'
          }
        ]
      },
      {
        file: 'custom.json',
        items: []
      }
    ];

    for (const seeder of defaultSeeders) {
      const filePath = path.join(this.baseDir, seeder.file);
      if (!fs.existsSync(filePath)) {
        try {
          fs.writeFileSync(filePath, JSON.stringify(seeder.items, null, 2), 'utf8');
        } catch (err: any) {
          console.warn(`[VisualReplyLibrary] Failed to seed ${filePath}:`, err.message);
        }
      }
    }
  }

  /**
   * Loads all *.json files from baseDir into memory.
   */
  public loadAll(): void {
    this.items.clear();
    this.itemFileMap.clear();

    if (!fs.existsSync(this.baseDir)) return;

    try {
      const files = fs.readdirSync(this.baseDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(this.baseDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const data = JSON.parse(content);
          if (Array.isArray(data)) {
            for (const item of data) {
              if (item && item.id && item.content) {
                const normalized: VisualReplyItem = {
                  id: String(item.id),
                  type: (item.type || 'custom') as VisualItemType,
                  content: String(item.content),
                  enabled: item.enabled !== false,
                  tags: Array.isArray(item.tags) ? item.tags : [],
                  mood: Array.isArray(item.mood) ? item.mood : [],
                  style: item.style || 'default',
                  weight: typeof item.weight === 'number' && item.weight > 0 ? item.weight : 10,
                  description: item.description,
                  cooldownSeconds: item.cooldownSeconds,
                  allowRepeat: item.allowRepeat !== false,
                  createdAt: item.createdAt,
                  updatedAt: item.updatedAt
                };
                this.items.set(normalized.id, normalized);
                this.itemFileMap.set(normalized.id, file);
              }
            }
          }
        } catch (err: any) {
          console.warn(`[VisualReplyLibrary] Error parsing ${file}:`, err.message);
        }
      }
    } catch (err: any) {
      console.warn(`[VisualReplyLibrary] Failed to list files in ${this.baseDir}:`, err.message);
    }
  }

  public getAllItems(filter?: { type?: VisualItemType; enabledOnly?: boolean }): VisualReplyItem[] {
    let list = Array.from(this.items.values());
    if (filter) {
      if (filter.enabledOnly) {
        list = list.filter(i => i.enabled);
      }
      if (filter.type) {
        list = list.filter(i => i.type === filter.type);
      }
    }
    return list;
  }

  public getItemById(id: string): VisualReplyItem | undefined {
    return this.items.get(id);
  }

  /**
   * Adds or updates a visual reply item and writes to disk.
   */
  public saveItem(item: VisualReplyItem, fileCategory?: string): void {
    const existingFile = this.itemFileMap.get(item.id);
    const targetFile = existingFile || (fileCategory ? (fileCategory.endsWith('.json') ? fileCategory : `${fileCategory}.json`) : `${item.type}.json`);
    const filePath = path.join(this.baseDir, targetFile);

    const now = new Date().toISOString();
    if (!item.createdAt) item.createdAt = now;
    item.updatedAt = now;

    // Load or initialize array in target file
    let fileItems: VisualReplyItem[] = [];
    if (fs.existsSync(filePath)) {
      try {
        fileItems = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!Array.isArray(fileItems)) fileItems = [];
      } catch {
        fileItems = [];
      }
    }

    const idx = fileItems.findIndex(i => i.id === item.id);
    if (idx >= 0) {
      fileItems[idx] = item;
    } else {
      fileItems.push(item);
    }

    fs.writeFileSync(filePath, JSON.stringify(fileItems, null, 2), 'utf8');

    this.items.set(item.id, item);
    this.itemFileMap.set(item.id, targetFile);
  }

  /**
   * Toggles the enabled state of an item.
   */
  public toggleEnabled(id: string, enabledState?: boolean): VisualReplyItem | null {
    const item = this.items.get(id);
    if (!item) return null;

    item.enabled = typeof enabledState === 'boolean' ? enabledState : !item.enabled;
    this.saveItem(item);
    return item;
  }

  /**
   * Deletes an item by ID from memory and disk.
   */
  public deleteItem(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;

    const file = this.itemFileMap.get(id);
    if (file) {
      const filePath = path.join(this.baseDir, file);
      if (fs.existsSync(filePath)) {
        try {
          let fileItems: VisualReplyItem[] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (Array.isArray(fileItems)) {
            fileItems = fileItems.filter(i => i.id !== id);
            fs.writeFileSync(filePath, JSON.stringify(fileItems, null, 2), 'utf8');
          }
        } catch (err: any) {
          console.warn(`[VisualReplyLibrary] Failed to delete item from ${file}:`, err.message);
        }
      }
    }

    this.items.delete(id);
    this.itemFileMap.delete(id);
    return true;
  }

  /**
   * Selects a curated visual reply item based on criteria, weights, and anti-repeat history.
   */
  public select(
    criteria: VisualSelectCriteria,
    context?: { commenterSteamId?: string }
  ): VisualReplyItem | null {
    let pool = Array.from(this.items.values()).filter(i => i.enabled);
    if (pool.length === 0) return null;

    // Filter by type
    if (criteria.type) {
      const allowedTypes = Array.isArray(criteria.type) ? criteria.type : [criteria.type];
      let typeMatches = pool.filter(i => allowedTypes.includes(i.type));

      if (typeMatches.length > 0) {
        pool = typeMatches;
      } else if (criteria.complement) {
        // If complement is allowed and direct type is missing, fallback to expressive types (kaomoji, emoji, steam)
        const complementTypes: VisualItemType[] = ['kaomoji', 'emoji', 'steam', 'custom'];
        const complementMatches = pool.filter(i => complementTypes.includes(i.type));
        if (complementMatches.length > 0) {
          pool = complementMatches;
        }
      } else {
        return null;
      }
    }

    // Filter by tags
    if (criteria.tags && criteria.tags.length > 0) {
      pool = pool.filter(i => i.tags && i.tags.some(t => criteria.tags!.includes(t)));
      if (pool.length === 0) return null;
    }

    // Filter by mood
    if (criteria.mood && criteria.mood.length > 0) {
      pool = pool.filter(i => i.mood && i.mood.some(m => criteria.mood!.includes(m)));
      if (pool.length === 0) return null;
    }

    // Anti-repeat: avoid recently selected items globally
    let candidates = pool.filter(i => !this.recentSelections.includes(i.id));
    if (candidates.length === 0) candidates = pool;

    // Anti-repeat: avoid recently selected items for this user
    const steamId = context?.commenterSteamId;
    if (steamId && this.userRecentSelections.has(steamId)) {
      const userHistory = this.userRecentSelections.get(steamId)!;
      const userFiltered = candidates.filter(i => !userHistory.includes(i.id));
      if (userFiltered.length > 0) {
        candidates = userFiltered;
      }
    }

    // Weighted Random Selection
    const selected = this.weightedRandomSelect(candidates);
    if (selected) {
      this.recordSelection(selected.id, steamId);
    }

    return selected;
  }

  private weightedRandomSelect(items: VisualReplyItem[]): VisualReplyItem | null {
    if (items.length === 0) return null;
    if (items.length === 1) return items[0];

    let totalWeight = 0;
    for (const it of items) {
      totalWeight += Math.max(1, it.weight || 10);
    }

    let randomVal = Math.random() * totalWeight;
    for (const it of items) {
      const w = Math.max(1, it.weight || 10);
      if (randomVal < w) {
        return it;
      }
      randomVal -= w;
    }

    return items[items.length - 1];
  }

  private recordSelection(id: string, steamId?: string): void {
    this.recentSelections.push(id);
    if (this.recentSelections.length > this.maxHistory) {
      this.recentSelections.shift();
    }

    if (steamId) {
      let list = this.userRecentSelections.get(steamId);
      if (!list) {
        list = [];
        this.userRecentSelections.set(steamId, list);
      }
      list.push(id);
      if (list.length > 10) {
        list.shift();
      }
    }
  }
}

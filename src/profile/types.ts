/**
 * Steam Self-Profile Analysis, Knowledge Base, and Persona System Types.
 */

export interface ShowcaseItem {
  title?: string;
  text?: string;
  imageUrl?: string;
}

export interface ProfileShowcase {
  type: string;
  title: string;
  items: ShowcaseItem[];
}

export interface RecentGameRecord {
  name: string;
  hoursTwoWeeks?: number;
  hoursTotal?: number;
  appId?: string;
}

export interface SteamProfileData {
  steamId: string;
  personaName: string;
  realName?: string;
  customUrl?: string;
  avatarUrl: string;
  level?: number;
  summary: string;
  backgroundUrl?: string;
  showcases: ProfileShowcase[];
  customSymbols: string[];
  languagesDetected: string[];
  recentGames: RecentGameRecord[];
  replaySummary?: {
    available: boolean;
    year?: number;
    highlights?: string[];
  } | 'unavailable';
}

export interface PlayedGameRecord {
  name: string;
  hours: number;
  appId?: string;
  lastPlayed?: string;
}

export interface SteamGameHistory {
  totalGames: number;
  topPlayedGames: PlayedGameRecord[];
  recentActiveGames: RecentGameRecord[];
  favoriteGenres?: string[];
}

export interface ProfileVisualSnapshot {
  headerScreenshotPath?: string;
  showcaseScreenshotPath?: string;
  visualSummary: {
    colorSchemeEstimate?: string;
    aestheticTone?: string;
    hasAnimatedBackground?: boolean;
    hasCustomArtwork?: boolean;
    badgeCount?: number;
  };
  screenshotHashes: string[];
}

export interface FullProfileSnapshot {
  version: string;
  capturedAt: string;
  fingerprint: string;
  profile: SteamProfileData;
  games: SteamGameHistory;
  visual: ProfileVisualSnapshot;
}

export interface KnowledgeFact {
  id: string;
  category: 'identity' | 'games' | 'habits' | 'showcase' | 'topics';
  content: string;
  source: string;
  confidence: number;
  addedAt: string;
  enabled: boolean;
}

export interface KnowledgeInference {
  id: string;
  category: 'preferences' | 'aesthetic' | 'communication' | 'profileStyle' | 'topics';
  content: string;
  evidence: string[];
  confidence: number;
  addedAt: string;
  enabled: boolean;
}

export interface KnowledgeBaseData {
  version: string;
  updatedAt: string;
  facts: KnowledgeFact[];
  inferences: KnowledgeInference[];
}

export type ConfidenceLevel = 'HIGH_CONFIDENCE' | 'MEDIUM_CONFIDENCE' | 'LOW_CONFIDENCE';

export interface PersonaSuggestion {
  id: string;
  title: string;
  suggestion: string;
  category: 'tone' | 'interests' | 'topics' | 'style';
  confidenceLevel: ConfidenceLevel;
  confidenceScore: number;
  evidence: string[];
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
}

export interface FormalPersona {
  name: string;
  tone: 'friendly' | 'playful' | 'polite' | 'cool' | 'scholarly';
  traits: string[];
  favoriteGames: string[];
  communicationStyle: string[];
  recommendedTopics: string[];
  avoidTopics: string[];
  updatedAt: string;
}

export interface AnalysisMeta {
  lastSyncAt: string | null;
  lastAnalyzedAt: string | null;
  lastAnalyzedFingerprint: string | null;
  currentFingerprint: string | null;
  analysisMode: 'MANUAL' | 'AUTO_IF_CHANGED' | 'DISABLED';
  status: 'idle' | 'syncing' | 'analyzing' | 'completed' | 'failed';
  lastError: string | null;
  deepSeekVisionUsed: boolean;
}

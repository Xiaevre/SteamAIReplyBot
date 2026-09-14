import { FullProfileSnapshot, KnowledgeFact, KnowledgeInference, PersonaSuggestion, ConfidenceLevel } from './types';
import { DeepSeekClient } from '../ai/deepseek';
import { Logger } from '../utils/logger';

export interface CuratorResult {
  facts: Array<Omit<KnowledgeFact, 'id' | 'addedAt'>>;
  inferences: Array<Omit<KnowledgeInference, 'id' | 'addedAt'>>;
  personaSuggestions: Array<Omit<PersonaSuggestion, 'id' | 'createdAt'>>;
  summary: {
    aestheticProfile?: string;
    gamingFocus?: string;
    communicationStyle?: string;
    profileStyle?: string;
    recommendedTopics: string[];
    avoidAssumptions: string[];
  };
}

export class DeepSeekProfileCurator {
  constructor(
    private deepseekClient: DeepSeekClient,
    private logger: Logger
  ) {}

  /**
   * Performs an asynchronous, low-frequency profile analysis via DeepSeek.
   * Strictly differentiates objective FACTS from subjective INFERENCES and PERSONA SUGGESTIONS.
   */
  public async analyzeSnapshot(snapshot: FullProfileSnapshot): Promise<CuratorResult | null> {
    this.logger.info('DEEPSEEK_PROFILE_CURATION_STARTED', {
      fingerprint: snapshot.fingerprint,
      steamId: snapshot.profile.steamId,
      personaName: snapshot.profile.personaName
    });

    const promptData = {
      ownerPersonaName: snapshot.profile.personaName,
      ownerLevel: snapshot.profile.level,
      ownerSummary: snapshot.profile.summary,
      customSymbols: snapshot.profile.customSymbols,
      languagesDetected: snapshot.profile.languagesDetected,
      backgroundUrl: snapshot.profile.backgroundUrl ? 'Custom Background Active' : 'Default',
      showcases: snapshot.profile.showcases.map(s => ({
        type: s.type,
        title: s.title,
        items: s.items.map(i => ({ title: i.title, text: i.text }))
      })),
      topGames: snapshot.games.topPlayedGames.slice(0, 15).map(g => ({
        name: g.name,
        hours: g.hours
      })),
      recentGames: snapshot.games.recentActiveGames.map(g => ({
        name: g.name,
        hoursTwoWeeks: g.hoursTwoWeeks
      })),
      visualSummary: snapshot.visual.visualSummary
    };

    const systemPrompt = `你是一个专业的 Steam 玩家资料与人设整理分析器。
你的目标是分析机器人账号主人（即当前 Steam 账号）的公开 Steam 资料、游戏游玩历史、主页展柜 DIY 与视觉风格，为机器人整理出客观事实 (FACTS)、合理推断 (INFERENCES) 以及人设建议 (PERSONA_SUGGESTIONS)。

【绝对安全准则与禁区】
1. 绝对不要推测或记录任何敏感隐私信息：严禁推测政治立场、宗教信仰、民族、健康状况、性取向、现实姓名、现实居住城市/地址、现实职业。
2. 专注于：游戏偏好与爱好、审美倾向、主页风格、语言习惯、社交沟通基调、适宜谈论的游戏话题。
3. 严格区分“事实”与“推断”：
   - FACTS: 明确的客观事实（例如“在《反恐精英》中累计游玩超过 1500 小时”、“主页设置了艺术作品展柜”）。
   - INFERENCES: 基于事实得出的兴趣或审美推测（例如“推测偏好二次元画风”、“推测对竞技射击游戏有长期经验”）。每一条必须指明依据 evidence 和置信度 confidence (0.0~1.0)。
   - PERSONA_SUGGESTIONS: 建议机器人在日常与玩家交流时采用的风格或熟悉话题。

【输出格式】
必须严格仅输出符合以下结构的 JSON Object，不得输出多余散文：
{
  "facts": [
    { "category": "games | identity | habits | showcase | topics", "content": "事实描述", "source": "steam_playtime | profile_bio | showcases", "confidence": 1.0, "enabled": true }
  ],
  "inferences": [
    { "category": "preferences | aesthetic | communication | profileStyle | topics", "content": "推断描述", "evidence": ["依据1", "依据2"], "confidence": 0.85, "enabled": true }
  ],
  "personaSuggestions": [
    { "title": "简短建议标题", "suggestion": "具体人设建议", "category": "tone | interests | topics | style", "confidenceScore": 0.88, "evidence": ["依据"] }
  ],
  "summary": {
    "aestheticProfile": "审美简析",
    "gamingFocus": "游戏偏好总结",
    "communicationStyle": "社交风格总结",
    "profileStyle": "主页DIY风格总结",
    "recommendedTopics": ["推荐话题1", "推荐话题2"],
    "avoidAssumptions": ["不要擅自假设的误区"]
  }
}`;

    const userPrompt = `请对以下账号主人的 Steam 资料快照进行深入整理，输出符合规范的 JSON：\n${JSON.stringify(promptData, null, 2)}`;

    try {
      let rawText: string | null = null;
      if (typeof (this.deepseekClient as any).generateChat === 'function') {
        rawText = await (this.deepseekClient as any).generateChat(systemPrompt, userPrompt, {
          jsonResponse: true,
          temperature: 0.3
        });
      } else {
        const response = await this.deepseekClient.generateReply(userPrompt, 'SteamProfileCurator');
        rawText = response ? response.reply : null;
      }

      if (!rawText) {
        this.logger.warn('DEEPSEEK_PROFILE_CURATION_EMPTY');
        return null;
      }

      const parsed = this.cleanAndParseJson(rawText);
      if (!parsed) {
        this.logger.warn('DEEPSEEK_PROFILE_CURATION_PARSE_FAILED', { raw: rawText.substring(0, 300) });
        return null;
      }

      return this.normalizeCuratorResult(parsed);
    } catch (err: any) {
      this.logger.error('DEEPSEEK_PROFILE_CURATION_ERROR', { error: err.message });
      return null;
    }
  }

  public cleanAndParseJson(rawText: string): any | null {
    if (!rawText) return null;
    let text = rawText.trim();

    // Remove markdown code fences if wrapped
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }

    try {
      return JSON.parse(text);
    } catch {
      // Find outermost JSON object
      const startIdx = text.indexOf('{');
      const endIdx = text.lastIndexOf('}');
      if (startIdx !== -1 && endIdx > startIdx) {
        try {
          return JSON.parse(text.substring(startIdx, endIdx + 1));
        } catch {}
      }
      return null;
    }
  }

  private normalizeCuratorResult(parsed: any): CuratorResult {
    const facts: Array<Omit<KnowledgeFact, 'id' | 'addedAt'>> = [];
    if (Array.isArray(parsed.facts)) {
      parsed.facts.forEach((f: any) => {
        if (f && typeof f.content === 'string' && f.content.trim()) {
          facts.push({
            category: f.category || 'games',
            content: f.content.trim(),
            source: f.source || 'steam_profile',
            confidence: typeof f.confidence === 'number' ? f.confidence : 1.0,
            enabled: f.enabled !== false
          });
        }
      });
    }

    const inferences: Array<Omit<KnowledgeInference, 'id' | 'addedAt'>> = [];
    if (Array.isArray(parsed.inferences)) {
      parsed.inferences.forEach((inf: any) => {
        if (inf && typeof inf.content === 'string' && inf.content.trim()) {
          inferences.push({
            category: inf.category || 'preferences',
            content: inf.content.trim(),
            evidence: Array.isArray(inf.evidence) ? inf.evidence : ['steam_profile_snapshot'],
            confidence: typeof inf.confidence === 'number' ? inf.confidence : 0.8,
            enabled: inf.enabled !== false
          });
        }
      });
    }

    const personaSuggestions: Array<Omit<PersonaSuggestion, 'id' | 'createdAt'>> = [];
    if (Array.isArray(parsed.personaSuggestions)) {
      parsed.personaSuggestions.forEach((ps: any) => {
        if (ps && typeof ps.suggestion === 'string' && ps.suggestion.trim()) {
          const score = typeof ps.confidenceScore === 'number' ? ps.confidenceScore : 0.75;
          let level: ConfidenceLevel = 'MEDIUM_CONFIDENCE';
          if (score >= 0.85) level = 'HIGH_CONFIDENCE';
          else if (score < 0.70) level = 'LOW_CONFIDENCE';

          personaSuggestions.push({
            title: ps.title || '建议人设特征',
            suggestion: ps.suggestion.trim(),
            category: ps.category || 'style',
            confidenceLevel: level,
            confidenceScore: score,
            evidence: Array.isArray(ps.evidence) ? ps.evidence : [],
            status: 'pending'
          });
        }
      });
    }

    const summary = parsed.summary || {};
    return {
      facts,
      inferences,
      personaSuggestions,
      summary: {
        aestheticProfile: summary.aestheticProfile || '',
        gamingFocus: summary.gamingFocus || '',
        communicationStyle: summary.communicationStyle || '',
        profileStyle: summary.profileStyle || '',
        recommendedTopics: Array.isArray(summary.recommendedTopics) ? summary.recommendedTopics : [],
        avoidAssumptions: Array.isArray(summary.avoidAssumptions) ? summary.avoidAssumptions : []
      }
    };
  }
}

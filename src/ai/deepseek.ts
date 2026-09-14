import { PromptManager } from './prompt';
import * as http from 'http';
import * as https from 'https';

export interface DeepSeekReplyResponse {
  category: string;
  language: 'zh' | 'en' | 'ja' | 'other';
  confidence: number;
  reply: string;
  learnablePhrases: string[];
}

export class DeepSeekClient {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(apiKey: string, model: string = 'deepseek-chat', baseUrl: string = 'https://api.deepseek.com/v1') {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  public async generateReply(commentText: string, commenterName?: string, extraSystemContext?: string): Promise<DeepSeekReplyResponse | null> {
    if (!this.apiKey) {
      console.warn('[DeepSeek] API Key not configured. Skipping AI request.');
      return null;
    }

    let systemPrompt = PromptManager.getSystemPrompt();
    if (extraSystemContext && extraSystemContext.trim()) {
      systemPrompt += `\n\n【补充背景与知识库参考】\n${extraSystemContext.trim()}`;
    }
    const userPrompt = `用户【${commenterName || '玩家'}】在我的 Steam Profile 留言内容如下：\n"""\n${commentText}\n"""\n请按规范输出对应 JSON。`;

    const requestBody = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' }
    });

    let attempt = 0;
    while (attempt < 2) {
      attempt++;
      try {
        const responseJson = await this.doHttpRequest(this.baseUrl + '/chat/completions', requestBody);
        const parsed = JSON.parse(responseJson);
        const contentStr = parsed.choices?.[0]?.message?.content;
        if (!contentStr) {
          throw new Error('Empty response from DeepSeek API');
        }

        const data = JSON.parse(contentStr);
        return {
          category: data.category || 'normal_conversation',
          language: data.language || 'zh',
          confidence: typeof data.confidence === 'number' ? data.confidence : 0.85,
          reply: data.reply || '',
          learnablePhrases: Array.isArray(data.learnablePhrases) ? data.learnablePhrases : []
        };
      } catch (e: any) {
        console.warn(`[DeepSeek] Attempt ${attempt} failed:`, e.message);
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    return null;
  }

  /**
   * General-purpose chat completion for non-comment tasks (e.g. Profile Curation, Persona synthesis).
   * Passes systemPrompt and userPrompt directly without comment reply formatting.
   */
  public async generateChat(
    systemPrompt: string,
    userPrompt: string,
    options: { temperature?: number; jsonResponse?: boolean; timeoutMs?: number } = {}
  ): Promise<string | null> {
    if (!this.apiKey) {
      console.warn('[DeepSeek] API Key not configured. Skipping AI request.');
      return null;
    }

    const requestBody = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: options.temperature !== undefined ? options.temperature : 0.4,
      response_format: options.jsonResponse ? { type: 'json_object' } : undefined
    });

    let attempt = 0;
    while (attempt < 2) {
      attempt++;
      try {
        const responseJson = await this.doHttpRequest(
          this.baseUrl + '/chat/completions',
          requestBody,
          options.timeoutMs || 35000
        );
        const parsed = JSON.parse(responseJson);
        const contentStr = parsed.choices?.[0]?.message?.content;
        if (!contentStr) {
          throw new Error('Empty response from DeepSeek API');
        }
        return contentStr;
      } catch (e: any) {
        console.warn(`[DeepSeek] generateChat attempt ${attempt} failed:`, e.message);
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    return null;
  }

  private doHttpRequest(urlStr: string, postData: string, timeoutMs: number = 25000): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(urlStr);
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: timeoutMs
      };

      const req = lib.request(options, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('DeepSeek API request timed out'));
      });

      req.write(postData);
      req.end();
    });
  }
}

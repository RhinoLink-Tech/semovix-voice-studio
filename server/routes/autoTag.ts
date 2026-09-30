/**
 * 5. Auto-Tag and Categorization
 * （自 server.ts 原样迁移）
 */
import { Router } from 'express';
import { Type } from '@google/genai';
import { ollamaGenerateJson, ollamaModelName, resolveReasoningEngine } from '../engines/reasoning';
import { getGeminiClient, hasGeminiApiKey } from '../engines/geminiClient';

export const autoTagRouter = Router();

autoTagRouter.post('/auto-tag-audio', async (req, res) => {
  try {
    const { title, description, category, transcript } = req.body;

    const engine = await resolveReasoningEngine(req.body?.reasoningModel);

    if (engine === 'ollama') {
      try {
        const parsed = await ollamaGenerateJson(
          `根据以下音频素材元数据生成 4-6 个简洁有用的中文标签（用于素材库搜索与整理，如“科技感”“低音轰鸣”“快节奏”“游戏UI”“热情解说”），并给一句更精炼的描述。
标题：${title}
描述：${description || '（无）'}
类别：${category || '未分类'}
文字稿：${(transcript || '（无）').slice(0, 500)}`,
          {
            type: 'object',
            properties: {
              tags: { type: 'array', items: { type: 'string' } },
              refinedDescription: { type: 'string' },
            },
            required: ['tags'],
          }
        );
        return res.json({ success: true, tags: parsed.tags || [], description: parsed.refinedDescription, engine: `ollama:${ollamaModelName()}` });
      } catch (e: any) {
        console.warn('Ollama auto-tag failed, fallback:', e.message);
      }
    }

    if (!hasGeminiApiKey()) {
      return res.json({
        tags: ['高清音质', '素材', category || '音频'],
        category: category || 'sample',
      });
    }

    const response = await getGeminiClient().models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Given the following audio metadata:
Title: ${title}
Description: ${description || ''}
Category: ${category}
Transcript: ${transcript || ''}

Generate 4-6 concise, useful Chinese tags for library search and organization (e.g. "科技感", "低音轰鸣", "快节奏", "游戏UI", "热情解说").`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            tags: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            refinedDescription: { type: Type.STRING },
          },
          required: ['tags'],
        },
      },
    });

    const parsed = JSON.parse(response.text?.trim() || '{}');
    res.json({ success: true, tags: parsed.tags || [], description: parsed.refinedDescription });
  } catch (error: any) {
    console.error('Auto tag error:', error);
    res.status(500).json({ error: error.message, code: 'internal_error' });
  }
});

/**
 * 3. AI Beat & Melody Pattern Generation
 * （自 server.ts 原样迁移，含 MUSIC_PATTERN_SCHEMA 与 normalizePattern）
 */
import { Router } from 'express';
import { Type } from '@google/genai';
import { ollamaGenerateJson, ollamaModelName, resolveReasoningEngine } from '../engines/reasoning';
import { getGeminiClient, hasGeminiApiKey } from '../engines/geminiClient';

export const musicPatternRouter = Router();

const MUSIC_PATTERN_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    bpm: { type: 'number' },
    scale: { type: 'string' },
    tracks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          soundType: { type: 'string', enum: ['kick', 'snare', 'hihat', 'bass', 'lead'] },
          steps: { type: 'array', items: { type: 'boolean' } },
          notes: { type: 'array', items: { type: 'string' }, description: '16 个元素，无音符的步用空字符串' },
          volume: { type: 'number' },
        },
        required: ['id', 'name', 'soundType', 'steps', 'volume'],
      },
    },
  },
  required: ['name', 'bpm', 'scale', 'tracks'],
};

/** 把 LLM 输出的 pattern 规整成客户端期待的形状（16 步、notes 空串→null） */
function normalizePattern(pattern: any): any {
  const fix16 = (arr: any[], pad: any) => Array.from({ length: 16 }, (_, i) => (Array.isArray(arr) ? arr[i] : undefined) ?? pad);
  return {
    name: pattern?.name || 'AI 律动',
    bpm: Math.max(40, Math.min(220, Math.round(Number(pattern?.bpm) || 90))),
    scale: pattern?.scale || 'C Minor',
    tracks: (Array.isArray(pattern?.tracks) ? pattern.tracks : []).map((t: any, i: number) => ({
      id: t?.id || `t${i + 1}`,
      name: t?.name || `Track ${i + 1}`,
      soundType: ['kick', 'snare', 'hihat', 'bass', 'lead'].includes(t?.soundType) ? t.soundType : 'kick',
      steps: fix16(t?.steps, false),
      notes: Array.isArray(t?.notes) ? fix16(t.notes.map((n: any) => (n === '' || n == null ? null : n)), null) : undefined,
      volume: Math.max(0.1, Math.min(1, Number(t?.volume) || 0.8)),
    })),
  };
}

musicPatternRouter.post('/generate-music-pattern', async (req, res) => {
  try {
    const { prompt = 'Lo-Fi Chill Beat', bpm = 90, scale = 'C Minor', reasoningModel = 'gemini-2.5-flash' } = req.body;

    const engine = await resolveReasoningEngine(reasoningModel);

    if (engine === 'ollama') {
      try {
        const raw = await ollamaGenerateJson(
          `你是电子音乐制作人。根据提示生成 16 步鼓机律动（JSON）。
提示：“${prompt}”，目标 BPM: ${bpm}，调式: ${scale}。
必须恰好 5 轨：Kick Drum、Snare/Clap、Closed Hi-Hat、Sub Bass、Synth Lead。
每轨 steps 为恰好 16 个布尔值；Bass 与 Lead 另给 notes 数组（16 个元素，音名如 "C2"、"Eb2"、"G4"，无音符的步用空字符串 ""）。
鼓点要有节奏感和音乐性，Bass 走和弦根音，Lead 用调内音。`,
          MUSIC_PATTERN_SCHEMA
        );
        return res.json({ success: true, pattern: normalizePattern(raw), engine: `ollama:${ollamaModelName()}` });
      } catch (e: any) {
        console.warn('Ollama music pattern failed, fallback:', e.message);
      }
    }

    if (!hasGeminiApiKey()) {
      // Default fallback pattern
      return res.json({
        success: true,
        pattern: {
          name: prompt,
          bpm: bpm || 90,
          scale: scale || 'C Minor',
          tracks: [
            { id: 't1', name: 'Kick Drum', soundType: 'kick', steps: [true, false, false, false, true, false, false, false, true, false, false, false, false, false, true, false], volume: 0.9 },
            { id: 't2', name: 'Snare / Clap', soundType: 'snare', steps: [false, false, false, false, true, false, false, false, false, false, false, false, true, false, false, false], volume: 0.8 },
            { id: 't3', name: 'Closed Hi-Hat', soundType: 'hihat', steps: [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true], volume: 0.6 },
            { id: 't4', name: 'Sub Bass', soundType: 'bass', steps: [true, false, false, false, false, true, false, false, true, false, false, false, false, true, false, false], notes: ['C2', null, null, null, null, 'Eb2', null, null, 'F2', null, null, null, null, 'G2', null, null], volume: 0.8 },
            { id: 't5', name: 'Synth Chords/Lead', soundType: 'lead', steps: [true, false, false, true, false, false, true, false, false, true, false, false, true, false, false, false], notes: ['C4', null, null, 'Eb4', null, null, 'G4', null, null, 'Bb4', null, null, 'C5', null, null, null], volume: 0.7 },
          ],
        },
      });
    }

    const modelToUse = reasoningModel || 'gemini-2.5-flash';

    const response = await getGeminiClient().models.generateContent({
      model: modelToUse,
      contents: `You are a talented electronic music producer. Generate a 16-step musical beat pattern based on the prompt: "${prompt}".
Target BPM: ${bpm}, Target Scale: ${scale}.
Return exactly 5 tracks: Kick Drum, Snare / Clap, Hi-Hat, Sub Bass, and Synth Lead/Pluck.
Each track must have an array of 16 booleans for 'steps', and for Bass and Lead, an optional array of 16 note strings (e.g. "C2", "Eb2", "G2" or null).`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            bpm: { type: Type.NUMBER },
            scale: { type: Type.STRING },
            tracks: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  name: { type: Type.STRING },
                  soundType: { type: Type.STRING, enum: ['kick', 'snare', 'hihat', 'bass', 'lead'] },
                  steps: {
                    type: Type.ARRAY,
                    items: { type: Type.BOOLEAN },
                    description: 'Exactly 16 boolean values indicating step triggers',
                  },
                  notes: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING, nullable: true },
                    description: '16 elements with note names (like C2, Eb2, G3) or null',
                  },
                  volume: { type: Type.NUMBER },
                },
                required: ['id', 'name', 'soundType', 'steps', 'volume'],
              },
            },
          },
          required: ['name', 'bpm', 'scale', 'tracks'],
        },
      },
    });

    const jsonText = response.text?.trim() || '{}';
    const pattern = JSON.parse(jsonText);

    res.json({ success: true, pattern, engine: 'gemini' });
  } catch (error: any) {
    console.error('Music pattern error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate beat pattern.', code: 'internal_error' });
  }
});

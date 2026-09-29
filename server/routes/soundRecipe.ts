/**
 * 2. Sound Effect (SFX) Recipe Generation
 * （自 server.ts 原样迁移，含 SOUND_RECIPE_SCHEMA 与内置兜底配方）
 */
import { Router } from 'express';
import { Type } from '@google/genai';
import { ollamaGenerateJson, ollamaModelName, resolveReasoningEngine } from '../engines/reasoning';
import { getGeminiClient, hasGeminiApiKey } from '../engines/geminiClient';

export const soundRecipeRouter = Router();

const SOUND_RECIPE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    category: { type: 'string' },
    duration: { type: 'number' },
    oscillators: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['sine', 'square', 'sawtooth', 'triangle'] },
          startFreq: { type: 'number' },
          endFreq: { type: 'number' },
          freqRamp: { type: 'string', enum: ['linear', 'exponential', 'none'] },
          detune: { type: 'number' },
          gain: { type: 'number' },
        },
        required: ['type', 'startFreq', 'gain'],
      },
    },
    envelope: {
      type: 'object',
      properties: { attack: { type: 'number' }, decay: { type: 'number' }, sustain: { type: 'number' }, release: { type: 'number' } },
      required: ['attack', 'decay', 'sustain', 'release'],
    },
    filter: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['lowpass', 'highpass', 'bandpass'] },
        startCutoff: { type: 'number' }, endCutoff: { type: 'number' }, q: { type: 'number' },
      },
    },
    noise: {
      type: 'object',
      properties: { type: { type: 'string', enum: ['white', 'pink', 'brown'] }, gain: { type: 'number' }, duration: { type: 'number' } },
    },
    effects: {
      type: 'object',
      properties: { distortion: { type: 'number' }, reverb: { type: 'number' } },
    },
  },
  required: ['title', 'description', 'category', 'duration', 'oscillators', 'envelope'],
};

/** 内置兜底音效配方（无任何引擎可用时） */
function defaultSfxRecipe(prompt: string, category: string) {
  return {
    title: prompt,
    description: `基于提示词 “${prompt}” 生成的程序化音效`,
    category: category || 'sfx',
    duration: 1.2,
    oscillators: [
      { type: 'sawtooth', startFreq: 440, endFreq: 110, freqRamp: 'exponential', gain: 0.7 },
      { type: 'sine', startFreq: 220, endFreq: 55, freqRamp: 'exponential', gain: 0.5 },
    ],
    envelope: { attack: 0.02, decay: 0.3, sustain: 0.1, release: 0.5 },
    filter: { type: 'lowpass', startCutoff: 3000, endCutoff: 400, q: 4 },
    noise: { type: 'white', gain: 0.15, duration: 0.3 },
    effects: { reverb: 0.3, distortion: 0.1 },
  };
}

/**
 * 2. Sound Effect (SFX) Recipe Generation
 */
soundRecipeRouter.post('/generate-sound-recipe', async (req, res) => {
  try {
    const { prompt, category = 'sci-fi', reasoningModel = 'gemini-2.5-flash' } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Sound prompt is required.', code: 'invalid_request' });
    }

    const engine = await resolveReasoningEngine(reasoningModel);

    if (engine === 'ollama') {
      try {
        const recipe = await ollamaGenerateJson(
          `你是资深音效设计师与合成器程序员。为下面的描述设计一个 Web Audio API 程序化合成配方（JSON）。
描述：“${prompt}”（类别：${category}）。
要求：振荡器频率/扫频、包络、滤波曲线、噪声参数具体可信，组合起来能真实还原该音效；duration 在 0.3-5.0 秒之间。`,
          SOUND_RECIPE_SCHEMA
        );
        return res.json({ success: true, recipe, engine: `ollama:${ollamaModelName()}` });
      } catch (e: any) {
        console.warn('Ollama SFX recipe failed, fallback:', e.message);
        return res.json({ success: true, recipe: defaultSfxRecipe(prompt, category), engine: 'fallback' });
      }
    }

    if (!hasGeminiApiKey()) {
      // Fallback default recipe
      return res.json({ success: true, recipe: defaultSfxRecipe(prompt, category), engine: 'fallback' });
    }

    const modelToUse = reasoningModel || 'gemini-2.5-flash';

    const response = await getGeminiClient().models.generateContent({
      model: modelToUse,
      contents: `You are an expert audio sound designer and synthesizer programmer.
Create a Web Audio API procedural synthesis recipe for the following sound description: "${prompt}" (Category: ${category}).
Provide precise oscillator frequencies, envelopes, filter curves, and noise parameters that faithfully create this sound.`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            description: { type: Type.STRING },
            category: { type: Type.STRING },
            duration: { type: Type.NUMBER, description: 'Duration in seconds between 0.3 and 5.0' },
            oscillators: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  type: { type: Type.STRING, enum: ['sine', 'square', 'sawtooth', 'triangle'] },
                  startFreq: { type: Type.NUMBER },
                  endFreq: { type: Type.NUMBER },
                  freqRamp: { type: Type.STRING, enum: ['linear', 'exponential', 'none'] },
                  detune: { type: Type.NUMBER },
                  gain: { type: Type.NUMBER },
                },
                required: ['type', 'startFreq', 'gain'],
              },
            },
            envelope: {
              type: Type.OBJECT,
              properties: {
                attack: { type: Type.NUMBER },
                decay: { type: Type.NUMBER },
                sustain: { type: Type.NUMBER },
                release: { type: Type.NUMBER },
              },
              required: ['attack', 'decay', 'sustain', 'release'],
            },
            filter: {
              type: Type.OBJECT,
              properties: {
                type: { type: Type.STRING, enum: ['lowpass', 'highpass', 'bandpass'] },
                startCutoff: { type: Type.NUMBER },
                endCutoff: { type: Type.NUMBER },
                q: { type: Type.NUMBER },
              },
            },
            noise: {
              type: Type.OBJECT,
              properties: {
                type: { type: Type.STRING, enum: ['white', 'pink', 'brown'] },
                gain: { type: Type.NUMBER },
                duration: { type: Type.NUMBER },
              },
            },
            effects: {
              type: Type.OBJECT,
              properties: {
                distortion: { type: Type.NUMBER },
                reverb: { type: Type.NUMBER },
              },
            },
          },
          required: ['title', 'description', 'category', 'duration', 'oscillators', 'envelope'],
        },
      },
    });

    const jsonText = response.text?.trim() || '{}';
    const recipe = JSON.parse(jsonText);

    res.json({ success: true, recipe, engine: 'gemini' });
  } catch (error: any) {
    console.error('SFX recipe error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate sound recipe.', code: 'internal_error' });
  }
});

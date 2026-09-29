import { Router } from 'express';
import { Type } from '@google/genai';
import { getGeminiClient } from '../engines/geminiClient';
import { ollamaGenerateJson, resolveReasoningEngine } from '../engines/reasoning';
import { createGuofengComposition, GUOFENG_INSTRUMENTS, hasModelMotifs, type GuofengInstrument, type GuofengRequest } from '../../src/music/guofeng';

export const guofengRouter = Router();

const motifFields = {
  step: { type: Type.NUMBER },
  degree: { type: Type.NUMBER },
  lengthSteps: { type: Type.NUMBER },
  velocity: { type: Type.NUMBER },
};

const motifSchema = {
  type: Type.OBJECT,
  properties: {
    phrase: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: motifFields, required: Object.keys(motifFields) } },
    answer: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: motifFields, required: Object.keys(motifFields) } },
  },
  required: ['phrase', 'answer'],
};

const ollamaMotifSchema = {
  type: 'object',
  properties: {
    phrase: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          step: { type: 'number' }, degree: { type: 'number' },
          lengthSteps: { type: 'number' }, velocity: { type: 'number' },
        },
        required: ['step', 'degree', 'lengthSteps', 'velocity'],
      },
    },
    answer: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          step: { type: 'number' }, degree: { type: 'number' },
          lengthSteps: { type: 'number' }, velocity: { type: 'number' },
        },
        required: ['step', 'degree', 'lengthSteps', 'velocity'],
      },
    },
  },
  required: ['phrase', 'answer'],
};

guofengRouter.post('/generate-guofeng-composition', async (req, res) => {
  const body = req.body ?? {};
  if (typeof body.prompt !== 'string' || body.prompt.trim().length > 500 ||
      !Array.isArray(body.instruments) || body.instruments.length === 0 || body.instruments.every((instrument: unknown) => instrument === 'drum') ||
      body.instruments.some((instrument: unknown) => !GUOFENG_INSTRUMENTS.includes(instrument as typeof GUOFENG_INSTRUMENTS[number]))) {
    return res.status(400).json({ error: '请填写不超过 500 字的描述，并至少选择一种有效乐器。', code: 'invalid_request' });
  }
  const requestedDuration = Number(body.durationSec);
  const requestedBpm = Number(body.bpm);
  if (!Number.isFinite(requestedDuration) || requestedDuration < 15 || requestedDuration > 30 ||
      !Number.isFinite(requestedBpm) || requestedBpm < 72 || requestedBpm > 120) {
    return res.status(400).json({ error: '时长须为 15–30 秒，速度须为 72–120 BPM。', code: 'invalid_request' });
  }
  const request: GuofengRequest = {
    prompt: body.prompt,
    mood: typeof body.mood === 'string' ? body.mood.slice(0, 32) : '空灵',
    scene: typeof body.scene === 'string' ? body.scene.slice(0, 32) : '山水',
    durationSec: requestedDuration,
    bpm: requestedBpm,
    key: Number.isInteger(body.key) ? body.key : 0,
    scale: body.scale === 'minor-pentatonic' ? 'minor-pentatonic' : 'major-pentatonic',
    instruments: [...new Set(body.instruments as GuofengInstrument[])],
  };
  try {
    const engine = await resolveReasoningEngine(body.reasoningModel);
    let motifs: unknown;
    let usedEngine: 'rules' | 'ollama' | 'gemini' = 'rules';
    let warning: string | undefined;
    if (engine !== 'fallback') {
      const instruction = `你是国风器乐作曲家。为以下场景谱写两个不同的五声音阶旋律动机，只返回 JSON。\n场景：${request.scene}；情绪：${request.mood}；描述：${request.prompt || '纯音乐背景配乐'}。\nphrase 与 answer 各含 4–10 个音。step 是两小节内的十六分音符位置 0–31，degree 是五声音阶级数 1–5，lengthSteps 是时值 1–8，velocity 是力度 0.2–1。留出呼吸空隙，第二句以 1 级音结束。不要写歌词。`;
      try {
        if (engine === 'ollama') {
          motifs = await ollamaGenerateJson(instruction, ollamaMotifSchema);
        } else {
          const response = await getGeminiClient().models.generateContent({
            model: typeof body.reasoningModel === 'string' && body.reasoningModel.startsWith('gemini') ? body.reasoningModel : 'gemini-2.5-flash',
            contents: instruction,
            config: { responseMimeType: 'application/json', responseSchema: motifSchema },
          });
          motifs = JSON.parse(response.text?.trim() || '{}');
        }
        if (hasModelMotifs(motifs)) usedEngine = engine;
        else { motifs = undefined; warning = '旋律模型未返回有效乐句，已改用内置编曲模板。'; }
      } catch (error) {
        warning = `旋律模型暂不可用，已改用内置编曲模板：${error instanceof Error ? error.message : '未知错误'}`;
      }
    } else {
      warning = '未检测到可用旋律模型，已使用内置编曲模板。';
    }
    const composition = createGuofengComposition(request, motifs, usedEngine);
    return res.json({ composition, engine: usedEngine, warning });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : '国风编曲失败。', code: 'internal_error' });
  }
});

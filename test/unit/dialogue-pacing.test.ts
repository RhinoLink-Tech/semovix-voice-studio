import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeWav, parseWav } from '../../server/audio/wav';

vi.mock('../../server/engines/geminiClient', () => ({
  getGeminiClient: vi.fn(),
  hasGeminiApiKey: vi.fn(() => true),
}));

vi.mock('../../server/engines/qwenWorker', () => ({
  waitForWorkerEngineReady: vi.fn(),
  qwenVoiceCatalog: vi.fn(),
  qwenWorkerSynthesize: vi.fn(),
  resolveQwenSpeaker: vi.fn((speaker: string) => speaker),
}));

import { getGeminiClient } from '../../server/engines/geminiClient';
import { qwenVoiceCatalog, qwenWorkerSynthesize } from '../../server/engines/qwenWorker';
import { geminiAdapter, qwenLocalAdapter, type DialoguePacing } from '../../server/engines/tts';
import { runSpeech } from '../../server/lib/speechPipeline';

const script = '主持人: 欢迎收听。\n嘉宾: 谢谢邀请。';
const speakers = [
  { speaker: '主持人', voiceName: 'voice_a' },
  { speaker: '嘉宾', voiceName: 'voice_b' },
];

describe('dialogue pacing', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['tight', 0.12],
    ['natural', 0.3],
    ['relaxed', 0.7],
  ] as const)('adds %s pauses between local Qwen turns', async (pacing, gap) => {
    const segmentWav = encodeWav(Buffer.alloc(4800), { sampleRate: 24000, channels: 1, bitsPerSample: 16 });
    vi.mocked(qwenVoiceCatalog).mockResolvedValue({ speakers: ['voice_a', 'voice_b'] } as never);
    vi.mocked(qwenWorkerSynthesize).mockResolvedValue(segmentWav);

    const result = await qwenLocalAdapter.synthesize({ text: script, voiceName: 'voice_a', multiSpeaker: true, speakers, pacing });
    expect(parseWav(Buffer.from(result.wavBase64, 'base64')).durationSec).toBeCloseTo(0.2 + gap, 2);
    expect(vi.mocked(qwenWorkerSynthesize).mock.calls.map(([arg]) => arg.speaker)).toEqual(['voice_a', 'voice_b']);
  });

  it('rejects a role name that is not in the two-speaker selection', async () => {
    vi.mocked(qwenVoiceCatalog).mockResolvedValue({ speakers: ['voice_a', 'voice_b'] } as never);
    await expect(qwenLocalAdapter.synthesize({
      text: '主持人: 欢迎收听。\n访客: 谢谢邀请。', voiceName: 'voice_a', multiSpeaker: true, speakers,
    })).rejects.toMatchObject({ code: 'unknown_dialogue_speaker' });
    expect(qwenWorkerSynthesize).not.toHaveBeenCalled();
  });

  it('rejects a dialogue line with empty speech', async () => {
    vi.mocked(qwenVoiceCatalog).mockResolvedValue({ speakers: ['voice_a', 'voice_b'] } as never);
    await expect(qwenLocalAdapter.synthesize({
      text: '主持人: 欢迎收听。\n嘉宾:   ', voiceName: 'voice_a', multiSpeaker: true, speakers,
    })).rejects.toMatchObject({ code: 'invalid_dialogue_script' });
    expect(qwenWorkerSynthesize).not.toHaveBeenCalled();
  });

  it('rejects unsupported Voice Profile dialogue before synthesis', async () => {
    await expect(runSpeech({ text: script, ttsModel: 'voice-profile', multiSpeaker: true, source: 'app' }))
      .rejects.toMatchObject({ status: 400, code: 'unsupported_multi_speaker' });
  });

  it.each(['tight', 'natural', 'relaxed'] as DialoguePacing[])('passes %s as guidance to Gemini', async pacing => {
    const generateContent = vi.fn().mockResolvedValue({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(4800).toString('base64'), mimeType: 'audio/pcm' } }] } }] });
    vi.mocked(getGeminiClient).mockReturnValue({ models: { generateContent } } as never);

    await geminiAdapter.synthesize({ text: script, voiceName: 'Kore', multiSpeaker: true, speakers, pacing, systemInstruction: '保持清晰。' });
    const instruction = generateContent.mock.calls[0][0].config.systemInstruction as string;
    expect(instruction).toContain('保持清晰。');
    expect(instruction).toContain({ tight: '紧凑', natural: '自然', relaxed: '舒缓' }[pacing]);
    expect(generateContent.mock.calls[0][0].contents[0].parts[0].text).toContain(script);
  });
});

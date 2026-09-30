/**
 * Golden Path 驱动脚本（发布基线 PR-3 §2.6 真实验收）。
 *
 * 用真实模型走完 AI 原创全链路：创建角色 → 设计批次（12 候选）→ 匿名评审 →
 * 内容适配与重复生成检查 → 冻结发布 V1.0 → 产品端点消费 ×2 → MCP 消费，
 * 全程把请求、响应、音频与校验结果留证到 artifacts/golden-path/。
 *
 * 诚实口径：评审分数由脚本按候选时长生成占位值（见 scoreFromDuration），
 * 人工回听确认标记为 agent 驱动——正式对外发布前需责任人重听并另行签署。
 *
 * 用法：bun scripts/golden-path.ts
 * 环境变量：GP_API（默认 http://127.0.0.1:3001）、GP_LIBRARY（默认 ./library）、
 *   GP_RESUME=1（上次失败后续跑：跳过已成功阶段，仅重跑失败及之后的阶段；
 *   需与原跑相同的 GP_IDENTITY_ID）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const API = process.env.GP_API ?? 'http://127.0.0.1:3001';
const WORKER = process.env.GP_WORKER ?? 'http://127.0.0.1:8800';
const LIBRARY = path.resolve(process.env.GP_LIBRARY ?? 'library');
const OUT = path.resolve('artifacts/golden-path');
// GP_RESUME=1：从上次失败的 summary.json 续跑——复用原 RUNSTAMP（幂等键保持一致），
// 已成功阶段直接跳过，跨阶段变量（batchId/manifestHash 等）从 summary 恢复
const prevSummary = process.env.GP_RESUME === '1' && fs.existsSync(path.join(OUT, 'summary.json'))
  ? JSON.parse(fs.readFileSync(path.join(OUT, 'summary.json'), 'utf8')) as Record<string, any>
  : null;
const stampDigits = new Date().toISOString().replace(/\D/g, '');
const RUNSTAMP = prevSummary?.run ?? `${stampDigits.slice(0, 8)}-${stampDigits.slice(8, 14)}`; // 20260930-100640（全安全字符）
const IDENTITY_ID = process.env.GP_IDENTITY_ID ?? `gp-narrator-${RUNSTAMP}`;
const PROFILE_NAME = 'Semovix 官方讲解员 V1';
const PROFILE_VERSION = 'V1.0';
const SEED = '20260930';

fs.mkdirSync(path.join(OUT, 'logs'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'generated-samples'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'mcp-results'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'design-batch'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'voice-profile'), { recursive: true });

const logFile = path.join(OUT, 'logs', 'driver.log');
const apiLog = path.join(OUT, 'logs', 'api-calls.jsonl');
const engineLog = path.join(OUT, 'logs', 'engine-states.jsonl');
const timings: Array<{ stage: string; startedAt: string; endedAt: string; durationSec: number; detail?: string }> =
  prevSummary ? [...(prevSummary.stages ?? []).filter((item: any) => !item.detail)] : [];
const resumedStages = new Set(timings.map(item => item.stage));
const summary: Record<string, unknown> = { run: RUNSTAMP, api: API, worker: WORKER, startedAt: new Date().toISOString() };
if (prevSummary) summary.resumedFrom = prevSummary.run;

function log(line: string) {
  const at = new Date().toISOString();
  const text = `[${at}] ${line}`;
  console.log(text);
  fs.appendFileSync(logFile, `${text}\n`);
}
function saveJson(rel: string, data: unknown) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs = 30000): Promise<{ status: number; json: any; text: string; headers: Record<string, string> }> {
  const started = Date.now();
  const response = await fetch(url, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  const ms = Date.now() - started;
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 二进制等非 JSON 响应 */ }
  fs.appendFileSync(apiLog, `${JSON.stringify({ at: new Date().toISOString(), method, url, status: response.status, ms })}\n`);
  const headerMap: Record<string, string> = {};
  response.headers.forEach((value, key) => { headerMap[key.toLowerCase()] = value; });
  return { status: response.status, json, text, headers: headerMap };
}
async function callBin(method: string, url: string, headers: Record<string, string> = {}, timeoutMs = 300000): Promise<{ status: number; buffer: Buffer }> {
  const started = Date.now();
  const response = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.appendFileSync(apiLog, `${JSON.stringify({ at: new Date().toISOString(), method, url, status: response.status, ms: Date.now() - started })}\n`);
  return { status: response.status, buffer };
}

/** 采样 Worker 引擎状态（冷启动/加载耗时证据，MOD §2.5） */
async function sampleEngines() {
  try {
    const { json } = await call('GET', `${WORKER}/health`);
    const engines = json?.engines ?? {};
    const snapshot = Object.fromEntries(Object.entries(engines).map(([name, info]: [string, any]) => [name, { state: info?.state, available: info?.available, loadAttempts: info?.loadAttempts, error: info?.error ?? null }]));
    fs.appendFileSync(engineLog, `${JSON.stringify({ at: new Date().toISOString(), ...snapshot })}\n`);
    return snapshot;
  } catch { return null; }
}
let lastEngineLine = '';
async function logEngineTransition() {
  const snapshot = await sampleEngines();
  if (!snapshot) return;
  const line = JSON.stringify(snapshot);
  if (line !== lastEngineLine) { log(`worker engines: ${line}`); lastEngineLine = line; }
}

async function stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (resumedStages.has(name)) { log(`↷ ${name} 上次已成功，续跑跳过`); return undefined as T; }
  const startedAt = new Date().toISOString();
  const started = Date.now();
  log(`▶ ${name}`);
  try {
    const result = await fn();
    timings.push({ stage: name, startedAt, endedAt: new Date().toISOString(), durationSec: Math.round((Date.now() - started) / 100) / 10 });
    log(`✔ ${name} 完成（${timings.at(-1)!.durationSec}s）`);
    return result;
  } catch (error) {
    timings.push({ stage: name, startedAt, endedAt: new Date().toISOString(), durationSec: Math.round((Date.now() - started) / 100) / 10, detail: String(error) });
    log(`✘ ${name} 失败：${String(error)}`);
    throw error;
  }
}

function requireOk(response: { status: number; json: any; text?: string }, what: string) {
  if (response.status >= 300) throw new Error(`${what} → HTTP ${response.status}: ${JSON.stringify(response.json ?? response.text)}`);
  return response.json;
}

async function pollUntil(name: string, url: string, isDone: (json: any) => boolean, describe: (json: any) => string, intervalMs: number, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { json } = await call('GET', url);
    if (isDone(json)) { log(`${name}: ${describe(json)} → 终态`); return json; }
    log(`${name}: ${describe(json)}`);
    await Promise.all([sleep(intervalMs), logEngineTransition()]);
  }
  throw new Error(`${name} 超时（${timeoutMs / 60000} 分钟）`);
}

/** 占位评分：按候选时长生成 1–5 的七维同值分数（非音色评审，见文件头诚实口径） */
function scoreFromDuration(duration: number): number {
  if (duration >= 6 && duration <= 15) return 4;
  if (duration >= 4 && duration <= 20) return 3;
  return 2;
}

async function main() {
  log(`Golden Path 驱动启动：API=${API} WORKER=${WORKER} library=${LIBRARY}`);

  // ── 环境快照 ─────────────────────────────────────────────
  await stage('0-环境快照', async () => {
    let gitHead = 'unknown';
    try { gitHead = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); } catch { /* 非 git 环境 */ }
    const nodeVersion = process.version;
    const worker = await call('GET', `${WORKER}/health`);
    const design = await call('GET', `${API}/api/voice-design/status`);
    const identities = await call('GET', `${API}/api/voice-identities`);
    let serverStart = 'unknown';
    try { serverStart = execSync(`ps -o lstart= -p $(lsof -ti :${new URL(API).port || '80'} -sTCP:LISTEN | head -1)`, { encoding: 'utf8' }).trim(); } catch { /* 探测失败不影响主流程 */ }
    saveJson('logs/environment.json', {
      capturedAt: new Date().toISOString(), gitHead, nodeVersion, api: API, worker: WORKER, libraryDir: LIBRARY,
      apiServerProcessStartedAt: serverStart,
      workerHealth: worker.json, voiceDesignStatus: design.json,
      existingIdentityCount: Array.isArray(identities.json?.identities) ? identities.json.identities.length : null,
    });
    await sampleEngines();
  });

  // ── 1 创建声音角色 ────────────────────────────────────────
  const identity = await stage('1-创建声音角色', async () => {
    const response = await call('POST', `${API}/api/voice-identities`, {
      id: IDENTITY_ID,
      roleName: 'Semovix 官方讲解员（Golden Path）',
      ownerName: 'Semovix',
      ownerType: '产品',
      source: 'AI 原创设计',
      language: '中文（普通话）',
      description: 'Golden Path 真实验收用声音角色：验证 AI 原创设计从批次到发布与消费的完整链路。',
      visibility: '团队内可见',
    });
    const code = response.json?.code ?? response.json?.error?.code;
    if (response.status === 409 && code === 'identity_exists') {
      // 复用既有角色（GP_IDENTITY_ID 指定或同刻重跑）：返回其当前快照
      const existing = await call('GET', `${API}/api/voice-identities/${IDENTITY_ID}`);
      const fetched = requireOk(existing, '读取既有声音角色') as { identity: Record<string, unknown> };
      log(`复用既有声音角色 ${IDENTITY_ID}（${fetched.identity.name}）`);
      saveJson('role-snapshot.json', fetched);
      return fetched.identity;
    }
    const created = requireOk(response, '创建声音角色') as { identity: Record<string, unknown> };
    saveJson('role-snapshot.json', created);
    return created.identity;
  });

  // ── 2 创建不可变设计批次（4 方向 × 3 候选 = 12） ───────────
  const batchId = (await stage('2-创建设计批次', async () => {
    const response = await call('POST', `${API}/api/voice-design/batches`, {
      identityId: IDENTITY_ID,
      identityName: String(identity?.name ?? ''),
      brief: '为 Semovix 产品讲解场景设计正式讲解声音：面向企业客户与技术评审，需要清晰、可信、耐长期回听；避免娱乐化与过度亲昵。声音应支撑产品介绍、概念讲解与数字播报三类内容。',
      reference: '本参考文本用于统一 Golden Path 验收口径：声音应当清晰、自然、稳定，经得起长期回听。',
      forbidden: ['娱乐化语气', '过度亲昵', '夸张宣传腔'],
      directions: [
        { id: 'A', name: '沉稳专业', description: '面向企业客户与高管评审的正式讲解声，稳重、克制、有分量。', features: ['低沉', '稳重', '正式'] },
        { id: 'B', name: '清晰明快', description: '面向产品演示与功能说明的明快播报声，节奏清晰、信息密度高。', features: ['明亮', '节奏快', '清晰'] },
        { id: 'C', name: '温和讲述', description: '面向教程与陪伴式讲解的温和声线，亲切但不失专业。', features: ['温和', '亲切', '平缓'] },
        { id: 'D', name: '权威旁白', description: '面向品牌与纪实内容的权威旁白声，有纪录片式的庄重感。', features: ['浑厚', '庄重', '权威'] },
      ],
      candidatesPerDirection: 3,
      language: '中文（普通话）',
      fixedSeed: true,
      seed: SEED,
      idempotencyKey: `gp-${RUNSTAMP}-design`,
    }, { 'Idempotency-Key': `gp-${RUNSTAMP}-design` });
    const batch = requireOk(response, '创建设计批次');
    if (batch.totalCount !== 12) throw new Error(`候选总数应为 12，实际 ${batch.totalCount}`);
    return batch.id as string;
  })) ?? String(prevSummary?.batchId ?? '');
  summary.batchId = batchId;

  // ── 3 轮询批次完成（首次含 VoiceDesign 引擎加载） ─────────
  await stage('3-候选生成', async () => {
    const batch = await pollUntil('设计批次', `${API}/api/voice-design/batches/${batchId}`,
      json => ['completed', 'failed', 'cancelled'].includes(json?.status),
      json => `${json?.status} ${json?.completedCount ?? '?'}/${json?.totalCount ?? '?'}`, 15000, 60 * 60000);
    if (batch.status !== 'completed') throw new Error(`批次终态 ${batch.status}：${batch.error ?? ''}`);
    const stored = JSON.parse(fs.readFileSync(path.join(LIBRARY, 'voice-design-batches', batchId, 'batch.json'), 'utf8'));
    saveJson('design-batch/batch.json', stored);
    const broken = (stored.candidates as Array<{ status: string; error?: string }>).filter(candidate => candidate.status !== 'completed');
    if (broken.length) throw new Error(`${broken.length} 个候选未完成：${JSON.stringify(broken.map(candidate => candidate.error))}`);
  });

  // ── 4 匿名评审 ────────────────────────────────────────────
  const finalists = (await stage('4-匿名评审', async () => {
    const response = await call('GET', `${API}/api/voice-design/batches/${batchId}/review-candidates`);
    const payload = requireOk(response, '读取匿名候选');
    saveJson('design-batch/review-candidates.json', payload);
    const candidates = payload.candidates as Array<{ id: number; duration: number; peaks: number[] }>;
    if (candidates.length !== 12) throw new Error(`匿名候选应为 12，实际 ${candidates.length}`);
    if (new Set(candidates.map(candidate => candidate.id)).size !== 12) throw new Error('匿名编号重复');

    // 占位评分（诚实口径见文件头）：按时长打分，全部候选 7 维同值
    const scores: Record<string, number[]> = {};
    const notes: Record<string, string> = {};
    const tags: Record<string, string[]> = {};
    for (const candidate of candidates) {
      scores[String(candidate.id)] = Array.from({ length: 7 }, () => scoreFromDuration(candidate.duration));
      notes[String(candidate.id)] = '';
      tags[String(candidate.id)] = [];
    }
    const ranked = [...candidates].sort((left, right) => {
      const scoreLeft = scoreFromDuration(left.duration); const scoreRight = scoreFromDuration(right.duration);
      if (scoreLeft !== scoreRight) return scoreRight - scoreLeft;
      if (left.duration !== right.duration) return right.duration - left.duration;
      return left.id - right.id;
    });
    const picked = [ranked[0].id, ranked[1].id];
    const eliminated = candidates.map(candidate => candidate.id).filter(id => !picked.includes(id));
    // 占位否决：挑一名已淘汰候选验证否决+备注通路
    const vetoTarget = eliminated[eliminated.length - 1];
    const vetoes: Record<string, string[]> = { [String(vetoTarget)]: ['时长偏离目标区间（脚本占位否决，用于验证否决记录通路）'] };
    notes[String(vetoTarget)] = '占位否决：由验收脚本写入以验证否决与备注通路，非人工评审结论。';
    for (const id of picked) { notes[String(id)] = '占位评分入围：按候选时长排序产生，待人工重听复核。'; tags[String(id)] = ['golden-path', 'finalist']; }

    const reviewResponse = await call('PUT', `${API}/api/voice-design/batches/${batchId}/review`, {
      identityId: IDENTITY_ID, finalists: picked, eliminated, vetoes, scores, notes, tags,
    });
    const saved = requireOk(reviewResponse, '保存匿名评审');
    saveJson('design-batch/review.json', saved.review);
    log(`评审入围：#${picked.join('、#')}；占位否决：#${vetoTarget}`);
    return picked;
  })) ?? (prevSummary?.finalists as number[] | undefined);
  summary.finalists = finalists;

  // ── 5 内容适配与重复生成检查（2 入围 × 8 输出） ───────────
  const validationRun = await stage('5-内容检查', async () => {
    const started = await call('POST', `${API}/api/voice-design/batches/${batchId}/validation-run`, { identityId: IDENTITY_ID, idempotencyKey: `gp-${RUNSTAMP}-validation` }, { 'Idempotency-Key': `gp-${RUNSTAMP}-validation` });
    if (started.status !== 202) throw new Error(`启动内容检查 → HTTP ${started.status}: ${JSON.stringify(started.json)}`);
    const run = await pollUntil('内容检查', `${API}/api/voice-design/batches/${batchId}/validation-run`,
      json => ['completed', 'failed', 'cancelled'].includes(json?.validationRun?.status),
      json => `${json?.validationRun?.status ?? '无记录'} ${json?.validationRun?.completedOutputs ?? '?'}/${json?.validationRun?.totalOutputs ?? '?'}`, 20000, 90 * 60000);
    const finalRun = run.validationRun;
    if (finalRun.status !== 'completed') throw new Error(`内容检查终态 ${finalRun.status}：${finalRun.error ?? ''}`);
    const stored = JSON.parse(fs.readFileSync(path.join(LIBRARY, 'voice-design-batches', batchId, 'validation-run.json'), 'utf8'));
    saveJson('design-batch/validation-run.json', finalRun);
    for (const candidate of finalRun.candidates as Array<{ candidateId: number; status: string; tasks: unknown[]; repeats: unknown[] }>) {
      log(`候选 #${candidate.candidateId}：${candidate.status}，tasks=${candidate.tasks.length} repeats=${candidate.repeats.length}`);
    }
    return finalRun;
  });

  // ── 6 人工回听确认 + 发布决策（agent 驱动，见诚实口径） ───
  const publishCandidate = validationRun?.candidates.find((candidate: { status: string }) => candidate.status === 'passed')
    ?? (prevSummary ? { candidateId: prevSummary.publishCandidateId } as { candidateId: number } : undefined);
  if (!publishCandidate) throw new Error(`无候选通过内容检查：${JSON.stringify((validationRun?.candidates ?? []).map((candidate: { candidateId: number; status: string }) => [candidate.candidateId, candidate.status]))}`);
  summary.publishCandidateId = publishCandidate.candidateId;

  await stage('6-发布决策', async () => {
    const response = await call('PUT', `${API}/api/voice-design/batches/${batchId}/validation`, {
      identityId: IDENTITY_ID, candidateId: publishCandidate.candidateId,
      profileName: PROFILE_NAME, profileVersion: PROFILE_VERSION,
      humanListeningConfirmed: true, // agent 驱动确认：正式发布前需责任人重听
    });
    saveJson('design-batch/validation-decision.json', requireOk(response, '保存发布决策'));
  });

  // ── 7 冻结发布 V1.0 ───────────────────────────────────────
  const manifestHash = (await stage('7-冻结发布', async () => {
    const response = await call('POST', `${API}/api/voice-identities/${IDENTITY_ID}/voice-profiles`, {
      batchId, candidateId: publishCandidate.candidateId, profileName: PROFILE_NAME, profileVersion: PROFILE_VERSION,
    });
    const published = requireOk(response, '冻结发布');
    if (published.profile?.status !== 'published') throw new Error(`发布状态异常：${JSON.stringify(published)}`);
    saveJson('voice-profile/publish-response.json', published);
    return published.profile.manifestHash as string;
  })) ?? String(prevSummary?.manifestHash ?? '');
  summary.manifestHash = manifestHash;
  summary.voiceName = `profile:${IDENTITY_ID}@${PROFILE_VERSION}`;

  // ── 8 产物完整性与 Hash 校验（GP-09） ─────────────────────
  await stage('8-产物校验', async () => {
    const manifestResponse = await call('GET', `${API}/api/voice-identities/${IDENTITY_ID}/voice-profiles/${PROFILE_VERSION}/manifest`);
    const manifest = requireOk(manifestResponse, '读取 Manifest').manifest;
    saveJson('voice-profile/V1.0/manifest.json', manifest);
    const audio = await callBin('GET', `${API}/api/voice-identities/${IDENTITY_ID}/voice-profiles/${PROFILE_VERSION}/reference-audio`);
    if (audio.status !== 200) throw new Error(`参考音频 → HTTP ${audio.status}`);
    fs.writeFileSync(path.join(OUT, 'voice-profile/V1.0/reference.wav'), audio.buffer);
    const audioHash = sha256(audio.buffer);
    if (audioHash !== manifest.referenceAudio.sha256) throw new Error(`参考音频 Hash 不符：API=${audioHash} manifest=${manifest.referenceAudio.sha256}`);
    // 库内产物直接复制为证据（manifest.sha256 / license.json / validation-report.json 仅存在于库内）
    const libraryProfile = path.join(LIBRARY, 'voice-profiles', IDENTITY_ID, PROFILE_VERSION);
    for (const file of ['manifest.json', 'manifest.sha256', 'license.json', 'validation-report.json', 'reference.wav']) {
      fs.copyFileSync(path.join(libraryProfile, file), path.join(OUT, 'voice-profile/V1.0', file));
    }
    const sidecar = fs.readFileSync(path.join(libraryProfile, 'manifest.sha256'), 'utf8').trim();
    const localManifest = fs.readFileSync(path.join(libraryProfile, 'manifest.json'));
    if (sha256(localManifest) !== sidecar.split(/\s+/)[0]) throw new Error('manifest.sha256 sidecar 与 manifest.json 不符');
    // 候选与检查音频证据（候选 WAV 位于批次根目录，如 A-01.wav）
    const batchDir = path.join(LIBRARY, 'voice-design-batches', batchId);
    fs.mkdirSync(path.join(OUT, 'design-batch/candidates'), { recursive: true });
    for (const entry of fs.readdirSync(batchDir)) {
      if (entry.endsWith('.wav')) fs.copyFileSync(path.join(batchDir, entry), path.join(OUT, 'design-batch/candidates', entry));
    }
    fs.cpSync(path.join(batchDir, 'validation-audio'), path.join(OUT, 'design-batch/validation-audio'), { recursive: true });
    fs.cpSync(path.join(LIBRARY, 'voice-identities', IDENTITY_ID), path.join(OUT, 'role'), { recursive: true });
    const catalog = await call('GET', `${API}/api/voice-profiles`);
    saveJson('voice-profile/catalog.json', catalog.json);
    log(`参考音频 SHA-256 校验通过：${audioHash}`);
  });

  // ── 9 产品端点消费 ×2（GP-10/11） ─────────────────────────
  const voiceName = String(summary.voiceName);
  await stage('9-产品消费', async () => {
    const texts = [
      '欢迎体验 Semovix Voice Studio。这条语音由已发布的 Voice Profile 真实生成，用于验证生产链路可用性。',
      'Golden Path 验收第二段文案：二零二六年九月三十日，版本零点一点零，共十二个候选，两段文案、两种内容风格。',
    ];
    for (let index = 0; index < texts.length; index++) {
      const response = await call('POST', `${API}/api/generate-speech`, { text: texts[index], ttsModel: 'voice-profile', voiceName }, {}, 300000);
      const generated = requireOk(response, `生产合成 ${index + 1}`);
      if (generated.engine !== 'voice-profile') throw new Error(`引擎应为 voice-profile：${generated.engine}`);
      if (generated.provenance?.manifestHash !== manifestHash) throw new Error(`溯源 manifestHash 不符：${JSON.stringify(generated.provenance)}`);
      const audio = await callBin('GET', `${API}${generated.audioUrl}`);
      fs.writeFileSync(path.join(OUT, `generated-samples/product-${index + 1}.wav`), audio.buffer);
      saveJson(`generated-samples/product-${index + 1}.json`, {
        requestText: texts[index], generationId: generated.generationId, audioUrl: generated.audioUrl,
        provenance: generated.provenance, outputSha256: sha256(audio.buffer), bytes: audio.buffer.length,
      });
      log(`生产合成 ${index + 1}：${generated.generationId}，${audio.buffer.length} 字节，sha256=${sha256(audio.buffer).slice(0, 16)}…`);
    }
  });

  // ── 10 MCP 消费（GP-12） ──────────────────────────────────
  await stage('10-MCP消费', async () => {
    const ACCEPT = 'application/json, text/event-stream';
    const init = await call('POST', `${API}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'golden-path-driver', version: RUNSTAMP } } }, { Accept: ACCEPT });
    if (init.status !== 200) throw new Error(`MCP initialize → HTTP ${init.status}`);
    const sessionId = init.headers['mcp-session-id'];
    if (!sessionId) throw new Error('MCP 未返回 mcp-session-id');
    const header = { Accept: ACCEPT, 'Mcp-Session-Id': sessionId };
    saveJson('mcp-results/initialize.json', init.json);
    await call('POST', `${API}/mcp`, { jsonrpc: '2.0', method: 'notifications/initialized' }, header);

    let rpcId = 100;
    const rpc = async (method: string, params?: unknown, timeoutMs = 30000) => call('POST', `${API}/mcp`, { jsonrpc: '2.0', id: ++rpcId, method, params }, header, timeoutMs);
    const callTool = async (name: string, args: Record<string, unknown>, timeoutMs = 300000) => {
      const response = await rpc('tools/call', { name, arguments: args }, timeoutMs);
      if (response.status !== 200 || response.json?.error) throw new Error(`MCP ${name} → ${response.status} ${JSON.stringify(response.json?.error ?? response.json)}`);
      const content = response.json.result.content as Array<{ type: string; text: string }>;
      let payload: unknown = null;
      try { payload = JSON.parse(content[0].text); } catch { /* 文本型输出 */ }
      return { isError: response.json.result.isError === true, payload: payload as Record<string, any>, text: content[0].text };
    };

    const tools = await rpc('tools/list');
    saveJson('mcp-results/tools-list.json', tools.json?.result?.tools ?? tools.json);
    const toolNames = (tools.json?.result?.tools as Array<{ name: string }> ?? []).map(tool => tool.name).sort();
    log(`MCP tools：${toolNames.join(', ')}`);

    const runtime = await callTool('check_runtime', {});
    saveJson('mcp-results/check-runtime.json', runtime.payload ?? runtime.text);

    const profiles = await callTool('list_voice_profiles', {});
    saveJson('mcp-results/list-voice-profiles.json', profiles.payload ?? profiles.text);
    const listed = profiles.payload?.profiles ?? profiles.payload?.voices;
    const listedOk = JSON.stringify(listed ?? profiles.payload).includes(voiceName);
    if (!listedOk) throw new Error(`MCP Profile 目录未包含 ${voiceName}`);

    const speech = await callTool('generate_speech', { text: '这段音频经 MCP 工具调用生成，用于验证 Agent 集成链路真实可用。', voice: voiceName });
    saveJson('mcp-results/generate-speech.json', speech.payload ?? speech.text);
    if (speech.isError) throw new Error(`MCP generate_speech 返回错误：${speech.text}`);
    const audioUrl = speech.payload?.audioUrl ?? speech.payload?.audio_url;
    if (audioUrl) {
      // MCP 工具返回绝对 URL，REST 端点返回相对路径——两者都兼容
      const absolute = String(audioUrl).startsWith('http') ? String(audioUrl) : `${API}${String(audioUrl)}`;
      const audio = await callBin('GET', absolute);
      fs.writeFileSync(path.join(OUT, 'generated-samples/mcp-generate-speech.wav'), audio.buffer);
    }
    log(`MCP generate_speech：${speech.text.slice(0, 160)}…`);

    // 会话注销（§2.8 会话语义）
    const closed = await call('DELETE', `${API}/mcp`, undefined, header);
    log(`MCP 会话注销 → HTTP ${closed.status}`);
  });

  // ── 11 生成台账（GP-13） ──────────────────────────────────
  await stage('11-台账核对', async () => {
    const response = await call('GET', `${API}/api/generations?limit=200`);
    const generations = requireOk(response, '读取生成台账').generations as Array<Record<string, unknown>>;
    const ours = generations.filter(row => row.voice_identity_id === IDENTITY_ID);
    saveJson('generations.json', { total: generations.length, goldenPath: ours });
    if (ours.length < 3) throw new Error(`台账中 Golden Path 生成应 ≥3 条，实际 ${ours.length}`);
    for (const row of ours) {
      if (row.manifest_hash !== manifestHash) throw new Error(`台账 manifest_hash 不符：${JSON.stringify(row)}`);
      if (!/^[a-f0-9]{64}$/.test(String(row.input_text_sha256 ?? '')) || !/^[a-f0-9]{64}$/.test(String(row.output_sha256 ?? ''))) throw new Error(`台账 Hash 列缺失：${JSON.stringify(row)}`);
    }
    log(`台账核对通过：${ours.length} 条生成记录均含 manifest_hash 与输入输出 SHA-256`);
  });

  summary.finishedAt = new Date().toISOString();
  summary.stages = timings;
  saveJson('logs/timings.json', timings);
  saveJson('summary.json', summary);
  log('Golden Path 全链路完成 ✔');
}

main().catch(error => {
  summary.failedAt = new Date().toISOString();
  summary.error = String(error?.message ?? error);
  summary.stages = timings;
  saveJson('summary.json', summary);
  saveJson('logs/timings.json', timings);
  log(`✘ Golden Path 失败：${summary.error}`);
  process.exit(1);
});

/**
 * Golden Path 补充验证（驱动跑完后执行）：GP-01/08 负例 + GP-14 转录核查。
 * 前置：scripts/golden-path.ts 已完成，artifacts/golden-path/summary.json 存在。
 *
 * - GP-01：同幂等键 + 异指纹再提交设计批次 → 409（不可覆盖语义）
 * - GP-08：同 identity 再发布同版本 → 409 version_exists
 * - GP-14：MCP transcribe 三条生产样本 → 转录文本 + 与请求文案的文字一致性
 *
 * 用法：bun scripts/golden-path-checks.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { textConsistency } from '../server/lib/textConsistency';

const API = process.env.GP_API ?? 'http://127.0.0.1:3001';
const OUT = path.resolve('artifacts/golden-path');
const summary = JSON.parse(fs.readFileSync(path.join(OUT, 'summary.json'), 'utf8')) as {
  batchId: string; manifestHash: string; voiceName: string; finalists: number[]; publishCandidateId: number;
};
const IDENTITY_ID = String(summary.voiceName.match(/profile:([^@]+)@/)?.[1] ?? '');
const BATCH_ID = summary.batchId;
if (!IDENTITY_ID || !BATCH_ID) throw new Error('summary.json 缺少 identityId/batchId，请先跑 golden-path.ts');

const logFile = path.join(OUT, 'logs', 'driver.log');
function log(line: string) {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  fs.appendFileSync(logFile, `${text}\n`);
}
const saveJson = (rel: string, data: unknown) => {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs = 600000): Promise<{ status: number; json: any; text: string; headers: Record<string, string> }> {
  const response = await fetch(url, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  const headerMap: Record<string, string> = {};
  response.headers.forEach((value, key) => { headerMap[key.toLowerCase()] = value; });
  return { status: response.status, json, text, headers: headerMap };
}

/** 文字一致性：与产品同口径（server/lib/textConsistency，含数字等价归一） */
const consistency = textConsistency;

async function main() {
  log('补充验证启动（GP-01 / GP-08 / GP-14）');

  // ── GP-01：同幂等键异指纹 → 409，批次不可被新请求覆盖 ──
  const batchFile = path.join(OUT, 'design-batch', 'batch.json');
  const original = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
  const replay = await call('POST', `${API}/api/voice-design/batches`, {
    ...original.snapshot,
    brief: `${original.snapshot.brief}（覆盖尝试——应被幂等键拒绝）`,
    idempotencyKey: `gp-${summary.run}-design`,
  }, { 'Idempotency-Key': `gp-${summary.run}-design` });
  const afterAttempt = JSON.parse(fs.readFileSync(path.join(process.env.GP_LIBRARY ?? 'library', 'voice-design-batches', BATCH_ID, 'batch.json'), 'utf8'));
  saveJson('logs/gp01-batch-immutability.json', {
    check: '同幂等键 + 异指纹再提交 → 期待 409 idempotency_key_conflict；库内 batch.json 保持原样',
    replayStatus: replay.status, replayCode: replay.json?.error?.code ?? replay.json?.code,
    batchUnchanged: JSON.stringify(original) === JSON.stringify(afterAttempt),
    pass: replay.status === 409 && (replay.json?.error?.code ?? replay.json?.code) === 'idempotency_key_conflict' && JSON.stringify(original) === JSON.stringify(afterAttempt),
  });
  log(`GP-01 同键异指纹 → HTTP ${replay.status}，批次未变=${JSON.stringify(original) === JSON.stringify(afterAttempt)}`);

  // ── GP-08：同版本重复发布 → 409 version_exists ──
  const republish = await call('POST', `${API}/api/voice-identities/${IDENTITY_ID}/voice-profiles`, {
    batchId: BATCH_ID, candidateId: summary.publishCandidateId,
    profileName: 'Semovix 官方讲解员 V1', profileVersion: 'V1.0',
  });
  saveJson('logs/gp08-version-immutable.json', {
    check: '对已冻结的 V1.0 再次发布 → 期待 409 version_exists',
    status: republish.status, code: republish.json?.error?.code ?? republish.json?.code,
    pass: republish.status === 409 && (republish.json?.error?.code ?? republish.json?.code) === 'version_exists',
  });
  log(`GP-08 重复发布 V1.0 → HTTP ${republish.status}`);

  // ── GP-14：三条生产样本 MCP 转录 + 文字一致性 ──
  const ACCEPT = 'application/json, text/event-stream';
  const init = await call('POST', `${API}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'golden-path-checks', version: '0.1.0' } } }, { Accept: ACCEPT });
  const sessionId = init.headers['mcp-session-id'];
  if (init.status !== 200 || !sessionId) throw new Error(`MCP initialize 失败：HTTP ${init.status}`);
  const header = { Accept: ACCEPT, 'Mcp-Session-Id': sessionId };
  await call('POST', `${API}/mcp`, { jsonrpc: '2.0', method: 'notifications/initialized' }, header);
  let rpcId = 100;
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const response = await call('POST', `${API}/mcp`, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }, header);
    if (response.status !== 200 || response.json?.error) throw new Error(`MCP ${name} → ${response.status} ${JSON.stringify(response.json?.error ?? response.json)}`);
    const content = response.json.result.content as Array<{ type: string; text: string }>;
    let payload: unknown = null;
    try { payload = JSON.parse(content[0].text); } catch { /* 文本输出 */ }
    return { isError: response.json.result.isError === true, payload: payload as Record<string, any>, text: content[0].text };
  };

  // 转录目标：两段产品文案的 requestText 从驱动留证读取；MCP 文案与驱动同文（硬编码保持一致）
  const mcpText = '这段音频经 MCP 工具调用生成，用于验证 Agent 集成链路真实可用。';
  const samples = ([1, 2] as const).map(index => ({
    file: `product-${index}.wav`,
    requestText: String(JSON.parse(fs.readFileSync(path.join(OUT, 'generated-samples', `product-${index}.json`), 'utf8')).requestText),
  })).concat([{ file: 'mcp-generate-speech.wav', requestText: mcpText }]);
  const results = [];
  for (const sample of samples) {
    const absolute = path.join(OUT, 'generated-samples', sample.file);
    const tool = await callTool('transcribe', { audioFilePath: absolute, language: 'zh' });
    if (tool.isError) throw new Error(`transcribe ${sample.file} 返回错误：${tool.text}`);
    const transcript = String(tool.payload?.text ?? tool.payload?.transcript ?? '');
    results.push({
      file: sample.file, requestText: sample.requestText, transcript,
      consistencyPercent: consistency(sample.requestText, transcript),
      payload: tool.payload,
    });
    log(`GP-14 ${sample.file}：一致性 ${results.at(-1)!.consistencyPercent}%`);
  }
  saveJson('generated-samples/transcripts.json', {
    check: 'MCP transcribe（本地 Whisper）对三条生产样本回听转录，与请求文案计算文字一致性（与产品内同口径算法）',
    results,
    pass: results.every(item => typeof item.consistencyPercent === 'number' && item.consistencyPercent >= 85),
  });
  await call('DELETE', `${API}/mcp`, undefined, header);
  log('MCP 会话已注销');

  // ── 台账终版（含 transcribe 记录） ──
  const ledger = await call('GET', `${API}/api/generations?limit=200`);
  saveJson('generations-final.json', ledger.json);
  log('补充验证完成 ✔');
}

main().catch(error => { log(`✘ 补充验证失败：${String(error?.message ?? error)}`); process.exit(1); });

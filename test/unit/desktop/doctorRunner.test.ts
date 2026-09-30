/**
 * Doctor 运行器测试（P0-A #8：噪音 stdout 提取、结构解析、命令组装）
 */
import { describe, expect, it } from 'vitest';
import { buildDoctorCommand, extractBalancedJson, parseDoctorPayload } from '../../../electron/main/lib/doctorRunner';

describe('extractBalancedJson', () => {
  it('从混杂噪音的 stdout 提取首个平衡 JSON（qwen3-tts 环境的 SoX 警告场景）', () => {
    const raw = [
      '/bin/sh: sox: command not found',
      'SoX could not be found!',
      '',
      '  If you do not have SoX, proceed here:',
      '{',
      '  "status": "pass_with_warnings",',
      '  "python": {"path": "/opt/anaconda3/envs/qwen3-tts/bin/python", "version": "3.12.14"},',
      '  "device": {"type": "mps", "name": "Apple M2 Max"},',
      '  "checks": [{"id": "python", "state": "pass", "message": "3.12.14"}]',
      '}',
      'some trailing noise',
    ].join('\n');
    const parsed = extractBalancedJson(raw) as Record<string, unknown>;
    expect(parsed.status).toBe('pass_with_warnings');
    expect((parsed.checks as unknown[]).length).toBe(1);
  });

  it('字符串字面量中的花括号不破坏配平', () => {
    const raw = 'noise {"msg": "brace { inside } string", "ok": true} tail';
    const parsed = extractBalancedJson(raw) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.msg).toBe('brace { inside } string');
  });

  it('无 JSON / 损坏 JSON 返回 null', () => {
    expect(extractBalancedJson('no json here')).toBeNull();
    expect(extractBalancedJson('{"broken": ')).toBeNull();
  });
});

describe('buildDoctorCommand', () => {
  it('bin 模式直接用解释器执行 doctor.py --json', () => {
    const { command, args } = buildDoctorCommand({ kind: 'bin', path: '/usr/local/bin/python3' }, '/app/worker/doctor.py');
    expect(command).toBe('/usr/local/bin/python3');
    expect(args).toEqual(['/app/worker/doctor.py', '--json']);
  });

  it('conda / 未配置模式走 conda run -n（默认 qwen3-tts）', () => {
    const conda = buildDoctorCommand({ kind: 'conda', env: 'my-env' }, '/app/worker/doctor.py');
    // 本机装有 conda 时解析为绝对路径（GUI 进程不继承 shell 函数），否则退回裸 'conda'
    expect(conda.command === 'conda' || /\/conda$/.test(conda.command)).toBe(true);
    expect(conda.args).toEqual(['run', '--no-capture-output', '-n', 'my-env', 'python', '/app/worker/doctor.py', '--json']);

    const fallback = buildDoctorCommand(null, '/app/worker/doctor.py');
    expect(fallback.args).toContain('qwen3-tts');
  });
});

describe('parseDoctorPayload', () => {
  it('解析完整合法载荷', () => {
    const report = parseDoctorPayload(
      {
        status: 'fail',
        python: { path: '/p', version: '3.9.1' },
        device: { type: 'cpu', name: '' },
        checks: [
          { id: 'python', state: 'fail', message: '3.9.1（需要 >= 3.10）' },
          { id: 'torch', state: 'pass', message: '' },
        ],
      },
      '2026-09-28T00:00:00Z',
    );
    expect(report?.status).toBe('fail');
    expect(report?.python?.version).toBe('3.9.1');
    expect(report?.checks).toHaveLength(2);
    expect(report?.ranAt).toBe('2026-09-28T00:00:00Z');
  });

  it('非法 state / 缺字段的检查项被过滤；整体结构非法返回 null', () => {
    const report = parseDoctorPayload(
      { status: 'pass', checks: [{ id: 'x', state: 'weird' }, { id: 'y', state: 'pass', message: 'ok' }, { state: 'pass' }] },
      'now',
    );
    expect(report?.checks).toEqual([{ id: 'y', state: 'pass', message: 'ok' }]);

    expect(parseDoctorPayload({ status: 'unknown' }, 'now')).toBeNull();
    expect(parseDoctorPayload(null, 'now')).toBeNull();
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { humanSenderLabel } from '../client/src/utils/messageSender.js';

describe('humanSenderLabel', () => {
  it('sender が無ければ You', () => {
    assert.equal(humanSenderLabel(undefined), 'You');
  });

  it('サブエージェントの報告は種別名つき', () => {
    assert.equal(humanSenderLabel({ kind: 'subagent', name: 'Explore' }), 'Subagent · Explore');
    assert.equal(humanSenderLabel({ kind: 'subagent' }), 'Subagent');
  });

  it('peer・タスク通知・その他の注入', () => {
    assert.equal(humanSenderLabel({ kind: 'peer', name: 'reviewer' }), 'Agent · reviewer');
    assert.equal(humanSenderLabel({ kind: 'task-notification' }), 'Task');
    assert.equal(humanSenderLabel({ kind: 'system' }), 'System');
  });
});

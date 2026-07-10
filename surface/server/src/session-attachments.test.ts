import { describe, expect, it } from 'vitest';
import { DomainError } from './events.js';
import {
  agentTurnInputLine,
  agentTurnMessageParts,
  parseAgentTurnAttachmentInputPayloads,
  parseAgentTurnAttachmentInputs,
  type AgentTurnAttachmentRef,
} from './session-attachments.js';

describe('agent turn attachments', () => {
  it('parses uploaded file ids and existing artifact refs', () => {
    expect(
      parseAgentTurnAttachmentInputs([
        'file-1',
        { source: 'artifact', path: 'shared/global/report.md', versionSeq: 3 },
      ]),
    ).toEqual([
      { source: 'upload', id: 'file-1' },
      { source: 'artifact', path: 'shared/global/report.md', ref: { seq: 3 } },
    ]);
  });

  it('rejects malformed attachment refs instead of dropping them', () => {
    expect(() => parseAgentTurnAttachmentInputs([{ source: 'artifact' }])).toThrow(DomainError);
  });

  it('enforces the attachment limit across both request fields', () => {
    expect(() =>
      parseAgentTurnAttachmentInputPayloads(
        Array.from({ length: 6 }, (_, i) => `upload-${i}`),
        Array.from({ length: 5 }, (_, i) => ({ source: 'artifact', path: `shared/global/${i}.md` })),
      ),
    ).toThrow(DomainError);
  });

  it('emits required localPath attachment blocks for harness input', () => {
    const attachment: AgentTurnAttachmentRef = {
      source: 'artifact',
      id: 'artifact-1',
      name: 'report.md',
      contentType: 'text/markdown',
      size: 123,
      artifactId: 'artifact-1',
      artifactPath: 'shared/global/report.md',
      artifactSeq: 4,
      blobSha: 'sha',
      workspacePath: '/workspace/shared/global/report.md',
      displayPath: 'shared/global/report.md',
    };

    expect(JSON.parse(agentTurnInputLine('review this', [attachment], 'high'))).toEqual({
      type: 'user',
      message: {
        content: [
          { type: 'text', text: 'review this' },
          {
            type: 'attachment',
            attachment_type: 'atrium-artifact',
            name: 'report.md',
            contentType: 'text/markdown',
            mimeType: 'text/markdown',
            localPath: '/workspace/shared/global/report.md',
            path: '/workspace/shared/global/report.md',
            artifactId: 'artifact-1',
            artifactPath: 'shared/global/report.md',
            artifactSeq: 4,
            blobSha: 'sha',
            required: true,
          },
        ],
      },
      reasoning: 'high',
    });
  });

  it('prepends exactly one context part to durable and execute message content', () => {
    const contextBlock = '[atrium context]\nfrom: Alice (human · driver)\nchannel: #general\nsent: 2026-07-08T14:32:05Z';

    expect(agentTurnMessageParts('review this', [], contextBlock)).toEqual([
      { type: 'context', text: contextBlock },
      { type: 'text', text: 'review this' },
    ]);
    expect(JSON.parse(agentTurnInputLine('review this', [], null, contextBlock)).message.content).toEqual([
      { type: 'context', text: contextBlock },
      { type: 'text', text: 'review this' },
    ]);
  });
});

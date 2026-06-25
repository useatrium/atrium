import {
  CentaurClient,
  type CentaurEventFrame,
  type ExecuteOptions,
  type ExecuteResponse,
  type ExecutionResponse,
  type JsonObject,
  type JsonValue,
  type MessagePart,
  type PostMessageOptions,
  type PostMessageResponse,
  type ReleaseResponse,
  type SpawnOptions,
  type SpawnResponse,
} from '@atrium/centaur-client';

const DEMO_HARNESS = 'demo';
const PROMPT_REF = 'harness:demo';
const PROMPT_SHA = 'demo-scripted-transcript';
const TOOL_USE_ID = 'toolu_demo_first_run';
const AGENT_THREAD_ID = 'demo-agent-thread';
const MODEL = 'atrium-demo';
const RESULT_TEXT =
  "Demo complete: the agent ran a shell command and streamed the result back to Atrium.";

type TailOptions = Parameters<CentaurClient['tailEvents']>[1];

export class DemoCentaurClient extends CentaurClient {
  private readonly demoThreads = new Set<string>();

  constructor(private readonly wrapped: CentaurClient) {
    super({ baseUrl: wrapped.baseUrl, apiKey: wrapped.apiKey });
  }

  spawn(threadKey: string, harness: string, opts: SpawnOptions = {}): Promise<SpawnResponse> {
    if (isDemoHarness(harness) || isDemoThread(threadKey)) {
      this.demoThreads.add(threadKey);
      void opts;
      return Promise.resolve({
        thread_key: threadKey,
        assignment_generation: 1,
        demo: true,
      });
    }
    return this.wrapped.spawn(threadKey, harness, opts);
  }

  postMessage(
    threadKey: string,
    generation: number,
    parts: MessagePart[],
    meta: JsonObject = {},
    opts: PostMessageOptions = {},
  ): Promise<PostMessageResponse> {
    if (this.isDemo(threadKey)) {
      void generation;
      void parts;
      void meta;
      void opts;
      return Promise.resolve({ ok: true, demo: true });
    }
    return this.wrapped.postMessage(threadKey, generation, parts, meta, opts);
  }

  execute(
    threadKey: string,
    generation: number,
    harness: string,
    opts: ExecuteOptions = {},
  ): Promise<ExecuteResponse> {
    if (isDemoHarness(harness) || this.isDemo(threadKey)) {
      this.demoThreads.add(threadKey);
      void generation;
      return Promise.resolve({
        execution_id: opts.executeId ?? `exec-demo-${Date.now()}`,
        demo: true,
      });
    }
    return this.wrapped.execute(threadKey, generation, harness, opts);
  }

  release(threadKey: string, releaseId: string, cancelInflight = false): Promise<ReleaseResponse> {
    if (this.isDemo(threadKey)) {
      void releaseId;
      void cancelInflight;
      return Promise.resolve({ ok: true, demo: true });
    }
    return this.wrapped.release(threadKey, releaseId, cancelInflight);
  }

  getExecution(executionId: string): Promise<ExecutionResponse> {
    return this.wrapped.getExecution(executionId);
  }

  answerQuestion(
    threadKey: string,
    executionId: string,
    questionId: string,
    answers: Record<string, { answers: string[] }>,
  ): Promise<Record<string, JsonValue | undefined>> {
    if (this.isDemo(threadKey)) {
      void executionId;
      void questionId;
      void answers;
      return Promise.resolve({ ok: true, demo: true });
    }
    return this.wrapped.answerQuestion(threadKey, executionId, questionId, answers);
  }

  async *tailEvents(threadKey: string, options: TailOptions): AsyncGenerator<CentaurEventFrame> {
    if (!this.isDemo(threadKey)) {
      yield* this.wrapped.tailEvents(threadKey, options);
      return;
    }

    const executionId = options.executionId ?? `exec-demo-${Date.now()}`;
    const afterEventId = options.afterEventId ?? 0;
    for (const frame of demoFrames(threadKey, executionId)) {
      if (options.signal?.aborted) return;
      if (frame.event_id <= afterEventId) continue;
      if (!(await delay(480, options.signal))) return;
      yield frame;
    }
  }

  private isDemo(threadKey: string): boolean {
    return isDemoThread(threadKey) || this.demoThreads.has(threadKey);
  }
}

function isDemoHarness(harness: string): boolean {
  return harness.trim().toLowerCase() === DEMO_HARNESS;
}

function isDemoThread(threadKey: string): boolean {
  return threadKey.startsWith('demo:');
}

function demoFrames(threadKey: string, executionId: string): CentaurEventFrame[] {
  const base = {
    engine: DEMO_HARNESS,
    harness: DEMO_HARNESS,
    thread_key: threadKey,
    execution_id: executionId,
    persona_id: null,
    prompt_ref: PROMPT_REF,
    prompt_sha: PROMPT_SHA,
    assignment_generation: 1,
  };
  return [
    {
      event: 'execution_state',
      event_id: 1,
      data: { type: 'execution.state', status: 'running', thread_key: threadKey, execution_id: executionId },
    },
    {
      event: 'execution_started',
      event_id: 2,
      data: {
        ...base,
        type: 'obs.execution_started',
        user_id: 'demo',
        runtime_id: 'atrium-demo-runtime',
        queue_delay_s: 0,
        delivery_platform: 'atrium-demo',
        execution_sequence: 0,
      },
    },
    {
      event: 'amp_raw_event',
      event_id: 3,
      data: {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: "I'll run a tiny check so you can see the stream." }],
        },
      },
    },
    {
      event: 'assistant_text_observed',
      event_id: 4,
      data: { ...base, type: 'obs.assistant_text', text_chars: 53, text_block_count: 1 },
    },
    {
      event: 'amp_raw_event',
      event_id: 5,
      data: {
        type: 'assistant',
        uuid: 'demo-tool-call',
        message: {
          id: 'msg_demo_tool',
          role: 'assistant',
          type: 'message',
          model: MODEL,
          usage: { input_tokens: 32, output_tokens: 8 },
          content: [
            {
              id: TOOL_USE_ID,
              name: 'Bash',
              type: 'tool_use',
              input: { command: "echo 'hello from your first agent' && uname -m" },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          context_management: null,
        },
        request_id: 'req_demo_tool',
        session_id: AGENT_THREAD_ID,
        parent_tool_use_id: null,
      },
    },
    {
      event: 'assistant_tool_use_observed',
      event_id: 6,
      data: {
        ...base,
        type: 'obs.assistant_tool_use',
        tool_name: 'Bash',
        tool_use_id: TOOL_USE_ID,
        input_keys: ['command'],
        input_size_bytes: 52,
      },
    },
    {
      event: 'amp_raw_event',
      event_id: 7,
      data: {
        type: 'tool',
        content: [
          {
            content: 'hello from your first agent\narm64',
            is_error: false,
            tool_use_id: TOOL_USE_ID,
          },
        ],
      },
    },
    {
      event: 'tool_result_observed',
      event_id: 8,
      data: {
        ...base,
        type: 'obs.tool_result',
        tool_use_id: TOOL_USE_ID,
        is_error: false,
        content_size_bytes: 33,
      },
    },
    {
      event: 'amp_raw_event',
      event_id: 9,
      data: {
        type: 'assistant',
        uuid: 'demo-final-text',
        message: {
          id: 'msg_demo_final',
          role: 'assistant',
          type: 'message',
          model: MODEL,
          usage: { input_tokens: 32, output_tokens: 20 },
          content: [
            {
              type: 'text',
              text: "That was a canned demo run. Connect Codex or Claude Code when you're ready to run a real task.",
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          context_management: null,
        },
        request_id: 'req_demo_final',
        session_id: AGENT_THREAD_ID,
        parent_tool_use_id: null,
      },
    },
    {
      event: 'assistant_text_observed',
      event_id: 10,
      data: { ...base, type: 'obs.assistant_text', text_chars: 89, text_block_count: 1 },
    },
    {
      event: 'usage_observed',
      event_id: 11,
      data: {
        ...base,
        type: 'obs.usage',
        model: MODEL,
        cost_usd: 0,
        input_tokens: 64,
        output_tokens: 28,
        total_tokens: 92,
        authoritative: true,
      },
    },
    {
      event: 'amp_raw_event',
      event_id: 12,
      data: { type: 'result', text: RESULT_TEXT },
    },
    {
      event: 'result_observed',
      event_id: 13,
      data: { ...base, type: 'obs.result', text_chars: RESULT_TEXT.length },
    },
    {
      event: 'amp_raw_event',
      event_id: 14,
      data: { type: 'turn.done', result: RESULT_TEXT, turn_id: 1, agent_thread_id: AGENT_THREAD_ID },
    },
    {
      event: 'execution_summary',
      event_id: 15,
      data: {
        ...base,
        type: 'obs.execution_summary',
        models: [MODEL],
        status: 'completed',
        cost_usd: 0,
        duration_s: 3.8,
        terminal_reason: 'completed',
      },
    },
    {
      event: 'execution_state',
      event_id: 16,
      data: {
        type: 'execution.state',
        status: 'completed',
        thread_key: threadKey,
        execution_id: executionId,
        result_text: RESULT_TEXT,
        agent_thread_id: AGENT_THREAD_ID,
        terminal_reason: 'completed',
      },
    },
  ];
}

function delay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

import { describe, expect, it } from 'vitest';
import { parseWhisperCppJson } from './whispercpp.js';

describe('parseWhisperCppJson', () => {
  it('maps whisper.cpp JSON language and transcription segments', () => {
    const sample = JSON.stringify({
      result: { language: 'en' },
      transcription: [
        {
          timestamps: { from: '00:00:00,000', to: '00:00:01,250' },
          offsets: { from: 0, to: 1250 },
          text: ' Hello there',
        },
        {
          timestamps: { from: '00:00:01,250', to: '00:00:02,500' },
          offsets: { from: 1250, to: 2500 },
          text: ' from Atrium.',
        },
      ],
    });

    expect(parseWhisperCppJson(sample)).toEqual({
      text: 'Hello there from Atrium.',
      lang: 'en',
      segments: [
        { start: 0, end: 1.25, text: 'Hello there' },
        { start: 1.25, end: 2.5, text: 'from Atrium.' },
      ],
    });
  });
});

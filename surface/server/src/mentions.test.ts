import { describe, expect, it } from 'vitest';
import { mentionedHandles, mentionTargetUserIds } from './mentions.js';

describe('mentionedHandles', () => {
  it('extracts handles at the start and middle of text', () => {
    expect(mentionedHandles('@alice please pair with @Ben')).toEqual(['alice', 'ben']);
  });

  it('extracts punctuation-adjacent handles with existing regex semantics', () => {
    expect(mentionedHandles('(@alice), @bob! mid@word')).toEqual(['alice', 'bob', 'word']);
  });

  it('dedupes handles after lowercasing', () => {
    expect(mentionedHandles('@Ben @ben @BEN')).toEqual(['ben']);
  });
});

describe('mentionTargetUserIds', () => {
  it('dedupes resolved users and excludes the actor id', () => {
    expect(
      mentionTargetUserIds(
        [{ id: 'mentioned-user' }, { id: 'actor-user' }, { id: 'mentioned-user' }],
        'actor-user',
      ),
    ).toEqual(['mentioned-user']);
  });
});

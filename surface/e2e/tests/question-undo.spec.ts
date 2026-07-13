import { expect, test, type Page } from '@playwright/test';
import {
  channelId,
  createTestChannel,
  injectQuestionRequested,
  login,
  openChannel,
  questionState,
  unique,
} from './helpers.js';

// The undo window is what stands between a fat finger and a 40-minute
// production write lock, and the answered trace is what tells you, weeks later,
// who took that lock. The unit tests drive both with fake timers; these drive
// the real app against the real server, because the failure that would hurt
// most — an Undo that visually reverts while the answer posts anyway — is
// invisible to a component test.

const UNDO_MS = 5_000;
/** The scheduled post fires at UNDO_MS; leave room for the round trip + fold. */
const PAST_WINDOW_MS = UNDO_MS + 3_000;

async function armQuestion(page: Page, prefix: string) {
  const room = await createTestChannel(prefix);
  const handle = unique(`${prefix}-driver`);
  const displayName = 'Undo Driver';
  await login(page, handle, displayName);
  const roomId = await channelId(page.context().request, room);
  const title = unique(`${prefix}-session`);
  const injected = await injectQuestionRequested({ handle, channelId: roomId, title });
  // The rows went straight into the database, so the channel picks them up on
  // its history fetch rather than a WS fanout.
  await page.goto('/');
  await openChannel(page, room);
  await expect(page.getByText(injected.questionText).first()).toBeVisible();
  return { ...injected, displayName };
}

/** The canonical answerable question, as the feed card renders it. */
function questionCard(page: Page) {
  return page.getByTestId('question-banner').first();
}

/** Pick an option the way a person does: on the visible label, not the sr-only input. */
async function pickOption(page: Page, label: string): Promise<void> {
  await questionCard(page).getByText(label, { exact: true }).click();
  await expect(questionCard(page).getByRole('radio', { name: new RegExp(label) })).toBeChecked();
}

test('Undo cancels the answer entirely — the options come back and nothing reaches the server', async ({ page }) => {
  const { sessionId } = await armQuestion(page, 'undo');

  // Every POST to the answer route is counted: "reverted the UI but posted
  // anyway" is the one failure mode that has to be impossible.
  let answerPosts = 0;
  await page.route('**/api/sessions/*/answer', async (route) => {
    answerPosts += 1;
    await route.continue();
  });

  // The radio itself is sr-only — a person clicks the option, so the test does.
  await pickOption(page, 'Careful');
  await questionCard(page).getByRole('button', { name: 'Answer' }).click();

  // Committed, not sent: the answer is stated, the options are gone, and Undo
  // is the only move left.
  const scheduled = page.getByTestId('question-scheduled-answer').first();
  await expect(scheduled).toBeVisible();
  await expect(scheduled).toContainText('Careful');
  await expect(page.getByTestId('question-banner')).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /Careful/ })).toHaveCount(0);
  await expect(scheduled.getByRole('button', { name: /^Undo \(\d+s\)$/ })).toBeVisible();

  await page.getByTestId('question-undo').first().click();

  // The question is answerable again, exactly as it was.
  await expect(page.getByTestId('question-scheduled-answer')).toHaveCount(0);
  await expect(questionCard(page).getByText('Careful', { exact: true })).toBeVisible();
  await expect(questionCard(page).getByRole('button', { name: 'Answer' })).toBeVisible();

  // Sit past the window the answer WOULD have fired in, then ask the server:
  // no request, no event, question still open, no trace anywhere.
  await page.waitForTimeout(PAST_WINDOW_MS);
  expect(answerPosts).toBe(0);
  const state = await questionState(sessionId);
  expect(state.answeredEventCount).toBe(0);
  expect(state.answeredQuestion).toBeNull();
  expect(state.pendingQuestionId).toBe('q-main');
  await expect(page.getByTestId('question-answered-trace')).toHaveCount(0);
});

test('the answer posts when the window elapses and leaves a trace a cold load still shows', async ({ page }) => {
  const { sessionId, displayName } = await armQuestion(page, 'trace');

  await pickOption(page, 'Fast');
  await questionCard(page).getByRole('button', { name: 'Answer' }).click();
  await expect(page.getByTestId('question-scheduled-answer').first()).toBeVisible();

  // Left alone, the window elapses and the answer really does go — and the card
  // flips to the durable record of who sent it.
  const trace = page.getByTestId('question-answered-trace').first();
  await expect(trace).toBeVisible({ timeout: PAST_WINDOW_MS + 10_000 });
  await expect(trace).toContainText('Answered by');
  await expect(trace).toContainText(displayName);
  await expect(trace).toContainText('Fast');

  const state = await questionState(sessionId);
  expect(state.answeredEventCount).toBe(1);
  expect(state.pendingQuestionId).toBeNull();
  expect(state.answeredQuestion).toMatchObject({
    questionId: 'q-main',
    answeredByName: displayName,
    answerText: 'Fast',
  });

  // The popout pane fetches the session row and folds no channel history — the
  // cold read the durable column exists for. A trace a reload erases is not a
  // trace.
  await page.goto(`/s/${sessionId}/pane`);
  const paneTrace = page.getByTestId('question-answered-trace').first();
  await expect(paneTrace).toBeVisible();
  await expect(paneTrace).toContainText(displayName);
  await expect(paneTrace).toContainText('Fast');
});

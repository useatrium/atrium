import { expect, test } from '@playwright/test';
import {
  apiAs,
  channelId,
  createTestChannel,
  login,
  openChannel,
  postMessage,
  seedArtifact,
  unique,
} from './helpers.js';

// The markup card's clamp is measured (scrollHeight vs clientHeight), so jsdom
// — which has no layout and reports 0 for both — structurally cannot test it.
// Its unit tests stub the metrics, which means they assert the wiring and not
// the behaviour. Two real bugs shipped through that gap: the clamp measured
// through a ref in an effect keyed on deps that never changed, so content
// mounting after a fetch was never measured and the toggle could not appear;
// and the fade rode on the collapsed state rather than on overflow, dimming
// diffs that already fit. Both need a browser to see.

const FRONTMATTER = ['---', 'title: "Seeded memo"', '---', ''].join('\n');

function markupBody(paragraphs: number, { separator = false } = {}): string {
  const lines = [FRONTMATTER, '# Memo', ''];
  lines.push('Keep {--old--}{++new++} wording and {==flag this==}{>>needs a source<<}.', '');
  // A lone `⋯` line is the hunk separator, which CriticMarkupView renders as an
  // "omitted content" section carrying an absolutely positioned `sr-only` span.
  if (separator) lines.push('⋯', '');
  for (let i = 0; i < paragraphs; i += 1) {
    lines.push(`Paragraph ${i + 1}: ${'body text that wraps and takes vertical space. '.repeat(6)}`, '');
  }
  return lines.join('\n');
}

const markupCard = 'article:has(:text-is("markup"))';

test('a markup diff that fits offers no toggle and no fade', async ({ page }) => {
  const room = await createTestChannel('markup-fits');
  const handle = unique('markup-reader');
  const ctx = await apiAs(handle);
  const id = await channelId(ctx, room);

  // Short: two changes, a couple of lines — nothing is hidden below the cut.
  const artifact = await seedArtifact({ channelId: id, body: markupBody(0) });
  await postMessage(ctx, id, `seeded fits — /e/${artifact.handle}`);

  await login(page, handle);
  await openChannel(page, room);

  const card = page.locator(markupCard);
  await expect(card).toBeVisible();
  await expect(card.getByText('2 changes')).toBeVisible();
  // The diff rendered, so the card is the markup card and not the excerpt one.
  await expect(card.locator('.atrium-critic-view-ins')).toBeVisible();

  const clamp = card.locator('[data-testid="markup-clamp"]');
  await expect(clamp).toBeVisible();
  await expect.poll(async () => clamp.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);

  await expect(card.getByRole('button', { name: /Show all changes/ })).toHaveCount(0);
  await expect(card.locator('[data-testid="markup-clamp-fade"]')).toHaveCount(0);

  await ctx.dispose();
});

test('a markup diff that overflows offers a toggle and a fade, and expanding clears both', async ({ page }) => {
  const room = await createTestChannel('markup-overflows');
  const handle = unique('markup-reader');
  const ctx = await apiAs(handle);
  const id = await channelId(ctx, room);

  // Long enough to exceed the card's 19.6rem clamp at any sane viewport.
  const artifact = await seedArtifact({ channelId: id, body: markupBody(14) });
  await postMessage(ctx, id, `seeded overflow — /e/${artifact.handle}`);

  await login(page, handle);
  await openChannel(page, room);

  const card = page.locator(markupCard);
  await expect(card).toBeVisible();
  const clamp = card.locator('[data-testid="markup-clamp"]');

  // The measurement must actually run against real layout: a ref that attaches
  // on a later render than the hook is invisible to an effect, and the toggle
  // below could never appear at all.
  await expect.poll(async () => clamp.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);

  const collapsedHeight = await clamp.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  const toggle = card.getByRole('button', { name: /Show all changes/ });
  await expect(toggle).toBeVisible();
  await expect(card.locator('[data-testid="markup-clamp-fade"]')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await toggle.click();

  // Show more must GROW the diff. A nested clamp once made this shrink instead.
  const expandedHeight = await clamp.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  expect(expandedHeight).toBeGreaterThan(collapsedHeight);
  await expect(card.getByRole('button', { name: 'Show fewer changes' })).toBeVisible();
  await expect(card.locator('[data-testid="markup-clamp-fade"]')).toHaveCount(0);

  await card.getByRole('button', { name: 'Show fewer changes' }).click();
  await expect(toggle).toBeVisible();
  await expect
    .poll(async () => clamp.evaluate((el) => Math.round(el.getBoundingClientRect().height)))
    .toBe(collapsedHeight);

  await ctx.dispose();
});

test('the collapsed clamp keeps an absolutely positioned descendant inside its clip', async ({ page }) => {
  // #544: `overflow: hidden` only clips descendants whose containing block runs
  // through the clamping box, so a clamp holding `position: absolute` content
  // must be `relative`. A hunk separator makes CriticMarkupView render one: an
  // `sr-only` span, which Tailwind positions absolutely.
  //
  // Honest scope: this guards the invariant, not a measured regression. Unlike
  // #544's footnote heading in MessageText — which escaped and inflated the
  // channel's scroll height by ~3000px — this span is 1px with auto offsets, so
  // escaping costs nothing observable (measured: scrollHeight is identical with
  // the clamp static and relative). It is the containing block that must hold,
  // because the next absolutely positioned thing this view renders may have size.
  const room = await createTestChannel('markup-clip');
  const handle = unique('markup-reader');
  const ctx = await apiAs(handle);
  const id = await channelId(ctx, room);

  const artifact = await seedArtifact({ channelId: id, body: markupBody(14, { separator: true }) });
  await postMessage(ctx, id, `seeded clip — /e/${artifact.handle}`);

  await login(page, handle);
  await openChannel(page, room);

  const clamp = page.locator(markupCard).locator('[data-testid="markup-clamp"]');
  await expect(clamp).toBeVisible();

  // The hazard has to be present, or this test guards nothing.
  await expect(clamp.locator('.atrium-critic-view-separator')).toHaveCount(1);
  await expect(clamp.locator('.sr-only')).toHaveCSS('position', 'absolute');
  await expect(clamp).toHaveCSS('position', 'relative');

  // The clipped box stays at its clamped height no matter what it contains.
  const height = await clamp.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  expect(height).toBeLessThanOrEqual(Math.ceil(19.6 * 16) + 2);

  await ctx.dispose();
});

import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { createTestChannel, login, messageRow, openChannel, sendMessage, unique } from './helpers.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

let fixtureServer: Server;
let fixtureOrigin = '';

test.beforeAll(async () => {
  fixtureServer = createServer((request, response) => {
    if (request.url === '/og') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html><head>
          <title>Fallback fixture title</title>
          <meta property="og:title" content="Link unfurl fixture title">
          <meta property="og:description" content="Fixture description for the external-link card.">
          <meta property="og:site_name" content="Atrium Fixture">
          <meta property="og:image" content="${fixtureOrigin}/preview.png">
        </head><body>fixture</body></html>`);
      return;
    }
    if (request.url === '/preview.png' || request.url === '/direct.png') {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.byteLength });
      response.end(PNG);
      return;
    }
    response.writeHead(404).end();
  });
  fixtureServer.listen(0, '127.0.0.1');
  await once(fixtureServer, 'listening');
  const address = fixtureServer.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind a TCP port');
  fixtureOrigin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (!fixtureServer) return;
  fixtureServer.close();
  await once(fixtureServer, 'close');
});

test('link-unfurl renders OG and inline image cards and persists author removal', async ({ page }) => {
  const room = await createTestChannel('link-unfurl');
  await login(page, unique('link-unfurler'), 'Link Unfurl Author');
  await openChannel(page, room);

  const ogUrl = `${fixtureOrigin}/og`;
  const imageUrl = `${fixtureOrigin}/direct.png`;
  const endpointProbe = await page.context().request.post('/api/unfurl/resolve', { data: { urls: [ogUrl] } });
  test.skip(endpointProbe.status() === 404, 'external unfurl server endpoint has not merged yet');
  expect(endpointProbe.ok(), `POST /api/unfurl/resolve (${endpointProbe.status()})`).toBeTruthy();

  const ogMarker = unique('og-link');
  await sendMessage(page, `${ogMarker} ${ogUrl}`, room);
  const ogRow = messageRow(page, ogMarker);
  await expect(ogRow.getByRole('link', { name: 'Link unfurl fixture title' })).toBeVisible();
  await expect(ogRow.locator('img[src^="/api/unfurl/image?url="]')).toBeVisible();

  const imageMarker = unique('image-link');
  await sendMessage(page, `${imageMarker} ${imageUrl}`, room);
  const imageRow = messageRow(page, imageMarker);
  await expect(imageRow.getByRole('img', { name: 'direct.png' })).toHaveAttribute(
    'src',
    `/api/unfurl/image?url=${encodeURIComponent(imageUrl)}`,
  );

  await ogRow.getByRole('button', { name: 'Remove preview' }).click();
  await expect(ogRow.getByRole('link', { name: 'Link unfurl fixture title' })).toHaveCount(0);

  await page.reload();
  await openChannel(page, room);
  const reloadedOgRow = messageRow(page, ogMarker);
  await expect(reloadedOgRow).toBeVisible();
  await expect(reloadedOgRow.getByRole('link', { name: 'Link unfurl fixture title' })).toHaveCount(0);
});

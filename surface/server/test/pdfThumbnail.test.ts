import { describe, expect, it } from 'vitest';
import { generateThumbnail } from '../src/thumbnails.js';

function onePagePdf(): Buffer {
  const content = 'BT /F1 18 Tf 20 50 Td (PDF thumbnail) Tj ET\n';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, 'ascii'));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body, 'ascii');
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    body += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'ascii');
}

describe('generateThumbnail PDF support', () => {
  it('renders the first page of a PDF into a webp thumbnail', async () => {
    const thumbnail = await generateThumbnail({
      bytes: onePagePdf(),
      mediaKind: 'pdf',
      mime: 'application/pdf',
    });

    expect(thumbnail).not.toBeNull();
    expect(thumbnail?.mime).toBe('image/webp');
    expect(thumbnail?.bytes.byteLength).toBeGreaterThan(0);
    expect(thumbnail!.bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(thumbnail!.bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
  });

  it('returns null for invalid PDF bytes', async () => {
    const thumbnail = await generateThumbnail({
      bytes: Buffer.from('not a pdf', 'utf8'),
      mediaKind: 'pdf',
      mime: 'application/pdf',
    });

    expect(thumbnail).toBeNull();
  });
});

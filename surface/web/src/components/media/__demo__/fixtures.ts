import type { PreviewFile } from '../types';

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAADSCAMAAAAMl+lkAAAAz1BMVEURGCctNEFtcnyytbvl6Ov4+vxESlbT1toaIC+ipq0iKTfy+PrW8O+t5OCA189Vy78ywbEcuqkUuKbo9fap495Ix7nJ7OrG6+nh8/No0Mbo7/slY+vt8vs3cOw0bezx9ftJfe5CeO1ZiO9Pge5plPB4nvKGqPN1nPGWtPSApPKgu/WLrPOpwvayyPbG1vjM2vjR3vm6zvfZ5Prk6/osaOzW4vlAdu1Vhe87c+1gjfB+o/KatvSxx/ZvmPGdufW/0fff6Ppnk/CQr/SUo7jf5OvVtSIHAAAF70lEQVR42u3ce1vaSBTHcQQqIioYr/XY2rquut6rdW3r7rZ7ef+vabWIEsjlTM5Mzhz8ff/m0eTzhMxkGGg0EEIIIYQQQgghhBBCCCGEEBI112y137zu2q3mXFW++Y720UdSZ74K30JX+7gjqrvg7Lf42t+76dqLrtcf/NK1Ha9BvH8n67qNH9qHG2FOIwnG3+k6Dn5z2gcbZQ7zwab2sUZZkw/Y0j7WKGvxATGHyarNB9Q+1EgDoDAACgOgMAAKA6AwAAoDoDAACgOgMAAKA6AwAAoDoDAACgOgMAAKA6AwAAoDoDAACgOgsBoAe0vLK/3BarI66K8sL/W0z9hzoQHX1jeSdBvra9onbQdws59k1d/UPm0bgFuDJK/BlvaJxw+43U+K6m9rn3rkgOtJWeva5x4zYO9tqV+SvJ2FETkM4NqA4fdwJ5yB8TgI4DaL7zH7N8IQgGtsvyQxfw0GAOzx3r9P72Lr98EAgJzxY2wk0RaIDrB8/pLO+GzGOyB/AJmNgcQ7YN8ZsK9tEBXglrNfkph+LvYN6DICjxpoI0QEuFnBL0ksr255BnS/A1q/C/oFdHkGGc/w84hfQNc54CjDc0G/gBsVATe0GSIB7FX0SxK7T8ReAZcqAy5pO8QBuFwZcFnbIQ7AlcqAK9oOcQBWmwU+Zncm6BWwynPcMO9Pczu0YxBwtTLgqufT2n1H73ftAVb2SxK/Z7X3gYg+1iI4k1fg3j499sueNcBI7oG9Axq2X4PgDI7CvV9p1EH4JxyvgHHMAw/ppaPggl4Bo3gSOabxfjMFGMOz8AmlO7UEGMFqzBlNdmwIUH898JymOzEEqL0ifUFZndkBVP5M5JKyOzcDqPup3BXl9ckMoObnwteU34UVQMWdCTdU1KUVQLW9McV+RFdGALV2Z+1+LgGkW4e/tkPspTDvgDr7A3d/L/Mjuub/tfd0x53aewdU2aG6d1fuR3TD9ftC/Ido/4AKe6R7Xzl+XMGfy9nsB5gAgLXv0u8d8fzoM+fO9nw186Y+AQBr/57IN6Yf0ZdywbGrmXXTDAFY8zeVTtl+RB/KFvmfPw54jHPBBgGs9bty9w5+RHfFgum7AWcoDgNY47c1T5z8iL4W/tOJu8E3NcDavi/8h6Mf0Z8FglN3g/KhOBhgPd9Y/+TsV3RZHU+/uHQoDgdYx28mXLjzPXSY89fus15cNhSHBAz+qx2XjnKjsj8mybmblgzFYQHD/m7MbUU/ovuMv3aW89qSmU9owDfhfrno2sks3fTgkD8aHWkDBqpsAbC4yQ+aikajv2YScEfkN/lB0/fC136fQcDdd0LAlErZaH47c4BPS06iXqZ45aN5/kKYTcCnHZTCRh80XZW/9GPuUGwSMLVkIuj2519jzYZyh2KLgGM7KIU9PmYwZ0P3OQdjEfCQd8qcfvBnQzm7GwwCHnNPmZPDbDL7k2V7gK4LgB6xZwLwTA5RtS9ZQ7E1wHO5Q/UO7ANWWwD0VsY6mC3AqguA3preqmkKkPHIELqpodgSoGQB0FuTQ7EhQNkCoK8mh2I7gHH4Ef2dXlM3A1i+g7Ku/jEJyNlBWVepodgIIG8HZV2N71i3AcjdQVlXY0OxCUD2Dsq6GvtBCxOA/B2UdfWyx8sC4Kk2V0bPX0M2AHivjZXZ6JP5+AH1FlCLuzQC6L6Dsq5uTABW2UFZU8MvTUQOqLyAWtx+L3pA9QXU4g5jB6y+g7KmzuIGjGIBtbiLmAFjWQAs7DpiQG0bXhED2giAwgAoDIDCACgMgMIAKAyAwgAoDIDCACgMgMIAKAyAwgAoDIDCACisMuC/rzUAAhCApgNgJID/vdZ8AaJhABQGQGEAFAZAYQAUxgdsax9qlLX5gC3tY42yFh+wqX2sUdbkA85pH2uUzfEBGx3tg42wjoNfY177aCNs3gWw0dU+3OjqOvk1FjCTSddecANsLEJwvPaio9/DNYh38Utd1+tvOJJgLB7WcRs/xpprtl77O7ndarrM/xBCCCGEEEIIIYQQQgghhGay/wE8AJ9iqxlNEwAAAABJRU5ErkJggg==';

const markdown = [
  '# Release notes',
  '',
  '- [x] Images, code, CSV, and notebooks preview in one shell',
  '- [ ] Wire callers from Hub and message rows',
  '',
  '| Kind | Status |',
  '| --- | --- |',
  '| Markdown | Rendered |',
  '| Code | Highlighted |',
].join('\n');

const code = [
  'export function classify(mime: string) {',
  "  if (mime.startsWith('image/')) return 'image';",
  "  return 'opaque';",
  '}',
].join('\n');

const csv = ['Name,Kind,Size', 'diagram.png,image,18 KB', 'notes.md,text,2 KB', 'metrics.csv,data,4 KB'].join('\n');

const notebook = JSON.stringify({
  cells: [
    { cell_type: 'markdown', source: ['## Notebook cell\n', 'A markdown cell rendered with the shared markdown component.'] },
    {
      cell_type: 'code',
      source: ['total = 21 * 2\n', 'total'],
      outputs: [{ output_type: 'execute_result', data: { 'text/plain': ['42'] } }],
    },
  ],
});

const silentWav =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';

const emptyMp4 = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=';

const pdf =
  'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMjAgMjEwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMTk0ID4+CnN0cmVhbQowLjA4IDAuMSAwLjE2IHJnIDAgMCAzMjAgMjEwIHJlIGYKMC45NyAwLjk4IDAuOTkgcmcgMjQgMjQgMjcyIDE2MiByZSBmCjAuMDggMC43MiAwLjY1IHJnIDUyIDkyIDYwIDYwIHJlIGYKMC4xNSAwLjM5IDAuOTIgcmcgMTUwIDUyIDExOCA4NiByZSBmCjAgMCAwIHJnIEJUIC9GMSAyMiBUZiA0MiAxNTggVGQgKEF0cml1bSBQREYpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMTEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo1NTUKJSVFT0YK';

const textUrl = (mime: string, text: string) => `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;

export const demoFiles: PreviewFile[] = [
  {
    id: 'image',
    name: 'signal-map.png',
    mime: 'image/png',
    mediaKind: 'image',
    width: 320,
    height: 210,
    sizeBytes: 1795,
    contentUrl: png,
    uploader: { id: 'u1', name: 'Ada' },
    createdAt: new Date().toISOString(),
    source: { kind: 'channel', id: 'c1', label: 'design' },
  },
  {
    id: 'pdf',
    name: 'atrium.pdf',
    mime: 'application/pdf',
    mediaKind: 'document',
    sizeBytes: 738,
    contentUrl: pdf,
  },
  {
    id: 'markdown',
    name: 'release-notes.md',
    mime: 'text/markdown',
    mediaKind: 'text',
    sizeBytes: markdown.length,
    contentUrl: textUrl('text/markdown', markdown),
    textUrl: textUrl('text/markdown', markdown),
  },
  {
    id: 'code',
    name: 'classify.ts',
    mime: 'text/typescript',
    mediaKind: 'code',
    sizeBytes: code.length,
    contentUrl: textUrl('text/plain', code),
    textUrl: textUrl('text/plain', code),
  },
  {
    id: 'csv',
    name: 'files.csv',
    mime: 'text/csv',
    mediaKind: 'data',
    sizeBytes: csv.length,
    contentUrl: textUrl('text/csv', csv),
    textUrl: textUrl('text/csv', csv),
  },
  {
    id: 'notebook',
    name: 'summary.ipynb',
    mime: 'application/x-ipynb+json',
    mediaKind: 'data',
    sizeBytes: notebook.length,
    contentUrl: textUrl('application/json', notebook),
    textUrl: textUrl('application/json', notebook),
  },
  {
    id: 'audio',
    name: 'voice-note.wav',
    mime: 'audio/wav',
    mediaKind: 'audio',
    sizeBytes: 44,
    contentUrl: silentWav,
  },
  {
    id: 'video',
    name: 'clip.mp4',
    mime: 'video/mp4',
    mediaKind: 'video',
    sizeBytes: 32,
    contentUrl: emptyMp4,
  },
  {
    id: 'zip',
    name: 'archive.zip',
    mime: 'application/zip',
    mediaKind: 'opaque',
    sizeBytes: 8192,
    contentUrl: 'data:application/zip;base64,',
  },
];

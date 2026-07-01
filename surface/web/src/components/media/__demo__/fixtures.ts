import type { PreviewFile } from '../types';

const png =
  'data:image/png;base64,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';

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

const docx =
  'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEsDBAoAAAAAAFNi4VwxpqS4OgIAADoCAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPFR5cGVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L2NvbnRlbnQtdHlwZXMiPgogIDxEZWZhdWx0IEV4dGVuc2lvbj0icmVscyIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1wYWNrYWdlLnJlbGF0aW9uc2hpcHMreG1sIi8+CiAgPERlZmF1bHQgRXh0ZW5zaW9uPSJ4bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi94bWwiLz4KICA8T3ZlcnJpZGUgUGFydE5hbWU9Ii93b3JkL2RvY3VtZW50LnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC53b3JkcHJvY2Vzc2luZ21sLmRvY3VtZW50Lm1haW4reG1sIi8+CiAgPE92ZXJyaWRlIFBhcnROYW1lPSIvd29yZC9zdHlsZXMueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LndvcmRwcm9jZXNzaW5nbWwuc3R5bGVzK3htbCIvPgo8L1R5cGVzPlBLAwQKAAAAAABTYuFcAAAAAAAAAAAAAAAABgAAAF9yZWxzL1BLAwQKAAAAAABTYuFcIBuG6i4BAAAuAQAACwAAAF9yZWxzLy5yZWxzPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pgo8UmVsYXRpb25zaGlwcyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzIj4KICA8UmVsYXRpb25zaGlwIElkPSJySWQxIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL29mZmljZURvY3VtZW50IiBUYXJnZXQ9IndvcmQvZG9jdW1lbnQueG1sIi8+CjwvUmVsYXRpb25zaGlwcz5QSwMECgAAAAAAU2LhXAAAAAAAAAAAAAAAAAUAAAB3b3JkL1BLAwQKAAAAAABTYuFcoUgCHrsBAAC7AQAADwAAAHdvcmQvc3R5bGVzLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPHc6c3R5bGVzIHhtbG5zOnc9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy93b3JkcHJvY2Vzc2luZ21sLzIwMDYvbWFpbiI+CiAgPHc6c3R5bGUgdzp0eXBlPSJwYXJhZ3JhcGgiIHc6ZGVmYXVsdD0iMSIgdzpzdHlsZUlkPSJOb3JtYWwiPjx3Om5hbWUgdzp2YWw9Ik5vcm1hbCIvPjwvdzpzdHlsZT4KICA8dzpzdHlsZSB3OnR5cGU9InBhcmFncmFwaCIgdzpzdHlsZUlkPSJIZWFkaW5nMSI+PHc6bmFtZSB3OnZhbD0iaGVhZGluZyAxIi8+PHc6YmFzZWRPbiB3OnZhbD0iTm9ybWFsIi8+PHc6cFByPjx3OnNwYWNpbmcgdzphZnRlcj0iMTYwIi8+PC93OnBQcj48dzpyUHI+PHc6Yi8+PHc6c3ogdzp2YWw9IjMyIi8+PC93OnJQcj48L3c6c3R5bGU+CjwvdzpzdHlsZXM+UEsDBAoAAAAAAFNi4VzWt4IBawMAAGsDAAARAAAAd29yZC9kb2N1bWVudC54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+Cjx3OmRvY3VtZW50IHhtbG5zOnc9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy93b3JkcHJvY2Vzc2luZ21sLzIwMDYvbWFpbiI+CiAgPHc6Ym9keT4KICAgIDx3OnA+PHc6cFByPjx3OnBTdHlsZSB3OnZhbD0iSGVhZGluZzEiLz48L3c6cFByPjx3OnI+PHc6dD5BdHJpdW0gb2ZmaWNlIHByZXZpZXc8L3c6dD48L3c6cj48L3c6cD4KICAgIDx3OnA+PHc6cj48dzp0PkRPQ1ggcmVuZGVyaW5nIGlzIGhhbmRsZWQgaW4gdGhlIGJyb3dzZXIgd2l0aCBkb2N4LXByZXZpZXcuPC93OnQ+PC93OnI+PC93OnA+CiAgICA8dzpwPjx3OnI+PHc6dD5UaGlzIHRpbnkgZml4dHVyZSB2ZXJpZmllcyBmb3JtYXR0ZWQgdGV4dCBpbnNpZGUgdGhlIG1lZGlhIGxpZ2h0Ym94Ljwvdzp0PjwvdzpyPjwvdzpwPgogICAgPHc6dGJsPgogICAgICA8dzp0cj48dzp0Yz48dzpwPjx3OnI+PHc6dD5UeXBlPC93OnQ+PC93OnI+PC93OnA+PC93OnRjPjx3OnRjPjx3OnA+PHc6cj48dzp0PlN0YXR1czwvdzp0PjwvdzpyPjwvdzpwPjwvdzp0Yz48L3c6dHI+CiAgICAgIDx3OnRyPjx3OnRjPjx3OnA+PHc6cj48dzp0PkRPQ1g8L3c6dD48L3c6cj48L3c6cD48L3c6dGM+PHc6dGM+PHc6cD48dzpyPjx3OnQ+UmVuZGVyZWQ8L3c6dD48L3c6cj48L3c6cD48L3c6dGM+PC93OnRyPgogICAgPC93OnRibD4KICAgIDx3OnNlY3RQcj48dzpwZ1N6IHc6dz0iMTIyNDAiIHc6aD0iMTU4NDAiLz48dzpwZ01hciB3OnRvcD0iNzIwIiB3OnJpZ2h0PSI3MjAiIHc6Ym90dG9tPSI3MjAiIHc6bGVmdD0iNzIwIi8+PC93OnNlY3RQcj4KICA8L3c6Ym9keT4KPC93OmRvY3VtZW50PlBLAQIUAAoAAAAAAFNi4VwxpqS4OgIAADoCAAATAAAAAAAAAAAAAAAAAAAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQACgAAAAAAU2LhXAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAQAAAAawIAAF9yZWxzL1BLAQIUAAoAAAAAAFNi4VwgG4bqLgEAAC4BAAALAAAAAAAAAAAAAAAAAI8CAABfcmVscy8ucmVsc1BLAQIUAAoAAAAAAFNi4VwAAAAAAAAAAAAAAAAFAAAAAAAAAAAAEAAAAOYDAAB3b3JkL1BLAQIUAAoAAAAAAFNi4VyhSAIeuwEAALsBAAAPAAAAAAAAAAAAAAAAAAkEAAB3b3JkL3N0eWxlcy54bWxQSwECFAAKAAAAAABTYuFc1reCAWsDAABrAwAAEQAAAAAAAAAAAAAAAADxBQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAYABgBdAQAAiwkAAAAA';

const xlsx =
  'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEsDBAoAAAAAAFpi4VzFLx19LgIAAC4CAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPFR5cGVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L2NvbnRlbnQtdHlwZXMiPjxEZWZhdWx0IEV4dGVuc2lvbj0icmVscyIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1wYWNrYWdlLnJlbGF0aW9uc2hpcHMreG1sIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ4bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi94bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii94bC93b3JrYm9vay54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQuc3ByZWFkc2hlZXRtbC5zaGVldC5tYWluK3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL3dvcmtzaGVldHMvc2hlZXQxLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5zcHJlYWRzaGVldG1sLndvcmtzaGVldCt4bWwiLz48L1R5cGVzPlBLAwQKAAAAAABaYuFcAAAAAAAAAAAAAAAABgAAAF9yZWxzL1BLAwQKAAAAAABaYuFcmNrriycBAAAnAQAACwAAAF9yZWxzLy5yZWxzPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/PjxSZWxhdGlvbnNoaXBzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMiPjxSZWxhdGlvbnNoaXAgSWQ9InJJZDEiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvb2ZmaWNlRG9jdW1lbnQiIFRhcmdldD0ieGwvd29ya2Jvb2sueG1sIi8+PC9SZWxhdGlvbnNoaXBzPlBLAwQKAAAAAABaYuFcAAAAAAAAAAAAAAAAAwAAAHhsL1BLAwQKAAAAAABaYuFcrhkVkBwBAAAcAQAADwAAAHhsL3dvcmtib29rLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz48d29ya2Jvb2sgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6cj0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcyI+PHNoZWV0cz48c2hlZXQgbmFtZT0iUHJldmlldyIgc2hlZXRJZD0iMSIgcjppZD0icklkMSIvPjwvc2hlZXRzPjwvd29ya2Jvb2s+UEsDBAoAAAAAAFpi4VwAAAAAAAAAAAAAAAAJAAAAeGwvX3JlbHMvUEsDBAoAAAAAAFpi4Vxa/YJrKAEAACgBAAAaAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+PFJlbGF0aW9uc2hpcHMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcyI+PFJlbGF0aW9uc2hpcCBJZD0icklkMSIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy93b3Jrc2hlZXQiIFRhcmdldD0id29ya3NoZWV0cy9zaGVldDEueG1sIi8+PC9SZWxhdGlvbnNoaXBzPlBLAwQKAAAAAABaYuFcAAAAAAAAAAAAAAAADgAAAHhsL3dvcmtzaGVldHMvUEsDBAoAAAAAAFpi4Vzh4nSkXAMAAFwDAAAYAAAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pjx3b3Jrc2hlZXQgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiI+PGRpbWVuc2lvbiByZWY9IkExOkM0Ii8+PHNoZWV0RGF0YT48cm93IHI9IjEiPjxjIHI9IkExIiB0PSJpbmxpbmVTdHIiPjxpcz48dD5OYW1lPC90PjwvaXM+PC9jPjxjIHI9IkIxIiB0PSJpbmxpbmVTdHIiPjxpcz48dD5LaW5kPC90PjwvaXM+PC9jPjxjIHI9IkMxIiB0PSJpbmxpbmVTdHIiPjxpcz48dD5QcmV2aWV3PC90PjwvaXM+PC9jPjwvcm93Pjxyb3cgcj0iMiI+PGMgcj0iQTIiIHQ9ImlubGluZVN0ciI+PGlzPjx0PlJvYWRtYXA8L3Q+PC9pcz48L2M+PGMgcj0iQjIiIHQ9ImlubGluZVN0ciI+PGlzPjx0Pldvcmtib29rPC90PjwvaXM+PC9jPjxjIHI9IkMyIiB0PSJpbmxpbmVTdHIiPjxpcz48dD5UYWJsZTwvdD48L2lzPjwvYz48L3Jvdz48cm93IHI9IjMiPjxjIHI9IkEzIiB0PSJpbmxpbmVTdHIiPjxpcz48dD5CdWRnZXQ8L3Q+PC9pcz48L2M+PGMgcj0iQjMiIHQ9ImlubGluZVN0ciI+PGlzPjx0PlNoZWV0PC90PjwvaXM+PC9jPjxjIHI9IkMzIiB0PSJpbmxpbmVTdHIiPjxpcz48dD4kNDIsMDAwPC90PjwvaXM+PC9jPjwvcm93Pjxyb3cgcj0iNCI+PGMgcj0iQTQiIHQ9ImlubGluZVN0ciI+PGlzPjx0PkxhdW5jaDwvdD48L2lzPjwvYz48YyByPSJCNCIgdD0iaW5saW5lU3RyIj48aXM+PHQ+RGF0ZTwvdD48L2lzPjwvYz48YyByPSJDNCIgdD0iaW5saW5lU3RyIj48aXM+PHQ+MjAyNi0wNy0wMTwvdD48L2lzPjwvYz48L3Jvdz48L3NoZWV0RGF0YT48L3dvcmtzaGVldD5QSwECFAAKAAAAAABaYuFcxS8dfS4CAAAuAgAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAAoAAAAAAFpi4VwAAAAAAAAAAAAAAAAGAAAAAAAAAAAAEAAAAF8CAABfcmVscy9QSwECFAAKAAAAAABaYuFcmNrriycBAAAnAQAACwAAAAAAAAAAAAAAAACDAgAAX3JlbHMvLnJlbHNQSwECFAAKAAAAAABaYuFcAAAAAAAAAAAAAAAAAwAAAAAAAAAAABAAAADTAwAAeGwvUEsBAhQACgAAAAAAWmLhXK4ZFZAcAQAAHAEAAA8AAAAAAAAAAAAAAAAA9AMAAHhsL3dvcmtib29rLnhtbFBLAQIUAAoAAAAAAFpi4VwAAAAAAAAAAAAAAAAJAAAAAAAAAAAAEAAAAD0FAAB4bC9fcmVscy9QSwECFAAKAAAAAABaYuFcWv2CaygBAAAoAQAAGgAAAAAAAAAAAAAAAABkBQAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHNQSwECFAAKAAAAAABaYuFcAAAAAAAAAAAAAAAADgAAAAAAAAAAABAAAADEBgAAeGwvd29ya3NoZWV0cy9QSwECFAAKAAAAAABaYuFc4eJ0pFwDAABcAwAAGAAAAAAAAAAAAAAAAADwBgAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sUEsFBgAAAAAJAAkAHQIAAIIKAAAAAA==';

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
    thumbnailUrl: png,
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
    id: 'docx',
    name: 'office-preview.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    mediaKind: 'document',
    sizeBytes: 2812,
    contentUrl: docx,
  },
  {
    id: 'xlsx',
    name: 'preview-workbook.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    mediaKind: 'document',
    sizeBytes: 3150,
    contentUrl: xlsx,
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

import { describe, expect, it } from 'vitest';
import { destinationForFile } from './FileLinkRoute';

describe('FileLinkRoute helpers', () => {
  it('builds a Files Hub destination with the containing directory', () => {
    expect(
      destinationForFile({
        artifactId: 'artifact-1',
        path: 'shared/global/reports/q3.md',
        tombstoned: false,
      }),
    ).toEqual({
      pathname: '/files',
      search: 'dir=shared%2Fglobal%2Freports&file=artifact-1',
      initialFileArtifactId: 'artifact-1',
    });
  });
});

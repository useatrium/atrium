// Policy: CI retries unblock merges, while loud annotations keep every flake a
// visible fix-it item. Never make successful retries silent.
import { appendFile } from 'node:fs/promises';
import path from 'node:path';

// Structurally typed against Vitest 4's reporter API rather than importing types
// from 'vitest/reporters': every package's typecheck compiles this shared file via
// its vitest config, and not all of their module resolutions can see vitest's
// subpath type exports from this directory. Vitest accepts duck-typed reporters.
interface ReportedTestCase {
  fullName: string;
  module: { moduleId: string };
  result(): { state: string };
  diagnostic(): { retryCount: number } | undefined;
}

interface FlakyTest {
  file: string;
  name: string;
}

function githubEscape(value: string, property = false): string {
  const escaped = value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  return property ? escaped.replaceAll(':', '%3A').replaceAll(',', '%2C') : escaped;
}

function markdownEscape(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ');
}

export class FlakyReporter {
  private readonly flakyTests: FlakyTest[] = [];

  constructor(private readonly packageName: string) {}

  onTestCaseResult(testCase: ReportedTestCase): void {
    if (testCase.result().state !== 'passed' || !testCase.diagnostic()?.retryCount) return;

    const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
    this.flakyTests.push({
      file: path.relative(root, testCase.module.moduleId).replaceAll(path.sep, '/'),
      name: testCase.fullName,
    });
  }

  async onTestRunEnd(): Promise<void> {
    if (this.flakyTests.length === 0) return;

    for (const test of this.flakyTests) {
      console.log(
        `::warning file=${githubEscape(test.file, true)},title=FLAKY::${githubEscape(test.name)} passed only on retry`,
      );
    }

    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryPath) return;

    const rows = this.flakyTests.map(
      (test) => `| ${markdownEscape(this.packageName)} | ${markdownEscape(test.file)} | ${markdownEscape(test.name)} |`,
    );
    await appendFile(
      summaryPath,
      `\n## Flaky tests (passed on retry)\n\n| Package | File | Test |\n| --- | --- | --- |\n${rows.join('\n')}\n`,
    );
  }
}

// Policy: CI retries unblock merges, while loud annotations keep every flake a
// visible fix-it item. Never make successful retries silent.
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { Reporter, TestCase } from 'vitest/reporters';

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

export class FlakyReporter implements Reporter {
  private readonly flakyTests: FlakyTest[] = [];

  constructor(private readonly packageName: string) {}

  onTestCaseResult(testCase: TestCase): void {
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

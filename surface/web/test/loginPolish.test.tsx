// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { authMethods: vi.fn().mockResolvedValue({ open: true, email: false, google: false, calls: false }) },
}));
vi.mock('../src/desktop', () => ({ captureDesktopLogin: vi.fn() }));

import { Login } from '../src/Login';

afterEach(cleanup);

describe('Login hierarchy', () => {
  it('leads with the product value and progressively reveals server context', () => {
    render(<Login onLogin={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Work with agents together.' })).toBeTruthy();
    expect(screen.getByText(/conversations, delegated work, and results/)).toBeTruthy();
    const details = screen.getByText('Server details').closest('details');
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.textContent).toContain(location.host);
  });
});

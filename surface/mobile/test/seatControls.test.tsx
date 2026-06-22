// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithTheme as renderUI } from './rnTestUtils';
import { SeatFooter, SeatRequestBanner } from '../src/components/work/SeatControls';

afterEach(cleanup);

function callbacks() {
  return {
    onRequest: vi.fn(),
    onTake: vi.fn(),
    onConfirmTake: vi.fn(),
    onCancelTake: vi.fn(),
  };
}

describe('SeatRequestBanner (mobile)', () => {
  it('renders the requester name and grants or ignores the request', () => {
    const onGrant = vi.fn();
    const onIgnore = vi.fn();

    renderUI(<SeatRequestBanner requesterName="Mina" onGrant={onGrant} onIgnore={onIgnore} />);

    expect(screen.getByText('Mina requests the seat')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Grant seat request' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ignore seat request' }));

    expect(onGrant).toHaveBeenCalledTimes(1);
    expect(onIgnore).toHaveBeenCalledTimes(1);
  });
});

describe('SeatFooter (mobile)', () => {
  it('renders request mode and requests the seat', () => {
    const props = callbacks();

    renderUI(<SeatFooter mode="request" driverName="Gary" {...props} />);

    const footer = screen.getByTestId('seat-footer');
    fireEvent.click(within(footer).getByRole('button', { name: 'Request seat' }));

    expect(props.onRequest).toHaveBeenCalledTimes(1);
    expect(within(footer).queryByRole('button', { name: 'Take seat' })).toBeNull();
  });

  it('renders take mode and takes the empty seat', () => {
    const props = callbacks();

    renderUI(<SeatFooter mode="take" driverName="Gary" {...props} />);

    const footer = screen.getByTestId('seat-footer');
    fireEvent.click(within(footer).getByRole('button', { name: 'Take seat' }));

    expect(props.onTake).toHaveBeenCalledTimes(1);
    expect(within(footer).queryByRole('button', { name: 'Request seat' })).toBeNull();
  });

  it('renders confirm mode and fires confirm or cancel callbacks', () => {
    const props = callbacks();

    renderUI(<SeatFooter mode="confirm" driverName="Gary" {...props} />);

    const footer = screen.getByTestId('seat-footer');
    expect(within(footer).getByText('Take the seat from Gary?')).toBeInTheDocument();

    fireEvent.click(within(footer).getByRole('button', { name: 'Confirm taking the seat from Gary' }));
    fireEvent.click(within(footer).getByRole('button', { name: 'Keep watching' }));

    expect(props.onConfirmTake).toHaveBeenCalledTimes(1);
    expect(props.onCancelTake).toHaveBeenCalledTimes(1);
  });

  it('renders waiting mode without seat action buttons', () => {
    const props = callbacks();

    renderUI(<SeatFooter mode="waiting" driverName="Gary" {...props} />);

    const footer = screen.getByTestId('seat-footer');
    expect(within(footer).getByText('Requested — waiting for Gary')).toBeInTheDocument();
    expect(within(footer).queryByRole('button')).toBeNull();
  });
});

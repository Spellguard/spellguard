// SPDX-License-Identifier: Apache-2.0

/**
 * The ui-kit Spinner renders a Rive animation (@rive-app/react-canvas), whose
 * runtime needs window.matchMedia + a real <canvas> — neither exists in jsdom.
 * Since the Spinner is now the app-wide loading indicator, any component test
 * that renders a loading state would crash on it. Stub the Rive hook with an
 * inert placeholder so tests exercise the component tree, not the animation.
 *
 * Node-environment suites never import react-canvas, and vi.mock is lazy, so
 * this setup file is safe to load unconditionally.
 */

import { vi } from 'vitest';

vi.mock('@rive-app/react-canvas', async () => {
  const { createElement } = await import('react');
  return {
    useRive: () => ({
      rive: null,
      RiveComponent: (props: Record<string, unknown>) =>
        createElement('div', { 'data-testid': 'rive-spinner', ...props }),
    }),
    Layout: class {},
    Alignment: { Center: 'center' },
    Fit: { Contain: 'contain' },
  };
});

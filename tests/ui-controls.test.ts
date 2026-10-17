import React, { act, createElement, forwardRef } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/renderer/hooks/useMotion', () => ({ useMotionPrefs: () => ({ reduced: true, low: true, animate: false }) }));
vi.mock('../src/renderer/state', () => ({ useApp: () => [], dismissToast: () => {} }));
vi.mock('../src/renderer/i18n', () => ({ t: (s: string) => s, platformName: (s: string) => s }));
vi.mock('motion/react', () => ({ AnimatePresence: ({ children }: { children: React.ReactNode }) => children, motion: { div: forwardRef<HTMLDivElement, Record<string, unknown>>(({ initial, animate, exit, transition, ...props }, ref) => createElement('div', { ...props, ref })) } }));
import { Button, Dialog, IconButton } from '../src/renderer/components/ui';
afterEach(() => vi.unstubAllGlobals());
describe('shared UI controls', () => {
  it('retains button styling with an additional selected or wishlist class', () => {
    const html = renderToStaticMarkup(createElement(Button, { className: 'is-wished', variant: 'ghost', children: 'Wishlist' }));
    expect(html).toContain('btn btn--ghost btn--md is-wished');
    expect(renderToStaticMarkup(createElement(IconButton, { icon: 'heart', label: 'Favorite', className: 'is-on' }))).toContain('icon-btn is-on');
  });
  it('keeps keyboard focus when an open dialog rerenders and uses its latest close handler', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>');
    vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.getElementById('root')!); const firstClose=vi.fn(), latestClose=vi.fn();
    const render = (onClose: () => void) => createElement(Dialog, { open:true, title:'Settings', onClose, children:createElement('input',{id:'name'}), actions:createElement('button',{id:'save'},'Save') });
    try {
      await act(async()=>{root.render(render(firstClose));});
      await act(async()=>{await new Promise(r=>setTimeout(r,30));});
      const save=document.getElementById('save')!; save.focus();
      await act(async()=>{root.render(render(latestClose));});
      await act(async()=>{await new Promise(r=>setTimeout(r,30));});
      expect(document.activeElement).toBe(save);
      window.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      expect(latestClose).toHaveBeenCalledOnce(); expect(firstClose).not.toHaveBeenCalled();
    } finally { await act(async()=>root.unmount()); dom.window.close(); }
  });
});

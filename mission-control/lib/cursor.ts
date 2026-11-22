'use client';

import { create } from 'zustand';

/** Shared time cursor: hovering any chart moves it everywhere (and drives replay). */
export const useCursor = create<{ ts: number | null; set: (ts: number | null) => void }>((set) => ({
  ts: null,
  set: (ts) => set({ ts }),
}));

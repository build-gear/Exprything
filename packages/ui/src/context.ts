import { createContext } from 'react';
import type { Api } from './api.ts';

export const CanvasCtx = createContext<{ api: Api; canvas: string; reload: () => void }>(null!);

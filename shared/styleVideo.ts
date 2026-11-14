import type { Format } from './types';

export interface StyleVideoPlan {
  style: 'interface' | 'diagram' | 'spatial' | 'pixel';
  title: string;
  duration: number;
  format: Format;
  beats: Array<{ eyebrow: string; title: string; detail: string; labels: string[] }>;
}
